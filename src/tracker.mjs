// 翻 exp-tracker/src/tracker.py（0071 工單任務 1）。
//
// 經驗值累積的核心邏輯（純運算，不碰畫面也不碰 GUI）。負責處理四件事：
//   1. 升級：經驗值會歸零重算，不能直接相減
//   2. OCR 看錯：漲幅離譜的樣本要丟掉
//   3. 掛機：一直沒長經驗的時間不該算進「每小時經驗」的分母
//   4. 換地圖：跨地圖的那一段不算給任何一張地圖
//
// **這支模組不讀螢幕、不讀 fetch，是純資料結構**——跟 Python 版一樣可以在
// 完全沒有網路/瀏覽器 API 的環境下單元測試。`MapNameStabilizer` 依賴的
// mapdb 候選清單如果還沒 `await mapdb.loadNames()`，`ExpTracker` 照樣能建、
// 照樣能 feed()，只是地圖名比對會退化成「還沒有總表可查」（跟 Python 版
// CSV 缺檔時的退化行為一致）。

import { MapNameStabilizer } from "./parsing.mjs";

// 近 N 分鐘滾動平均用的陣列上限（tracker.py:21）。10 分鐘視窗、10 秒一筆取樣
// 大概 60 筆，設 128 綽綽有餘。
const RECENT_MAXLEN = 128;

// 「OCR 多讀一位數」那條檢查，經驗值小於這個數就不套用（tracker.py:182）。
export const MIN_EXP_FOR_DIGIT_CHECK = 1000;

/** 把一筆 append 進固定長度陣列，超過上限就丟掉最舊的一筆（模擬 Python deque(maxlen=...)）。 */
function pushBounded(arr, item, maxlen) {
  arr.push(item);
  if (arr.length > maxlen) arr.shift();
}

/**
 * 單一地圖的累計數字（逐字對照 tracker.py:24-163 的 MapStat）。
 */
export class MapStat {
  constructor() {
    this.exp = 0;
    this.percent = 0.0;
    this.seconds = 0.0;
    this.samples = 0;
    // 近 N 分鐘滾動平均用的 [seconds, exp, percent] 序列，只加不改既有欄位。
    // 不進 asDict()（tracker.py 前提澄清：不可以放進 history.json 的格式）。
    this._recent = [];
  }

  get expPerHour() {
    return this.seconds > 0 ? (this.exp / this.seconds) * 3600 : 0.0;
  }

  get percentPerHour() {
    return this.seconds > 0 ? (this.percent / this.seconds) * 3600 : 0.0;
  }

  /**
   * 找近 windowSec 秒視窗的 [最新一筆, 起點一筆]，資料不足或時間差 <= 0 回 null
   * （逐字對照 tracker.py:52-91）。
   * @param {number} windowSec
   * @param {[number, number, number]|null} [pending] [dt, gain, pct]
   * @returns {[[number,number,number],[number,number,number]]|null}
   */
  _recentWindow(windowSec, pending = null) {
    if (this._recent.length < 2) return null;
    let latest = this._recent[this._recent.length - 1];
    if (pending !== null && pending !== undefined) {
      let [dt, gain, pct] = pending;
      // 升級瞬間 fast_exp 歸零會讓 gain 變成很大的負數，一起夾住。
      dt = Math.max(0.0, dt);
      gain = Math.max(0.0, gain);
      latest = [latest[0] + dt, latest[1] + gain, latest[2] + pct];
    }
    const cutoff = latest[0] - windowSec;
    let start = this._recent[0];
    for (const item of this._recent) {
      if (item[0] >= cutoff) {
        start = item;
        break;
      }
    }
    if (latest[0] - start[0] <= 0) return null;
    return [latest, start];
  }

  /**
   * 近 windowSec 秒（預設 10 分鐘）的滾動平均每小時經驗（逐字對照
   * tracker.py:93-112）。**不接 pending 參數**（Python 版「不要做」清單明講
   * 保留不動，簽章跟公式都不能動）。
   * @param {number} [windowSec]
   * @returns {number|null}
   */
  expPerHourRecent(windowSec = 600.0) {
    const bounds = this._recentWindow(windowSec);
    if (bounds === null) return null;
    const [latest, start] = bounds;
    return ((latest[1] - start[1]) / (latest[0] - start[0])) * 3600;
  }

  /**
   * 近 windowSec 秒（預設 10 分鐘）實際賺到的經驗量（逐字對照
   * tracker.py:114-139）。⚠️ 不可以直接把頭尾相減，要「先算速率再乘視窗」。
   * @param {number} [windowSec]
   * @param {[number, number, number]|null} [pending]
   * @returns {number|null}
   */
  expInWindow(windowSec = 600.0, pending = null) {
    const bounds = this._recentWindow(windowSec, pending);
    if (bounds === null) return null;
    const [latest, start] = bounds;
    return ((latest[1] - start[1]) / (latest[0] - start[0])) * windowSec;
  }

  /**
   * 近 windowSec 秒（預設 10 分鐘）這段時間吃掉本級的幾 %（逐字對照
   * tracker.py:141-155）。
   * @param {number} [windowSec]
   * @param {[number, number, number]|null} [pending]
   * @returns {number|null}
   */
  percentInWindow(windowSec = 600.0, pending = null) {
    const bounds = this._recentWindow(windowSec, pending);
    if (bounds === null) return null;
    const [latest, start] = bounds;
    return ((latest[2] - start[2]) / (latest[0] - start[0])) * windowSec;
  }

  /** 逐字對照 tracker.py:157-163，存檔／顯示用的形狀（不含 _recent）。
   * round() 用 toFixed 不用「先乘後除」，理由見 storage.mjs 的 roundTo()。
   */
  asDict() {
    return {
      exp: this.exp,
      percent: Number(this.percent.toFixed(4)),
      seconds: Number(this.seconds.toFixed(1)),
      samples: this.samples,
    };
  }
}

/**
 * 餵進一筆取樣之後的結果，給畫面顯示與寫 log 用（逐字對照 tracker.py:166-177）。
 */
export class FeedResult {
  constructor() {
    this.mapName = null;
    this.exp = null;
    this.percent = null;
    this.level = null;
    this.gain = 0;
    this.counted = false;
    this.leveledUp = false;
    this.note = "";
  }
}

/**
 * 逐字對照 tracker.py:185-476 的 ExpTracker。
 */
export class ExpTracker {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.minPercentForLevelEstimate]
   * @param {number} [opts.maxGainPercentPerSample]
   * @param {number} [opts.mapConfirmSamples]
   * @param {number} [opts.levelConfirmSamples]
   * @param {number} [opts.idleTimeoutSec]
   * @param {import('./exptable.mjs').ExpTable|null} [opts.table]
   * @param {Object<string,string>} [opts.mapAliases]
   */
  constructor({
    minPercentForLevelEstimate = 0.05,
    maxGainPercentPerSample = 25.0,
    mapConfirmSamples = 2,
    levelConfirmSamples = 3,
    idleTimeoutSec = 180.0,
    table = null,
    mapAliases = {},
  } = {}) {
    this.minPercentForLevelEstimate = minPercentForLevelEstimate;
    this.maxGainPercentPerSample = maxGainPercentPerSample;
    this.mapConfirmSamples = mapConfirmSamples;
    this.levelConfirmSamples = levelConfirmSamples;
    this.idleTimeoutSec = idleTimeoutSec;
    this.table = table;
    this.mapAliases = mapAliases;

    /** @type {Map<string, MapStat>} */
    this.maps = new Map();
    this.level = null;
    this.levelTotal = null;
    this.currentExp = null;
    this.currentPercent = null;

    this._stabilizer = new MapNameStabilizer(this.mapConfirmSamples, undefined, this.mapAliases);
    this._prevMap = null;
    this._prevExp = null;
    this._prevTs = null;
    this._prevLevelTotal = null;
    this._idleStreak = 0.0;
    this._levelNote = "";
    this._oddCount = 0;
  }

  // ---------- 對外 ----------

  /**
   * 吃一筆取樣（時間戳、經驗值、百分比、地圖名稱原始字串、等級）。
   * `level` 是直接從畫面讀到的等級；跟經驗數字反推的結果打架時以反推的為準
   * （逐字對照 tracker.py:216-241）。
   * @param {number} ts
   * @param {number|null} exp
   * @param {number|null} percent
   * @param {string} rawMap
   * @param {number|null} [level]
   * @returns {FeedResult}
   */
  feed(ts, exp, percent, rawMap, level = null) {
    const result = this._feed(ts, exp, percent, rawMap, level);
    if (result.counted && result.mapName !== null) {
      const stat = this.maps.get(result.mapName);
      if (stat) {
        pushBounded(stat._recent, [stat.seconds, stat.exp, stat.percent], RECENT_MAXLEN);
      }
    }
    if (this._levelNote) {
      result.note = this._levelNote + (result.note ? "；" + result.note : "");
    }
    return result;
  }

  /**
   * 預覽模式專用的唯讀入口，**只**餵地圖名稱穩定器（逐字對照 tracker.py:243-252）。
   * @param {string} raw
   * @returns {string|null}
   */
  feedMapOnly(raw) {
    return this._stabilizer.feed(raw);
  }

  _feed(ts, exp, percent, rawMap, level = null) {
    const mapName = this._stabilizer.feed(rawMap);
    const levelBefore = this.level;
    this._levelNote = this._updateLevel(exp, percent, level);

    // 本級所需經驗已知的話，百分比一律自己算。round(x,2) 用 toFixed 不用
    // 「先乘後除」——理由跟 storage.mjs 的 roundTo() 檔頭註解一樣，先乘會被
    // 浮點誤差污染，跟 Python round() 對不起來。
    if (exp !== null && exp !== undefined && this.levelTotal) {
      percent = Number(((exp / this.levelTotal) * 100).toFixed(2));
    }

    this.currentExp = exp;
    this.currentPercent = percent;
    const result = new FeedResult();
    result.mapName = mapName;
    result.exp = exp;
    result.percent = percent;
    result.level = this.level;

    if (exp === null || exp === undefined) {
      result.note = "讀不到經驗值";
      return result;
    }
    if (mapName === null || mapName === undefined) {
      result.note = "讀不到地圖";
      return result;
    }

    if (!this.maps.has(mapName)) this.maps.set(mapName, new MapStat());
    // 第一筆取樣不算「換地圖」，只是還沒有基準點而已。
    const changedMap = this._prevMap !== null && this._prevMap !== mapName;
    this._prevMap = mapName;

    if (changedMap || this._prevExp === null || this._prevTs === null) {
      this._rebase(ts, exp);
      result.note = changedMap ? "換地圖，重設基準" : "設定基準";
      return result;
    }

    const dt = ts - this._prevTs;
    if (dt <= 0) {
      result.note = "時間沒有前進";
      return result;
    }

    const [gain, leveledUp] = this._gain(this._prevExp, exp);
    if (gain === null) {
      this._rebase(ts, exp);
      result.note = "漲幅離譜，判定 OCR 看錯，丟棄";
      return result;
    }

    // 掛機判定：連續沒長經驗超過 idleTimeoutSec，這段時間不計入分母。
    this._idleStreak = gain === 0 ? this._idleStreak + dt : 0.0;
    if (this._idleStreak > this.idleTimeoutSec) {
      this._rebase(ts, exp);
      result.note = "掛機中，不計時";
      return result;
    }

    // 升級了就把等級往前推一級（除非上面查表已經自己認出新等級）。
    if (leveledUp && this.level !== null && this.level === levelBefore) {
      this._setLevel(this.level + 1);
    }

    const stat = this.maps.get(mapName);
    stat.exp += gain;
    stat.seconds += dt;
    stat.samples += 1;
    const denominator = this._prevLevelTotal || this.levelTotal;
    if (denominator) {
      stat.percent += (gain / denominator) * 100;
    }

    this._rebase(ts, exp);
    result.gain = gain;
    result.counted = true;
    result.leveledUp = leveledUp;
    result.level = this.level;
    return result;
  }

  /** 按下「結束」或暫停時呼叫（逐字對照 tracker.py:332-336）。 */
  resetBaseline() {
    this._prevExp = null;
    this._prevTs = null;
    this._idleStreak = 0.0;
  }

  /**
   * 依每小時經驗由高到低排序的排行榜（逐字對照 tracker.py:338-344）。
   * @returns {[string, MapStat][]}
   */
  ranking() {
    return [...this.maps.entries()].sort((a, b) => b[1].expPerHour - a[1].expPerHour);
  }

  /** 所有地圖加總（逐字對照 tracker.py:346-354）。 */
  totals() {
    const total = new MapStat();
    for (const stat of this.maps.values()) {
      total.exp += stat.exp;
      total.percent += stat.percent;
      total.seconds += stat.seconds;
      total.samples += stat.samples;
    }
    return total;
  }

  /**
   * 照目前的速度，還要多久升級（秒）。算不出來時回傳 null
   * （逐字對照 tracker.py:356-368）。
   * @param {string|null} [mapName]
   * @returns {number|null}
   */
  secondsToLevelUp(mapName = null) {
    if (!this.levelTotal || this.currentExp === null || this.currentExp === undefined) return null;
    const remaining = this.levelTotal - this.currentExp;
    if (remaining <= 0) return 0.0;

    const stat = mapName ? this.maps.get(mapName) : null;
    const rate = stat ? stat.expPerHour : this.totals().expPerHour;
    if (rate <= 0) return null;
    return (remaining / rate) * 3600;
  }

  // ---------- 內部 ----------

  /**
   * 依這一筆取樣更新「現在幾級 / 本級總經驗」，回傳要顯示的提醒
   * （逐字對照 tracker.py:372-416）。
   */
  _updateLevel(exp, percent, level = null) {
    let guessed = null;
    if (exp !== null && exp !== undefined && percent !== null && percent !== undefined && this.table) {
      guessed = this.table.guessLevel(exp, percent, undefined, this.minPercentForLevelEstimate);
    }

    const candidate = guessed !== null && guessed !== undefined ? guessed : level;
    if (candidate !== null && candidate !== undefined && !this._plausible(candidate)) {
      guessed = null;
      level = null;
    }

    if ((level === null || level === undefined) && (guessed === null || guessed === undefined)) {
      if (
        !this.table &&
        exp !== null &&
        exp !== undefined &&
        percent !== null &&
        percent !== undefined &&
        percent >= this.minPercentForLevelEstimate
      ) {
        this.levelTotal = Math.round(exp / percent * 100);
      }
      return this.level ? "這一筆等級讀不出來，沿用 Lv." + this.level : "";
    }

    if (level !== null && level !== undefined && guessed !== null && guessed !== undefined && level !== guessed) {
      this._setLevel(guessed);
      return "畫面讀到 Lv." + level + "，但經驗數字對到 Lv." + guessed + "，以經驗數字為準";
    }

    if (level !== null && level !== undefined) {
      this._setLevel(level);
      return "";
    }

    this._setLevel(guessed);
    return "";
  }

  /**
   * 這個等級合不合理？（逐字對照 tracker.py:418-436）
   * @param {number|null} candidate
   * @returns {boolean}
   */
  _plausible(candidate) {
    if (candidate === null || candidate === undefined) return false;
    if (this.level === null || candidate === this.level || candidate === this.level + 1) {
      this._oddCount = 0;
      return true;
    }

    this._oddCount += 1;
    if (this._oddCount >= this.levelConfirmSamples) {
      this._oddCount = 0;
      return true;
    }
    return false;
  }

  _setLevel(level) {
    this.level = level;
    if (this.table) {
      this.levelTotal = this.table.expToNext(level) || this.levelTotal;
    }
  }

  _rebase(ts, exp) {
    this._prevExp = exp;
    this._prevTs = ts;
    this._prevLevelTotal = this.levelTotal;
  }

  /**
   * 算這一段的經驗成長，回傳 [成長值, 是否升級]。成長值為 null 代表這筆該丟掉
   * （逐字對照 tracker.py:448-476）。
   * @param {number} prev
   * @param {number} now
   * @returns {[number|null, boolean]}
   */
  _gain(prev, now) {
    const levelTotal = this._prevLevelTotal || this.levelTotal;
    let leveledUp = false;
    let gain;

    if (now >= prev) {
      // OCR 有時會在經驗值前面多讀出一個數字。位數多一位、而且把最高位拿掉
      // 之後剛好接得上前一筆，就判定是多讀的，整筆丟掉。
      const nowStr = String(now);
      const prevStr = String(prev);
      const trimmed = nowStr.slice(1);
      if (prev >= MIN_EXP_FOR_DIGIT_CHECK && nowStr.length > prevStr.length && trimmed && Number(trimmed) >= prev) {
        return [null, false];
      }
      gain = now - prev;
    } else if (levelTotal && prev <= levelTotal) {
      // 升級了：先補滿上一級剩下的，再加上這一級已經累積的。
      gain = levelTotal - prev + now;
      leveledUp = true;
    } else {
      // 經驗值變少又推不出級距，不猜，直接丟掉。
      return [null, false];
    }

    if (levelTotal && gain > (levelTotal * this.maxGainPercentPerSample) / 100) {
      return [null, false];
    }
    return [gain, leveledUp];
  }
}

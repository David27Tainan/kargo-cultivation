// 翻 exp-tracker/src/ratebuffer.py（0071 工單任務 1）。
//
// 「一小時經驗」／「十分鐘經驗」那條 UI 端滾動緩衝。**不讀 tracker.mjs 的任何
// 方法**（Python 版 0036 號工單的裁定，逐字保留）：它唯一跟 tracker 有關的
// 東西是「現在在有效秒數軸上的位置」，靠建構時注入的 `effSecondsFn` 這個
// callable 從外面拿。
//
// 用法（`app.mjs` 端，逐字對照 Python docstring）：
//     const rate = new RateBuffer(RATE_MIN_DT_SEC, RATE_BUFFER_THROTTLE_SEC, currentEffSeconds);
//     rate.noteLatest(exp, percent);     // 每筆 fast_sample，不管在不在計時
//     rate.push(effSeconds, exp, percent);  // 只有計時中才存進緩衝
//     rate.noteMap(mapName);             // 每筆慢迴圈 sample
//     rate.window(3600.0);               // 畫面要顯示時

// 0.5 秒一筆 × 7200 = 3600 秒（一小時經驗最長的視窗）。
export const DEFAULT_MAXLEN = 7200;

export class RateBuffer {
  /**
   * @param {number} minDtSec
   * @param {number} downsampleSec
   * @param {(() => number)|null} [effSecondsFn]
   * @param {number} [maxlen]
   */
  constructor(minDtSec, downsampleSec, effSecondsFn = null, maxlen = DEFAULT_MAXLEN) {
    this.minDtSec = Number(minDtSec);
    this.downsampleSec = Number(downsampleSec);
    this._effSecondsFn = effSecondsFn;
    this._maxlen = maxlen;
    /** @type {[number, number, number][]} */
    this._buf = [];
    // 上次「真的存進緩衝」那一筆的 eff 秒數，降採樣節流用。
    this._lastPushEff = null;
    // 目前為止看過最大的 eff 秒數，時間軸單調用。
    this._lastEff = null;
    this._mapName = null;
    this._latestExp = null;
    this._latestPct = null;
    this._bootstrapStartedAt = null;
  }

  // ---------- 狀態 ----------

  get mapName() {
    return this._mapName;
  }

  get bootstrapAt() {
    return this._bootstrapStartedAt;
  }

  get lastEff() {
    return this._lastEff;
  }

  get latestExp() {
    return this._latestExp;
  }

  get length() {
    return this._buf.length;
  }

  // ---------- 寫入 ----------

  /**
   * 整條清乾淨並把 bootstrap 原點設成現在。呼叫時機：按「開始」、按「結束」。
   * @param {number|null} [now] 牆鐘時間（毫秒/1000，秒），不傳就用 Date.now()/1000
   */
  reset(now = null) {
    this._buf = [];
    this._lastPushEff = null;
    this._lastEff = null;
    this._mapName = null;
    this._latestExp = null;
    this._latestPct = null;
    this._bootstrapStartedAt = now === null ? Date.now() / 1000 : now;
  }

  /** 明確設定 bootstrap 軸的原點。 */
  bootstrapStarted(t) {
    this._bootstrapStartedAt = t;
  }

  /**
   * 記住「最新一點」，不受降採樣節流限制。
   * @param {number|null} exp
   * @param {number|null} percent
   */
  noteLatest(exp, percent) {
    if (exp !== null && exp !== undefined) this._latestExp = exp;
    if (percent !== null && percent !== undefined) this._latestPct = percent;
  }

  /**
   * 收一筆 fast_sample。回傳「這一筆有沒有真的存進緩衝」（被降採樣節流掉就是 false）。
   * @param {number} effSeconds
   * @param {number|null} exp
   * @param {number|null} percent
   * @returns {boolean}
   */
  push(effSeconds, exp, percent) {
    this.noteLatest(exp, percent);
    if (exp === null || exp === undefined) return false;

    // 時間軸只准往前。
    if (this._lastEff !== null && effSeconds < this._lastEff) {
      effSeconds = this._lastEff;
    }
    this._lastEff = effSeconds;

    if (this._lastPushEff !== null && effSeconds - this._lastPushEff < this.downsampleSec) {
      return false;
    }
    const pctValue = this._latestPct !== null && this._latestPct !== undefined ? this._latestPct : 0.0;
    this._buf.push([effSeconds, exp, pctValue]);
    if (this._buf.length > this._maxlen) this._buf.shift();
    this._lastPushEff = effSeconds;
    return true;
  }

  /**
   * 慢迴圈讀到地圖名時呼叫。回傳「有沒有因為換地圖而清空緩衝」。
   * 「第一次認出地圖」不算換地圖（0038 號工單裁定，逐字保留）。
   * @param {string|null} name
   * @param {number|null} [now]
   * @returns {boolean}
   */
  noteMap(name, now = null) {
    if (name === null || name === undefined || name === this._mapName) return false;
    let cleared = false;
    if (this._mapName !== null) {
      this._buf = [];
      this._lastPushEff = null;
      this._lastEff = null;
      this._bootstrapStartedAt = now === null ? Date.now() / 1000 : now;
      cleared = true;
    }
    this._mapName = name;
    return cleared;
  }

  // ---------- 讀出 ----------

  /**
   * 視窗內的 [exp 成長, percent 成長]，累積不到 minDtSec 就回 null。
   * 「先算速率再乘視窗」：(latest − start) / dt * sec。
   * @param {number} sec
   * @returns {[number, number]|null}
   */
  window(sec) {
    if (this._latestExp === null || this._latestExp === undefined || this._buf.length === 0) return null;
    const effSeconds = this._currentEff();
    const cutoff = effSeconds - sec;
    let start = this._buf[0];
    for (let i = this._buf.length - 1; i >= 0; i--) {
      const item = this._buf[i];
      if (item[0] < cutoff) break;
      start = item;
    }
    const dt = effSeconds - start[0];
    if (dt < this.minDtSec) return null;
    const latestPct = this._latestPct !== null && this._latestPct !== undefined ? this._latestPct : start[2];
    const gain = Math.max(0.0, this._latestExp - start[1]);
    const pctGain = Math.max(0.0, latestPct - start[2]);
    return [(gain / dt) * sec, (pctGain / dt) * sec];
  }

  /**
   * 現在在有效秒數軸上的位置，一樣套「只准往前」的水位線。**不更新**
   * `_lastEff`——水位線只由真的收到的取樣（push()）推進。
   * @returns {number}
   */
  _currentEff() {
    let eff = this._effSecondsFn !== null && this._effSecondsFn !== undefined ? Number(this._effSecondsFn()) : 0.0;
    if (this._lastEff !== null && eff < this._lastEff) eff = this._lastEff;
    return eff;
  }
}

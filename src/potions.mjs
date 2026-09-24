// 翻 exp-tracker/src/potions.py（0072 工單任務 1）。
//
// 藥水花費的純運算：跟桌面版一樣分兩件事，都不碰畫面／截圖。
//   1. PotionCatalog：藥水種類與單價表。桌面版存 data/potions.json（缺檔從
//      potions.example.json 複製）；瀏覽器版沒有檔案系統，改存 localStorage
//      （key `kc:potions`，計畫書 §10），缺資料時用內建的預設兩筆（紅水/藍水，
//      「待核對」，跟桌面版 potions.example.json 的預設值一致）。
//   2. PotionTracker：把「快捷欄還剩幾瓶」翻成「消耗幾瓶、花多少錢」，四條規則
//      逐字對照 potions.py 檔頭表格：少了算消耗、多了當補貨只重設基準、一次少
//      超過門檻當 OCR 讀壞整筆丟掉並重設基準、讀不到（null）跳過但基準不動。
//      血水／藍水各自獨立判斷。滾動視窗「先算速率再乘視窗」，不可以頭尾相減。
//
// 跟 tracker.mjs 的關係：一個字都不碰它，只借 tracker.totals().seconds 當分母
// （app.mjs 負責把這個秒數傳進來）。跟 ratebuffer.mjs 不共用——藥水 10 秒才有
// 一筆，這裡自己留一條 deque。

import { loadPotions as loadPotionsFromStorage, savePotions as savePotionsToStorage } from "./storage.mjs";

/** 10 秒內數量掉超過這麼多瓶就當 OCR 讀壞（potions.py:43）。 */
export const DEFAULT_MAX_DELTA_PER_SAMPLE = 60;
/** 滾動視窗 deque 上限，跟 tracker.mjs 的 RECENT_MAXLEN 同一個數字（potions.py:46）。 */
export const RECENT_MAXLEN = 128;
/** 藥水補的是哪一條（potions.py:48）。 */
export const VALID_KINDS = ["hp", "mp"];

/** 桌面版 potions.example.json 的預設兩筆（規劃時沒查證經典版實際價格，都標「待核對」）。 */
const DEFAULT_CATALOG = [
  { name: "紅水", kind: "hp", price: 320, note: "待核對" },
  { name: "藍水", kind: "mp", price: 200, note: "待核對" },
];

function cleanEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = raw.name;
  if (typeof name !== "string" || !name.trim()) return null;
  let kind = raw.kind;
  if (!VALID_KINDS.includes(kind)) kind = "hp";
  const price = Number(raw.price);
  if (!Number.isFinite(price) || price < 0) return null;
  return { ...raw, name: name.trim(), kind, price: Math.trunc(price) };
}

/**
 * 藥水種類 -> 單價（楓幣）。存在 localStorage `kc:potions`（桌面版是
 * `data/potions.json`）。缺資料／壞資料一律當成 DEFAULT_CATALOG，不炸掉
 * （potions.py PotionCatalog.load() 缺檔複製 example 的網頁版翻譯）。
 */
export class PotionCatalog {
  /** @param {object[]} [entries] */
  constructor(entries = null) {
    this._entries = (entries || []).map(cleanEntry).filter(Boolean);
  }

  /** 從 localStorage 讀（第一次沒資料時用內建預設值，逐字對照桌面版兩筆）。 */
  static load() {
    const raw = loadPotionsFromStorage();
    if (!Array.isArray(raw) || raw.length === 0) {
      return new PotionCatalog(DEFAULT_CATALOG);
    }
    return new PotionCatalog(raw);
  }

  /** 寫回 localStorage。 */
  save() {
    savePotionsToStorage(this._entries);
  }

  /** @param {"hp"|"mp"|null} [kind] @returns {object[]} 副本 */
  list(kind = null) {
    const items = this._entries.map((e) => ({ ...e }));
    return kind === null || kind === undefined ? items : items.filter((e) => e.kind === kind);
  }

  /** @param {"hp"|"mp"|null} [kind] */
  names(kind = null) {
    return this.list(kind).map((e) => e.name);
  }

  /** @param {string|null} name @returns {number|null} */
  price(name) {
    if (!name) return null;
    const found = this._entries.find((e) => e.name === name);
    return found ? found.price : null;
  }

  /** @param {string|null} name @returns {"hp"|"mp"|null} */
  kind(name) {
    if (!name) return null;
    const found = this._entries.find((e) => e.name === name);
    return found ? found.kind : null;
  }

  /**
   * 新增或改價。**不落地**，呼叫端要自己 save()（逐字對照 potions.py
   * upsert()：kind 省略時，已存在的名字沿用原本的 kind，新名字當 hp）。
   * @param {string} name
   * @param {number} price
   * @param {"hp"|"mp"|null} [kind]
   * @returns {object}
   */
  upsert(name, price, kind = null) {
    name = (name || "").trim();
    if (!name) throw new Error("藥水名稱不能是空的");
    price = Math.trunc(Number(price));
    if (!Number.isFinite(price) || price < 0) throw new Error("單價不能是負的");
    const found = this._entries.find((e) => e.name === name);
    if (found) {
      found.price = price;
      if (VALID_KINDS.includes(kind)) found.kind = kind;
      return { ...found };
    }
    const entry = { name, kind: VALID_KINDS.includes(kind) ? kind : "hp", price };
    this._entries.push(entry);
    return { ...entry };
  }

  /** @param {string} name */
  remove(name) {
    this._entries = this._entries.filter((e) => e.name !== name);
  }
}

// ---------------------------------------------------------------------------
// 消耗統計（逐字對照 potions.py PotionTracker）

export class PotionTracker {
  /**
   * @param {number} [maxDeltaPerSample]
   * @param {number} [maxlen]
   */
  constructor(maxDeltaPerSample = DEFAULT_MAX_DELTA_PER_SAMPLE, maxlen = RECENT_MAXLEN) {
    this.maxDeltaPerSample = Number(maxDeltaPerSample);
    this.hpUsed = 0;
    this.mpUsed = 0;
    this._prev = { hp: null, mp: null };
    this._maxlen = maxlen;
    /** @type {[number, number, number][]} [seconds, hpCum, mpCum] */
    this._recent = [];
  }

  /** 忘掉「上次剩幾瓶」。累計量不歸零（potions.py reset_baseline()）。 */
  resetBaseline() {
    this._prev = { hp: null, mp: null };
  }

  /**
   * 餵進一筆 10 秒取樣。`seconds` 是這一刻 tracker.totals().seconds（有效秒數軸，
   * 呼叫端負責傳進來——這支模組不 import tracker.mjs，見檔頭）。
   * @param {number} ts
   * @param {number|null} hpCount
   * @param {number|null} mpCount
   * @param {number} [seconds]
   * @returns {{hpUsed:number, mpUsed:number, note:string}}
   */
  feed(ts, hpCount, mpCount, seconds = 0.0) {
    const notes = [];
    const hpUsed = this._feedOne("hp", hpCount, "血水", notes);
    const mpUsed = this._feedOne("mp", mpCount, "藍水", notes);
    this.hpUsed += hpUsed;
    this.mpUsed += mpUsed;
    this._recent.push([Number(seconds), this.hpUsed, this.mpUsed]);
    if (this._recent.length > this._maxlen) this._recent.shift();
    return { hpUsed, mpUsed, note: notes.join("；") };
  }

  _feedOne(key, now, label, notes) {
    if (now === null || now === undefined) {
      notes.push(label + "讀不到，跳過（基準不動）");
      return 0;
    }
    now = Number(now);
    const prev = this._prev[key];
    this._prev[key] = now;
    if (prev === null || prev === undefined) {
      notes.push(label + "設定基準 " + now);
      return 0;
    }
    const delta = prev - now;
    if (delta < 0) {
      notes.push(label + "數量變多（" + prev + "→" + now + "），當補貨重設基準");
      return 0;
    }
    if (delta > this.maxDeltaPerSample) {
      notes.push(label + "一次少 " + delta + " 瓶（超過 " + this.maxDeltaPerSample + "），當 OCR 讀壞丟棄");
      return 0;
    }
    return delta;
  }

  // ---------- 算錢 ----------

  /** @param {number} hpPrice @param {number} mpPrice @returns {number} */
  cost(hpPrice, mpPrice) {
    return this.hpUsed * hpPrice + this.mpUsed * mpPrice;
  }

  /**
   * 每小時藥水費。`seconds` <= 0 回 null（不是 0）。
   * @param {number|null} seconds
   * @param {number} hpPrice
   * @param {number} mpPrice
   * @returns {number|null}
   */
  costPerHour(seconds, hpPrice, mpPrice) {
    if (!seconds || seconds <= 0) return null;
    return (this.cost(hpPrice, mpPrice) / seconds) * 3600;
  }

  _windowBounds(windowSec) {
    if (this._recent.length < 2) return null;
    const latest = this._recent[this._recent.length - 1];
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
   * 近 windowSec 秒的 [花費, 血水瓶數, 藍水瓶數]。資料不足回 null。
   * **先算速率再乘視窗**，不可以把頭尾相減（CLAUDE.md 鐵則）。
   * @param {number} windowSec
   * @param {number} hpPrice
   * @param {number} mpPrice
   * @returns {[number, number, number]|null}
   */
  inWindow(windowSec, hpPrice, mpPrice) {
    const bounds = this._windowBounds(windowSec);
    if (bounds === null) return null;
    const [latest, start] = bounds;
    const span = latest[0] - start[0];
    const hp = ((latest[1] - start[1]) / span) * windowSec;
    const mp = ((latest[2] - start[2]) / span) * windowSec;
    return [hp * hpPrice + mp * mpPrice, hp, mp];
  }

  /** 寫進歷史紀錄用的原始總量（不是每小時值）。 */
  asDict(hpPrice = 0, mpPrice = 0) {
    return { hp_used: this.hpUsed, mp_used: this.mpUsed, cost: this.cost(hpPrice, mpPrice) };
  }
}

// ---------------------------------------------------------------------------
// 快捷欄格子（逐字對照 exp-tracker/src/calibration_ui.py：slot_box／count_region_for_slot）

export const SLOT_COLS = 4;
export const SLOT_ROWS = 2;
export const SLOT_COUNT = SLOT_COLS * SLOT_ROWS;
/** 八格在遊戲畫面上的按鍵名（左上到右下）。 */
export const SLOT_KEY_NAMES = ["Shift", "Ins", "Hm", "Pup", "Ctrl", "Del", "End", "Pdn"];
export const SLOT_UNSET_LABEL = "未設定";

/** 數量框左右各多留這麼寬、高度固定這麼高（實機調過，見 CLAUDE.md「藥水數量框的兩個坑」）。 */
export const COUNT_BOX_HEIGHT = 13;
export const COUNT_BOX_PAD_X = 1;

/**
 * 快捷欄第 `index` 格（0~7）的框，等分 `panel_region` 算出來（逐字對照
 * calibration_ui.py slot_box()）。編號規則：左上角是 0，先左到右、再換下一排。
 * `panel` 指「八個格子的範圍」，不含面板本身的裝飾外框。
 * @param {{left:number, top:number, width:number, height:number, anchor?:string}} panel
 * @param {number} index
 */
export function slotBox(panel, index) {
  const col = index % SLOT_COLS;
  const row = Math.floor(index / SLOT_COLS);
  const cellW = panel.width / SLOT_COLS;
  const cellH = panel.height / SLOT_ROWS;
  const left = Math.trunc(panel.left + col * cellW);
  const right = Math.trunc(panel.left + (col + 1) * cellW);
  const top = Math.trunc(panel.top + row * cellH);
  const bottom = Math.trunc(panel.top + (row + 1) * cellH);
  return { left, top, width: right - left, height: bottom - top, anchor: panel.anchor || "top-left" };
}

/**
 * 第 `index` 格的「數量」框：格子底部 COUNT_BOX_HEIGHT 高、左右各多
 * COUNT_BOX_PAD_X（逐字對照 calibration_ui.py count_region_for_slot()）。
 * 這是起始公式，校準頁可以用方向鍵微調。
 * @param {{left:number, top:number, width:number, height:number, anchor?:string}} panel
 * @param {number} index
 */
export function countRegionForSlot(panel, index) {
  const box = slotBox(panel, index);
  return {
    left: box.left - COUNT_BOX_PAD_X,
    top: box.top + box.height - COUNT_BOX_HEIGHT,
    width: box.width + COUNT_BOX_PAD_X * 2,
    height: COUNT_BOX_HEIGHT,
    anchor: box.anchor,
  };
}

// ---------------------------------------------------------------------------
// 顯示格式（逐字對照桌面版 app.py 的 "{:,.0f} [HP:{:.0f}/MP:{:.0f}]" 與
// storage.py _fmt_potion_cell()）

function formatInt(n) {
  return Math.round(n).toLocaleString("zh-TW");
}

/**
 * 精簡窗「水錢」那行的格式：`"1,234 [HP:12/MP:34]"`；資料不足回
 * `"— [HP:—/MP:—]"`（逐字對照 app.py:219-222）。
 * @param {[number, number, number]|null} inWindowResult PotionTracker.inWindow() 的回傳值
 */
export function formatPotionRow(inWindowResult) {
  if (!inWindowResult) return "— [HP:—/MP:—]";
  const [cost, hp, mp] = inWindowResult;
  return formatInt(cost) + " [HP:" + formatInt(hp) + "/MP:" + formatInt(mp) + "]";
}

/**
 * 排行榜「藥水費/hr」「藥水費/10min」欄格式（逐字對照 storage.py
 * `_fmt_potion_cell()`）：`seconds <= 0`，或 hp/mp/cost 全是 0，顯示 `"—"`；
 * 否則 `factor = window / seconds` 套在這一列存的原始總量上。
 * @param {number} hpUsed
 * @param {number} mpUsed
 * @param {number} cost
 * @param {number} seconds
 * @param {number} windowSec
 */
export function formatPotionCell(hpUsed, mpUsed, cost, seconds, windowSec) {
  if (!(seconds > 0) || (hpUsed === 0 && mpUsed === 0 && cost === 0)) return "—";
  const factor = windowSec / seconds;
  return formatInt(cost * factor) + " [HP:" + formatInt(hpUsed * factor) + "/MP:" + formatInt(mpUsed * factor) + "]";
}

// 翻 exp-tracker/src/exptable.py（0071 工單任務 1）。
//
// 經驗值表：每一級升到下一級需要多少經驗。有了這張表就不必再靠
// 「經驗值 ÷ 百分比」去猜本級總經驗，升級時的補算也會是精確值。
//
// 資料來源：`data/exp_table.json`（0070 已由 `tools/build_data.py` 轉出，
// `[[level, exp_to_next], ...]`，199 列，來源同 Python 端）。跟 mapdb.mjs
// 同一種瀏覽器限制：讀檔是 fetch，非同步——呼叫端要先 `await loadTable()`
// 一次才有資料（Python 版是同步 `ExpTable.load()`）。

export const MAX_LEVEL = 200;
export const DEFAULT_TABLE_URL = "./data/exp_table.json";

export class ExpTable {
  /** @param {Map<number, number>|Object<string,number>} rows level -> exp_to_next */
  constructor(rows) {
    this.rows = rows instanceof Map ? rows : new Map(Object.entries(rows).map(([k, v]) => [Number(k), v]));
  }

  /**
   * 該等級升到下一級所需的經驗值。滿等或查不到時回傳 null
   * （逐字對照 exptable.py:45-49）。
   * @param {number|null} level
   * @returns {number|null}
   */
  expToNext(level) {
    if (level === null || level === undefined) return null;
    return this.rows.has(level) ? this.rows.get(level) : null;
  }

  /**
   * 用「目前經驗值」與「百分比」反推現在幾級（逐字對照 exptable.py:51-83）。
   * @param {number} exp
   * @param {number} percent
   * @param {number} [tolerance]
   * @param {number} [minPercent]
   * @returns {number|null}
   */
  guessLevel(exp, percent, tolerance = 0.025, minPercent = 0.05) {
    if (!exp || !percent || percent <= 0) return null;
    if (percent < minPercent) return null;

    const estimate = (exp / percent) * 100;
    let bestLevel = null;
    let bestError = null;
    for (const [level, need] of this.rows) {
      const error = Math.abs(need - estimate) / need;
      if (bestError === null || error < bestError) {
        bestLevel = level;
        bestError = error;
      }
    }

    if (bestError !== null && bestError <= tolerance) return bestLevel;
    return null;
  }
}

/** @type {ExpTable|null} */
let tableCache = null;
/** @type {Promise<ExpTable|null>|null} */
let loadPromise = null;
let cachedUrl = null;

/**
 * 讀取經驗值表（比照 Python `ExpTable.load()`，差別是非同步 fetch）。
 * 檔案不在或格式壞掉時回傳 null（呼叫端退回用百分比推估）。
 * @param {string} [url]
 * @returns {Promise<ExpTable|null>}
 */
export async function loadTable(url = DEFAULT_TABLE_URL) {
  if (tableCache !== null && cachedUrl === url) return tableCache;
  if (!loadPromise || cachedUrl !== url) {
    cachedUrl = url;
    loadPromise = fetch(url)
      .then((resp) => (resp.ok ? resp.json() : null))
      .then((rows) => {
        if (!Array.isArray(rows) || rows.length === 0) return null;
        const map = new Map();
        for (const row of rows) {
          if (!Array.isArray(row) || row.length !== 2) continue;
          map.set(Number(row[0]), Number(row[1]));
        }
        return map.size ? new ExpTable(map) : null;
      })
      .catch(() => null);
  }
  tableCache = await loadPromise;
  return tableCache;
}

/** 測試用：清掉快取。 */
export function resetCache() {
  tableCache = null;
  loadPromise = null;
  cachedUrl = null;
}

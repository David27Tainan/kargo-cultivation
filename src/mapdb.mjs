// 翻 exp-tracker/src/mapdb.py（0071 工單任務 1）。
//
// 地圖總表比對：給一個 OCR 讀值，回最像的正式地圖名稱。跟 Python 版最大的
// 差異是資料來源——Python 直接同步讀 `data/地圖名稱.csv`；瀏覽器只能用
// `fetch()` 非同步抓 `data/maps.json`（`tools/build_data.py` 轉出來的候選
// 字串陣列，**只放字串，不放地圖 ID**，見 0071 前提澄清 (4)）。
//
// **這支模組因此多了一個 Python 沒有的非同步初始化步驟**：呼叫端（app.mjs）
// 要在建立任何 `MapNameStabilizer`／`ExpTracker` 之前先 `await loadNames()`
// 一次，之後 `bestMatch()`／`available()` 才讀得到真的候選清單。這是瀏覽器
// 環境的限制（fetch 天生非同步），不是邏輯上的偏離——比對規則、門檻、優先序
// 一個字沒改（見「裁定與偏離」，0071-回報.md）。
//
// 比對規則沿用 parsing.MapNameStabilizer._same_map 的精神：
//   1. parsing.mapNumbers() 必須完全相同
//   2. 其餘部分用 difflib.mjs 的 ratio() 取最高分的那一個
//   3. 分數低於門檻（預設 0.6，MATCH_THRESHOLD，不要調低——0032 號工單實測
//      672 個候選對全部歷史讀值，沒有任何一筆錯誤配對超過 0.6）就不採用，
//      回傳 null

import { mapNumbers } from "./parsing.mjs";
import { fold } from "./zhfold.mjs";
import { ratio } from "./difflib.mjs";

export const MATCH_THRESHOLD = 0.6;
export const DEFAULT_MAPS_URL = "./data/maps.json";

/** @type {string[]|null} */
let namesCache = null;
/** @type {Promise<string[]>|null} */
let loadPromise = null;
let cachedUrl = null;

/**
 * 讀地圖總表，回傳去重後的候選名稱陣列（"區域 地圖名稱"，已 normalizeRoman()）。
 * 第一次呼叫會發一次 `fetch()`，之後都吃快取（比照 Python `load_names()` 的
 * 模組層級快取設計）。fetch 失敗（缺檔／網路問題／格式不對）回空陣列，
 * 不會丟例外（呼叫端可以放心當「沒有總表可查」處理）。
 * @param {string} [url]
 * @returns {Promise<string[]>}
 */
export async function loadNames(url = DEFAULT_MAPS_URL) {
  if (namesCache !== null && cachedUrl === url) return namesCache;
  if (!loadPromise || cachedUrl !== url) {
    cachedUrl = url;
    loadPromise = fetch(url)
      .then((resp) => (resp.ok ? resp.json() : []))
      .then((data) => (Array.isArray(data) ? data : []))
      .catch(() => []);
  }
  namesCache = await loadPromise;
  return namesCache;
}

/**
 * 測試用：清掉快取，強制下次 loadNames() 重新 fetch（比照 Python
 * `reset_cache()`）。
 */
export function resetCache() {
  namesCache = null;
  loadPromise = null;
  cachedUrl = null;
}

/**
 * 已經快取的候選清單，同步讀取（沒 load 過就是空陣列）。
 * `MapNameStabilizer` 的預設值、`bestMatch()`/`available()` 沒有傳
 * `names` 參數時都讀這裡——呼叫端要記得先 `await loadNames()` 過一次。
 * @returns {string[]}
 */
export function namesSync() {
  return namesCache || [];
}

/**
 * 地圖總表在不在、讀不讀得到東西（比照 Python `available()`）。
 * @param {string[]|null} [names] 不傳就用 namesSync() 的快取
 * @returns {boolean}
 */
export function available(names = null) {
  const list = names !== null ? names : namesSync();
  return list.length > 0;
}

/**
 * 給一個 OCR 讀值，回地圖總表裡最像的正式名稱；比不上門檻或總表不在就回 null。
 * 逐字對照 Python `best_match()`：先過濾掉編號（mapNumbers）不同的候選，
 * 再挑 `ratio(fold(raw), fold(candidate))` 最高分的那個。
 * @param {string} raw
 * @param {string[]|null} [names] 不傳就用 namesSync() 的快取（正式流程走這條）
 * @param {number} [threshold]
 * @returns {string|null}
 */
export function bestMatch(raw, names = null, threshold = MATCH_THRESHOLD) {
  if (!raw) return null;
  const list = names !== null ? names : namesSync();
  if (!list.length) return null;

  const rawNumbers = mapNumbers(raw);
  const rawFolded = fold(raw);
  let best = null;
  let bestScore = 0.0;
  for (const candidate of list) {
    if (!sameNumbers(mapNumbers(candidate), rawNumbers)) continue;
    const score = ratio(rawFolded, fold(candidate));
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best !== null && bestScore >= threshold ? best : null;
}

function sameNumbers(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

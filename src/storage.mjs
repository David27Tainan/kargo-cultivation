// 翻 exp-tracker/src/storage.py 的資料部分（0071 工單任務 1／5）。
//
// 跟 Python 版最大的差異：Python 寫本機 CSV 檔（`歷史紀錄.csv`），瀏覽器版
// 沒有檔案系統，紀錄改存 localStorage（key 前綴 `kc:`，計畫書 §10）。
// **欄位形狀、分攤規則、CSV 匯出/匯入的欄位數規則（8／11／14 欄）完全照抄
// storage.py**，只是「存起來」這件事從寫檔改成 `localStorage.setItem()`。
//
// CSV 匯出/匯入是給使用者跟桌面版 `歷史紀錄.csv` 互通用的（計畫書 §9.2），
// 不是內部儲存格式——localStorage 裡存的是 JSON 陣列，物件欄位同
// `HISTORY_FIELDS`。

// ---------------------------------------------------------------------------
// 欄位形狀（逐字對照 storage.py:38-63）

export const HISTORY_HEADER = [
  "紀錄編號", "地圖", "開始時間", "結束時間", "經驗值", "百分比", "秒數", "取樣數",
  "血水消耗", "藍水消耗", "藥水費", "楓幣淨賺", "楓幣秒數", "楓幣樣本數",
];
export const HISTORY_FIELDS = [
  "id", "map", "started_at", "ended_at", "exp", "percent", "seconds", "samples",
  "hp_used", "mp_used", "potion_cost", "meso_gain", "meso_span_sec", "meso_samples",
];
// 0055 之前的欄位數。少於這個是壞掉的列，介於兩者之間是舊格式，補 0。
export const HISTORY_FIELDS_BEFORE_0055 = 8;
// 0055～0063 的欄位數（血水／藍水／藥水費三欄，還沒有楓幣）。
export const HISTORY_FIELDS_BEFORE_0064 = 11;

const FIELD_DEFAULTS = {
  id: "", map: "", started_at: "", ended_at: "",
  exp: 0, percent: 0.0, seconds: 0.0, samples: 0,
  hp_used: 0, mp_used: 0, potion_cost: 0,
  meso_gain: 0, meso_span_sec: 0.0, meso_samples: 0,
};

// ---------------------------------------------------------------------------
// localStorage key（計畫書 §10）

export const KEY_HISTORY = "kc:history";
export const KEY_SETTINGS = "kc:settings";
export const KEY_UI = "kc:ui";
// 0072 工單（W3）新增：校準頁存的六塊區域＋藥水快捷欄指定、藥水種類與單價表
// （計畫書 §10：`kc:calibration` / `kc:potions`）。
export const KEY_CALIBRATION = "kc:calibration";
export const KEY_POTIONS = "kc:potions";
// 0080 工單（W4.3）：校準頁「存成範例」存的六張圖（dataURL，物件 {key: dataUrl}）。
// 桌面版存的是檔案（`data/calib_examples/*.png`），網頁版沒有檔案系統，改存
// localStorage；沒存過的 key 由呼叫端退回 `assets/calib_examples/<file>.png`
// （桌面版同一批範例圖，工單前提「開始前」允許複製這幾張 PNG 進 repo）。
export const KEY_EXAMPLES = "kc:examples";

// 0076 工單（W4）前提澄清 (4)：提案人實機驗收後裁定藥水／楓幣預設打開。
// 只改這兩個預設值——loadSettings() 是 `{ ...DEFAULT_SETTINGS, ...raw }`，
// key 已經存在 localStorage 的舊訪客讀到的是自己存過的值，不受這次改動影響。
const DEFAULT_SETTINGS = {
  fastIntervalMs: 250,
  potionsEnabled: true,
  mesoEnabled: true,
  rateMode: "hour", // "hour" | "recent"（同桌面版 ui_state.json 的 rate_mode）
};
const DEFAULT_UI = {
  tab: "main",
  healthVisible: true,
  // 0078 工單任務 1：預設改回 1（0077 版預設 2，提案人實機試用後回饋「畫面太大
  // 縮回原本大小」；1x 就是跟桌面版逐像素一樣，設定頁仍可選 1/2/3）。
  zoom: 1,
  // 0078 工單任務 1：已經存過舊版預設值 2 的訪客，版本升級時要一次性把 zoom
  // 重設回 1，之後尊重使用者自己在設定頁選的值——用這個旗標防止每次讀取都重設
  // （見 loadUi() 的遷移邏輯）。全新訪客沒有舊資料可遷移，直接視為已完成。
  zoomMigrated121: true,
};

/**
 * localStorage 讀不讀得到（0071 任務 5：儲存不可用時要提示）。
 * 每次呼叫都真的試寫一個探測 key 再刪掉——localStorage 存在但被瀏覽器政策
 * 擋住（例如某些隱私模式）時，`typeof localStorage` 檢查不出來，一定要
 * 真的 try/catch 一次讀寫。
 * @returns {boolean}
 */
export function isStorageAvailable() {
  try {
    const probeKey = "kc:__probe__";
    localStorage.setItem(probeKey, "1");
    localStorage.removeItem(probeKey);
    return true;
  } catch {
    return false;
  }
}

function safeGetJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function safeSetJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 歷史紀錄

/**
 * 讀出全部歷史紀錄（比照 Python `load_records()`，來源是 localStorage 不是
 * CSV 檔）。讀不到或壞掉一律回 `[]`，不崩潰；陣列裡型別不對的項目會被跳過。
 * @returns {object[]}
 */
export function loadHistory() {
  const raw = safeGetJson(KEY_HISTORY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((r) => r && typeof r === "object" && typeof r.map === "string" && r.map);
}

/**
 * 覆寫整份歷史紀錄。
 * @param {object[]} records
 * @returns {boolean} 寫入是否成功
 */
export function saveHistory(records) {
  return safeSetJson(KEY_HISTORY, records);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Python `datetime.isoformat(timespec="seconds")` 的 JS 版（本機時間，不是 UTC）。 */
function isoSeconds(date) {
  return (
    date.getFullYear() +
    "-" + pad2(date.getMonth() + 1) +
    "-" + pad2(date.getDate()) +
    "T" + pad2(date.getHours()) +
    ":" + pad2(date.getMinutes()) +
    ":" + pad2(date.getSeconds())
  );
}

// Python round(x, n) 對照：**不能**用 `Math.round(x * 10**n) / 10**n`——
// 乘法本身會先吃一次浮點誤差，實測 `Math.round(590.55*10)/10` = 590.6，
// 但 Python `round(590.55, 1)` = 590.5（590.55 的真正雙精度值其實略小於
// 590.55，Python 的 round() 是對「這個值本身」做正確捨入；先乘後除會把
// 590.549999999999954… 在乘法時意外進位回 5905.5，資訊已經丟了）。
// `Number.toFixed(n)` 是依 ECMA 規格對「x 的精確數學值」找最接近的 n 位
// 小數字串，這一步不會像先乘後除那樣被乘法本身的捨入誤差污染，結果才
// 跟 Python 的 round() 對得上（唯一差異是精確落在 .5 邊界時的偶進位規則，
// 這種輸入來自 OCR 讀值的連續運算，實務上幾乎不會發生，不特別處理）。
function roundTo(x, digits) {
  return Number(x.toFixed(digits));
}
function round1(x) {
  return roundTo(x, 1);
}
function round2(x) {
  return roundTo(x, 2);
}
function round4(x) {
  return roundTo(x, 4);
}

/** 產生跟 Python `uuid4().hex[:6]`同構的 6 碼十六進位亂數字串。 */
function randomHex6() {
  const bytes = new Uint8Array(3);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function makeRecordId(now) {
  const stamp =
    now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate()) +
    "_" + pad2(now.getHours()) + pad2(now.getMinutes()) + pad2(now.getSeconds());
  return stamp + "-" + randomHex6();
}

/**
 * 把這一場的成績存進歷史。**每張地圖都是新的一筆**，不跟舊紀錄合併
 * （逐字對照 storage.py `append_session()`）。
 *
 * `potion`／`meso` 這張單一律傳 `null`（0071 前提澄清 (5)：藥水／楓幣是
 * 0072 才有資料的欄位，這裡永遠按分攤規則寫 0，不是真的沒有分攤邏輯）。
 * @param {Map<string, import('./tracker.mjs').MapStat>} sessionMaps
 * @param {Date|null} [startedAt]
 * @param {{hp_used?:number, mp_used?:number, cost?:number}|null} [potion]
 * @param {{gain?:number, span_sec?:number, samples?:number}|null} [meso]
 * @param {Date} [now] 測試用，注入固定時間
 * @returns {object[]} 寫入後的完整紀錄陣列
 */
export function appendSession(sessionMaps, startedAt = null, potion = null, meso = null, now = new Date()) {
  if (!sessionMaps || sessionMaps.size === 0) return loadHistory();

  const start = startedAt || now;
  const kept = [...sessionMaps.entries()].filter(([, stat]) => !(stat.seconds <= 0 && stat.exp <= 0));
  const totalSeconds = kept.reduce((sum, [, stat]) => sum + stat.seconds, 0);

  const records = loadHistory();
  for (const [name, stat] of kept) {
    const share = totalSeconds > 0 ? stat.seconds / totalSeconds : 0.0;
    records.push({
      id: makeRecordId(now),
      map: name,
      started_at: isoSeconds(start),
      ended_at: isoSeconds(now),
      exp: stat.exp,
      percent: round4(stat.percent),
      seconds: round1(stat.seconds),
      samples: stat.samples,
      hp_used: Math.round((potion?.hp_used ?? 0) * share),
      mp_used: Math.round((potion?.mp_used ?? 0) * share),
      potion_cost: round2((potion?.cost ?? 0) * share),
      meso_gain: Math.round((meso?.gain ?? 0) * share),
      meso_span_sec: round1((meso?.span_sec ?? 0.0) * share),
      meso_samples: Math.round((meso?.samples ?? 0) * share),
    });
  }
  saveHistory(records);
  return records;
}

/**
 * 刪掉指定的歷史紀錄。
 * @param {string[]} ids
 * @returns {object[]}
 */
export function deleteRecords(ids) {
  const idSet = new Set(ids);
  const keep = loadHistory().filter((r) => !idSet.has(r.id));
  saveHistory(keep);
  return keep;
}

/** 清掉全部歷史紀錄（key 還在，只是變成空陣列——localStorage 沒有「檔案留著」這種概念，語意上等價）。 */
export function clearHistory() {
  saveHistory([]);
  return [];
}

// ---------------------------------------------------------------------------
// CSV 匯出／匯入（計畫書 §9.2）

function csvField(value) {
  const s = String(value);
  if (/["\r\n,]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function csvRow(fields) {
  return fields.map(csvField).join(",") + "\r\n";
}

/**
 * 匯出 CSV 內容（UTF-8 **含 BOM**、14 欄，表頭同 HISTORY_HEADER）。
 * @param {object[]} records
 * @returns {string}
 */
export function exportCsv(records) {
  let out = "﻿" + csvRow(HISTORY_HEADER);
  for (const r of records) {
    out += csvRow(
      HISTORY_FIELDS.map((f) => (r[f] !== undefined && r[f] !== null ? r[f] : FIELD_DEFAULTS[f]))
    );
  }
  return out;
}

/**
 * 匯出檔名：`魔龍修仙-紀錄-YYYYMMDD.csv`（計畫書 §9.2）。
 * @param {Date} [date]
 * @returns {string}
 */
export function exportFilename(date = new Date()) {
  return "魔龍修仙-紀錄-" + date.getFullYear() + pad2(date.getMonth() + 1) + pad2(date.getDate()) + ".csv";
}

function intOrZero(v) {
  if (v === "" || v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}
function floatOrZero(v) {
  if (v === "" || v === null || v === undefined) return 0.0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0.0;
}
function parseIntStrict(v) {
  if (v === "" || v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!/^[+-]?\d+$/.test(s)) return null;
  return parseInt(s, 10);
}
function parseFloatStrict(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * 一列 CSV（字串陣列，不含表頭）-> 一筆 record，欄位數不對或數字轉不動就
 * 回 null（逐字對照 storage.py `_parse_history_row()`）。**只認「剛好 8／
 * 11／14 欄」三種**，不是「>= 8 就收」。
 * @param {string[]} row
 * @returns {object|null}
 */
export function parseHistoryRow(row) {
  if (![HISTORY_FIELDS_BEFORE_0055, HISTORY_FIELDS_BEFORE_0064, HISTORY_FIELDS.length].includes(row.length)) {
    return null;
  }
  const padded = row.concat(new Array(Math.max(0, HISTORY_FIELDS.length - row.length)).fill(""));
  const raw = {};
  HISTORY_FIELDS.forEach((f, i) => {
    raw[f] = padded[i];
  });
  if (!raw.map) return null;

  const exp = parseIntStrict(raw.exp);
  const percent = parseFloatStrict(raw.percent);
  const seconds = parseFloatStrict(raw.seconds);
  const samples = parseIntStrict(raw.samples);
  if (exp === null || percent === null || seconds === null || samples === null) return null;

  return {
    id: raw.id,
    map: raw.map,
    started_at: raw.started_at,
    ended_at: raw.ended_at,
    exp,
    percent,
    seconds,
    samples,
    hp_used: intOrZero(raw.hp_used),
    mp_used: intOrZero(raw.mp_used),
    potion_cost: floatOrZero(raw.potion_cost),
    meso_gain: intOrZero(raw.meso_gain),
    meso_span_sec: floatOrZero(raw.meso_span_sec),
    meso_samples: intOrZero(raw.meso_samples),
  };
}

/**
 * 最小 CSV 解析（處理雙引號包住的欄位、欄位內的逗號/換行、`""` 轉義），
 * 不假設一定沒有引號——桌面版匯出的 `歷史紀錄.csv` 地圖名不含逗號，但
 * 使用者可能拿別的 CSV 來匯入，寧可多做一點防禦。回傳去掉 BOM 的整份
 * 二維陣列（含表頭那一列）。
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsvText(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r") {
      // 跳過，交給 \n 收尾（相容 \r\n／\n 兩種換行）
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * 匯入 CSV：吃 8／11／14 欄（表頭那一列丟掉，不靠表頭文字反查，跟
 * Python `load_records()` 一致）。壞掉的列跳過，不會讓整份被當成空的。
 * @param {string} text
 * @returns {object[]}
 */
export function importCsv(text) {
  const rows = parseCsvText(text);
  if (rows.length === 0) return [];
  const records = [];
  for (const row of rows.slice(1)) {
    if (row.length === 1 && row[0] === "") continue; // 尾端空行
    const rec = parseHistoryRow(row);
    if (rec !== null) records.push(rec);
  }
  return records;
}

// ---------------------------------------------------------------------------
// 設定／UI 狀態（計畫書 §10，這張單只做 kc:history／kc:settings／kc:ui；
// kc:calibration／kc:potions 是 0072 校準頁／藥水頁的事）

/** @returns {typeof DEFAULT_SETTINGS} */
export function loadSettings() {
  const raw = safeGetJson(KEY_SETTINGS, null);
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...raw };
}

/** @param {Partial<typeof DEFAULT_SETTINGS>} settings */
export function saveSettings(settings) {
  return safeSetJson(KEY_SETTINGS, { ...loadSettings(), ...settings });
}

/** @returns {typeof DEFAULT_UI} */
export function loadUi() {
  const raw = safeGetJson(KEY_UI, null);
  if (!raw || typeof raw !== "object") return { ...DEFAULT_UI };
  const merged = { ...DEFAULT_UI, ...raw };
  // 0078 工單任務 1：舊訪客（`raw` 存在但沒有 `zoomMigrated121` 旗標）一次性把
  // zoom 重設回 1，並直接寫回 storage 蓋掉舊值，不透過 saveUi()（saveUi() 內部
  // 會再呼叫一次 loadUi()，這裡直接呼叫還會遞迴）。之後這個旗標會一直是
  // true，不會再被這段邏輯動到。
  if (!raw.zoomMigrated121) {
    merged.zoom = 1;
    merged.zoomMigrated121 = true;
    safeSetJson(KEY_UI, merged);
  }
  return merged;
}

/** @param {Partial<typeof DEFAULT_UI>} ui */
export function saveUi(ui) {
  return safeSetJson(KEY_UI, { ...loadUi(), ...ui });
}

// ---------------------------------------------------------------------------
// 校準（0072 工單，計畫書 §9.3／§10）：
//   { frameSize:{w,h}, regions:{exp,level,map,panel,hp,mp}, hpSlot, mpSlot }
// `regions` 的六個 key 跟計畫書 §10 一致，每塊是 {left,top,width,height,anchor}。
// 沒校準過就回 null，呼叫端自己決定要不要退回 regions.mjs 的 DEFAULTS。

/** @returns {object|null} */
export function loadCalibration() {
  const raw = safeGetJson(KEY_CALIBRATION, null);
  if (!raw || typeof raw !== "object" || !raw.regions) return null;
  return raw;
}

/** @param {object} calibration */
export function saveCalibration(calibration) {
  return safeSetJson(KEY_CALIBRATION, calibration);
}

/** 清掉校準（「重選遊戲視窗」／清除所有本機資料用）。 */
export function clearCalibration() {
  try {
    localStorage.removeItem(KEY_CALIBRATION);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 藥水種類與單價表（0072 工單，`kc:potions`，物件陣列，形狀見 potions.mjs）。

/** @returns {object[]} 讀不到或壞掉回 []（potions.mjs 的 PotionCatalog.load() 會補預設值）。 */
export function loadPotions() {
  const raw = safeGetJson(KEY_POTIONS, []);
  return Array.isArray(raw) ? raw : [];
}

/** @param {object[]} entries */
export function savePotions(entries) {
  return safeSetJson(KEY_POTIONS, entries);
}

/** 清掉全部本機資料（設定頁「清除所有本機資料」，計畫書 §9.4，頁內二次確認後呼叫）。 */
export function clearAllLocalData() {
  try {
    for (const key of [KEY_HISTORY, KEY_SETTINGS, KEY_UI, KEY_CALIBRATION, KEY_POTIONS, KEY_EXAMPLES]) {
      localStorage.removeItem(key);
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 校準頁「範例」欄（0080 工單，`kc:examples`）：{key: dataUrl}，key 是
// exp/map/level/panel/hp/mp 六個校準區域鍵，跟 `regions.CALIBRATION_BASE.regions`
// 一致。**只存使用者自己按「存成範例」存的那張**，沒存過的 key 不會出現在這個
// 物件裡——呼叫端（app.mjs `_calibExampleUrl()`）負責退回 `assets/calib_examples/`
// 那份桌面版預設圖，這裡不做退回邏輯（跟 `loadCalibration()` 回 `null` 讓呼叫端
// 決定要不要退回 `regions.DEFAULTS` 是同一種分工）。

/** @returns {Object<string,string>} */
export function loadExamples() {
  const raw = safeGetJson(KEY_EXAMPLES, {});
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

/** @param {string} key @param {string} dataUrl */
export function saveExample(key, dataUrl) {
  const all = loadExamples();
  all[key] = dataUrl;
  return safeSetJson(KEY_EXAMPLES, all);
}

// ---------------------------------------------------------------------------
// 排行榜資料組裝（計畫書 §9.2／0071 前提澄清 (5)）

/**
 * 秒數 -> `H:MM:SS`（跟桌面版精簡窗/排行榜同一種格式）。
 * @param {number|null} seconds
 * @returns {string}
 */
export function formatHms(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h + ":" + pad2(m) + ":" + pad2(s);
}

/** ISO `YYYY-MM-DDTHH:MM:SS` -> `MM-DD HH:MM`（排行榜「時間」欄格式）。 */
export function formatHistoryTime(isoStr) {
  if (!isoStr) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(isoStr);
  if (!m) return isoStr;
  return m[2] + "-" + m[3] + " " + m[4] + ":" + m[5];
}

/**
 * 組排行榜列：歷史紀錄 + 這一場還沒存檔的地圖（時間欄「本次」），依每小時
 * 經驗由高到低排序（逐字對照 storage.py/app.py `_refresh_table()` 的資料
 * 來源規則）。
 *
 * 0072 工單起，`potionRaw`／`mesoRaw` 帶原始總量（不是每小時值——顯示時才用
 * `potions.formatPotionCell()`／`mesos.formatMesoCell()` 換算，理由是這支模組
 * 不 import potions.mjs/mesos.mjs 避免循環相依，見兩支模組檔頭）：
 *   potionRaw = {hp, mp, cost} | null，mesoRaw = {gain, spanSec} | null。
 *   歷史紀錄一律有值（欄位存在，可能是 0）；這一場未存檔的地圖只有在呼叫端
 *   傳了 `sessionExtras` 時才依秒數比例分攤算出來，否則是 null（顯示「—」）。
 * @param {object[]} historyRecords
 * @param {Map<string, import('./tracker.mjs').MapStat>} [sessionMaps]
 * @param {{potion?:{hpUsed:number,mpUsed:number,cost:number}, meso?:{gain:number,spanSec:number}}|null} [sessionExtras]
 * @returns {Array<{id:string, map:string, timeLabel:string, expPerHour:number,
 *   expPer10Min:number, potionRaw:{hp:number,mp:number,cost:number}|null,
 *   mesoRaw:{gain:number,spanSec:number}|null, durationSec:number,
 *   samples:number, source:'history'|'session'}>}
 */
export function buildRankingRows(historyRecords, sessionMaps = new Map(), sessionExtras = null) {
  const rows = [];
  for (const r of historyRecords) {
    const expPerHour = r.seconds > 0 ? (r.exp / r.seconds) * 3600 : 0;
    const expPer10Min = r.seconds > 0 ? (r.exp / r.seconds) * 600 : 0;
    rows.push({
      id: r.id,
      map: r.map,
      timeLabel: formatHistoryTime(r.ended_at),
      expPerHour,
      expPer10Min,
      potionRaw: { hp: r.hp_used || 0, mp: r.mp_used || 0, cost: r.potion_cost || 0 },
      mesoRaw: { gain: r.meso_gain || 0, spanSec: r.meso_span_sec || 0 },
      durationSec: r.seconds,
      samples: r.samples,
      source: "history",
    });
  }

  const keptSession = [...sessionMaps.entries()].filter(([, stat]) => !(stat.seconds <= 0 && stat.exp <= 0));
  const totalSeconds = keptSession.reduce((sum, [, stat]) => sum + stat.seconds, 0);
  for (const [name, stat] of keptSession) {
    const share = totalSeconds > 0 ? stat.seconds / totalSeconds : 0.0;
    const potionRaw = sessionExtras && sessionExtras.potion
      ? {
          hp: sessionExtras.potion.hpUsed * share,
          mp: sessionExtras.potion.mpUsed * share,
          cost: sessionExtras.potion.cost * share,
        }
      : null;
    const mesoRaw = sessionExtras && sessionExtras.meso
      ? { gain: sessionExtras.meso.gain * share, spanSec: sessionExtras.meso.spanSec * share }
      : null;
    rows.push({
      id: null,
      map: name,
      timeLabel: "本次",
      expPerHour: stat.expPerHour,
      expPer10Min: stat.seconds > 0 ? (stat.exp / stat.seconds) * 600 : 0,
      potionRaw,
      mesoRaw,
      durationSec: stat.seconds,
      samples: stat.samples,
      source: "session",
    });
  }
  rows.sort((a, b) => b.expPerHour - a.expPerHour);
  return rows;
}

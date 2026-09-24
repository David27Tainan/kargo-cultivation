// 翻 exp-tracker/src/parsing.py。0070（W1）先翻了快／慢迴圈會用到的兩個函式：
// parseExpLine／parseLevel。0071 補完地圖名稱那一段：cleanMapName、
// normalizeRoman、mapSuffix、mapNumbers、hasUnreadableNumeral、mergeMapName、
// MapNameStabilizer、parseCount。
//
// 規則摘要見 kargo-cultivation/docs/規則摘要.md §3，逐字對照 Python 原始碼
// （行號以規劃當天的 parsing.py 為準），衝突以 Python 原始碼為準。
//
// 0071 前提澄清 (6)：網頁版地圖只用 ch（簡體）模型讀（cht 整顆拿掉，見
// CLAUDE.md／計畫書 §5.2），`mergeMapName(繁, 簡)` 翻譯時兩個參數都餵 ch 讀值
// （同一個字串），編號補正邏輯照舊——這支模組的函式簽章跟 Python 一模一樣，
// 呼叫端（tracker.mjs／app.mjs）決定要餵什麼進來，這裡不用為了「只有一顆
// 模型」改寫函式本身。

import { fold } from "./zhfold.mjs";
import { ratio } from "./difflib.mjs";
import { namesSync as mapdbNamesSync, bestMatch as mapdbBestMatch } from "./mapdb.mjs";

// 數字裡不可以放 \s——被切開的數字是靠 SPLIT_NUMBER_RE 先黏回去的，這裡再吃
// 一次空白，只會把「本來就該分開的兩個數字」黏成一個（parsing.py:16）。
const DIGITS_RE = /\d[\d,.]*\d|\d/g;

// 小數點會被 OCR 認成各種東西（冒號、分號、頓號…），這些字元也要放進來
// （parsing.py:19）。
const DECIMAL_LOOKALIKES = ".,:;·、。'`";

function escapeForCharClass(s) {
  // 放進字元類別 [...] 的簡單跳脫：跳脫會被字元類別特別解讀的符號。
  return s.replace(/[\\\]^-]/g, "\\$&");
}

const PERCENT_CHARS = "\\d\\s" + escapeForCharClass(DECIMAL_LOOKALIKES);
const PERCENT_IN_BRACKET_RE = new RegExp("[\\[\\(\\{<]([" + PERCENT_CHARS + "]{1,12})%");
const PERCENT_RE = new RegExp("([" + PERCENT_CHARS + "]{1,12})%");
const DECIMAL_FIX_RE = new RegExp("\\s*[" + escapeForCharClass(DECIMAL_LOOKALIKES) + "]\\s*", "g");

// 遊戲的百分比固定兩位小數（parsing.py:25）。
const PERCENT_DECIMALS = 2;

// RapidOCR 常把一個數字切成好幾個文字框，接起來時中間會多一個空白，例如
// "EXP 1176050[60 .13%]"。這條把「數字/小數點之間」的空白黏回去，只黏剛好
// 一個（parsing.py:30）。
const SPLIT_NUMBER_RE = /(?<=[\d.,])\s(?=[\d.,])/g;
const LEVEL_RE = /\d{1,3}/g;

// "EXP" 後面那個孤零零的字元是雜訊，條件卡得很緊：那個字元後面要有空白，
// 再後面要接 3 位以上的數字，才認定是雜訊（parsing.py:36）。
const EXP_LABEL_NOISE_RE = /[Ee][Xx][Pp][^\dA-Za-z]*[A-Za-z0-9]\s+(?=\d{3,})/g;

// 只在數字情境下做的字元替換（parsing.py:38）。注意：不要把 | ! ！ 放進來——
// 那些在地圖名結尾多半是羅馬數字 I，這裡跟地圖無關，但保留跟 Python 一致的表。
const DIGIT_FIXES = {
  O: "0",
  o: "0",
  D: "0",
  l: "1",
  I: "1",
  "|": "1",
  S: "5",
  B: "8",
};

function applyDigitFixes(text) {
  let out = "";
  for (const ch of text) {
    out += Object.prototype.hasOwnProperty.call(DIGIT_FIXES, ch) ? DIGIT_FIXES[ch] : ch;
  }
  return out;
}

/**
 * 從經驗值那一行抓出 [絕對經驗值, 百分比]。抓不到的那一項回傳 null。
 * 典型輸入："EXP 1,234,567 [12.34%]"、"1234567[12.34%]"、"EXP 1,234,567"
 * （逐字對照 parsing.py:216-249）
 * @param {string} raw
 * @returns {[number|null, number|null]}
 */
export function parseExpLine(raw) {
  if (!raw) return [null, null];

  // 先把 EXP 標籤後面的雜訊字元剝掉，再做 O->0 那組替換。順序不能反：
  // 反過來的話 S 已經變成 5，就分不出它是雜訊還是真的數字了。
  let text = applyDigitFixes(raw.replace(EXP_LABEL_NOISE_RE, "EXP "));

  // 先找括號裡的百分比（正常格式），找不到才退而求其次找任何百分比。
  let percent = null;
  PERCENT_IN_BRACKET_RE.lastIndex = 0;
  PERCENT_RE.lastIndex = 0;
  const m = PERCENT_IN_BRACKET_RE.exec(text) || PERCENT_RE.exec(text);
  if (m) {
    percent = percentFromChunk(m[1]);
    // 百分比那段要先挖掉，不然 "12.34%" 的 12 跟 34 會被當成經驗值。
    text = text.slice(0, m.index) + " " + text.slice(m.index + m[0].length);
  }

  // 剩下的數字裡，位數最多的那個當作絕對經驗值。
  text = text.replace(SPLIT_NUMBER_RE, "");
  let best = null;
  for (const chunk of text.match(DIGITS_RE) || []) {
    const digits = chunk.replace(/\D/g, "");
    if (!digits) continue;
    if (best === null || digits.length > best.length) {
      best = digits;
    }
  }

  let exp = best !== null ? Number(best) : null;
  if (exp !== null && exp > 1e15) {
    // 明顯是 OCR 把兩段黏在一起，寧可不要
    exp = null;
  }
  return [exp, percent];
}

/**
 * 把百分比那一段文字轉成數字（逐字對照 parsing.py:252-282）。
 * @param {string} chunk
 * @returns {number|null}
 */
function percentFromChunk(chunk) {
  // 黏回被拆開的小數點，順便把冒號那類看錯的字元換回小數點。
  const text = chunk.replace(DECIMAL_FIX_RE, ".").trim();

  let digits;
  if (text.includes(".")) {
    digits = text.replace(/[^\d.]/g, "");
  } else {
    // 只剩數字（可能中間還有空白），把最後兩位當小數。
    const rawDigits = text.replace(/\D/g, "");
    if (!rawDigits) return null;
    let padded = rawDigits;
    if (padded.length <= PERCENT_DECIMALS) {
      padded = padded.padStart(PERCENT_DECIMALS + 1, "0");
    }
    digits = padded.slice(0, padded.length - PERCENT_DECIMALS) + "." + padded.slice(padded.length - PERCENT_DECIMALS);
  }

  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  return value >= 0.0 && value <= 100.0 ? value : null;
}

/**
 * 從等級那一小塊抓出等級數字（逐字對照 parsing.py:285-317）。
 *
 * digitsOnly=false（預設，退回校準值時用）：框裡還帶著 "LV." 這種前綴，
 *   刻意不做 O->0 那種替換（"LV" 的 L 會被當成 1，讀出等級 1）。
 * digitsOnly=true（模板比對自動定位成功時用）：框只剩數字本身，直接去掉所有
 *   非數字字元再取。同樣不套 DIGIT_FIXES。
 *
 * @param {string} raw
 * @param {boolean} digitsOnly
 * @returns {number|null}
 */
export function parseLevel(raw, digitsOnly = false) {
  if (!raw) return null;

  if (digitsOnly) {
    const digits = raw.replace(/\D/g, "");
    if (!digits) return null;
    const level = Number(digits);
    return level >= 1 && level <= 200 ? level : null;
  }

  const cleaned = raw.replace(SPLIT_NUMBER_RE, "");
  const numbers = cleaned.match(LEVEL_RE);
  if (!numbers || numbers.length === 0) return null;
  const level = Number(numbers[numbers.length - 1]);
  return level >= 1 && level <= 200 ? level : null;
}

// ---------------------------------------------------------------------------
// 地圖名稱（0071 工單任務 1 補完，逐字對照 parsing.py:41-624）

// 地圖名稱那塊要洗掉的雜訊符號（parsing.py:41）。
const MAP_JUNK = " \t「」[](){}<>《》:：.、,_-—/\\";
// 地圖名稱至少要幾個字才採用（parsing.py:43）。
const MIN_MAP_NAME_LENGTH = 2;
// 名字結尾是「編號包在方括號裡」（"[地區04]"、"[01]"）時，收尾的 "]" 是名字
// 本身的一部分，不是雜訊方括號（parsing.py:51，0043 號工單）。
const BRACKETED_NUMBER_SUFFIX_RE = /\[[^[\]]*\d[^[\]]*\]\s*$/;

// 地圖名稱結尾的編號（parsing.py:84，0048 號工單：「川」+ 一個以上的 I 一律
// 是 Ⅲ，不疊加 I 的數量）。
const MAP_SUFFIX_RE = /(?:川I+|[IVXivx1-9]+)$/;
// 編號不一定在結尾（parsing.py:86）。
const ANY_DIGITS_RE = /\d+/g;
const ROMAN_VALUES = { I: 1, V: 5, X: 10 };
// 羅馬數字 I 在遊戲的像素字裡常被 OCR 認成這些（parsing.py:89）。
const ROMAN_ONE_LOOKALIKES = "!！|｜lｌ丨¡";

// 全形羅馬數字 -> ASCII 字母組合（parsing.py:96-101，0032 號工單前提澄清 (2)）。
const FULLWIDTH_ROMAN = {
  "Ⅰ": "I", "Ⅱ": "II", "Ⅲ": "III", "Ⅳ": "IV", "Ⅴ": "V",
  "Ⅵ": "VI", "Ⅶ": "VII", "Ⅷ": "VIII", "Ⅸ": "IX", "Ⅹ": "X",
  "ⅰ": "i", "ⅱ": "ii", "ⅲ": "iii", "ⅳ": "iv", "ⅴ": "v",
  "ⅵ": "vi", "ⅶ": "vii", "ⅷ": "viii", "ⅸ": "ix", "ⅹ": "x",
};

// 編號被讀成「川」時要重讀（0045 號工單，parsing.py:185）。
// 0074 工單任務 3：app.mjs 的 _slowTick() 要用這個字元判斷「這一行」（投影分行後
// 的某一行）該不該送去重讀，所以輸出成正式 export（不只是 _internal 測試用途）。
export const BROKEN_NUMERAL_CHAR = "川";

const ROMAN_NUMERALS = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
// merge_map_name() 重組名字前殘留在 base 尾端的雜訊字元集合（parsing.py:368）。
const TRAILING_NUMERAL_CHARS = "IVXivx123456789" + ROMAN_ONE_LOOKALIKES + "川";

/** Python str.strip(chars) 的 JS 版：頭尾都剝掉 chars 集合裡的字元。 */
function stripChars(s, chars) {
  const set = new Set(chars);
  let start = 0;
  let end = s.length;
  while (start < end && set.has(s[start])) start++;
  while (end > start && set.has(s[end - 1])) end--;
  return s.slice(start, end);
}

/** Python str.rstrip(chars) 的 JS 版：只剝尾端。 */
function rstripChars(s, chars) {
  const set = new Set(chars);
  let end = s.length;
  while (end > 0 && set.has(s[end - 1])) end--;
  return s.slice(0, end);
}

/** Python str.split()（無參數）的 JS 版：依空白切、丟掉空字串。 */
function splitWords(s) {
  return s.split(/\s+/).filter(Boolean);
}

/**
 * 把全形羅馬數字（Ⅰ~Ⅹ、ⅰ~ⅹ）換成對應的 ASCII 字母組合（parsing.py:104-112）。
 * @param {string} text
 * @returns {string}
 */
export function normalizeRoman(text) {
  if (!text) return text;
  let out = "";
  for (const ch of text) {
    out += Object.prototype.hasOwnProperty.call(FULLWIDTH_ROMAN, ch) ? FULLWIDTH_ROMAN[ch] : ch;
  }
  return out;
}

function replaceRomanOneLookalikes(text) {
  let out = "";
  for (const ch of text) {
    out += ROMAN_ONE_LOOKALIKES.includes(ch) ? "I" : ch;
  }
  return out;
}

/**
 * 取出地圖名稱結尾的編號，正規化成阿拉伯數字。沒有編號就回空字串
 * （逐字對照 parsing.py:115-156）。
 * @param {string} name
 * @returns {string}
 */
export function mapSuffix(name) {
  name = normalizeRoman(name);
  name = replaceRomanOneLookalikes(name);
  const m = MAP_SUFFIX_RE.exec(name);
  if (!m) return "";
  let text = m[0];
  if (text.startsWith("川")) {
    // 「川」+ 任意數量的 I 一律是 Ⅲ，不疊加 I 的數量。
    return "3";
  }
  text = text.toUpperCase();
  if (/^\d+$/.test(text)) return text;

  // 數字混羅馬字（"I2"、"2I"、"V1"）不是合法羅馬數字，_ROMAN_VALUES 查不到
  // 就回空字串當「沒有編號」（A1，0050 號工單，parsing.py:142-148）。
  for (const ch of text) {
    if (!Object.prototype.hasOwnProperty.call(ROMAN_VALUES, ch)) return "";
  }

  // 羅馬數字轉阿拉伯：IV = 4、VI = 6。
  let total = 0;
  let prev = 0;
  const chars = Array.from(text).reverse();
  for (const ch of chars) {
    const value = ROMAN_VALUES[ch];
    total += value < prev ? -value : value;
    prev = Math.max(prev, value);
  }
  return String(total);
}

/**
 * 取出地圖名稱裡的所有編號，照出現順序，全部正規化成阿拉伯數字
 * （逐字對照 parsing.py:159-178）。
 * @param {string} name
 * @returns {string[]}
 */
export function mapNumbers(name) {
  name = normalizeRoman(name);
  const suffix = mapSuffix(name);
  let body = name;
  if (suffix) {
    // 結尾那段已經算過了，先拿掉再找中間的數字，免得同一個編號算兩次。
    const withRomanFixed = replaceRomanOneLookalikes(name);
    body = withRomanFixed.replace(MAP_SUFFIX_RE, "");
  }
  const digitRuns = body.match(ANY_DIGITS_RE) || [];
  const numbers = digitRuns.map((n) => n.replace(/^0+/, "") || "0");
  if (suffix) numbers.push(suffix);
  return numbers;
}

/**
 * 合併後的名字有沒有「編號被讀壞、需要加大倍率重讀」的訊號（0045 號工單，
 * 逐字對照 parsing.py:188-213）。
 * @param {string} name
 * @returns {boolean}
 */
export function hasUnreadableNumeral(name) {
  return name.includes(BROKEN_NUMERAL_CHAR) && mapNumbers(name).length === 0;
}

/**
 * 快捷欄格子底下那個「還剩幾瓶」的數量（逐字對照 parsing.py:320-343）。
 * @param {string} raw
 * @returns {number|null}
 */
export function parseCount(raw) {
  if (!raw) return null;
  const digits = applyDigitFixes(raw).replace(/\D/g, "");
  if (!digits) return null;
  return Number(digits);
}

function endsWithBracketedNumber(text) {
  if (!text) return false;
  return BRACKETED_NUMBER_SUFFIX_RE.test(text);
}

/**
 * 把地圖名稱那塊的 OCR 結果洗乾淨（逐字對照 parsing.py:346-359）。
 * @param {string} raw
 * @returns {string}
 */
export function cleanMapName(raw) {
  if (!raw) return "";
  const keepBracket = endsWithBracketedNumber(raw);
  let name = raw.replace(/\s+/g, " ");
  name = stripChars(name, MAP_JUNK).trim();
  if (keepBracket && !name.endsWith("]")) name = name + "]";
  return name;
}

/**
 * 在一整段文字裡找地圖編號（逐字對照 parsing.py:371-381）。
 * @param {string} text
 * @returns {string}
 */
function suffixInText(text) {
  for (const token of splitWords(cleanMapName(text))) {
    const number = mapSuffix(token);
    if (number) return number;
  }
  return "";
}

/**
 * 把簡體模型讀到的「名字中間的編號」補回繁體讀到的名字（逐字對照
 * parsing.py:384-412）。
 * @param {string} base
 * @param {string} suffixText
 * @returns {string}
 */
function mergeEmbeddedNumber(base, suffixText) {
  const baseTokens = splitWords(base);
  const otherTokens = splitWords(suffixText);
  if (baseTokens.length !== otherTokens.length) return base;

  for (let i = 0; i < otherTokens.length; i++) {
    const token = otherTokens[i];
    const m = /\d+/.exec(token);
    // 編號在結尾的（猴子森林2）交給 mapSuffix 那套處理，這裡只管中間的。
    if (!m || m.index + m[0].length === token.length) continue;
    const digits = m[0];
    const target = baseTokens[i];
    const tailLen = token.length - (m.index + m[0].length);
    // 繁體本來就讀對了，或是讀到的字太短拼不出來，都不要動。
    if (target.includes(digits) || target.length < tailLen) continue;
    baseTokens[i] = token.slice(0, m.index) + digits + target.slice(target.length - tailLen);
  }

  return baseTokens.join(" ");
}

/**
 * 地圖名稱 = 主文字模型讀到的字 + 編號模型讀到的編號（逐字對照
 * parsing.py:415-434）。0071 起網頁版兩個參數都餵 ch（簡體）讀值（同一個
 * 字串，見檔頭 0071 前提澄清 (6)），編號補正邏輯照舊。
 * @param {string} nameText
 * @param {string} suffixText
 * @returns {string}
 */
export function mergeMapName(nameText, suffixText) {
  let base = mergeEmbeddedNumber(cleanMapName(nameText), cleanMapName(suffixText));
  const number = suffixInText(suffixText);
  if (!number || base.endsWith("]")) return base;

  base = rstripChars(base, TRAILING_NUMERAL_CHARS).trimEnd();
  const index = Number(number);
  return base + (index < ROMAN_NUMERALS.length ? ROMAN_NUMERALS[index] : number);
}

function sameMapNumbers(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * 讓地圖名稱不要因為 OCR 每次抖一兩個字，就被當成換了新地圖
 * （逐字對照 parsing.py:455-624）。
 *
 * `csvNames`/`csvMatch` 不傳（`null`）時走 mapdb.mjs 的預設值
 * （`mapdb.namesSync()`／`mapdb.bestMatch`）——**跟 Python 版不同的地方**：
 * Python 用同步檔案讀取，這裡是瀏覽器 fetch，呼叫端要先
 * `await mapdb.loadNames()` 一次，`namesSync()` 才讀得到真的候選清單
 * （0071 前提澄清「裁定與偏離」，見 mapdb.mjs 檔頭）。
 */
export class MapNameStabilizer {
  /**
   * @param {number} [confirmSamples]
   * @param {number} [similarity]
   * @param {Object<string,string>|null} [aliases]
   * @param {string[]|null} [csvNames]
   * @param {((raw: string) => string|null)|null} [csvMatch]
   */
  constructor(confirmSamples = 2, similarity = 0.75, aliases = null, csvNames = null, csvMatch = null) {
    this.confirmSamples = Math.max(1, confirmSamples);
    this.similarity = similarity;
    // OCR 讀出來的名字 -> 想顯示的名字。
    this.aliases = aliases || {};
    if (csvNames === null || csvMatch === null) {
      if (csvNames === null) csvNames = defaultCsvNames();
      if (csvMatch === null) csvMatch = defaultCsvMatch;
    }
    this.csvNames = csvNames;
    this._csvMatch = csvMatch;
    // 對照表右邊那些「正式的名字」= 使用者認可的地圖清單，加上地圖總表全部候選。
    this.official = new Set([...Object.values(this.aliases), ...this.csvNames]);
    /** @type {string[]} */
    this.known = [];
    /** @type {string|null} */
    this.current = null;
    this._pending = null;
    this._pendingCount = 0;
  }

  /**
   * 兩個名字是不是同一張地圖？編號必須完全一樣，其餘部分夠像就算
   * （逐字對照 parsing.py:497-522）。
   * @param {string} a
   * @param {string} b
   * @returns {boolean}
   */
  _sameMap(a, b) {
    if (!sameMapNumbers(mapNumbers(a), mapNumbers(b))) return false;
    if (a !== b && this.official.has(a) && this.official.has(b)) return false;
    return ratio(fold(a), fold(b)) >= this.similarity;
  }

  /**
   * 把讀到的名字對應回「要顯示的名字」（parsing.py:524-529）。
   * @param {string} name
   * @returns {string}
   */
  canonical(name) {
    return this.canonicalWithSource(name)[0];
  }

  /**
   * 跟 canonical() 一樣，多回傳一個來源標記："alias"|"known"|"csv"|"raw"
   * （逐字對照 parsing.py:531-554）。
   * @param {string} name
   * @returns {[string, "alias"|"known"|"csv"|"raw"]}
   */
  canonicalWithSource(name) {
    if (Object.prototype.hasOwnProperty.call(this.aliases, name)) {
      return [this.aliases[name], "alias"];
    }
    const key = this._bestMatch(name, Object.keys(this.aliases));
    if (key !== null) return [this.aliases[key], "alias"];
    const known = this._bestMatch(name, this.known);
    if (known !== null) return [known, "known"];
    const matched = this._csvMatch(name);
    if (matched !== null && matched !== undefined) return [matched, "csv"];
    return [name, "raw"];
  }

  /**
   * 在候選名字裡挑「最像的」那個，都不夠像就回 null（逐字對照
   * parsing.py:556-576）。
   * @param {string} name
   * @param {Iterable<string>} candidates
   * @returns {string|null}
   */
  _bestMatch(name, candidates) {
    let best = null;
    let bestScore = 0.0;
    const foldedName = fold(name);
    for (const candidate of candidates) {
      if (!this._sameMap(candidate, name)) continue;
      const score = ratio(fold(candidate), foldedName);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  }

  /**
   * 吃一次 OCR 結果，回傳目前確定的地圖名稱；還讀不出來就回 null
   * （逐字對照 parsing.py:578-623）。
   * @param {string} raw
   * @returns {string|null}
   */
  feed(raw) {
    const cleaned = cleanMapName(raw);
    if (cleaned.length < MIN_MAP_NAME_LENGTH) return this.current;

    const [name, source] = this.canonicalWithSource(cleaned);
    if (this.current !== null && this._sameMap(this.current, name)) {
      this._pending = null;
      this._pendingCount = 0;
      return this.current;
    }

    if (source !== "raw") {
      this.current = name;
      if (!this.known.includes(this.current)) this.known.push(this.current);
      this._pending = null;
      this._pendingCount = 0;
      return this.current;
    }

    if (this._pending !== null && this._sameMap(this._pending, name)) {
      this._pendingCount += 1;
    } else {
      this._pending = name;
      this._pendingCount = 1;
    }

    if (this._pendingCount >= this.confirmSamples) {
      this.current = this._pending;
      if (!this.known.includes(this.current)) this.known.push(this.current);
      this._pending = null;
      this._pendingCount = 0;
    }

    return this.current;
  }
}

// 延遲讀取 mapdb 的預設值：跟 Python `_default_csv_lookup()` 精神一致
// （不強制要求 mapdb 資料已經備妥）——差別是這裡永遠不會 import 失敗
// （同一個 bundle），只有「還沒 loadNames() 過」的情況，這時候回空陣列／
// 永遠配不到，等呼叫端補跑 mapdb.loadNames() 後下一次 feed() 才會生效
// （見檔頭「0071 前提澄清」與 mapdb.mjs 檔頭的說明）。
function defaultCsvNames() {
  return mapdbNamesSync();
}

function defaultCsvMatch(raw) {
  return mapdbBestMatch(raw);
}

export const _internal = {
  DIGITS_RE,
  PERCENT_CHARS,
  PERCENT_IN_BRACKET_RE,
  PERCENT_RE,
  DECIMAL_FIX_RE,
  SPLIT_NUMBER_RE,
  LEVEL_RE,
  EXP_LABEL_NOISE_RE,
  DIGIT_FIXES,
  PERCENT_DECIMALS,
  percentFromChunk,
};

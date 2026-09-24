// 翻 exp-tracker/src/mesos.py（0072 工單任務 2）。
//
// 楓幣每小時：物品欄閃一下讀到一筆，只記「第一筆」（基準）跟「最後一筆」，
// per_hour = (最後 − 第一) / (時間差) × 3600。不扣水錢（提案人明講，gain() 直接
// 拿最後一筆減第一筆，買水修裝已經反映在楓幣總額變化裡）。
//
// findIcon()：楓幣圖示（15×15）在**整張**畫面找，**單一倍率**，不准縮小畫面找
// （0072 前提澄清 (1)）。跟 uilocate.locate() 那種 30 scale 全視窗比對不同——
// 這裡改用計畫書 §6「兩階段」設計：
//   1. 粗篩：模板裡挑 8 個固定取樣點（從 templates/meso_icon.png 挑，寫死成
//      COARSE_SAMPLE_POINTS 常數），整張畫面每個位置只比這 8 個像素
//      （容差 COARSE_TOLERANCE），全部過的才進第 2 階段。
//   2. 對候選位置做完整 NCC，門檻 MESO_ICON_THRESHOLD(0.8)。
// 這跟桌面版「cv2.matchTemplate 單一尺寸全視窗，10.5ms」不同調（JS 沒有
// cv2 那種原生最佳化的暴力比對，逐像素 15×15 乘加在整張 1368×800 畫面上會是
// 秒級，見 locate.mjs 檔頭「cv2 的 matchTemplate」那段），兩階段設計把粗篩
// 壓到「每個位置只比 8 個像素」，實測（Python 對照腳本，見回報單）
// inventory_open.png 只留 1 個候選（916,404），game_now.png 0 個候選——
// 真正的 NCC（第 2 階段）只需要對極少數候選算，成本可以忽略。

import { buildIntegral } from "./locate.mjs";

export const MESO_ICON_THRESHOLD = 0.8;
/** 快迴圈每幾拍找一次圖示（web 版 250ms 一拍，2 拍 = 500ms，前提澄清 (1)：跟桌面版 3 拍/300ms 刻意不同）。 */
export const MESO_SCAN_EVERY_TICKS = 2;
/** 兩次楓幣 OCR 至少要隔這麼多秒。 */
export const MESO_OCR_MIN_INTERVAL_SEC = 5.0;
/** 數字白框相對圖示左上角的位移／尺寸（inventory_open.png 量的）。 */
export const MESO_NUMBER_OFFSET = [18, 0];
export const MESO_NUMBER_SIZE = [104, 15];
export const MESO_OCR_REGION = { upscale: 6, preprocess: "gray", lang: "ch" };
/** MesoTracker.perHour() 的最短視窗：兩筆之間差不到這麼多秒回 null。 */
export const MIN_SPAN_SEC = 60.0;
/** 一筆跟前一筆差超過這麼多楓幣，當 OCR 讀壞丟掉、不動基準。 */
export const DEFAULT_MAX_JUMP = 50_000_000;
/** 「最後一筆距現在」超過這麼多秒算「舊了」（精簡窗提示、健康列楓幣那塊的 ok_within）。 */
export const MESO_STALE_SEC = 60.0;

export const ICON_SIZE = 15;
/** 粗篩容差（灰階值 0~255）。 */
export const COARSE_TOLERANCE = 24;

// 8 個粗篩取樣點，從 templates/meso_icon.png（15×15）挑的：{dx, dy, expected}，
// dx/dy 是相對圖示左上角的位移，expected 是那個像素的灰階值（0~255）。
// 逐一核對過 templates/meso_icon.png 的灰階陣列（見 0072-evidence/meso_sample_points.png
// 標記圖），涵蓋角落背景色（173）、白色描邊（255）、黑色外框（0，兩個不同位置）、
// 金幣邊緣過渡色（204）、金幣內部深淺兩種金色（151、193），8 個值彼此差異夠大，
// 遊戲畫面其他地方（介面色調跟金幣完全不同）不太可能同時通過全部 8 點的 ±24 容差。
export const COARSE_SAMPLE_POINTS = [
  { dx: 0, dy: 0, expected: 173 },
  { dx: 1, dy: 1, expected: 255 },
  { dx: 7, dy: 7, expected: 151 },
  { dx: 5, dy: 2, expected: 0 },
  { dx: 4, dy: 12, expected: 0 },
  { dx: 2, dy: 4, expected: 204 },
  { dx: 9, dy: 9, expected: 151 },
  { dx: 7, dy: 6, expected: 193 },
];

/**
 * 粗篩：整張灰階圖裡，8 個取樣點全部落在容差內的候選位置（圖示左上角）。
 * @param {Uint8Array|Float32Array} gray
 * @param {number} W
 * @param {number} H
 * @param {number} [size]
 * @param {number} [tolerance]
 * @returns {{x:number,y:number}[]}
 */
export function coarseCandidates(gray, W, H, size = ICON_SIZE, tolerance = COARSE_TOLERANCE) {
  const candidates = [];
  const maxX = W - size;
  const maxY = H - size;
  if (maxX < 0 || maxY < 0) return candidates;
  for (let y = 0; y <= maxY; y++) {
    for (let x = 0; x <= maxX; x++) {
      let ok = true;
      for (const p of COARSE_SAMPLE_POINTS) {
        const v = gray[(y + p.dy) * W + (x + p.dx)];
        if (Math.abs(v - p.expected) > tolerance) {
          ok = false;
          break;
        }
      }
      if (ok) candidates.push({ x, y });
    }
  }
  return candidates;
}

/** 對單一候選位置算 TM_CCOEFF_NORMED（模板已知均值/平方和，避免重複算）。 */
function nccAt(gray, W, template, size, tMean, denomT, x, y) {
  const N = size * size;
  let cross = 0;
  let winSum = 0;
  let winSumSq = 0;
  for (let j = 0; j < size; j++) {
    const rowBase = (y + j) * W + x;
    const tBase = j * size;
    for (let i = 0; i < size; i++) {
      const v = gray[rowBase + i];
      cross += v * template[tBase + i];
      winSum += v;
      winSumSq += v * v;
    }
  }
  const iMean = winSum / N;
  const denomI = Math.max(0, winSumSq - N * iMean * iMean);
  const numerator = cross - N * iMean * tMean;
  const denom = Math.sqrt(denomI * denomT);
  return denom > 0 ? numerator / denom : 0;
}

/**
 * 楓幣圖示：整張找、單一倍率、兩階段（逐字對照 mesos.py find_icon() 的角色，
 * 演算法是網頁版自己的兩階段設計，見檔頭）。`gray`／`template` 都是灰階
 * typed array；`template` 固定 15×15（ICON_SIZE）。
 * @param {Uint8Array|Float32Array} gray
 * @param {number} W
 * @param {number} H
 * @param {Uint8Array|Float32Array} template
 * @returns {{score:number, x:number, y:number}}
 */
export function findIcon(gray, W, H, template) {
  if (!template || !gray || W < ICON_SIZE || H < ICON_SIZE) return { score: 0, x: 0, y: 0 };
  const candidates = coarseCandidates(gray, W, H);
  if (candidates.length === 0) return { score: 0, x: 0, y: 0 };

  const N = ICON_SIZE * ICON_SIZE;
  let tSum = 0;
  let tSumSq = 0;
  for (let i = 0; i < template.length; i++) {
    tSum += template[i];
    tSumSq += template[i] * template[i];
  }
  const tMean = tSum / N;
  const denomT = Math.max(0, tSumSq - N * tMean * tMean);

  let best = { score: -Infinity, x: 0, y: 0 };
  for (const c of candidates) {
    const score = nccAt(gray, W, template, ICON_SIZE, tMean, denomT, c.x, c.y);
    if (score > best.score) best = { score, x: c.x, y: c.y };
  }
  return best;
}

/**
 * 圖示左上角座標 -> 數字白框 (left, top, width, height)（前提澄清 (3) 的固定位移）。
 * @param {[number, number]} iconXY
 */
export function numberRegion(iconXY) {
  const [ix, iy] = iconXY;
  const [ox, oy] = MESO_NUMBER_OFFSET;
  const [w, h] = MESO_NUMBER_SIZE;
  return [ix + ox, iy + oy, w, h];
}

/**
 * OCR 讀到的楓幣數字文字 -> int。拿掉逗號與空白後轉數字，解析不出來回 null。
 * @param {string|null} text
 * @returns {number|null}
 */
export function parseAmount(text) {
  if (!text) return null;
  const cleaned = text.replace(/,/g, "").replace(/\s/g, "").trim();
  if (!cleaned) return null;
  if (!/^-?\d+$/.test(cleaned)) return null;
  return parseInt(cleaned, 10);
}

// ---------------------------------------------------------------------------
// MesoTracker（逐字對照 mesos.py MesoTracker）

export class MesoTracker {
  /** @param {number} [maxJump] */
  constructor(maxJump = DEFAULT_MAX_JUMP) {
    this.maxJump = Number(maxJump);
    /** @type {[number, number][]} [ts, amount] */
    this._samples = [];
  }

  /**
   * 記一筆 (ts, amount)。第一筆是基準；之後每筆跟「前一筆」比對離群保護。
   * @param {number} ts
   * @param {number} amount
   * @returns {boolean} 有沒有真的收下這一筆
   */
  feed(ts, amount) {
    amount = Math.trunc(Number(amount));
    ts = Number(ts);
    if (this._samples.length > 0) {
      const prevAmount = this._samples[this._samples.length - 1][1];
      if (Math.abs(amount - prevAmount) > this.maxJump) return false;
    }
    this._samples.push([ts, amount]);
    return true;
  }

  /** 忘掉這一趟的全部資料。按「開始」時呼叫。 */
  reset() {
    this._samples = [];
  }

  count() {
    return this._samples.length;
  }

  /** @returns {number|null} */
  lastTs() {
    return this._samples.length ? this._samples[this._samples.length - 1][0] : null;
  }

  /** 最後一筆 − 第一筆。一筆都沒有回 null；只有一筆回 0；可以是負的。 */
  gain() {
    if (this._samples.length === 0) return null;
    return this._samples[this._samples.length - 1][1] - this._samples[0][1];
  }

  /** 最後一筆時間 − 第一筆時間。不到兩筆回 0。 */
  spanSeconds() {
    if (this._samples.length < 2) return 0.0;
    return this._samples[this._samples.length - 1][0] - this._samples[0][0];
  }

  /** 每小時楓幣。spanSeconds() < MIN_SPAN_SEC 回 null。 */
  perHour() {
    const span = this.spanSeconds();
    if (span < MIN_SPAN_SEC) return null;
    const gain = this.gain();
    if (gain === null) return null;
    return (gain / span) * 3600.0;
  }

  /** windowSec 秒視窗換算出來的楓幣量（先算速率再乘視窗）。 */
  inWindow(windowSec) {
    const perHour = this.perHour();
    if (perHour === null) return null;
    return (perHour * windowSec) / 3600.0;
  }

  asDict() {
    return { gain: this.gain() || 0, span_sec: this.spanSeconds(), samples: this.count() };
  }
}

// ---------------------------------------------------------------------------
// 顯示格式（計畫書 §9.1／CLAUDE.md「精簡窗的文字」）

function formatSignedInt(n) {
  const rounded = Math.round(n);
  const sign = rounded < 0 ? "−" : ""; // U+2212，不是連字號
  return sign + Math.abs(rounded).toLocaleString("zh-TW");
}

/**
 * 精簡窗「楓幣/hr」「楓幣/10min」那行的數字（不含前綴/圖示，畫面端自己拼字串）。
 * @param {number|null} amount
 * @returns {string}
 */
export function formatMesoAmount(amount) {
  return amount === null || amount === undefined ? "—" : formatSignedInt(amount);
}

/**
 * 排行榜「楓幣/hr」「楓幣/10min」欄格式：span_sec <= 0 顯示「—」，否則
 * gain / span * window（逐字對照 app.py `_fmt_meso_cell()` 的資料形狀）。
 * @param {number} gain
 * @param {number} spanSec
 * @param {number} windowSec
 */
export function formatMesoCell(gain, spanSec, windowSec) {
  if (!(spanSec > 0)) return "—";
  return formatSignedInt((gain / spanSec) * windowSec);
}

// 0077 工單任務 2：精簡窗「楓幣/hr」「楓幣/10min」數字的六級顏色，逐字照抄
// exp-tracker/src/ui_skin.py 的 MESO_TIER_COLORS（由大到小排，取第一個
// amount >= 門檻的那級；負數／非數字一律回最低那級）。純顯示格式，不影響
// 任何統計/OCR 邏輯，只有 app.mjs 的 `_updateMesoRow()` 會用到。
export const MESO_TIER_COLORS = [
  [1_000_000_000, "#A6006E"], // 48 深酒紅
  [100_000_000, "#D022C2"], // 47 紫紅
  [10_000_000, "#FF5400"], // 46 橘
  [1_000_000, "#629A00"], // 45 綠
  [100_000, "#00BDC4"], // 44 青藍
  [0, "#007AF4"], // 43 藍
];

/**
 * 楓幣金額 → 遊戲商店同一套的六級顏色（見 MESO_TIER_COLORS）。
 * @param {number|null|undefined} amount
 * @returns {string} CSS 色碼
 */
export function mesoTierColor(amount) {
  const value = typeof amount === "number" && Number.isFinite(amount) ? amount : 0;
  for (const [threshold, color] of MESO_TIER_COLORS) {
    if (value >= threshold) return color;
  }
  return MESO_TIER_COLORS[MESO_TIER_COLORS.length - 1][1];
}

// 除錯／測試用：coarse+NCC 的內部工具（不給正式流程用）。
export const _debug = { nccAt, buildIntegral };

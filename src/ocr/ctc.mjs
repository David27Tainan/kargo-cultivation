// PaddleOCR 前處理的純數學部分 + CTC 解碼。
//
// 刻意跟「怎麼拿到像素」（canvas／ImageBitmap）分開：這支檔案只吃/吐陣列與
// 數字，才能在 Node（`node --test`）裡直接測，不需要瀏覽器環境。用 canvas
// 把 ImageBitmap 讀成 RGBA 像素那一步留在 engine.mjs（那支需要
// OffscreenCanvas，只能在瀏覽器／Worker 裡跑），但**真正的縮放數學
// （resizeBicubic／resizeBilinear）在這裡實作，不靠 canvas 的
// drawImage／imageSmoothingQuality**——0070 工單任務 3 一開始試過用
// canvas `imageSmoothingQuality='high'` 近似 cv2 的 INTER_CUBIC，golden
// 比對 19 筆只過 10 筆（`level_region` 這種小圖差最多，分數差到 0.12），
// 改成自己寫的 cubic convolution 後就準了很多，見 tests/ocr.html 的結果與
// 0070-回報.md。
//
// 逐字對照來源：
//   resize_norm_img  exp-tracker/.build-venv/Lib/site-packages/rapidocr/ch_ppocr_rec/main.py
//   CTCLabelDecode    exp-tracker/.build-venv/Lib/site-packages/rapidocr/ch_ppocr_rec/utils.py
//   前處理順序（gray/gray_invert、BGR、upscale）  exp-tracker/src/ocr.py 的 _preprocess()

/** PP-OCR rec 模型固定吃的畫布高度（config.yaml 的 rec_img_shape: [3,48,320]）。 */
export const REC_IMG_HEIGHT = 48;
/** 沒有特別寬的圖時，padding 到的預設寬度（同上，320）。 */
export const REC_IMG_WIDTH_DEFAULT = 320;

/**
 * 把 RGBA 像素轉成灰階（R=G=B=luma），alpha 不動。
 * luma 公式跟 PIL `ImageOps.grayscale()`（ITU-R 601-2）一樣：
 *   L = R*299/1000 + G*587/1000 + B*114/1000
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @returns {Uint8ClampedArray} 新陣列，不改原本的
 */
export function toGray(rgba) {
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const l = Math.round((r * 299 + g * 587 + b * 114) / 1000);
    out[i] = l;
    out[i + 1] = l;
    out[i + 2] = l;
    out[i + 3] = rgba[i + 3];
  }
  return out;
}

/**
 * 反白（255 - 值），alpha 不動。要在 toGray() 之後呼叫（gray_invert = invert(grayscale(image))）。
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @returns {Uint8ClampedArray}
 */
export function invert(rgba) {
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = 255 - rgba[i];
    out[i + 1] = 255 - rgba[i + 1];
    out[i + 2] = 255 - rgba[i + 2];
    out[i + 3] = rgba[i + 3];
  }
  return out;
}

/**
 * 對照 `TextRecognizer.resize_norm_img()` 開頭那段算 `resized_w`／`img_width`
 * 的邏輯（main.py 的 `resize_norm_img`），只算尺寸，不動像素。
 *
 * 只處理「一張圖」的情況（我們永遠是 batch=1，不像 Python 那樣一批多張取
 * `max_wh_ratio`），所以這裡的 `maxWhRatio` 就是
 * `max(imgWidthDefault/imgHeight, w/h)`，等於 Python 在 batch_num=1 時的結果。
 *
 * @param {number} w 前處理＋upscale 之後的圖寬
 * @param {number} h 前處理＋upscale 之後的圖高
 * @param {number} imgHeight 預設 48
 * @param {number} imgWidthDefault 預設 320
 */
export function resizeTarget(w, h, imgHeight = REC_IMG_HEIGHT, imgWidthDefault = REC_IMG_WIDTH_DEFAULT) {
  const ratio = w / h;
  const maxWhRatio = Math.max(imgWidthDefault / imgHeight, ratio);
  // Python `int(...)`：對正數等同無條件捨去（truncate）。
  const imgWidth = Math.trunc(imgHeight * maxWhRatio);
  const ceilVal = Math.ceil(imgHeight * ratio);
  let resizedW = ceilVal > imgWidth ? imgWidth : ceilVal;
  resizedW = Math.max(1, resizedW);
  return { resizedW, imgWidth, imgHeight };
}

// ---------------------------------------------------------------------------
// 自己寫的縮放（不靠 canvas）。座標換算跟 cv2 一樣：dst 像素 x 對應的來源座標
// `srcX = (x + 0.5) * (srcW/dstW) - 0.5`，取樣點超出邊界時夾到 [0, srcW-1]
// （等同 cv2 預設的邊界處理，複製邊緣像素，不是環繞或鏡射）。

function clampIndex(i, n) {
  if (i < 0) return 0;
  if (i > n - 1) return n - 1;
  return i;
}

/**
 * Catmull-Rom / Keys 家族的三次卷積核。
 *
 * 0073 工單任務 1 逐階段對齊診斷抓到的坑：**cv2 的 `INTER_CUBIC` 係數是
 * a=-0.75，不是 a=-0.5**——0070 這裡原本寫 -0.5，golden 文字大部分能過是因為
 * 差異被後面的 resize_norm_img（縮到 48px 高）跟 CTC 解碼的容錯蓋掉了，
 * 但拆開來看純粹的「放大」這一步，JS 輸出跟 `cv2.resize(..., INTER_CUBIC)`
 * 逐像素比對 max abs diff 到 14~23（0~255 尺度）、30~46% 像素不同，遠超過
 * 正常的四捨五入誤差。改成 -0.75（OpenCV `resize.cpp` 的 `interpolateCubic()`
 * 用的係數 `const float A = -0.75f;`）之後同一支診斷頁 max abs diff 降到 0，
 * 見 `tests/stages.html` 與 `派工單/0073-evidence/`。
 */
function cubicWeight(x, a = -0.75) {
  const ax = Math.abs(x);
  if (ax <= 1) {
    return (a + 2) * ax * ax * ax - (a + 3) * ax * ax + 1;
  }
  if (ax < 2) {
    return a * ax * ax * ax - 5 * a * ax * ax + 8 * a * ax - 4 * a;
  }
  return 0;
}

/**
 * 沿著一個維度（水平或垂直）做 1D 三次卷積縮放。`getPixel(srcIndex, channel)`
 * 由呼叫端提供，回傳來源像素在某個 channel 的值；`setPixel(dstIndex, channel, value)`
 * 寫回結果。分開成水平/垂直兩次呼叫（separable resize），避免寫兩份幾乎一樣的迴圈。
 */
function resample1D(srcLen, dstLen, channels, getPixel, setPixel, kernel) {
  const scale = srcLen / dstLen;
  for (let d = 0; d < dstLen; d++) {
    const srcPos = (d + 0.5) * scale - 0.5;
    const base = Math.floor(srcPos);
    const frac = srcPos - base;
    // 4 個 tap：base-1, base, base+1, base+2
    const idx = [clampIndex(base - 1, srcLen), clampIndex(base, srcLen), clampIndex(base + 1, srcLen), clampIndex(base + 2, srcLen)];
    const w = kernel
      ? [kernel(1 + frac), kernel(frac), kernel(1 - frac), kernel(2 - frac)]
      : [1 - frac, frac]; // 雙線性只用兩個 tap（base, base+1），見 resample1DLinear
    for (let c = 0; c < channels; c++) {
      let sum = 0;
      for (let t = 0; t < idx.length; t++) {
        sum += w[t] * getPixel(idx[t], c);
      }
      setPixel(d, c, sum);
    }
  }
}

/**
 * 雙線性（bilinear）1D 縮放，只用 2 個 tap（cv2 預設 INTER_LINEAR 用的方式）。
 */
function resample1DLinear(srcLen, dstLen, channels, getPixel, setPixel) {
  const scale = srcLen / dstLen;
  for (let d = 0; d < dstLen; d++) {
    const srcPos = (d + 0.5) * scale - 0.5;
    const base = Math.floor(srcPos);
    const frac = srcPos - base;
    const i0 = clampIndex(base, srcLen);
    const i1 = clampIndex(base + 1, srcLen);
    for (let c = 0; c < channels; c++) {
      const v = getPixel(i0, c) * (1 - frac) + getPixel(i1, c) * frac;
      setPixel(d, c, v);
    }
  }
}

function clamp255(v) {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return Math.round(v);
}

/**
 * 對 RGBA 像素做 2D 三次卷積縮放（先水平、再垂直），近似 cv2.resize(...,
 * interpolation=cv2.INTER_CUBIC)。alpha 頻道跟著一起縮放（我們用不到，
 * 但保持完整的 RGBA 輸出方便丟回 canvas／ImageData）。
 * @param {Uint8ClampedArray} rgba
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} dstW
 * @param {number} dstH
 * @returns {Uint8ClampedArray} 長度 dstW*dstH*4
 */
export function resizeBicubic(rgba, srcW, srcH, dstW, dstH) {
  const channels = 4;
  // 第一步：水平縮放，srcW -> dstW，高度不變（srcH）
  const mid = new Float64Array(dstW * srcH * channels);
  for (let y = 0; y < srcH; y++) {
    resample1D(
      srcW,
      dstW,
      channels,
      (x, c) => rgba[(y * srcW + x) * channels + c],
      (x, c, v) => {
        mid[(y * dstW + x) * channels + c] = v;
      },
      cubicWeight
    );
  }
  // 第二步：垂直縮放，srcH -> dstH，寬度已經是 dstW
  const out = new Uint8ClampedArray(dstW * dstH * channels);
  for (let x = 0; x < dstW; x++) {
    resample1D(
      srcH,
      dstH,
      channels,
      (y, c) => mid[(y * dstW + x) * channels + c],
      (y, c, v) => {
        out[(y * dstW + x) * channels + c] = clamp255(v);
      },
      cubicWeight
    );
  }
  return out;
}

/**
 * 對 RGBA 像素做雙線性縮放，近似 cv2.resize(..., interpolation=cv2.INTER_LINEAR)
 * （cv2 預設值，PaddleOCR 的 `resize_norm_img()` 內部縮到高度 48 用的就是這個）。
 * @param {Uint8ClampedArray} rgba
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} dstW
 * @param {number} dstH
 * @returns {Uint8ClampedArray} 長度 dstW*dstH*4
 */
export function resizeBilinear(rgba, srcW, srcH, dstW, dstH) {
  const channels = 4;
  const mid = new Float64Array(dstW * srcH * channels);
  for (let y = 0; y < srcH; y++) {
    resample1DLinear(
      srcW,
      dstW,
      channels,
      (x, c) => rgba[(y * srcW + x) * channels + c],
      (x, c, v) => {
        mid[(y * dstW + x) * channels + c] = v;
      }
    );
  }
  const out = new Uint8ClampedArray(dstW * dstH * channels);
  for (let x = 0; x < dstW; x++) {
    resample1DLinear(
      srcH,
      dstH,
      channels,
      (y, c) => mid[(y * dstW + x) * channels + c],
      (y, c, v) => {
        out[(y * dstW + x) * channels + c] = clamp255(v);
      }
    );
  }
  return out;
}

/**
 * 把「已經縮到 (resizedW × imgHeight) 的 RGBA 像素」轉成 PaddleOCR 吃的
 * `[3, imgHeight, imgWidth]` CHW、BGR、正規化到 [-1,1] 的 Float32Array，
 * 右側 padding 補 0（對照 `resize_norm_img()` 最後那段
 * `padding_im[:, :, 0:resized_w] = resized_image`）。
 *
 * 頻道順序：cv2.cvtColor(RGB2BGR) 之後 channel0=B、channel1=G、channel2=R，
 * `.transpose((2,0,1))` 把頻道搬到最前面，所以輸出 tensor 的三個平面依序是
 * B、G、R。
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba 大小 resizedW*imgHeight*4
 * @param {number} resizedW
 * @param {number} imgHeight
 * @param {number} imgWidth padding 後的寬度
 * @returns {Float32Array} 長度 3*imgHeight*imgWidth
 */
export function toChwBgrNormalized(rgba, resizedW, imgHeight, imgWidth) {
  const planeSize = imgHeight * imgWidth;
  const tensor = new Float32Array(3 * planeSize); // 預設 0，等於已經 padding 好了
  for (let y = 0; y < imgHeight; y++) {
    for (let x = 0; x < resizedW; x++) {
      const srcIdx = (y * resizedW + x) * 4;
      const r = rgba[srcIdx];
      const g = rgba[srcIdx + 1];
      const b = rgba[srcIdx + 2];
      const pixPos = y * imgWidth + x;
      tensor[pixPos] = (b / 255 - 0.5) / 0.5; // channel 0 = B
      tensor[planeSize + pixPos] = (g / 255 - 0.5) / 0.5; // channel 1 = G
      tensor[2 * planeSize + pixPos] = (r / 255 - 0.5) / 0.5; // channel 2 = R
    }
  }
  return tensor;
}

/**
 * 讀字典檔內容（extract_dict.py 輸出的 ch_dict.txt／cht_dict.txt），
 * 用 "\n" 切開，**保留空行**（空行本身是一個字元位）。
 * @param {string} text
 * @returns {string[]}
 */
export function loadDict(text) {
  // 去掉檔案結尾唯一一個換行造成的多餘空字串（extract_dict.py 是用
  // "\n".join(chars) 寫的，不會多寫結尾換行，但保險起見還是處理一下，
  // 跟 extract_dict.py 對稱）。
  let body = text;
  if (body.endsWith("\n")) body = body.slice(0, -1);
  return body.split("\n");
}

/**
 * CTC 解碼（逐字對照 `CTCLabelDecode.decode()`，batch_size 固定 1）。
 *
 * 字元表約定（跟 extract_dict.py 的輸出對齊）：
 *   idx === 0            -> blank（忽略，`get_ignored_tokens()` 只忽略 0）
 *   idx in [1, dict.length] -> dict[idx - 1]
 * （dict.txt 本身已經包含 rapidocr 補在尾端的那個空白，見 extract_dict.py。）
 *
 * @param {Float32Array|Array<number>} predsFlat 長度 T*C，[t*C + c] 是第 t 個
 *   時間步、第 c 類的機率（或 logit，argmax 不在乎有沒有 softmax 過）。
 * @param {number} T 時間步數
 * @param {number} C 類別數（= dict.length + 1，多的 1 是 blank）
 * @param {string[]} dict
 * @returns {{text: string, score: number}}
 */
export function ctcDecode(predsFlat, T, C, dict) {
  let prevIdx = null;
  const chars = [];
  const probs = [];

  for (let t = 0; t < T; t++) {
    const base = t * C;
    let bestIdx = 0;
    let bestProb = predsFlat[base];
    for (let c = 1; c < C; c++) {
      const p = predsFlat[base + c];
      if (p > bestProb) {
        bestProb = p;
        bestIdx = c;
      }
    }
    // remove_duplicate：跟前一個時間步的原始 idx 相同就跳過（第一步永遠保留）。
    const keep = t === 0 || bestIdx !== prevIdx;
    prevIdx = bestIdx;
    if (!keep) continue;
    if (bestIdx === 0) continue; // ignored token（blank）

    const ch = dict[bestIdx - 1];
    if (ch === undefined) continue; // 字典對不上模型輸出維度，安全略過
    chars.push(ch);
    // Python：conf_list 逐一 round(5) 之後才取平均，這裡對齊。
    probs.push(round5(bestProb));
  }

  const text = chars.join("");
  const score = probs.length ? round5(probs.reduce((a, b) => a + b, 0) / probs.length) : 0;
  return { text, score };
}

function round5(x) {
  return Math.round(x * 1e5) / 1e5;
}

// ---------------------------------------------------------------------------
// 地圖區塊分行（0070 工單前提澄清 (2)）：沒有 det 模型，地圖裁圖可能有兩行
// （區域名／地圖名），用「水平投影」自己分行：灰階 → 每列算「亮度 > 閾值的
// 像素數」→ 連續非空列成一行 → 行高 < minHeight 的丟掉。
//
// 閾值原本工單建議 96，但在真實 fixture（tests/fixtures/crops/map_game.png
// 等，見 tools/ocr_golden.py）上實測：背景是均勻的 179（灰階），文字是白字
// 描黑邊（填色 push 到 >200，邊緣描黑到 <60），96 這個閾值背景本身就超過了
// （179 > 96），整張圖會被判成「沒有空列」、分不開兩行。改調到 200——背景
// 179 恰好落在門檻下方、文字的白色填色部分能穩定超過門檻，在三張 fixture
// （map_game／map_inventory／calib_map）上實測分行正確（前兩張分成兩行，
// calib_map 本身沒有清楚的文字，維持一整塊，見 0070-回報.md 附的分行結果圖）。

/** 地圖分行的預設亮度閾值（實測調出來的值，見上方說明）。 */
export const MAP_LINE_SPLIT_THRESHOLD = 200;
/** 行高小於這個像素數就丟掉（雜訊）。 */
export const MAP_LINE_MIN_HEIGHT = 6;

/**
 * 把 RGBA 轉成單通道灰階（跟 toGray() 用同一個 luma 公式，但這裡回傳
 * width*height 長度的單通道陣列，不是 RGBA replicate）。
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @returns {Uint8ClampedArray}
 */
export function lumaChannel(rgba) {
  const n = rgba.length / 4;
  const out = new Uint8ClampedArray(n);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    out[p] = Math.round((rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000);
  }
  return out;
}

/**
 * 水平投影分行。
 * @param {Uint8ClampedArray|Uint8Array} gray 單通道灰階，長度 width*height
 * @param {number} width
 * @param {number} height
 * @param {number} threshold
 * @param {number} minHeight
 * @returns {[number, number][]} 每行的 [起始 y（含）, 結束 y（不含）]
 */
export function splitLines(gray, width, height, threshold = MAP_LINE_SPLIT_THRESHOLD, minHeight = MAP_LINE_MIN_HEIGHT) {
  const nonEmpty = new Array(height).fill(false);
  for (let y = 0; y < height; y++) {
    const base = y * width;
    for (let x = 0; x < width; x++) {
      if (gray[base + x] > threshold) {
        nonEmpty[y] = true;
        break;
      }
    }
  }
  const lines = [];
  let start = null;
  for (let y = 0; y < height; y++) {
    if (nonEmpty[y] && start === null) {
      start = y;
    } else if (!nonEmpty[y] && start !== null) {
      lines.push([start, y]);
      start = null;
    }
  }
  if (start !== null) lines.push([start, height]);
  return lines.filter(([a, b]) => b - a >= minHeight);
}

/** 欄位裁切的預設左右留白（0073 工單任務 2 的裁定，跟 Python 端 col_trim_image 同一個數字）。 */
export const MAP_COL_TRIM_MARGIN = 2;

/**
 * 0073 工單任務 2：垂直投影，把一行文字左右的空白裁掉（左右各留 margin px）。
 * 逐字對照 `tools/ocr_golden.py`／`tools/map_settings_probe.py` 的 `col_trim_image()`：
 * 找不到任何一欄亮度 > threshold 的像素（整行都暗）就回傳 `[0, width]`（不裁，
 * 呼叫端據此判斷不用重新裁圖），不然會裁成 0 寬。
 * @param {Uint8ClampedArray|Uint8Array} gray 單通道灰階，長度 width*height（傳整行的灰階，不是整塊地圖）
 * @param {number} width
 * @param {number} height
 * @param {number} threshold
 * @param {number} margin
 * @returns {[number, number]} [x0（含）, x1（不含）]
 */
export function trimColumns(gray, width, height, threshold = MAP_LINE_SPLIT_THRESHOLD, margin = MAP_COL_TRIM_MARGIN) {
  let x0 = -1;
  let x1 = -1;
  for (let x = 0; x < width; x++) {
    let bright = false;
    for (let y = 0; y < height; y++) {
      if (gray[y * width + x] > threshold) {
        bright = true;
        break;
      }
    }
    if (bright) {
      if (x0 === -1) x0 = x;
      x1 = x;
    }
  }
  if (x0 === -1) return [0, width];
  const left = Math.max(0, x0 - margin);
  const right = Math.min(width, x1 + 1 + margin);
  if (right <= left) return [0, width];
  return [left, right];
}

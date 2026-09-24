// onnxruntime-web 引擎：載入 ort、兩顆 rec 模型、兩份字典；recognize() 跑一次辨識。
//
// 正式流程跑在 Worker 裡（見 worker.mjs），因為 onnxruntime-web 用 WASM，
// 載入/推論會擋住主執行緒。這支檔案本身只用到 OffscreenCanvas／fetch／
// Cache Storage，主執行緒跟 Worker 都有，所以 `tests/ocr.html` 為了比對方便
// 直接在主執行緒 import 這支檔案跑（不透過 worker.mjs 的訊息協定），
// 測的是同一份辨識邏輯，只差執行緒。
//
// 對照 exp-tracker/src/ocr.py 的 `_preprocess()` + RapidOCR 內部
// `resize_norm_img()`：
//   1. preprocess：none／gray／gray_invert
//   2. 放大 upscale 倍（cv2.INTER_CUBIC；這裡用 canvas
//      imageSmoothingQuality='high' 近似，golden 過不了再換自己寫的 cubic）
//   3. resize 到高度 48（cv2 預設 INTER_LINEAR；用 canvas 預設平滑近似）
//   4. BGR、正規化到 [-1,1]、CHW、padding 到 imgWidth（ctc.mjs 的
//      `toChwBgrNormalized()`）
//   5. 丟給 onnxruntime-web 推論
//   6. CTC 解碼（ctc.mjs 的 `ctcDecode()`）
//
// 不用 det、不用 cls（計畫書 §5.2）：永遠把裁進來的整張圖當一行辨識。

import {
  REC_IMG_HEIGHT,
  REC_IMG_WIDTH_DEFAULT,
  resizeTarget,
  toChwBgrNormalized,
  loadDict,
  ctcDecode,
  toGray,
  invert,
  resizeBicubic,
  resizeBilinear,
} from "./ctc.mjs";

// 一顆模型與字典的檔名（相對這支檔案，也就是 src/ocr/ 底下再往上兩層）。
// 0071 起只用 ch（簡體）：地圖主文字改用 ch 讀（計畫書 §5.2 規劃端裁定），
// chinese_cht 整顆拿掉（無 det 場景下讀不準，16 種設定組合實測過，見 0073-回報.md）。
const MODEL_FILES = {
  ch: { onnx: "../../models/ch_PP-OCRv4_rec_mobile.onnx", dict: "../../models/ch_dict.txt" },
};

// 0071 起改版（少了 chinese_cht 模型，約 11MB），key 改掉才不會讓舊訪客的
// Cache Storage 還抱著已經刪除的 cht 檔案（工單前提澄清「陷阱」明講）。
const CACHE_NAME = "kc-models-v2";

/**
 * 用 Cache Storage 存一份 onnx／字典檔，第二次開不重抓（照計畫書 §5.1 的裁定，
 * kafuffu 的做法：key 固定 `kc-models-v1`）。抓不到快取（隱私模式／被擋）時
 * 直接退回普通 fetch，不影響功能。
 * @param {string} url
 * @returns {Promise<Response>}
 */
async function cachedFetch(url) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) return hit;
    const resp = await fetch(url);
    if (resp.ok) {
      try {
        await cache.put(url, resp.clone());
      } catch {
        // Cache Storage 寫入失敗（容量、隱私模式）不影響本次使用
      }
    }
    return resp;
  } catch {
    return fetch(url);
  }
}

/**
 * 載入 ort、兩顆模型、兩份字典。
 * @param {(info: {stage: string, loaded?: number, total?: number}) => void} [progress]
 */
export async function createEngine(progress = () => {}) {
  const baseUrl = new URL(".", import.meta.url);
  const ort = await import(new URL("../../vendor/ort.wasm.min.mjs", baseUrl).href);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = new URL("../../vendor/", baseUrl).href;

  const sessions = {};
  const dicts = {};

  const langs = Object.keys(MODEL_FILES);
  let doneBytes = 0;
  // 一顆模型約 11MB（0071 起只剩 ch，計畫書§5.2），先抓已知大小當進度分母，
  // 抓到真的 content-length 再校正。
  let totalBytes = 11 * 1024 * 1024;

  for (const lang of langs) {
    const files = MODEL_FILES[lang];
    const onnxUrl = new URL(files.onnx, baseUrl).href;
    const dictUrl = new URL(files.dict, baseUrl).href;

    progress({ stage: "model:" + lang, loaded: doneBytes, total: totalBytes });
    const onnxResp = await cachedFetch(onnxUrl);
    if (!onnxResp.ok) throw new Error("模型下載失敗：" + onnxUrl);
    const contentLength = Number(onnxResp.headers.get("content-length") || 0);
    if (contentLength) totalBytes = Math.max(totalBytes, doneBytes + contentLength);
    const onnxBuf = await onnxResp.arrayBuffer();
    doneBytes += onnxBuf.byteLength;
    progress({ stage: "model:" + lang, loaded: doneBytes, total: totalBytes });

    sessions[lang] = await ort.InferenceSession.create(new Uint8Array(onnxBuf), {
      executionProviders: ["wasm"],
    });

    const dictResp = await cachedFetch(dictUrl);
    if (!dictResp.ok) throw new Error("字典下載失敗：" + dictUrl);
    const dictText = await dictResp.text();
    dicts[lang] = loadDict(dictText);
  }

  progress({ stage: "ready", loaded: totalBytes, total: totalBytes });

  return {
    /**
     * 辨識一張 ImageBitmap。
     * @param {ImageBitmap} bitmap
     * @param {{lang?: 'ch'|'chinese_cht', upscale?: number, preprocess?: 'none'|'gray'|'gray_invert'}} opts
     * @returns {Promise<{text: string, score: number}>}
     */
    async recognize(bitmap, opts = {}) {
      return recognizeWith(ort, sessions, dicts, bitmap, opts);
    },
    /**
     * 0073 工單任務 1（逐階段對齊診斷）用：跳過前處理，直接把一份已經算好的
     * `[1,3,H,W]` float32 tensor 餵進模型，回傳還沒 CTC 解碼的原始輸出
     * （`{data, dims}`，`dims` 是 `[1,T,C]`）。只給 `tests/stages.html` 用，
     * 正式流程（`recognize()`）不會呼叫這個函式。
     * @param {'ch'|'chinese_cht'} lang
     * @param {Float32Array} tensor
     * @param {number[]} dims [1,3,imgHeight,imgWidth]
     */
    async runRaw(lang, tensor, dims) {
      const session = sessions[lang];
      if (!session) throw new Error("沒有這個語言的模型：" + lang);
      const inputName = session.inputNames[0];
      const outputName = session.outputNames[0];
      const feeds = { [inputName]: new ort.Tensor("float32", tensor, dims) };
      const results = await session.run(feeds);
      const output = results[outputName];
      return { data: output.data, dims: output.dims };
    },
    dicts,
  };
}

async function recognizeWith(ort, sessions, dicts, bitmap, opts) {
  const lang = opts.lang || "ch";
  const upscale = opts.upscale && opts.upscale > 1 ? opts.upscale : 1;
  const preprocess = opts.preprocess || "none";

  const w0 = bitmap.width;
  const h0 = bitmap.height;
  if (w0 === 0 || h0 === 0) return { text: "", score: 0 };

  // 1. 取原始 RGBA（只用 canvas 拿像素，縮放數學自己算，不靠
  //    imageSmoothingQuality——golden 比對過，canvas 內建平滑跟 cv2 的
  //    INTER_CUBIC／INTER_LINEAR 差太多，見 ctc.mjs 檔頭說明）
  const srcCanvas = new OffscreenCanvas(w0, h0);
  const sctx = srcCanvas.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(bitmap, 0, 0);
  let rgba = sctx.getImageData(0, 0, w0, h0).data;

  // 2. preprocess（先轉圖，才放大——順序照 ocr.py `_preprocess()`）
  if (preprocess === "gray" || preprocess === "gray_invert") {
    rgba = toGray(rgba);
    if (preprocess === "gray_invert") rgba = invert(rgba);
  }

  // 3. 放大 upscale 倍（cv2.INTER_CUBIC，自己寫的 cubic convolution，a=-0.5）
  let w1 = w0;
  let h1 = h0;
  let upRgba = rgba;
  if (upscale > 1) {
    w1 = w0 * upscale;
    h1 = h0 * upscale;
    upRgba = resizeBicubic(new Uint8ClampedArray(rgba), w0, h0, w1, h1);
  }

  // 4. resize 到高度 48（cv2 預設 INTER_LINEAR，自己寫的雙線性）
  const { resizedW, imgWidth, imgHeight } = resizeTarget(w1, h1, REC_IMG_HEIGHT, REC_IMG_WIDTH_DEFAULT);
  const finalData = resizeBilinear(new Uint8ClampedArray(upRgba), w1, h1, Math.max(1, resizedW), imgHeight);

  // 5. 打包成 [1,3,imgHeight,imgWidth] tensor
  const tensor = toChwBgrNormalized(finalData, resizedW, imgHeight, imgWidth);

  // 6. 推論
  const session = sessions[lang];
  if (!session) throw new Error("沒有這個語言的模型：" + lang);
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const feeds = { [inputName]: new ort.Tensor("float32", tensor, [1, 3, imgHeight, imgWidth]) };
  const results = await session.run(feeds);
  const output = results[outputName];
  const dims = output.dims; // [1, T, C]
  const T = dims[1];
  const C = dims[2];

  // 7. CTC 解碼
  return ctcDecode(output.data, T, C, dicts[lang]);
}

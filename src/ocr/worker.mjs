// OCR 跑在這支 Web Worker 裡：主執行緒只用 postMessage 傳 ImageBitmap
// （transfer，不複製），worker 算完文字與分數再傳回去。
//
// 0070 工單任務 4：自動定位（locate.mjs 的 NCC）也跑在這支 worker（跟 OCR
// 共用同一個，工單前提澄清「可以跟 OCR 同一個 worker，或另開一個，執行者
// 定」）——NCC 一次要 10 秒上下（見 locate.mjs 檔頭的效能說明），放主執行緒
// 會整個凍住畫面，一定要丟到 worker。
//
// 訊息協定：
//   主執行緒 -> worker
//     { type: 'init' }
//     { type: 'recognize', id, bitmap, lang, upscale, preprocess }
//     { type: 'locate', id, bitmap }   // bitmap 是整張擷取畫面
//   worker -> 主執行緒
//     { type: 'progress', stage, loaded, total }
//     { type: 'ready' }
//     { type: 'result', id, text, score }
//     { type: 'locate_result', id, result }   // result 是 locate() 的回傳值或 null
//     { type: 'error', id?, message }

import { createEngine } from "./engine.mjs";
import { locate } from "../locate.mjs";

let enginePromise = null;
let templatesPromise = null;

function getEngine() {
  if (!enginePromise) {
    enginePromise = createEngine((info) => {
      postMessage({ type: "progress", ...info });
    });
  }
  return enginePromise;
}

function bitmapToGray(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  const gray = new Uint8Array(bitmap.width * bitmap.height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = Math.round((data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000);
  }
  return { data: gray, width: bitmap.width, height: bitmap.height };
}

async function loadTemplateGray(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("模板下載失敗：" + url);
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob);
  const gray = bitmapToGray(bitmap);
  bitmap.close();
  return gray;
}

function getTemplates() {
  if (!templatesPromise) {
    const baseUrl = new URL("../../templates/", import.meta.url);
    templatesPromise = Promise.all([
      loadTemplateGray(new URL("lv.png", baseUrl).href),
      loadTemplateGray(new URL("shop.png", baseUrl).href),
    ]).then(([lv, shop]) => ({ lv, shop }));
  }
  return templatesPromise;
}

self.onmessage = async (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "init") {
    try {
      await getEngine();
      postMessage({ type: "ready" });
    } catch (err) {
      postMessage({ type: "error", message: String(err && err.message ? err.message : err) });
    }
    return;
  }

  if (msg.type === "recognize") {
    const { id, bitmap, lang, upscale, preprocess } = msg;
    try {
      const engine = await getEngine();
      const { text, score } = await engine.recognize(bitmap, { lang, upscale, preprocess });
      postMessage({ type: "result", id, text, score });
    } catch (err) {
      postMessage({ type: "error", id, message: String(err && err.message ? err.message : err) });
    } finally {
      if (bitmap && typeof bitmap.close === "function") bitmap.close();
    }
    return;
  }

  if (msg.type === "locate") {
    const { id, bitmap } = msg;
    try {
      const templates = await getTemplates();
      const gray = bitmapToGray(bitmap);
      const result = locate(gray.data, gray.width, gray.height, templates);
      postMessage({ type: "locate_result", id, result });
    } catch (err) {
      postMessage({ type: "error", id, message: String(err && err.message ? err.message : err) });
    } finally {
      if (bitmap && typeof bitmap.close === "function") bitmap.close();
    }
    return;
  }
};

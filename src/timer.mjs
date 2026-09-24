// 計時器一律走 Worker（計畫書 §8）：Chrome 背景分頁會把主執行緒的
// setTimeout/setInterval 節流到 1 秒、5 分鐘後 1 分鐘，慢迴圈用主執行緒 timer
// 會整個死掉。做法照 0070 工單「開始前」指的參考實作：Worker 裡開一個
// setInterval，用 postMessage 通知主執行緒，Worker 自己的計時不受分頁背景/
// 最小化影響。
//
// 用 Blob URL 建 Worker，內容就一行 `setInterval(()=>postMessage(0), ms)`，
// 不需要另外的 .js 檔案。

/**
 * 每隔 ms 毫秒呼叫一次 fn，回傳 stop() 可以停止。
 * @param {() => void} fn
 * @param {number} ms
 * @returns {() => void} stop
 */
export function every(fn, ms) {
  const src = `setInterval(()=>postMessage(0), ${Math.max(1, Math.floor(ms))});`;
  const blob = new Blob([src], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  worker.onmessage = () => fn();
  return function stop() {
    worker.onmessage = null;
    worker.terminate();
  };
}

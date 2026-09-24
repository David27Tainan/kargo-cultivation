// 擷取遊戲畫面（計畫書 §4）：Chrome「分享視窗」→ MediaStreamTrack →
// ImageCapture.grabFrame()。
//
// 座標原點＝分享畫面的左上角。Chrome 分享「視窗」給的是含邊框的整張視窗畫面
// （跟桌面版 WGC frame 是同一種東西），跟 `GetWindowRect` 對不上，這支模組
// 不處理那段換算——那是 regions.mjs／locate.mjs 的事，這裡只負責「怎麼拿到
// 一張畫面」。
//
// 拿畫面用 `ImageCapture.grabFrame()`，不用 `drawImage(video)`：分頁在背景
// 時 `<video>` 元素可能停在舊畫面，`grabFrame()` 不會（0070 工單前提澄清 (5)、
// 計畫書 §4）。

const DEFAULT_CONSTRAINTS = {
  video: {
    frameRate: { ideal: 4, max: 8 },
    // 一定要給很大的 ideal，否則 Chrome 可能把分享的視窗縮小送過來，座標全歪
    // （計畫書 §4）。
    width: { ideal: 4096 },
    height: { ideal: 4096 },
  },
  audio: false,
};

// grabFrame() 逾時秒數（0070 工單任務 2）。
const GRAB_TIMEOUT_MS = 2500;

/**
 * 跟使用者要求分享一個視窗／畫面，回傳擷取控制物件。
 *
 * 回傳物件：
 *   track        MediaStreamTrack，`track.getSettings()` 可以查實際尺寸
 *   size         目前已知的畫面尺寸 { width, height }（第一次要 grab 過一次才準）
 *   grabFrame()  拿一張畫面（ImageBitmap），逾時 2.5 秒會 reject；
 *                呼叫端用完 bitmap 一定要呼叫 `bitmap.close()`，不然記憶體會一直漲
 *                （每秒好幾張 1000×800 上下的圖，幾秒鐘就是幾百 MB）。
 *   onEnded(fn)      使用者自己在瀏覽器停止分享時觸發（對應 track.onended）
 *   onSizeChange(fn) 兩次 grab 拿到的尺寸不一樣時觸發（自動定位快取要用這個訊號清快取）
 *   close()          主動結束分享
 */
export async function connect(constraints = DEFAULT_CONSTRAINTS) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    throw new Error("此瀏覽器不支援分享視窗（getDisplayMedia），請用電腦版 Chrome。");
  }

  const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
  const track = stream.getVideoTracks()[0];
  if (!track) {
    throw new Error("分享的畫面沒有視訊軌。");
  }
  const imageCapture = new ImageCapture(track);

  const listeners = { ended: [], sizechange: [] };
  function emit(name, detail) {
    for (const fn of listeners[name]) {
      try {
        fn(detail);
      } catch (err) {
        // 監聽者自己的錯誤不能把擷取流程打斷
        console.error("[capture] listener 錯誤", err);
      }
    }
  }

  track.addEventListener("ended", () => emit("ended"));

  const settings = typeof track.getSettings === "function" ? track.getSettings() : {};
  let size = { width: settings.width || 0, height: settings.height || 0 };

  async function grabFrame() {
    const pending = imageCapture.grabFrame();
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        // 逾時之後如果那張圖其實晚了才進來，要記得關掉，不要洩漏
        pending.then(
          (bitmap) => bitmap.close && bitmap.close(),
          () => {}
        );
        reject(new Error("grabFrame 逾時（超過 " + GRAB_TIMEOUT_MS + "ms）"));
      }, GRAB_TIMEOUT_MS);
    });

    let bitmap;
    try {
      bitmap = await Promise.race([pending, timeout]);
    } finally {
      clearTimeout(timer);
    }

    if (bitmap.width !== size.width || bitmap.height !== size.height) {
      const prev = size;
      size = { width: bitmap.width, height: bitmap.height };
      emit("sizechange", { prev, size });
    }
    return bitmap;
  }

  return {
    track,
    get size() {
      return size;
    },
    grabFrame,
    onEnded(fn) {
      listeners.ended.push(fn);
    },
    onSizeChange(fn) {
      listeners.sizechange.push(fn);
    },
    close() {
      track.stop();
    },
  };
}

export { DEFAULT_CONSTRAINTS, GRAB_TIMEOUT_MS };

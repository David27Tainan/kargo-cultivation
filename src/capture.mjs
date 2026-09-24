// 擷取遊戲畫面（計畫書 §4）：Chrome「分享視窗」→ MediaStreamTrack → 畫面。
//
// 座標原點＝分享畫面的左上角。Chrome 分享「視窗」給的是含邊框的整張視窗畫面
// （跟桌面版 WGC frame 是同一種東西），跟 `GetWindowRect` 對不上，這支模組
// 不處理那段換算——那是 regions.mjs／locate.mjs 的事，這裡只負責「怎麼拿到
// 一張畫面」。
//
// 0082 工單（W5）改版：`ImageCapture.grabFrame()` 在分頁被瀏覽器背景節流時
// 大量逾時（GRAB_TIMEOUT_MS 2.5 秒 reject），實測提案人分頁在背景時快慢
// 迴圈都拿不到畫面，慢迴圈樣本間隔從該有的 10 秒暴增到 3～10 分鐘（見
// 派工單/0082-回報.md 診斷文字證據）——這是 Chrome 對 display-capture track
// 用 `ImageCapture.grabFrame()` 的已知問題，不是這個專案的 OCR／統計邏輯壞掉。
//
// 改用 `MediaStreamTrackProcessor`（WebCodecs，Chrome 94+）把 track 轉成
// `ReadableStream<VideoFrame>`，用一個不間斷的 read 迴圈持續消費、只保留
// 「最新一張」（舊的立刻 `close()`，不要用 videoFrame 堆記憶體）——這條路徑
// 是瀏覽器原生媒體管線在推送，不像 `grabFrame()` 那樣每次都要重新跟合成器
// 要一張新畫面，對分頁背景節流更穩定。`grabFrame()` 對外的呼叫端介面完全不
// 變（`captureHandle.grabFrame()` 還是回傳一張 `ImageBitmap`，呼叫端一樣要
// `bitmap.close()`）——`grabFrame()` 內部只是把「目前最新的 VideoFrame」轉成
// `ImageBitmap`（`createImageBitmap()` 接受 VideoFrame 是 CanvasImageSource
// 的一員，Chrome 94+ 支援），不會消耗掉那個 VideoFrame，下一次呼叫還是能用
// 同一張（除非 pump 迴圈已經換成更新的）。
//
// **沒有搬進 Worker**（工單原文「最好把 track 轉移到 Worker 裡讀…做不到就
// 留在主執行緒但用 stream 讀而不是 grabFrame」允許的退路）：transferable
// MediaStreamTrack 要 Chrome 121+，這張單的風險／時間預算內先解掉「grabFrame
// 逾時」這個已經證實的根因，主執行緒的 stream 讀取法本身就已經跟 grabFrame()
// 是不同的機制（不依賴 JS timer 節流，是瀏覽器原生管線推送），要不要再搬進
// Worker 留给下一張單評估，見回報單「需要決定的事」。
//
// `MediaStreamTrackProcessor` 不存在的瀏覽器（理論上不會發生，這個專案只鎖定
// 近期 Chrome，但保留退路）自動退回舊版 `ImageCapture.grabFrame()` 路徑。

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

// grabFrame() 逾時秒數（0070 工單任務 2；0082 沿用同一個數字當「stream 模式下
// 等待第一張/最新一張 VideoFrame 到位」的逾時上限，見 _buildHandle() 的
// grabFrame() 實作）。
const GRAB_TIMEOUT_MS = 2500;

// 診斷文字用：「最近 60 秒抓到幾張畫面、失敗幾次」的滑動視窗長度（0082 工單
// 任務 1(d)）。
const FRAME_STATS_WINDOW_MS = 60000;

function nowMs() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

/**
 * 跟使用者要求分享一個視窗／畫面，回傳擷取控制物件。
 *
 * 回傳物件：
 *   track            MediaStreamTrack，`track.getSettings()` 可以查實際尺寸
 *   size             目前已知的畫面尺寸 { width, height }（第一次要 grab 過一次才準）
 *   grabFrame()      拿一張畫面（ImageBitmap），逾時 2.5 秒會 reject；
 *                    呼叫端用完 bitmap 一定要呼叫 `bitmap.close()`，不然記憶體會一直漲
 *                    （每秒好幾張 1000×800 上下的圖，幾秒鐘就是幾百 MB）。
 *   onEnded(fn)      使用者自己在瀏覽器停止分享時觸發（對應 track.onended）
 *   onSizeChange(fn) 兩次 grab 拿到的尺寸不一樣時觸發（自動定位快取要用這個訊號清快取）
 *   close()          主動結束分享
 *   frameStats()     0082 新增：{captured, failed, usingStream} 最近 60 秒抓到/失敗張數，
 *                    診斷文字用（見 app.mjs `_buildDiagText()`）
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
  return _buildHandle(track);
}

/**
 * 0082 工單任務 2(b) 新增：跳過 `getDisplayMedia()`，直接用一個已經有的
 * `MediaStreamTrack` 建立跟 `connect()` 回傳值形狀完全一致的控制物件。
 * `getDisplayMedia()` 的原生分享選單需要真人點選（自動化工具點不到，見
 * 0070-回報單），這個入口讓 `tests/frame-anim.html` 可以用
 * `canvas.captureStream(fps)` 產生真的 `MediaStreamTrack` 走**這次新的
 * stream 讀取路徑**（不是假的 grabFrame handle），驗證「分頁背景時慢迴圈樣本
 * 還是每 10 秒一筆」這個修好的行為。
 * @param {MediaStreamTrack} track
 */
export async function connectFromTrack(track) {
  if (!track) throw new Error("connectFromTrack() 需要一個真的 MediaStreamTrack。");
  return _buildHandle(track);
}

function _buildHandle(track) {
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

  function noteSize(width, height) {
    if (width !== size.width || height !== size.height) {
      const prev = size;
      size = { width, height };
      emit("sizechange", { prev, size });
    }
  }

  // 0082 任務 1(d)：最近 60 秒抓到幾張／失敗幾次，只存時間戳，用的時候再篩窗。
  const captureTimestamps = [];
  const failureTimestamps = [];
  function recordCapture() {
    captureTimestamps.push(nowMs());
    trimStats(captureTimestamps);
  }
  function recordFailure() {
    failureTimestamps.push(nowMs());
    trimStats(failureTimestamps);
  }
  function trimStats(arr) {
    const cutoff = nowMs() - FRAME_STATS_WINDOW_MS;
    while (arr.length && arr[0] < cutoff) arr.shift();
  }
  function frameStats() {
    trimStats(captureTimestamps);
    trimStats(failureTimestamps);
    return { captured: captureTimestamps.length, failed: failureTimestamps.length, usingStream };
  }

  const usingStream = typeof MediaStreamTrackProcessor !== "undefined";
  let grabFrame;
  let closeExtra = () => {};

  if (usingStream) {
    ({ grabFrame, close: closeExtra } = _buildStreamGrabber(track, noteSize, recordCapture, recordFailure));
  } else {
    ({ grabFrame } = _buildImageCaptureGrabber(track, noteSize, recordCapture, recordFailure));
  }

  return {
    track,
    get size() {
      return size;
    },
    grabFrame,
    frameStats,
    onEnded(fn) {
      listeners.ended.push(fn);
    },
    onSizeChange(fn) {
      listeners.sizechange.push(fn);
    },
    close() {
      closeExtra();
      track.stop();
    },
  };
}

/**
 * 0082 新增的主要路徑：`MediaStreamTrackProcessor` 把 track 轉成
 * `ReadableStream<VideoFrame>`，用一個不間斷的 read 迴圈持續消費，只保留
 * 「最新一張」（`latestFrame`，舊的立刻 close 掉，不要堆記憶體）。
 * `grabFrame()` 只是把目前的 `latestFrame` 轉成 `ImageBitmap`，不消耗它。
 */
function _buildStreamGrabber(track, noteSize, recordCapture, recordFailure) {
  const processor = new MediaStreamTrackProcessor({ track });
  const reader = processor.readable.getReader();
  let latestFrame = null;
  let stopped = false;
  let lastError = null;

  (async function pump() {
    while (!stopped) {
      let result;
      try {
        result = await reader.read();
      } catch (err) {
        if (!stopped) {
          lastError = err;
          console.error("[capture] MediaStreamTrackProcessor read() 失敗", err);
        }
        return;
      }
      if (result.done) return;
      const frame = result.value;
      if (latestFrame) latestFrame.close();
      latestFrame = frame;
    }
  })();

  async function grabFrame() {
    const start = nowMs();
    // 剛連線那一瞬間可能還沒有任何 VideoFrame 進來，短暫輪詢等待（跟舊版
    // grabFrame() 逾時語意一致：等不到就當這次抓取失敗，呼叫端本來就有處理
    // 失敗的邏輯，不需要另外改 app.mjs）。
    while (!latestFrame && nowMs() - start < GRAB_TIMEOUT_MS) {
      if (stopped) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!latestFrame) {
      recordFailure();
      throw new Error(
        "grabFrame 逾時（超過 " + GRAB_TIMEOUT_MS + "ms，stream 模式還沒收到任何畫面）" +
          (lastError ? "；read() 曾經失敗：" + lastError.message : "")
      );
    }
    let bitmap;
    try {
      bitmap = await createImageBitmap(latestFrame);
    } catch (err) {
      recordFailure();
      throw err;
    }
    noteSize(bitmap.width, bitmap.height);
    recordCapture();
    return bitmap;
  }

  function close() {
    stopped = true;
    try {
      reader.cancel();
    } catch {
      // 忽略：track 可能已經結束
    }
    if (latestFrame) {
      latestFrame.close();
      latestFrame = null;
    }
  }

  return { grabFrame, close };
}

/**
 * 舊版路徑（0070～0081 唯一實作），`MediaStreamTrackProcessor` 不存在時的退路。
 * 這是已知會被分頁背景節流卡住的路徑（0082 查因結論），只當 fallback 用。
 */
function _buildImageCaptureGrabber(track, noteSize, recordCapture, recordFailure) {
  const imageCapture = new ImageCapture(track);

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
    } catch (err) {
      clearTimeout(timer);
      recordFailure();
      throw err;
    } finally {
      clearTimeout(timer);
    }

    noteSize(bitmap.width, bitmap.height);
    recordCapture();
    return bitmap;
  }

  return { grabFrame };
}

export { DEFAULT_CONSTRAINTS, GRAB_TIMEOUT_MS };

// 翻 exp-tracker/src/regions.py：anchor 換算 + 退路預設校準值。
//
// 座標原點跟桌面版不一樣（0070 工單前提澄清 (1)）：Chrome 分享「視窗」給的
// 是含邊框的整張視窗畫面，跟桌面版 WGC frame 是同一種東西，WGC frame 比
// `GetWindowRect` 少一圈邊框（桌面版實測 `(7,0)`）。這張單主要靠自動定位
// （locate.mjs）拿 exp/level 的框，這裡的 DEFAULTS 只在定位失敗時當退路。

export const VALID_ANCHORS = ["top-left", "top-right", "bottom-left", "bottom-right"];

/**
 * 依區域中心落在畫面的哪個象限，猜它是貼著哪個角（逐字對照 regions.py 的
 * guess_anchor()）。
 * @param {{left:number, top:number, width:number, height:number}} region
 * @param {number} frameWidth
 * @param {number} frameHeight
 */
export function guessAnchor(region, frameWidth, frameHeight) {
  const cx = region.left + region.width / 2;
  const cy = region.top + region.height / 2;
  const vertical = cy > frameHeight / 2 ? "bottom" : "top";
  const horizontal = cx > frameWidth / 2 ? "right" : "left";
  return vertical + "-" + horizontal;
}

/**
 * anchor 換算後的 (left, top)——相對畫面左上角。逐字對照 regions.py 的
 * `_anchor_adjusted()`。
 * @param {{left:number, top:number, anchor?:string}} region
 * @param {number} frameWidth
 * @param {number} frameHeight
 * @param {{width:number, height:number}|null} calibratedSize
 */
export function anchorAdjusted(region, frameWidth, frameHeight, calibratedSize) {
  let dx = 0;
  let dy = 0;
  if (calibratedSize && calibratedSize.width && calibratedSize.height) {
    dx = frameWidth - calibratedSize.width;
    dy = frameHeight - calibratedSize.height;
  }

  let anchor = region.anchor || "top-left";
  if (!VALID_ANCHORS.includes(anchor)) anchor = "top-left";

  const left = region.left + (anchor.endsWith("right") ? dx : 0);
  const top = region.top + (anchor.startsWith("bottom") ? dy : 0);
  return [left, top];
}

/**
 * 回傳這塊區域現在相對「分享畫面左上角」的 (left, top, width, height)。
 * 瀏覽器版只有這一種座標系（沒有桌面版 resolve() 那種再加螢幕座標的版本，
 * 因為 getDisplayMedia 給的畫面本身就是全部我們拿得到的座標系）。
 * 對照 regions.py 的 `resolve_relative()`。
 * @param {{left:number, top:number, width:number, height:number, anchor?:string}} region
 * @param {number} frameWidth
 * @param {number} frameHeight
 * @param {{width:number, height:number}|null} calibratedSize
 */
export function resolveRelative(region, frameWidth, frameHeight, calibratedSize) {
  const [left, top] = anchorAdjusted(region, frameWidth, frameHeight, calibratedSize);
  return { left, top, width: region.width, height: region.height };
}

/**
 * 把一個 [x1,y1,x2,y2] 框往外（或往內，pad 可以是負的）擴張 pad px，
 * 上下左右各自加減 pad。0075 號工單：`locate.mjs` 的 NCC 定位精度容差是
 * ≤1px，這 1px 剛好會切到緊貼邊界的字元（見 0074-回報.md「等級讀成 5」的
 * 查因），`app.mjs` 用這個把 `locate()` 算出的 level 框往外擴 1px 吸收這個
 * 誤差——**只有 level 這塊需要**，exp 本來裁圖就有留白。Python 沒有這 1px，
 * 是網頁版自己的裁定（見 CLAUDE.md「0075 踩到的坑」）。
 * @param {[number,number,number,number]} box
 * @param {number} pad
 * @returns {[number,number,number,number]}
 */
export function expandBox(box, pad) {
  const [x1, y1, x2, y2] = box;
  return [x1 - pad, y1 - pad, x2 + pad, y2 + pad];
}

/**
 * 畫面尺寸跟校準時不一樣的話，回傳現在的 [寬,高]；一樣或沒紀錄就回 null。
 * 對照 regions.py 的 `size_changed()`。
 */
export function sizeChanged(frameWidth, frameHeight, calibratedSize) {
  if (!calibratedSize || !calibratedSize.width || !calibratedSize.height) return null;
  if (frameWidth === calibratedSize.width && frameHeight === calibratedSize.height) return null;
  return [frameWidth, frameHeight];
}

// ---------------------------------------------------------------------------
// 任務 6：退路預設校準值（0074 工單定案）。
//
// 量自提案人在自己機器上用 Chrome「分享視窗」實際連線遊戲拿到的真實畫面
// （派工單/0074-evidence/share_frame_1368x800.png，2026-09-23），不是桌面版
// config.example.yaml 的佔位值。Chrome 分享「視窗」給的畫面是 1368×800，
// 比桌面版 GetWindowRect 少 14 寬、7 高（左右各 7px、底 7px 的隱形邊框被去
// 掉，頂部沒有）——原點位移跟桌面版 WGC frame 量到的一樣是 (7,0)（計畫書
// §4 的推測成立，見 0074-回報.md 前提澄清）。
export const DEFAULTS = {
  // 量自 1368×800 真實 Chrome 分享畫面，2026-09-23，見 派工單/0074-evidence。
  frameSize: { width: 1368, height: 800 },
  exp: { left: 807, top: 762, width: 182, height: 15, anchor: "bottom-right" },
  level: { left: 57, top: 775, width: 22, height: 13, anchor: "bottom-left" },
  map: { left: 45, top: 55, width: 73, height: 38, anchor: "top-left" },
};

// ---------------------------------------------------------------------------
// 0072 工單（W3）任務 3：校準頁「自動定位」用的基準（`locate.mjs` 的
// `locateAll()`）。桌面版 `uilocate.py` 的 `ANCHOR_BASE_POS`／`config.example.yaml`
// 座標是相對 `GetWindowRect`（提案人那台 1382×807）算的；這裡的瀏覽器分享畫面
// 已經是「WGC frame 那種」座標系（1368×800，見上面 DEFAULTS 的說明），所以
// 全部欄位都是桌面版的值 **left 減 7、top 不變**（0074 工單量到的原點位移
// (7,0)），不是重新量的——跟 DEFAULTS.exp/level/map 的推導方式一致（814-7=807、
// 64-7=57、52-7=45，逐一對得上）。panel／hp／mp 三塊、四個錨點基準位置一樣照
// 這個規則換算自 `exp-tracker/config.example.yaml` 與 `uilocate.py`
// `ANCHOR_BASE_POS`。
export const CALIBRATION_BASE = {
  frameSize: { width: 1368, height: 800 },
  regions: {
    exp: { ...DEFAULTS.exp },
    level: { ...DEFAULTS.level },
    map: { ...DEFAULTS.map },
    // config.example.yaml potions.panel_region: {left:1219,...} -> 1219-7=1212
    panel: { left: 1212, top: 648, width: 143, height: 69, anchor: "bottom-right" },
    // potions.hp_count_region: {left:1289,...} -> 1289-7=1282
    hp: { left: 1282, top: 702, width: 36, height: 13, anchor: "bottom-right" },
    // potions.mp_count_region: {left:1325,...} -> 1325-7=1318
    mp: { left: 1318, top: 702, width: 34, height: 13, anchor: "bottom-right" },
  },
  // uilocate.py ANCHOR_BASE_POS：{lv:(14,766), shop:(1012,764), minimap:(19,36),
  // quick:(1213,642)} -> x 各減 7。
  anchors: {
    lv: [7, 766],
    shop: [1005, 764],
    minimap: [12, 36],
    quick: [1206, 642],
  },
};

/**
 * 拖框／自動定位算出來的框 [x1,y1,x2,y2] -> 校準頁存的區域形狀
 * {left,top,width,height,anchor}，anchor 用 `guessAnchor()` 現場猜。
 * @param {[number,number,number,number]} box
 * @param {number} frameWidth
 * @param {number} frameHeight
 */
export function boxToRegion(box, frameWidth, frameHeight) {
  const [x1, y1, x2, y2] = box;
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  const anchor = guessAnchor({ left, top, width, height }, frameWidth, frameHeight);
  return { left, top, width, height, anchor };
}

/**
 * 寬高 ±（校準頁按鈕）：只改 width/height，left/top 不動（anchor 只在換算
 * 「貼哪個角」時用，儲存的座標本身永遠是左上角，跟桌面版 calibration_ui.py
 * 的 `resize_region()` 同精神）。寬高不會被減到 0 以下。
 * @param {{left:number, top:number, width:number, height:number, anchor?:string}} region
 * @param {number} dw
 * @param {number} dh
 */
export function resizeRegion(region, dw, dh) {
  return { ...region, width: Math.max(1, region.width + dw), height: Math.max(1, region.height + dh) };
}

/**
 * 方向鍵微調：left/top 各加 dx/dy（可以是負的），寬高不變。
 * @param {{left:number, top:number, width:number, height:number, anchor?:string}} region
 * @param {number} dx
 * @param {number} dy
 */
export function nudgeRegion(region, dx, dy) {
  return { ...region, left: region.left + dx, top: region.top + dy };
}

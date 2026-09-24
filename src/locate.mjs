// 翻 exp-tracker/src/uilocate.py 的 locate()：模板比對自動定位經驗／等級兩塊。
// 只翻 locate()（校準頁用的 locate_all() 是 0072／W3 的事，這張單不用）。
//
// 常數逐字對照 uilocate.py：
const TEMPLATE_DIST = 998.0;
const LV_OFFSET = [48, 10, 83, 23];
const EXP_OFFSET = [801, -5, 990, 10];
export const SCORE_THRESHOLD = 0.8;
const SCALE_MIN = 0.1;
const SCALE_MAX = 4.0;

/** np.linspace(0.5, 2.0, 30)。 */
export const SCALES = (() => {
  const n = 30;
  const start = 0.5;
  const stop = 2.0;
  const step = (stop - start) / (n - 1);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = start + step * i;
  out[n - 1] = stop; // 避免浮點誤差，最後一個值釘死
  return out;
})();

// ---------------------------------------------------------------------------
// 效能裁定（跟 uilocate.py 不一樣的地方，寫進回報單「裁定與偏離」）：
//
// Python 的 cv2.matchTemplate 用高度最佳化的原生程式碼，JS 沒有等價物，
// 暴力對每個像素位置、每個模板像素做乘加，實測（Node，1382×807 灰階圖、
// shop 模板 scale≈1.5、單一 scale）要 **6.9 秒**。30 個 scale × 2 張模板暴力
// 硬算會是好幾分鐘，不是工單原本估的「可能要幾秒」。
//
// 0070 版「每個 scale 各自粗篩（固定 4x 縮圖）＋精修」對某些畫面／模板組合
// 會選錯 scale（不是分數差一點，是完全跑到別的 scale 去）：0074 工單在真實
// 分享畫面 `share_frame_1368x800.png` 上抓到 `lv.png`（較小的模板）粗篩選中
// 錯的 scale、分數 0.722 沒過門檻，但直接對 Python 選的 scale 做全解析度
// NCC，JS 自己算出來是 0.952——**真正的峰值一直都在，只是縮太小（32×34 的
// lv 模板被縮成 8×8）、而且每個 scale 只留 1 個候選，峰值被縮圖的雜訊蓋過**。
// 0075 號工單改成：
//   1. **縮小倍率 `f` 自動算，不再寫死 4**：`f = max(1, floor(min(縮放後模板
//      寬,高) / MIN_COARSE_TEMPLATE_DIM))`，也就是縮完模板最短邊至少留
//      `MIN_COARSE_TEMPLATE_DIM`（12）像素——模板越小，縮得越少，8×8 這種
//      縮過頭的粗篩圖不會再出現。lv（32×34，scale 1.0）→ f=2；shop（109×34，
//      scale 1.0）→ f=2；scale 0.5 時 lv 縮成 16×17 → f=1（等於不粗篩，直接
//      全解析度搜）。
//   2. **每個 scale 的粗篩結果做非極大值抑制（NMS，半徑 NMS_RADIUS_BASE/f，
//      粗篩格點座標）後取前 TOP_K 個候選**，不再只留 1 個。0070 版「縮到
//      4×4 隨便都能湊出偏高粗篩分數」這個坑，光靠「留最佳 1 個」沒辦法
//      分辨「真正的峰值剛好被縮圖抹平成第 2、3 名」跟「粗篩本身就找錯地方」
//      ——多留幾個候選、每個都送去原解析度精修比分數，才不會漏掉被縮圖蓋過
//      的真峰值。
//   3. 每個候選在原解析度 ±(2f+2) px 視窗精修，取這 TOP_K 個候選裡精修分數
//      最高的當這個 scale 的答案；30 個 scale 之間比較的還是精修過的全解析度
//      分數（0070 的裁定不變：直接跨 scale 比粗篩分數是錯的）。
//   4. 縮小後模板兩邊都 < MIN_COARSE_TEMPLATE_DIM（f 算出來是 1）：跟 0070 版
//      一樣，乾脆直接在**原始解析度整張圖**做一次 NCC，不需要粗篩／NMS。
//
// 粗篩用的縮小圖金字塔按 `f` 的實際值延遲建立、快取在 `locate()` 呼叫期間
// 共用的 Map 裡（lv／shop 兩張模板、30 個 scale 下來 `f` 只會落在少數幾個
// 整數值，不用每個 scale 都重新縮一次整張圖）。
//
// 前提：真正的比對峰值又強又孤立（HUD 圖示對整張畫面，門檻 0.8 已經很高）。
// `tools/locate_golden.py` 產的 golden 跟這支比對過（見回報單），
// 位置誤差 ≤1px。單次定位時間上限見 0075-回報.md（工單訂 ≤20 秒）。
export const MIN_COARSE_TEMPLATE_DIM = 12; // 縮完模板最短邊至少留這麼多 px 才夠可靠
export const TOP_K = 5; // 每個 scale 粗篩後留幾個候選送去精修
export const NMS_RADIUS_BASE = 8; // NMS 半徑 = NMS_RADIUS_BASE / f，單位是粗篩格點座標

// ---------------------------------------------------------------------------
// 積分圖（sum 與 sum of squares），O(1) 查詢任一矩形窗口的和。

export function buildIntegral(gray, W, H) {
  const stride = W + 1;
  const integral = new Float64Array(stride * (H + 1));
  const integralSq = new Float64Array(stride * (H + 1));
  for (let y = 0; y < H; y++) {
    let rowSum = 0;
    let rowSumSq = 0;
    for (let x = 0; x < W; x++) {
      const v = gray[y * W + x];
      rowSum += v;
      rowSumSq += v * v;
      const idx = (y + 1) * stride + (x + 1);
      integral[idx] = integral[idx - stride] + rowSum;
      integralSq[idx] = integralSq[idx - stride] + rowSumSq;
    }
  }
  return { integral, integralSq, stride };
}

function windowSum(table, stride, x, y, w, h) {
  const a = y * stride + x;
  const b = y * stride + (x + w);
  const c = (y + h) * stride + x;
  const d = (y + h) * stride + (x + w);
  return table[d] - table[b] - table[c] + table[a];
}

/**
 * TM_CCOEFF_NORMED，在 `gray`（W×H）裡對 `template`（tw×th）搜尋，範圍限制在
 * [searchBox.x0, searchBox.x1] × [searchBox.y0, searchBox.y1]（含端點，座標是
 * 模板左上角能落的範圍）。`searchBox` 省略時搜整張圖。
 *
 * `integralData`：`{integral, integralSq, stride}`，呼叫端**必須**先用
 * `buildIntegral(gray, W, H)` 算好、在同一張圖／同一個 pyramid 層級的多次
 * 搜尋之間重複使用——積分圖只跟 `gray` 有關，跟模板、scale、視窗都無關。
 * 第一版每次搜尋都重新 `buildIntegral()`（O(W*H)，還配置兩個
 * `Float64Array(W*H)` 大小的陣列），30 個 scale × 2 張模板下來反覆配置、
 * GC 的成本主導了整個定位時間（實測從 23.8 秒降到遠低於這個數字，見
 * 0070-回報單），所以拆成「呼叫端建一次、傳進來重複用」。
 * @returns {{score:number, x:number, y:number}} 找不到合法位置時 score=-Infinity
 */
function nccSearch(gray, W, H, template, tw, th, integralData, searchBox) {
  const N = tw * th;
  if (N === 0 || tw > W || th > H) return { score: -Infinity, x: 0, y: 0 };

  let tSum = 0;
  let tSumSq = 0;
  for (let i = 0; i < template.length; i++) {
    tSum += template[i];
    tSumSq += template[i] * template[i];
  }
  const tMean = tSum / N;
  const denomT = Math.max(0, tSumSq - N * tMean * tMean);

  const { integral, integralSq, stride } = integralData;

  const maxX = W - tw;
  const maxY = H - th;
  let x0 = 0;
  let y0 = 0;
  let x1 = maxX;
  let y1 = maxY;
  if (searchBox) {
    x0 = Math.max(0, searchBox.x0);
    y0 = Math.max(0, searchBox.y0);
    x1 = Math.min(maxX, searchBox.x1);
    y1 = Math.min(maxY, searchBox.y1);
  }

  // 熱路徑：把 windowSum() 展開成內聯運算（避免函式呼叫開銷）——30 個 scale
  // 下來這個迴圈是全場最貴的部分，第一版量過 inline 前後差好幾倍，見
  // 0070-回報單「掃描毫秒數」那條。
  let best = -Infinity;
  let bx = 0;
  let by = 0;
  for (let y = y0; y <= y1; y++) {
    const rowTop = y * stride;
    const rowBot = (y + th) * stride;
    for (let x = x0; x <= x1; x++) {
      const winSum = integral[rowBot + x + tw] - integral[rowTop + x + tw] - integral[rowBot + x] + integral[rowTop + x];
      const winSumSq =
        integralSq[rowBot + x + tw] - integralSq[rowTop + x + tw] - integralSq[rowBot + x] + integralSq[rowTop + x];
      const iMean = winSum / N;
      const denomI = Math.max(0, winSumSq - N * iMean * iMean);
      let cross = 0;
      for (let j = 0; j < th; j++) {
        const rowBase = (y + j) * W + x;
        const tBase = j * tw;
        for (let i = 0; i < tw; i++) cross += gray[rowBase + i] * template[tBase + i];
      }
      const numerator = cross - N * iMean * tMean;
      const denom = Math.sqrt(denomI * denomT);
      const score = denom > 0 ? numerator / denom : 0;
      if (score > best) {
        best = score;
        bx = x;
        by = y;
      }
    }
  }
  return { score: best, x: bx, y: by };
}

/**
 * 跟 `nccSearch()` 算的是同一個分數，差別是**整張圖每個位置的分數都留下來**
 * （回傳一整個格點陣列），給粗篩階段的 NMS + top-K 用。0075 號工單新增：
 * 0070 版的粗篩只留 argmax，縮到很小的模板容易被縮圖雜訊蓋過真正的峰值
 * （見上面「效能裁定」那段的說明），要多留幾個候選才能挑出被蓋過的那個。
 *
 * **成本跟 `nccSearch()` 全圖搜尋一樣**：內層雙迴圈本來就要掃過整個搜尋範圍
 * 才能找到 argmax，這裡只是把「比較後只留最大值」換成「存進陣列」，不多掃
 * 一次。只給粗篩（縮小圖）用，不要拿去對原始解析度整張圖跑——全解析度格點
 * 太多，NMS/top-K 掃描會變貴。
 *
 * @returns {{scores:Float32Array, gw:number, gh:number}|null} scores[y*gw+x]
 *   是模板左上角落在 (x,y) 的分數；找不到合法搜尋範圍回 null。
 */
function nccSearchAll(gray, W, H, template, tw, th, integralData) {
  const N = tw * th;
  if (N === 0 || tw > W || th > H) return null;

  let tSum = 0;
  let tSumSq = 0;
  for (let i = 0; i < template.length; i++) {
    tSum += template[i];
    tSumSq += template[i] * template[i];
  }
  const tMean = tSum / N;
  const denomT = Math.max(0, tSumSq - N * tMean * tMean);

  const { integral, integralSq, stride } = integralData;
  const maxX = W - tw;
  const maxY = H - th;
  const gw = maxX + 1;
  const gh = maxY + 1;
  const scores = new Float32Array(gw * gh);

  for (let y = 0; y <= maxY; y++) {
    const rowTop = y * stride;
    const rowBot = (y + th) * stride;
    const rowOut = y * gw;
    for (let x = 0; x <= maxX; x++) {
      const winSum = integral[rowBot + x + tw] - integral[rowTop + x + tw] - integral[rowBot + x] + integral[rowTop + x];
      const winSumSq =
        integralSq[rowBot + x + tw] - integralSq[rowTop + x + tw] - integralSq[rowBot + x] + integralSq[rowTop + x];
      const iMean = winSum / N;
      const denomI = Math.max(0, winSumSq - N * iMean * iMean);
      let cross = 0;
      for (let j = 0; j < th; j++) {
        const rowBase = (y + j) * W + x;
        const tBase = j * tw;
        for (let i = 0; i < tw; i++) cross += gray[rowBase + i] * template[tBase + i];
      }
      const numerator = cross - N * iMean * tMean;
      const denom = Math.sqrt(denomI * denomT);
      scores[rowOut + x] = denom > 0 ? numerator / denom : 0;
    }
  }
  return { scores, gw, gh };
}

/**
 * 對 `nccSearchAll()` 的格點分數做非極大值抑制（NMS）+ 取前 K 名。
 * 做法是「找最大值 → 以它為圓心、半徑 `radius`（格點座標）內全部標記已用 →
 * 重複 K 次」，不是先整個排序——格點數可能有幾十萬個，K 只要 5，重複找
 * 最大值（O(K*n)）比排序整個陣列（O(n log n)）便宜。
 * @returns {{x:number, y:number, score:number}[]} 按分數由高到低，最多 K 個
 */
function topKWithNMS(all, K, radius) {
  const { scores, gw, gh } = all;
  const n = scores.length;
  const used = new Uint8Array(n);
  const picked = [];
  const r2 = radius * radius;

  for (let k = 0; k < K; k++) {
    let best = -Infinity;
    let bestIdx = -1;
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const s = scores[i];
      if (s > best) {
        best = s;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;

    const bx = bestIdx % gw;
    const by = (bestIdx / gw) | 0;
    picked.push({ x: bx, y: by, score: best });

    const xMin = Math.max(0, bx - radius);
    const xMax = Math.min(gw - 1, bx + radius);
    const yMin = Math.max(0, by - radius);
    const yMax = Math.min(gh - 1, by + radius);
    for (let y = yMin; y <= yMax; y++) {
      const dy = y - by;
      const rowBase = y * gw;
      for (let x = xMin; x <= xMax; x++) {
        const dx = x - bx;
        if (dx * dx + dy * dy <= r2) used[rowBase + x] = 1;
      }
    }
  }
  return picked;
}

// ---------------------------------------------------------------------------
// 單通道（灰階）縮放：模板縮放 Python 用 cv2.INTER_LANCZOS4（uilocate.py
// `_match_template()`），canvas 沒有對應的內建選項，自己寫。
//
// 一開始試過沿用 ctc.mjs 那套 Catmull-Rom bicubic（a=-0.5）近似，golden 比對
// 位置準（≤1px），但分數差到 0.02~0.03（門檻是 ≤0.02），換成這裡的
// Lanczos-4（8-tap windowed sinc）之後才穩定壓進門檻內，見回報單。

function clampIndex(i, n) {
  if (i < 0) return 0;
  if (i > n - 1) return n - 1;
  return i;
}

const LANCZOS_A = 4;

function sinc(x) {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

function lanczosWeight(x) {
  if (x === 0) return 1;
  if (x <= -LANCZOS_A || x >= LANCZOS_A) return 0;
  return sinc(x) * sinc(x / LANCZOS_A);
}

/** Lanczos-4 需要左右各 4 個 tap，共 8 個。 */
function resample1DChannel(srcLen, dstLen, get, set) {
  if (srcLen === dstLen) {
    for (let i = 0; i < srcLen; i++) set(i, get(i));
    return;
  }
  const scale = srcLen / dstLen;
  for (let d = 0; d < dstLen; d++) {
    const srcPos = (d + 0.5) * scale - 0.5;
    const base = Math.floor(srcPos);
    const frac = srcPos - base;
    let sum = 0;
    let wsum = 0;
    for (let t = -LANCZOS_A + 1; t <= LANCZOS_A; t++) {
      const w = lanczosWeight(t - frac);
      if (w === 0) continue;
      const idx = clampIndex(base + t, srcLen);
      sum += w * get(idx);
      wsum += w;
    }
    // 邊界附近 tap 會被裁掉（clampIndex 造成重複取樣，不是遺漏），這裡改用
    // 「權重歸一化」讓邊界像素不會因為裁掉的 tap 憑空變暗/變亮
    // （cv2 對邊界用複製延伸＋不歸一化，兩者在邊界的差異僅限最外圈幾個
    //  像素，模板本身通常有安全邊距，不歸一化 vs 歸一化在中心區域結果一致）。
    set(d, wsum !== 0 ? sum / wsum : sum);
  }
}

/**
 * 單通道灰階圖縮放（Lanczos-4），回傳 Float32Array，長度 dstW*dstH。
 * @param {Float32Array|Uint8Array} data
 */
export function resizeGray(data, srcW, srcH, dstW, dstH) {
  dstW = Math.max(1, Math.round(dstW));
  dstH = Math.max(1, Math.round(dstH));
  const mid = new Float32Array(dstW * srcH);
  for (let y = 0; y < srcH; y++) {
    resample1DChannel(
      srcW,
      dstW,
      (x) => data[y * srcW + x],
      (x, v) => {
        mid[y * dstW + x] = v;
      }
    );
  }
  const out = new Float32Array(dstW * dstH);
  for (let x = 0; x < dstW; x++) {
    resample1DChannel(
      srcH,
      dstH,
      (y) => mid[y * dstW + x],
      (y, v) => {
        out[y * dstW + x] = v;
      }
    );
  }
  return out;
}

/** 區塊平均縮小（給粗篩階段用，不需要子像素精度）。 */
export function downsampleGray(gray, W, H, factor) {
  const Wd = Math.max(1, Math.floor(W / factor));
  const Hd = Math.max(1, Math.floor(H / factor));
  const out = new Float32Array(Wd * Hd);
  for (let y = 0; y < Hd; y++) {
    for (let x = 0; x < Wd; x++) {
      let sum = 0;
      let count = 0;
      const x0 = x * factor;
      const y0 = y * factor;
      for (let j = 0; j < factor; j++) {
        const sy = y0 + j;
        if (sy >= H) continue;
        for (let i = 0; i < factor; i++) {
          const sx = x0 + i;
          if (sx >= W) continue;
          sum += gray[sy * W + sx];
          count++;
        }
      }
      out[y * Wd + x] = count > 0 ? sum / count : 0;
    }
  }
  return { data: out, width: Wd, height: Hd };
}

/**
 * 這個 scale 下縮放後的模板要用哪個粗篩縮小倍率 `f`：縮完模板最短邊要 >=
 * `MIN_COARSE_TEMPLATE_DIM` 才夠可靠，`f` 越大縮得越多。回 1 代表模板已經
 * 小到不值得粗篩，直接在原始解析度整張圖搜。0075 號工單：取代 0070 版寫死
 * 的 4x 金字塔——那個固定倍率對小模板（例如 scale 小的 lv.png）會把粗篩圖
 * 縮到只剩 8×8，形狀資訊幾乎沒了，粗篩分數不可靠。
 */
function chooseFactor(stw, sth) {
  const f = Math.floor(Math.min(stw, sth) / MIN_COARSE_TEMPLATE_DIM);
  return Math.max(1, f);
}

/**
 * 粗篩用的縮小圖金字塔，按實際用到的 `factor` 延遲建立、快取在呼叫端傳進來
 * 的 `cache`（一個 `Map`）裡——同一次 `locate()` 呼叫，lv／shop 兩張模板、
 * 30 個 scale 下來 `chooseFactor()` 算出來的 `factor` 只會落在少數幾個整數
 * 值，不用每個 scale 都重新縮一次整張畫面。
 */
function getPyramid(cache, gray, W, H, factor) {
  let entry = cache.get(factor);
  if (!entry) {
    entry = downsampleGray(gray, W, H, factor);
    entry.integral = buildIntegral(entry.data, entry.width, entry.height);
    cache.set(factor, entry);
  }
  return entry;
}

/**
 * 對一張模板做多倍率搜尋。每個 scale：
 *   - `factor === 1`（模板已經太小，粗篩不可靠）：直接在原始解析度整張圖
 *     搜一次。
 *   - `factor > 1`：在對應倍率的縮小圖上做全圖 NCC 粗篩（`nccSearchAll()`），
 *     NMS 取前 `TOP_K` 個候選，每個候選各自在原始解析度 ±(2*factor+2) px
 *     視窗精修一次，取這幾個精修分數裡最高的當這個 scale 的答案。
 * 30 個 scale 之間比較的都是精修過的全解析度分數，回傳分數最高的
 * (scale, x, y, score)（0070 的裁定不變：跨 scale 比粗篩分數是錯的）。
 */
function matchTemplateMultiScale(gray, W, H, fullIntegral, template, tw, th, scales, pyramidCache) {
  let best = { scale: scales[0], score: -Infinity, x: 0, y: 0 };

  for (const scale of scales) {
    const stw = Math.max(1, Math.round(tw * scale));
    const sth = Math.max(1, Math.round(th * scale));
    if (stw > W || sth > H) continue;

    const factor = chooseFactor(stw, sth);
    let result;
    if (factor === 1) {
      const fullTemplate = resizeGray(template, tw, th, stw, sth);
      result = nccSearch(gray, W, H, fullTemplate, stw, sth, fullIntegral);
    } else {
      const { data: coarseGray, width: cW, height: cH, integral: coarseIntegral } = getPyramid(pyramidCache, gray, W, H, factor);
      const ctw = Math.max(1, Math.round(stw / factor));
      const cth = Math.max(1, Math.round(sth / factor));
      const coarseTemplate = resizeGray(template, tw, th, ctw, cth);
      const all = nccSearchAll(coarseGray, cW, cH, coarseTemplate, ctw, cth, coarseIntegral);

      if (all) {
        const nmsRadius = Math.max(1, Math.round(NMS_RADIUS_BASE / factor));
        const candidates = topKWithNMS(all, TOP_K, nmsRadius);
        const fullTemplate = resizeGray(template, tw, th, stw, sth);
        const margin = 2 * factor + 2;

        let bestCandidate = { score: -Infinity, x: 0, y: 0 };
        for (const cand of candidates) {
          const cx = cand.x * factor;
          const cy = cand.y * factor;
          const refined = nccSearch(gray, W, H, fullTemplate, stw, sth, fullIntegral, {
            x0: cx - margin,
            y0: cy - margin,
            x1: cx + margin,
            y1: cy + margin,
          });
          if (refined.score > bestCandidate.score) bestCandidate = refined;
        }
        result = bestCandidate;
      } else {
        result = { score: -Infinity, x: 0, y: 0 };
      }
    }

    if (result.score > best.score) {
      best = { scale, score: result.score, x: result.x, y: result.y };
    }
  }
  return best;
}

function computeBox(anchor, offset, scale) {
  const [x, y] = anchor;
  const [x1, y1, x2, y2] = offset;
  return [Math.round(x + x1 * scale), Math.round(y + y1 * scale), Math.round(x + x2 * scale), Math.round(y + y2 * scale)];
}

// ---------------------------------------------------------------------------
// 快取：畫面尺寸 (w,h) 當 key，只有成功才寫（逐字對照 uilocate.py A5 的裁定）。
let cacheKey = null;
let cacheResult = null;

export function resetCache() {
  cacheKey = null;
  cacheResult = null;
}

/**
 * 給一張灰階圖（Uint8Array/Float32Array，長度 W*H）與兩張模板（lv/shop，各自
 * 也是灰階 {data,width,height}），算出 exp／level 的框。找不到回傳 null。
 *
 * 逐字對照 uilocate.py 的 locate()：兩張模板各自的最佳分數都要 ≥
 * SCORE_THRESHOLD(0.8)；scale = (shop.x - lv.x) / TEMPLATE_DIST，
 * 要落在 [SCALE_MIN, SCALE_MAX]；框用 LV_OFFSET／EXP_OFFSET 算，anchor 固定
 * lv 的命中點。
 *
 * @param {Uint8Array|Float32Array} gray
 * @param {number} W
 * @param {number} H
 * @param {{lv: {data, width, height}, shop: {data, width, height}}} templates
 */
export function locate(gray, W, H, templates) {
  if (!gray || W === 0 || H === 0) return null;

  const key = W + "x" + H;
  if (key === cacheKey) return cacheResult;

  // 積分圖只跟畫面本身有關，跟模板／scale 無關，建一次給 lv／shop、30 個
  // scale 共用（第一版每次搜尋都重建，GC 壓力主導了定位時間，見上面的說明）。
  // 粗篩金字塔改成延遲建立（0075 號工單：縮小倍率 f 現在是每個 scale 各自
  // 算出來的，不再是寫死的單一 4x），lv／shop 共用同一個 cache——兩張模板
  // 30 個 scale 下來 f 只會落在少數幾個整數值，不用重複縮同一張畫面。
  const fullIntegral = buildIntegral(gray, W, H);
  const pyramidCache = new Map();

  const lvBest = matchTemplateMultiScale(
    gray,
    W,
    H,
    fullIntegral,
    templates.lv.data,
    templates.lv.width,
    templates.lv.height,
    SCALES,
    pyramidCache
  );
  const shopBest = matchTemplateMultiScale(
    gray,
    W,
    H,
    fullIntegral,
    templates.shop.data,
    templates.shop.width,
    templates.shop.height,
    SCALES,
    pyramidCache
  );

  if (lvBest.score < SCORE_THRESHOLD || shopBest.score < SCORE_THRESHOLD) {
    return null;
  }

  const scale = (shopBest.x - lvBest.x) / TEMPLATE_DIST;
  if (scale < SCALE_MIN || scale > SCALE_MAX) {
    return null;
  }

  const result = {
    exp: computeBox([lvBest.x, lvBest.y], EXP_OFFSET, scale),
    level: computeBox([lvBest.x, lvBest.y], LV_OFFSET, scale),
    scale,
    lvScore: lvBest.score,
    shopScore: shopBest.score,
    lvPos: [lvBest.x, lvBest.y],
    shopPos: [shopBest.x, shopBest.y],
  };

  cacheKey = key;
  cacheResult = result;
  return result;
}

// 除錯用：給 tests/locate.html／node 測試檢查中間結果，正式流程（app.mjs）
// 不會呼叫這個。
export const _debug = {
  nccSearch,
  nccSearchAll,
  topKWithNMS,
  matchTemplateMultiScale,
  downsampleGray,
  resizeGray,
  chooseFactor,
  getPyramid,
};

// ---------------------------------------------------------------------------
// 0072 工單（W3）任務 3：校準頁「自動定位」一次算六塊，翻
// exp-tracker/src/uilocate.py 的 locate_all()。跟上面的 locate() 是另一套：
// 四個錨點模板（lv／shop／minimap／quick，quick 帶遮罩），scale 只由 shop 算
// 一次（粗網格 → 最佳值 ±0.05 細網格），其他三個錨點用這個 scale 各比對一次；
// 某個錨點沒過門檻，只有它管的那幾塊退回「貼角落」推算。常數逐字對照
// docs/規則摘要.md §2／uilocate.py 99-131, 334-530（frame 座標系見 regions.mjs
// 的 CALIBRATION_BASE：這裡的「基準」直接是分享畫面座標，已經扣掉桌面版
// GetWindowRect 跟 WGC frame 那 (7,0) 的邊框位移，不需要再搬一次）。

export const FINE_SCALE_SPAN = 0.05;
export const FINE_SCALE_STEP = 0.01;
export const ANCHOR_THRESHOLDS = { lv: 0.8, shop: 0.8, minimap: 0.8, quick: 0.7 };
export const BLOCK_ANCHOR = {
  exp: "shop",
  level: "lv",
  map: "minimap",
  panel: "quick",
  hp: "quick",
  mp: "quick",
};
const LOCATE_ALL_KEYS = ["exp", "level", "map", "panel", "hp", "mp"];

/** 最近鄰縮放（給遮罩用：mask 是硬 0/255，插值會弄出灰階邊緣，見 uilocate.py 的 INTER_NEAREST）。 */
function resizeNearest(data, srcW, srcH, dstW, dstH) {
  dstW = Math.max(1, Math.round(dstW));
  dstH = Math.max(1, Math.round(dstH));
  const out = new Float32Array(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, Math.floor((y * srcH) / dstH));
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor((x * srcW) / dstW));
      out[y * dstW + x] = data[sy * srcW + sx];
    }
  }
  return out;
}

/** 區塊平均縮小，給粗篩用的遮罩（跟 downsampleGray 同精神，回傳 0~255 的「覆蓋權重」）。 */
function downsampleMask(mask, W, H, factor) {
  return downsampleGray(mask, W, H, factor).data;
}

/**
 * 帶遮罩的 TM_CCOEFF_NORMED，只在 `searchBox` 範圍內搜（小範圍，逐位置直接算，
 * 不走積分圖——遮罩形狀不一定是矩形，積分圖那套「矩形窗口和」的技巧用不上，
 * 但因為只在精修階段的小窗口內跑，成本可以接受）。遮罩內像素數固定（遮罩形狀
 * 不隨視窗位置變，只隨要不要用而定），所以「有效像素數」`Nm` 是常數，可以先算好。
 */
function maskedNccSearch(gray, W, H, template, mask, tw, th, searchBox) {
  let Nm = 0;
  let tSum = 0;
  let tSumSq = 0;
  for (let i = 0; i < template.length; i++) {
    if (mask[i] > 0) {
      Nm++;
      tSum += template[i];
      tSumSq += template[i] * template[i];
    }
  }
  if (Nm === 0) return { score: 0, x: 0, y: 0 };
  const tMean = tSum / Nm;
  const denomT = Math.max(0, tSumSq - Nm * tMean * tMean);

  const maxX = W - tw;
  const maxY = H - th;
  const x0 = Math.max(0, searchBox ? searchBox.x0 : 0);
  const y0 = Math.max(0, searchBox ? searchBox.y0 : 0);
  const x1 = Math.min(maxX, searchBox ? searchBox.x1 : maxX);
  const y1 = Math.min(maxY, searchBox ? searchBox.y1 : maxY);
  if (x1 < x0 || y1 < y0) return { score: -Infinity, x: 0, y: 0 };

  let best = -Infinity;
  let bx = 0;
  let by = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let winSum = 0;
      let winSumSq = 0;
      let cross = 0;
      for (let j = 0; j < th; j++) {
        const rowBase = (y + j) * W + x;
        const tBase = j * tw;
        for (let i = 0; i < tw; i++) {
          if (mask[tBase + i] <= 0) continue;
          const v = gray[rowBase + i];
          winSum += v;
          winSumSq += v * v;
          cross += v * template[tBase + i];
        }
      }
      const iMean = winSum / Nm;
      const denomI = Math.max(0, winSumSq - Nm * iMean * iMean);
      const numerator = cross - Nm * iMean * tMean;
      const denom = Math.sqrt(denomI * denomT);
      const score = denom > 0 ? numerator / denom : 0;
      if (score > best) {
        best = score;
        bx = x;
        by = y;
      }
    }
  }
  return { score: best, x: bx, y: by };
}

/**
 * 單一 scale 下找一個錨點模板（可帶遮罩）：模板夠小（chooseFactor 算出 factor
 * === 1）直接在原始解析度整張圖搜；否則粗篩（降採樣）+ NMS 取前 TOP_K 個候選 +
 * 原始解析度小窗口精修，跟 matchTemplateMultiScale() 每個 scale 內部做的事一樣，
 * 只是這裡固定單一 scale、可以帶遮罩。
 * @returns {{score:number, x:number, y:number}}
 */
function matchAnchorAtScale(gray, W, H, fullIntegral, template, tw, th, scale, mask, pyramidCache) {
  const stw = Math.max(1, Math.round(tw * scale));
  const sth = Math.max(1, Math.round(th * scale));
  if (stw > W || sth > H) return { score: -Infinity, x: 0, y: 0 };

  const resizedTemplate = resizeGray(template, tw, th, stw, sth);
  const resizedMask = mask ? resizeNearest(mask, tw, th, stw, sth) : null;
  const factor = chooseFactor(stw, sth);

  if (factor === 1) {
    return mask
      ? maskedNccSearch(gray, W, H, resizedTemplate, resizedMask, stw, sth, null)
      : nccSearch(gray, W, H, resizedTemplate, stw, sth, fullIntegral);
  }

  const { data: coarseGray, width: cW, height: cH } = getPyramid(pyramidCache, gray, W, H, factor);
  const ctw = Math.max(1, Math.round(stw / factor));
  const cth = Math.max(1, Math.round(sth / factor));
  const coarseTemplate = resizeGray(resizedTemplate, stw, sth, ctw, cth);
  const margin = 2 * factor + 2;

  let candidates;
  if (mask) {
    const coarseMask = downsampleMask(resizedMask, stw, sth, factor);
    // 粗篩用「原始尺寸縮到 ctw×cth」的遮罩形狀不對齊，改用同一顆縮到 ctw×cth
    // 的遮罩（downsampleMask 已經是縮到 floor(stw/factor) 那組，跟 ctw/cth
    // 用同一個 factor 算出來，尺寸應該一致；不一致時保守地整塊當作有遮罩）。
    const cMaskW = Math.max(1, Math.floor(stw / factor));
    const cMaskH = Math.max(1, Math.floor(sth / factor));
    const maskForScoring = cMaskW === ctw && cMaskH === cth ? coarseMask : new Float32Array(ctw * cth).fill(255);
    const all = maskedNccSearchAll(coarseGray, cW, cH, coarseTemplate, maskForScoring, ctw, cth);
    if (!all) return { score: -Infinity, x: 0, y: 0 };
    const nmsRadius = Math.max(1, Math.round(NMS_RADIUS_BASE / factor));
    candidates = topKWithNMS(all, TOP_K, nmsRadius);
  } else {
    const coarseIntegral = getPyramid(pyramidCache, gray, W, H, factor).integral;
    const all = nccSearchAll(coarseGray, cW, cH, coarseTemplate, ctw, cth, coarseIntegral);
    if (!all) return { score: -Infinity, x: 0, y: 0 };
    const nmsRadius = Math.max(1, Math.round(NMS_RADIUS_BASE / factor));
    candidates = topKWithNMS(all, TOP_K, nmsRadius);
  }

  let best = { score: -Infinity, x: 0, y: 0 };
  for (const cand of candidates) {
    const cx = cand.x * factor;
    const cy = cand.y * factor;
    const box = { x0: cx - margin, y0: cy - margin, x1: cx + margin, y1: cy + margin };
    const refined = mask
      ? maskedNccSearch(gray, W, H, resizedTemplate, resizedMask, stw, sth, box)
      : nccSearch(gray, W, H, resizedTemplate, stw, sth, fullIntegral, box);
    if (refined.score > best.score) best = refined;
  }
  return best;
}

/** 跟 nccSearchAll() 一樣但帶遮罩，給粗篩用（格點數不多，直接逐位置算，不走積分圖）。 */
function maskedNccSearchAll(gray, W, H, template, mask, tw, th) {
  if (tw > W || th > H) return null;
  let Nm = 0;
  let tSum = 0;
  let tSumSq = 0;
  for (let i = 0; i < template.length; i++) {
    if (mask[i] > 0) {
      Nm++;
      tSum += template[i];
      tSumSq += template[i] * template[i];
    }
  }
  if (Nm === 0) return null;
  const tMean = tSum / Nm;
  const denomT = Math.max(0, tSumSq - Nm * tMean * tMean);

  const gw = W - tw + 1;
  const gh = H - th + 1;
  const scores = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let winSum = 0;
      let winSumSq = 0;
      let cross = 0;
      for (let j = 0; j < th; j++) {
        const rowBase = (y + j) * W + x;
        const tBase = j * tw;
        for (let i = 0; i < tw; i++) {
          if (mask[tBase + i] <= 0) continue;
          const v = gray[rowBase + i];
          winSum += v;
          winSumSq += v * v;
          cross += v * template[tBase + i];
        }
      }
      const iMean = winSum / Nm;
      const denomI = Math.max(0, winSumSq - Nm * iMean * iMean);
      const numerator = cross - Nm * iMean * tMean;
      const denom = Math.sqrt(denomI * denomT);
      scores[y * gw + x] = denom > 0 ? numerator / denom : 0;
    }
  }
  return { scores, gw, gh };
}

/**
 * shop 錨點的 scale：先在 SCALES 粗網格找最佳值，再用最佳值四捨五入到 0.01 後
 * ±FINE_SCALE_SPAN、步進 FINE_SCALE_STEP 的細網格再找一次（逐字對照
 * uilocate.py _find_scale()）。
 */
function findScale(gray, W, H, fullIntegral, template, tw, th, pyramidCache) {
  let best = matchTemplateMultiScale(gray, W, H, fullIntegral, template, tw, th, SCALES, pyramidCache);
  const center = Math.round(best.scale * 100) / 100;
  const lo = Math.max(SCALE_MIN, center - FINE_SCALE_SPAN);
  const hi = Math.min(SCALE_MAX, center + FINE_SCALE_SPAN);
  const steps = Math.round((hi - lo) / FINE_SCALE_STEP);
  const fineScales = [];
  for (let i = 0; i <= steps; i++) fineScales.push(Math.round((lo + i * FINE_SCALE_STEP) * 100) / 100);
  const fine = matchTemplateMultiScale(gray, W, H, fullIntegral, template, tw, th, fineScales, pyramidCache);
  return fine.score > best.score ? fine : best;
}

/**
 * 貼角落推算（某個錨點沒過門檻時的退路，逐字對照 uilocate.py
 * `_place_from_base()`）。`base`：基準座標系下的這塊區域（含 anchor）；
 * `baseSize`：基準畫面尺寸；回傳目前這張圖上的 [x1,y1,x2,y2]。
 */
function placeFromBase(base, baseSize, scale, imgW, imgH) {
  const anchor = base.anchor || "top-left";
  const fromRight = anchor.endsWith("right");
  const fromBottom = anchor.startsWith("bottom");
  const dx = fromRight ? base.left - baseSize.width : base.left;
  const dy = fromBottom ? base.top - baseSize.height : base.top;
  const width = Math.round(base.width * scale);
  const height = Math.round(base.height * scale);
  const left = fromRight ? imgW + Math.round(dx * scale) : Math.round(dx * scale);
  const top = fromBottom ? imgH + Math.round(dy * scale) : Math.round(dy * scale);
  return [left, top, left + width, top + height];
}

function placeFromAnchor(base, anchorBase, anchorPos, scale) {
  const [ax, ay] = anchorPos;
  const [bx, by] = anchorBase;
  const dx = base.left - bx;
  const dy = base.top - by;
  const width = Math.round(base.width * scale);
  const height = Math.round(base.height * scale);
  const left = Math.round(ax + dx * scale);
  const top = Math.round(ay + dy * scale);
  return [left, top, left + width, top + height];
}

/**
 * 校準頁「自動定位」鈕：一次算六塊區域（exp／level／map／panel／hp／mp）。
 * `anchorTemplates`：`{lv,shop,minimap,quick,quick_mask}` 灰階 `{data,width,height}`。
 * `base`：`regions.CALIBRATION_BASE`（基準座標＋錨點基準位置＋基準畫面尺寸，
 * 都已經是分享畫面座標，不用再扣邊框位移）。
 *
 * 回傳 `{scale, approx, fallback, scores, anchors, regions}`；shop 沒過門檻、
 * 模板缺檔、圖片是空的、`base.regions` 缺鍵一律回 `null`（逐字對照
 * uilocate.py locate_all()）。
 * @param {Uint8Array|Float32Array} gray
 * @param {number} W
 * @param {number} H
 * @param {{lv:object, shop:object, minimap:object, quick:object, quick_mask:object}} anchorTemplates
 * @param {{regions:Object<string,object>, anchors:Object<string,[number,number]>, frameSize:{width:number,height:number}}} base
 */
export function locateAll(gray, W, H, anchorTemplates, base) {
  if (!gray || W === 0 || H === 0 || !anchorTemplates) return null;
  for (const key of LOCATE_ALL_KEYS) {
    if (!base || !base.regions || !base.regions[key]) return null;
  }

  const fullIntegral = buildIntegral(gray, W, H);
  const pyramidCache = new Map();

  const shopBest = findScale(gray, W, H, fullIntegral, anchorTemplates.shop.data, anchorTemplates.shop.width, anchorTemplates.shop.height, pyramidCache);
  if (shopBest.score < ANCHOR_THRESHOLDS.shop || shopBest.scale < SCALE_MIN || shopBest.scale > SCALE_MAX) {
    return null;
  }
  const scale = Math.round(shopBest.scale * 100) / 100;

  const lvBest = matchAnchorAtScale(gray, W, H, fullIntegral, anchorTemplates.lv.data, anchorTemplates.lv.width, anchorTemplates.lv.height, scale, null, pyramidCache);
  const minimapBest = matchAnchorAtScale(gray, W, H, fullIntegral, anchorTemplates.minimap.data, anchorTemplates.minimap.width, anchorTemplates.minimap.height, scale, null, pyramidCache);
  const quickBest = matchAnchorAtScale(gray, W, H, fullIntegral, anchorTemplates.quick.data, anchorTemplates.quick.width, anchorTemplates.quick.height, scale, anchorTemplates.quick_mask.data, pyramidCache);

  const scores = { lv: lvBest.score, shop: shopBest.score, minimap: minimapBest.score, quick: quickBest.score };
  const anchors = {
    lv: lvBest.score >= ANCHOR_THRESHOLDS.lv ? [lvBest.x, lvBest.y] : null,
    shop: [shopBest.x, shopBest.y],
    minimap: minimapBest.score >= ANCHOR_THRESHOLDS.minimap ? [minimapBest.x, minimapBest.y] : null,
    quick: quickBest.score >= ANCHOR_THRESHOLDS.quick ? [quickBest.x, quickBest.y] : null,
  };

  const fallback = [];
  const regionsOut = {};
  for (const key of LOCATE_ALL_KEYS) {
    const anchorName = BLOCK_ANCHOR[key];
    const anchorPos = anchors[anchorName];
    if (anchorPos) {
      regionsOut[key] = placeFromAnchor(base.regions[key], base.anchors[anchorName], anchorPos, scale);
    } else {
      regionsOut[key] = placeFromBase(base.regions[key], base.frameSize, scale, W, H);
      fallback.push(key);
    }
  }

  return { scale, approx: fallback.length > 0, fallback, scores, anchors, regions: regionsOut };
}

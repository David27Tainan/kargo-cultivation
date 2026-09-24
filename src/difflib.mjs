// difflib.SequenceMatcher(None, a, b).ratio() 的 JS 版（Ratcliff/Obershelp），
// 翻自 CPython 的 Lib/difflib.py（0071 工單前提澄清 (3)）。
//
// 地圖名都很短（< 200 字），CPython 的 autojunk 只在 len(b) >= 200 時才會啟動
// （`SequenceMatcher.__chain_b()` 的 `if n >= 200: ...`），所以這裡**不實作
// junk/autojunk 邏輯**——完全不影響地圖名這個用途的結果，少一層複雜度。
//
// 驗收：`tools/difflib_golden.py` 用 Python 的 difflib.SequenceMatcher 產生
// 20 組（含中文、含編號、含空字串），`tests/difflib.test.mjs` 逐組比對，
// 誤差 ≤ 1e-9。

/**
 * 對照 Python `SequenceMatcher.__chain_b()`：b 裡每個字元出現的位置清單。
 * @param {string} b
 * @returns {Map<string, number[]>}
 */
function chainB(b) {
  const b2j = new Map();
  for (let i = 0; i < b.length; i++) {
    const ch = b[i];
    let list = b2j.get(ch);
    if (!list) {
      list = [];
      b2j.set(ch, list);
    }
    list.push(i);
  }
  return b2j;
}

/**
 * 對照 Python `SequenceMatcher.find_longest_match(alo, ahi, blo, bhi)`：
 * 在 a[alo:ahi] 與 b[blo:bhi] 之間找最長的連續相同子字串。
 * 沒有 junk（isbjunk 恆為 false），所以這裡是原演算法拿掉 junk 分支後的版本。
 * @returns {[number, number, number]} [besti, bestj, bestsize]
 */
function findLongestMatch(a, b, b2j, alo, ahi, blo, bhi) {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;

  // j2len：目前這一輪（固定 i）算到的「以 j 結尾的連續相同長度」
  let j2len = new Map();
  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map();
    const indices = b2j.get(a[i]);
    if (indices) {
      for (const j of indices) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
    }
    j2len = newj2len;
  }

  // Python 版接著會往兩側擴張（排除 junk/popular 的邊界情況）——沒有 junk 時
  // 這段擴張本來就不會再擴大 bestsize（上面的 DP 本身已經找到最長的連續段），
  // 保留邏輯位置但直接照抄 Python 的「往外延伸」以求逐字對照，遇到不影響
  // 結果的情況也不例外。
  while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
    besti--;
    bestj--;
    bestsize++;
  }
  while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) {
    bestsize++;
  }

  return [besti, bestj, bestsize];
}

/**
 * 對照 Python `SequenceMatcher.get_matching_blocks()`：遞迴切成左右兩段，
 * 收集所有相符的區塊（含結尾補的 0-length 哨兵）。
 * @returns {[number, number, number][]} [[ai, bj, size], ...]
 */
function getMatchingBlocks(a, b, b2j) {
  const la = a.length;
  const lb = b.length;
  const queue = [[0, la, 0, lb]];
  const matchingBlocks = [];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = findLongestMatch(a, b, b2j, alo, ahi, blo, bhi);
    if (k > 0) {
      matchingBlocks.push([i, j, k]);
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  matchingBlocks.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  // 合併相鄰區塊（Python 版會把 i1+k1==i2 && j1+k1==j2 的相鄰區塊黏起來）
  let i1 = 0;
  let j1 = 0;
  let k1 = 0;
  const nonAdjacent = [];
  for (const [i2, j2, k2] of matchingBlocks) {
    if (i1 + k1 === i2 && j1 + k1 === j2) {
      k1 += k2;
    } else {
      if (k1) nonAdjacent.push([i1, j1, k1]);
      [i1, j1, k1] = [i2, j2, k2];
    }
  }
  if (k1) nonAdjacent.push([i1, j1, k1]);
  nonAdjacent.push([la, lb, 0]);
  return nonAdjacent;
}

/**
 * `difflib.SequenceMatcher(None, a, b).ratio()` 的 JS 版：
 * `2 * M / T`，M 是相符字元總數，T 是兩字串長度總和。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function ratio(a, b) {
  a = a || "";
  b = b || "";
  const t = a.length + b.length;
  if (t === 0) return 1.0;
  const b2j = chainB(b);
  const blocks = getMatchingBlocks(a, b, b2j);
  let matches = 0;
  for (const [, , size] of blocks) matches += size;
  return (2.0 * matches) / t;
}

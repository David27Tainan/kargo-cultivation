// 翻 exp-tracker/src/health.py（0072 工單任務 4）。純運算：六塊讀取狀態怎麼
// 判斷 ok／stale／bad／off，不碰畫面。app.mjs 在收到訊息的當下呼叫
// markOk()/markFail()，畫面重畫時呼叫 status()。

/** 剛好 10 秒算「還新鮮」（含 10 秒本身，<=）；超過就是 stale。 */
export const STALE_SEC = 10.0;
/** 程式開了這麼久還一次都沒讀到過，直接判定 bad。 */
export const COLD_START_SEC = 30.0;
/** 連續失敗要到第幾次才算「真的壞了」。 */
export const FAIL_STREAK_THRESHOLD = 3;

/**
 * 六塊的 key，順序跟計畫書 §9.1／桌面版 calibration_ui.ROWS 一致（少了快捷欄，
 * 那沒有自己的讀值，血水／藍水兩列已經涵蓋）。"meso" 是 0072 加的，放最後，
 * 不對應校準頁任何一列（圖示是整張找的，不是校準頁框出來的區域）。
 */
export const HEALTH_KEYS = ["exp_region", "map_region", "level_region", "potions.hp_count_region", "potions.mp_count_region", "meso"];

export const HEALTH_LABELS = {
  exp_region: "經驗值",
  map_region: "地圖",
  level_region: "等級",
  "potions.hp_count_region": "血水",
  "potions.mp_count_region": "藍水",
  meso: "楓幣",
};

export const HEALTH_SYMBOLS = { ok: "●", stale: "●", bad: "×", off: "—" };
export const HEALTH_COLORS = {
  ok: "#2e9e3e",
  stale: "#888888",
  bad: "#c0392b",
  off: "#888888",
};

/**
 * 健康列「自動收合」的純判斷：全部綠燈的那一刻回 "collapse"，其他時候回 null。
 * 只收不彈（紅叉不自動跳出來），stale（灰）不算綠。
 * @param {boolean} prevAllOk
 * @param {boolean} allOk
 * @returns {"collapse"|null}
 */
export function autoPanelAction(prevAllOk, allOk) {
  if (allOk && !prevAllOk) return "collapse";
  return null;
}

/**
 * 回傳 "ok"｜"stale"｜"bad"｜"off" 之一（逐字對照 health.py health_status()）。
 * @param {number|null} lastOk
 * @param {number|null} lastFail
 * @param {number} now
 * @param {boolean} enabled
 * @param {number|null} startedAt
 * @param {number} [okWithin]
 * @param {boolean} [coldStartBad]
 * @returns {"ok"|"stale"|"bad"|"off"}
 */
export function healthStatus(lastOk, lastFail, now, enabled, startedAt, okWithin = STALE_SEC, coldStartBad = true) {
  if (!enabled) return "off";
  if (lastFail !== null && lastFail !== undefined && (lastOk === null || lastOk === undefined || lastFail >= lastOk)) {
    return "bad";
  }
  if (lastOk === null || lastOk === undefined) {
    if (coldStartBad && startedAt !== null && startedAt !== undefined && now - startedAt >= COLD_START_SEC) {
      return "bad";
    }
    return "stale";
  }
  if (now - lastOk <= okWithin) return "ok";
  return "stale";
}

/** 單一塊的兩個時間戳 + 連續失敗計數（逐字對照 health.py BlockHealth）。 */
export class BlockHealth {
  constructor() {
    this.lastOk = null;
    this.lastFail = null;
    this._streak = 0;
  }

  /** @param {number} now */
  ok(now) {
    this.lastOk = now;
    this._streak = 0;
  }

  /** @param {number} now */
  fail(now) {
    this._streak += 1;
    if (this._streak >= FAIL_STREAK_THRESHOLD) this.lastFail = now;
  }

  status(now, enabled, startedAt, okWithin = STALE_SEC, coldStartBad = true) {
    return healthStatus(this.lastOk, this.lastFail, now, enabled, startedAt, okWithin, coldStartBad);
  }
}

/** 六塊 BlockHealth 的容器（逐字對照 health.py HealthTracker）。 */
export class HealthTracker {
  /** @param {number} startedAt 程式開始算的時間（不是按「開始」計時那一刻）。 */
  constructor(startedAt) {
    this.startedAt = startedAt;
    /** @type {Object<string, BlockHealth>} */
    this.blocks = {};
    for (const key of HEALTH_KEYS) this.blocks[key] = new BlockHealth();
  }

  markOk(key, now) {
    this.blocks[key].ok(now);
  }

  markFail(key, now) {
    this.blocks[key].fail(now);
  }

  status(key, now, enabled, okWithin = STALE_SEC, coldStartBad = true) {
    return this.blocks[key].status(now, enabled, this.startedAt, okWithin, coldStartBad);
  }
}

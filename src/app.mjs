// 主程式：狀態機、兩條迴圈（快 250ms／慢 10s）、畫面更新。
//
// 0070（W1）只做到「連上遊戲視窗，畫面上即時看到經驗、等級、地圖」。
// 0071（W2）這張單接上：
//   - tracker.mjs／ratebuffer.mjs／storage.mjs（任務 2）
//   - 精簡數據列（任務 3）
//   - 排行紀錄分頁 + CSV 匯出／匯入（任務 4）
//   - localStorage 儲存（任務 5）

import { VERSION } from "./version.mjs";
import * as capture from "./capture.mjs";
import { every } from "./timer.mjs";
import * as regions from "./regions.mjs";
import { parseExpLine, parseLevel, parseCount, mergeMapName, hasUnreadableNumeral, BROKEN_NUMERAL_CHAR, cleanMapName } from "./parsing.mjs";
import { lumaChannel, splitLines } from "./ocr/ctc.mjs";
import { ExpTracker } from "./tracker.mjs";
import { RateBuffer } from "./ratebuffer.mjs";
import * as mapdb from "./mapdb.mjs";
import * as exptable from "./exptable.mjs";
import * as storage from "./storage.mjs";
import { PotionCatalog, PotionTracker, formatPotionRow, formatPotionCell, countRegionForSlot, SLOT_KEY_NAMES, SLOT_COUNT, SLOT_UNSET_LABEL } from "./potions.mjs";
import { MesoTracker, findIcon, numberRegion, parseAmount, formatMesoAmount, formatMesoCell, mesoTierColor, MESO_SCAN_EVERY_TICKS, MESO_OCR_MIN_INTERVAL_SEC, MESO_ICON_THRESHOLD, MESO_STALE_SEC } from "./mesos.mjs";
import { HealthTracker, HEALTH_KEYS, autoPanelAction, STALE_SEC as HEALTH_OK_WITHIN } from "./health.mjs";
import { locateAll } from "./locate.mjs";

const DEFAULT_FAST_INTERVAL_MS = 250;
const MIN_FAST_INTERVAL_MS = 100;
const MAX_FAST_INTERVAL_MS = 1000;
// 慢迴圈頻率（規則摘要 §8）：預覽期還沒讀到地圖時 10 秒，讀到之後 30 秒
// （從下一輪才生效）；正式模式（按了開始）固定 10 秒，不受地圖讀到與否影響。
const SLOW_INTERVAL_NO_MAP_MS = 10000;
const SLOW_INTERVAL_HAS_MAP_MS = 30000;
const SLOW_INTERVAL_RECORDING_MS = 10000;
const MAX_GRAB_FAILURES = 4;
// 0074 工單任務 3：地圖名含「川」又抓不到編號時，對那一行加大倍率重讀（同一顆
// ch 模型，逐字對照桌面版 ocr.py 的 BROKEN_NUMERAL_RETRY_UPSCALES；0071 起地圖
// 只剩 ch 一顆模型，不再是桌面版「cht 讀字失敗、ch 讀編號重讀」那種兩顆模型分工）。
const BROKEN_NUMERAL_RETRY_UPSCALES = [8, 10, 12];
// 連續讀不到幾次跳橫幅（計畫書 §9.1，同桌面版 `_unreadable >= 3`）。
const UNREADABLE_WARN_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// 0080 工單（W4.3）：校準頁整頁照桌面版 calibration_ui.py 重做。這些常數逐一
// 對照桌面版同名常數，見 exp-tracker/src/calibration_ui.py 檔頭。

/** 校準頁「現在截到」每 500ms 重裁一次（同桌面版 PREVIEW_INTERVAL_MS，桌面版是 1000ms，
 * 網頁版沿用工單前提 (2) 指定的 500ms）。 */
const CALIB_LIVE_INTERVAL_MS = 500;
/** 六個校準區域鍵 -> 列名（同桌面版 ROWS 的顯示名稱）。 */
const CALIB_ROW_LABELS = { exp: "經驗值", map: "地圖名稱", level: "等級", panel: "快捷欄", hp: "血水數量", mp: "藍水數量" };
/** 六個校準區域鍵 -> 烤圖 slug（assets/ui-built/tabs/<slug>_{normal,selected}.png，
 * tools/build_ui.py 的 TAB_TEXTS 已經烤過這六個列名，跟頁籤共用同一顆
 * tab_button_image()，見該檔 `slug()` 對照表）。 */
const CALIB_ROW_SLUGS = { exp: "exp", map: "map", level: "level", panel: "panel", hp: "hp-count", mp: "mp-count" };
/** 「現在截到」「範例」欄的放大倍率：exp/map/level 是 1（同桌面版 LIVE_ZOOM/EXAMPLE_ZOOM），
 * 快捷欄／血水／藍水數量是 2（同桌面版 COUNT_LIVE_ZOOM=PREVIEW_ZOOM=2；桌面版快捷欄格線圖
 * 用 GRID_ZOOM=1.4，網頁版統一用 2 讓格名讀得清楚，見回報單「裁定與偏離」）。 */
const CALIB_ZOOM = { exp: 1, map: 1, level: 1, panel: 2, hp: 2, mp: 2 };
/** 範例圖檔名（`assets/calib_examples/`，複製自桌面版同一批，同 EXAMPLE_FILENAMES）。 */
const CALIB_EXAMPLE_FILES = { exp: "exp.png", map: "map.png", level: "level.png", panel: "panel.png", hp: "hp_count.png", mp: "mp_count.png" };
/** 讀到欄原文縮到這麼長（同桌面版 RAW_PREVIEW_LEN）。 */
const CALIB_RAW_PREVIEW_LEN = 12;

// UI 端滾動緩衝的門檻/降採樣（同桌面版 app.py 的 RATE_MIN_DT_SEC／
// RATE_BUFFER_THROTTLE_SEC，見 ratebuffer.py 檔頭；不准調回 3.0、不准加平滑）。
const RATE_MIN_DT_SEC = 1.0;
const RATE_BUFFER_THROTTLE_SEC = 0.5;

function byId(id) {
  return document.getElementById(id);
}

/** 單調時鐘，秒（0071 前提澄清 (2)：dt 一律用這個算，不准用 Date.now()）。 */
function monoNow() {
  return performance.now() / 1000;
}

// ---------------------------------------------------------------------------
// OcrClient：包住 ocr/worker.mjs 的訊息協定，暴露成 Promise-based API。
// worker 同時扛 OCR 辨識跟 locate() 的 NCC 自動定位（見 worker.mjs 檔頭）。

class OcrClient {
  constructor() {
    this.worker = new Worker(new URL("./ocr/worker.mjs", import.meta.url), { type: "module" });
    this.nextId = 1;
    this.pending = new Map();
    this.onProgress = null;
    this.worker.onmessage = (event) => this._onMessage(event.data);
    this.worker.onerror = (event) => {
      console.error("[ocr worker] 錯誤", event);
    };
  }

  _onMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "progress") {
      if (this.onProgress) this.onProgress(msg);
      return;
    }
    if (msg.type === "ready") {
      const p = this.pending.get("init");
      if (p) {
        this.pending.delete("init");
        p.resolve();
      }
      return;
    }
    if (msg.type === "result" || msg.type === "locate_result") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.resolve(msg);
      }
      return;
    }
    if (msg.type === "error") {
      const key = msg.id !== undefined ? msg.id : "init";
      const p = this.pending.get(key);
      if (p) {
        this.pending.delete(key);
        p.reject(new Error(msg.message));
      } else {
        console.error("[ocr worker] 未配對的錯誤", msg.message);
      }
      return;
    }
  }

  init() {
    return new Promise((resolve, reject) => {
      this.pending.set("init", { resolve, reject });
      this.worker.postMessage({ type: "init" });
    });
  }

  /** @param {ImageBitmap} bitmap 呼叫後這個 bitmap 的所有權轉給 worker，呼叫端不用也不能再用它 */
  recognize(bitmap, opts) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(
        { type: "recognize", id, bitmap, lang: opts.lang, upscale: opts.upscale, preprocess: opts.preprocess },
        [bitmap]
      );
    });
  }

  /** @param {ImageBitmap} bitmap 整張擷取畫面，所有權轉給 worker */
  locate(bitmap) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: "locate", id, bitmap }, [bitmap]);
    });
  }
}

// ---------------------------------------------------------------------------

class App {
  constructor() {
    this.els = {
      version: byId("version"),
      btnConnect: byId("btn-connect"),
      btnStart: byId("btn-start"),
      btnStop: byId("btn-stop"),
      status: byId("status"),
      statMap: byId("stat-map"),
      statLevelExp: byId("stat-level-exp"),
      statRate: byId("stat-rate"),
      chkRateMode: byId("chk-rate-mode"),
      statTimeToLevelup: byId("stat-time-to-levelup"),
      statSessionTime: byId("stat-session-time"),
      preview: byId("preview"),
      modelProgress: byId("model-progress"),
      btnDownloadFrame: byId("btn-download-frame"),
      frameSize: byId("frame-size"),
      bannerUnreadable: byId("banner-unreadable"),
      unreadableCount: byId("unreadable-count"),
      // 0077 工單前提 (3)：設定頁併進校準頁的第三個分頁「設定」，不再是獨立的
      // 頂層分頁，所以這裡只剩三個（main/ranking/calibration）。
      tabButtons: [byId("tab-btn-main"), byId("tab-btn-ranking"), byId("tab-btn-calibration")],
      tabPages: [byId("tab-main"), byId("tab-ranking"), byId("tab-calibration")],
      rankingBody: byId("ranking-body"),
      btnClearHistory: byId("btn-clear-history"),
      btnExportCsv: byId("btn-export-csv"),
      btnImportCsv: byId("btn-import-csv"),
      fileImportCsv: byId("file-import-csv"),
      rankingNote: byId("ranking-note"),
      confirmOverlay: byId("confirm-overlay"),
      confirmMessage: byId("confirm-message"),
      confirmYes: byId("confirm-yes"),
      confirmNo: byId("confirm-no"),
      // ---- 0072（W3）：健康列 ----
      // 0078 工單任務 3：healthPanel 是整個 `.kc-health-window`（收合時整個滑走的
      // 那一層），healthBar 是裡面裝六列的容器，healthToggle 已經搬到主視窗標題列。
      healthPanel: byId("panel-health"),
      healthBar: byId("health-bar"),
      healthToggle: byId("health-toggle"),
      btnUnreadableCalibrate: byId("btn-unreadable-calibrate"),
      // ---- 精簡數據：水錢／楓幣 ----
      statPotion: byId("stat-potion"),
      statMeso: byId("stat-meso"),
      frameSizeWarning: byId("frame-size-warning"),
      // ---- 診斷文字 ----
      btnCopyDiag: byId("btn-copy-diag"),
      diagNote: byId("diag-note"),
      // ---- 校準頁（0080 工單：整頁照桌面版 calibration_ui.py 重做） ----
      tabBtnCalibration: byId("tab-btn-calibration"),
      tabCalibration: byId("tab-calibration"),
      calibHeaderRow: byId("calib-header-row"),
      // 0077 工單前提 (3)：多一個「設定」分頁（原本的頂層設定頁搬進來）。
      calibSubtabButtons: [
        byId("calib-subtab-btn-region"), byId("calib-subtab-btn-potion"), byId("calib-subtab-btn-settings"),
      ],
      calibSubpages: [
        byId("calib-subpage-region"), byId("calib-subpage-potion"), byId("calib-subpage-settings"),
      ],
      calibRowBody: byId("calib-row-body"),
      calibRowBodyPotion: byId("calib-row-body-potion"),
      calibControlBar: byId("calib-control-bar"),
      calibSelectedLabel: byId("calib-selected-label"),
      btnCalibRepick: byId("btn-calib-repick"),
      btnCalibSaveExample: byId("btn-calib-save-example"),
      btnCalibUp: byId("btn-calib-up"),
      btnCalibLeft: byId("btn-calib-left"),
      btnCalibRight: byId("btn-calib-right"),
      btnCalibDown: byId("btn-calib-down"),
      btnCalibWMinus: byId("btn-calib-w-minus"),
      btnCalibWPlus: byId("btn-calib-w-plus"),
      btnCalibHMinus: byId("btn-calib-h-minus"),
      btnCalibHPlus: byId("btn-calib-h-plus"),
      btnCalibAutolocate: byId("btn-calib-autolocate"),
      btnCalibRepickWindow: byId("btn-calib-repick-window"),
      btnCalibTitlebarClose: byId("btn-calib-titlebar-close"),
      calibPageStatus: byId("calib-page-status"),
      calibRepickOverlay: byId("calib-repick-overlay"),
      calibRepickHint: byId("calib-repick-hint"),
      calibRepickCanvas: byId("calib-repick-canvas"),
      selectHpSlot: byId("select-hp-slot"),
      selectMpSlot: byId("select-mp-slot"),
      selectHpType: byId("select-hp-type"),
      selectMpType: byId("select-mp-type"),
      potionSlotSummary: byId("potion-slot-summary"),
      potionCatalogBody: byId("potion-catalog-body"),
      newPotionName: byId("new-potion-name"),
      newPotionKind: byId("new-potion-kind"),
      newPotionPrice: byId("new-potion-price"),
      btnPotionAdd: byId("btn-potion-add"),
      btnCalibSave: byId("btn-calib-save"),
      btnCalibCancel: byId("btn-calib-cancel"),
      // ---- 設定頁（0077 起是校準頁第三個分頁，id 不變） ----
      settingFastInterval: byId("setting-fast-interval"),
      settingPotionsEnabled: byId("setting-potions-enabled"),
      settingPotionsHint: byId("setting-potions-hint"),
      settingMesoEnabled: byId("setting-meso-enabled"),
      settingRateModeRadios: Array.from(document.getElementsByName("setting-rate-mode")),
      settingZoom: byId("setting-zoom"),
      btnClearAllData: byId("btn-clear-all-data"),
      aboutVersion: byId("about-version"),
    };
    this.previewCtx = this.els.preview.getContext("2d");

    this.ocr = new OcrClient();
    this.ocr.onProgress = (info) => this._onModelProgress(info);

    this.captureHandle = null;
    this.stopFast = null;
    this.stopSlow = null;
    this._slowIntervalMs = SLOW_INTERVAL_NO_MAP_MS;

    /** exp/level 定位結果（locate() 回傳的框），null 代表退路用 DEFAULTS */
    this.located = null;
    /** 目前用的三塊區域（相對擷取畫面左上角），每次連線/尺寸改變時重算 */
    this.currentRegions = null;

    this.grabFailures = 0;
    this._frameStalled = false; // 0082 任務 2(c)：「畫面停住了」狀態文字有沒有卡住
    this._diagPrevFeedTs = null; // 0082 任務 1：診斷欄位 dt 用的影子變數
    this.regionCache = { exp: null, level: null, map: null, hp: null, mp: null };

    /** 0073 工單任務 4：最近一次 grabFrame() 的完整畫面（未縮放），給「下載目前畫面」用。 */
    this.lastFullCanvas = null;
    this.lastFrameSize = null;

    // ---- 0071 任務 2：狀態機／tracker／ratebuffer ----
    /** "disconnected" | "preview" | "recording" */
    this.state = "disconnected";
    this.tracker = null;
    this.rate = null;
    this._table = null;
    this._aliases = {};
    this._dataReady = this._preloadData();
    this._currentMapName = null;
    this._lastCountedAt = null; // 只有最近一筆慢迴圈 feed() 有計入時才有值（monoNow()）
    this._sessionStartedAt = null; // Date，寫進 storage 的 started_at
    this._unreadableStreak = 0;
    this._warnedUnreadable = false;
    this._settings = storage.loadSettings();
    this._rateMode = this._settings.rateMode === "recent" ? "recent" : "hour";

    // ---- 0072（W3）任務 1／2／4：藥水／楓幣／健康列 ----
    this._potionCatalog = PotionCatalog.load();
    this._potionTracker = null; // connect() 才建（跟 tracker/rate 同時機）
    this._mesoTracker = null;
    this._mesoTemplate = null; // 灰階 Float32Array，connect() 時載一次
    this._mesoTick = 0;
    this._lastMesoOcrAt = null; // monoNow()，MESO_OCR_MIN_INTERVAL_SEC 節流用
    this._lastMesoIcon = null; // {x,y} 給診斷文字用
    this._health = new HealthTracker(Date.now() / 1000);
    this._healthPrevAllOk = false;
    this._healthVisible = storage.loadUi().healthVisible;
    this._diagSamples = []; // 最近 20 筆慢迴圈樣本（複製診斷文字用）

    // ---- 校準（kc:calibration，0080 工單整頁重做）----
    this._calibration = storage.loadCalibration(); // null 或 {frameSize, regions:{...}, hpSlot, mpSlot}
    this._calibWorking = null; // 編輯中的副本（取消不落地）
    this._calibSelected = "exp";
    this._calibRowEls = {}; // key -> {tr, btn, liveCanvas, exampleImg, ocrSpan}
    this._calibOcrCache = {}; // key -> 上次送去 OCR 的裁圖位元組（畫面沒變不重讀）
    this._calibOcrPending = new Set(); // 正在跑 OCR 的 key，避免同一塊重疊送出
    this._calibLiveTimer = null; // 校準頁開著時每 500ms 重裁重畫（前提澄清 (2)）
    this._calibRepickDrag = null; // 重新框選遮罩拖框狀態 {startX, startY, key, naturalW, naturalH}
    this._anchorTemplates = null; // 自動定位用的四張錨點模板（灰階），第一次用到才載入
    // 0081 工單任務 1：校準頁是疊在精簡窗上面的獨立對話框，不是精簡窗（main/ranking）
    // 本身的分頁——`_calibrationOpen` 獨立追蹤校準頁開關，`_switchTab()` 開校準頁時
    // 不再把 tab-main/tab-ranking 的 active 狀態一起拿掉。
    this._calibrationOpen = false;

    this._bind();
    this._bindCalibration();
    this._bindSettings();
    this.els.version.textContent = VERSION;
    this.els.aboutVersion.textContent = VERSION;
    this._applySettingsToUi();
    this._applyZoom(storage.loadUi().zoom || 1);
    window.addEventListener("resize", () => this._applyZoom(storage.loadUi().zoom || 1));
    this._renderRankingTable();
    this._renderHealthBar();
    this._tickUiTimer = setInterval(() => this._updateStatsDisplay(), 500);
    this._healthTickTimer = setInterval(() => this._refreshHealth(), 1000);
  }

  async _preloadData() {
    const [, table] = await Promise.all([mapdb.loadNames(), exptable.loadTable(), this._loadAliases()]);
    this._table = table;
  }

  async _loadAliases() {
    try {
      const resp = await fetch("./data/map_aliases.json");
      if (!resp.ok) return;
      const raw = await resp.json();
      this._aliases = Object.fromEntries(
        Object.entries(raw).filter(([k, v]) => typeof v === "string" && !k.startsWith("_"))
      );
    } catch {
      this._aliases = {};
    }
  }

  _bind() {
    this.els.btnConnect.addEventListener("click", () => this.connect());
    this.els.btnStart.addEventListener("click", () => this.start());
    this.els.btnStop.addEventListener("click", () => this.disconnectOrStop());
    this.els.btnDownloadFrame.addEventListener("click", () => this._downloadFrame());
    this.els.chkRateMode.addEventListener("change", () => {
      this._rateMode = this.els.chkRateMode.checked ? "recent" : "hour";
      storage.saveSettings({ rateMode: this._rateMode });
      for (const radio of this.els.settingRateModeRadios) radio.checked = radio.value === this._rateMode;
      this._updateStatsDisplay();
    });
    this.els.chkRateMode.checked = this._rateMode === "recent";

    for (const btn of this.els.tabButtons) {
      btn.addEventListener("click", () => {
        // 0078 工單任務 2：「紀錄」鈕要能 toggle（桌面版 `_toggle_expand()` 是
        // `self.expanded = not self.expanded`，同一顆鈕展開/收回）。0077 版這裡
        // 直接呼叫 `_switchTab(btn.dataset.tab)`，已經在 ranking 分頁時再按
        // 一次還是切去 ranking（等於沒反應），沒有收回主面板的路徑——只有
        // 「紀錄」這顆鈕需要 toggle 行為，「主面板」「校準」兩顆鈕維持原本
        // 「按下去就切過去」的邏輯不變。
        if (btn.dataset.tab === "ranking" && this._currentTab() === "ranking") {
          this._switchTab("main");
        } else {
          this._switchTab(btn.dataset.tab);
        }
      });
    }

    this.els.btnClearHistory.addEventListener("click", () => {
      this._confirm("確定要清除全部歷史紀錄嗎？這個動作無法復原。", () => {
        storage.clearHistory();
        this._renderRankingTable();
      });
    });
    this.els.btnExportCsv.addEventListener("click", () => this._exportCsv());
    this.els.btnImportCsv.addEventListener("click", () => this.els.fileImportCsv.click());
    this.els.fileImportCsv.addEventListener("change", (ev) => this._importCsv(ev));

    this.els.healthToggle.addEventListener("click", () => {
      this._healthVisible = !this._healthVisible;
      storage.saveUi({ healthVisible: this._healthVisible });
      this._renderHealthBar();
    });
    this.els.btnUnreadableCalibrate.addEventListener("click", () => {
      this._hideUnreadableBanner();
      this._switchTab("calibration");
    });
    this.els.btnCopyDiag.addEventListener("click", () => this._copyDiagText());
  }

  _switchTab(tab) {
    const wasCalibration = this._calibrationOpen;
    if (tab === "calibration") {
      // 0081 工單任務 1：校準頁疊在精簡窗上面，不是精簡窗的分頁——只切換校準頁
      // 自己的 active 狀態，tab-main/tab-ranking（精簡窗內容）維持原狀不動，
      // 精簡窗與健康列因此開校準前後完全一樣。
      this.els.tabBtnCalibration.classList.add("active");
      this.els.tabCalibration.classList.add("active");
      this._calibrationOpen = true;
    } else {
      this.els.tabBtnCalibration.classList.remove("active");
      this.els.tabCalibration.classList.remove("active");
      this._calibrationOpen = false;
      for (const btn of this.els.tabButtons) {
        if (btn === this.els.tabBtnCalibration) continue;
        btn.classList.toggle("active", btn.dataset.tab === tab);
      }
      for (const page of this.els.tabPages) {
        if (page === this.els.tabCalibration) continue;
        page.classList.toggle("active", page.dataset.tab === tab);
      }
    }
    storage.saveUi({ tab });
    if (tab === "ranking") this._renderRankingTable();
    if (tab === "calibration") this._onEnterCalibrationTab();
    else if (wasCalibration) this._leaveCalibrationTab();
  }

  /** 0078 工單任務 2：目前作用中的分頁（給「紀錄」鈕判斷要不要 toggle 用）。
   * 0081 工單任務 1：校準頁是獨立疊層，`_calibrationOpen` 優先於 tabButtons 掃描
   * ——正是因為開校準頁時 tab-btn-main/tab-btn-ranking 的 active class 不再被拿掉，
   * 單純掃描第一個 active 的鈕會誤判成 main。 */
  _currentTab() {
    if (this._calibrationOpen) return "calibration";
    const active = this.els.tabButtons.find((btn) => btn.dataset.tab !== "calibration" && btn.classList.contains("active"));
    return active ? active.dataset.tab : "main";
  }

  /** 頁內確認元件（**不准用 window.confirm**，計畫書 §9.2）。 */
  _confirm(message, onYes) {
    this.els.confirmMessage.textContent = message;
    this.els.confirmOverlay.classList.add("show");
    const cleanup = () => {
      this.els.confirmOverlay.classList.remove("show");
      this.els.confirmYes.removeEventListener("click", onYesClick);
      this.els.confirmNo.removeEventListener("click", onNoClick);
    };
    const onYesClick = () => {
      cleanup();
      onYes();
    };
    const onNoClick = () => cleanup();
    this.els.confirmYes.addEventListener("click", onYesClick);
    this.els.confirmNo.addEventListener("click", onNoClick);
  }

  _onModelProgress(info) {
    if (info.stage === "ready") {
      this.els.modelProgress.textContent = "模型已載入";
      return;
    }
    const loaded = info.loaded || 0;
    const total = info.total || 0;
    const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
    this.els.modelProgress.textContent = "載入模型中… " + pct + "%";
  }

  setStatus(text) {
    this.els.status.textContent = text;
  }

  async connect() {
    this.els.btnConnect.disabled = true;
    this.setStatus("請求分享畫面…");
    try {
      this.captureHandle = await capture.connect();
    } catch (err) {
      this.setStatus("分享失敗：" + (err && err.message ? err.message : err));
      this.els.btnConnect.disabled = false;
      return;
    }
    await this._afterCaptureConnected();
  }

  /**
   * 測試專用入口：注入假的 captureHandle，繞過真的 `getDisplayMedia()`
   * （原生分享選單需要真人點選，自動化工具點不到，見 0070-回報單）。
   * `tests/frame.html`／`tests/frame-anim.html` 靠這個驅動整條 pipeline。
   * @param {ReturnType<typeof capture.connect>} handle
   */
  async debugConnect(handle) {
    this.captureHandle = await handle;
    await this._afterCaptureConnected();
  }

  async _afterCaptureConnected() {
    this.captureHandle.onEnded(() => this._onShareEnded());
    this.captureHandle.onSizeChange(({ size }) => {
      this.located = null;
      this.currentRegions = null;
      if (size) this._checkFrameSizeWarning(size.width, size.height);
    });

    await this._dataReady;
    // 0082 工單任務 2 查因用的檢查點：確認 mapdb.namesSync() 在建 tracker 這一刻
    // 真的已經載好（0071 裁定「先 await loadNames() 才建 ExpTracker」），不是
    // 空的退化成「還沒有總表可查」。正常情況下這裡不會印出來——`_dataReady`
    // 早在 App 建構時就已經在跑 `mapdb.loadNames()`，這裡只是留一個防呆警告。
    if (mapdb.namesSync().length === 0) {
      console.warn("[app] mapdb.namesSync() 在建立 ExpTracker 時是空的，地圖總表比對會退化成沒有總表可查！");
    }
    if (!this.tracker) {
      this.tracker = new ExpTracker({ table: this._table, mapAliases: this._aliases });
    }
    if (!this.rate) {
      this.rate = new RateBuffer(RATE_MIN_DT_SEC, RATE_BUFFER_THROTTLE_SEC, () => this._currentEffSeconds());
    }
    if (!this._potionTracker) {
      this._potionTracker = new PotionTracker();
    }
    if (!this._mesoTracker) {
      this._mesoTracker = new MesoTracker();
    }
    if (!this._mesoTemplate) {
      this._mesoTemplate = await this._loadGrayTemplate("./templates/meso_icon.png").catch(() => null);
    }
    this.state = "preview";
    this._slowIntervalMs = SLOW_INTERVAL_NO_MAP_MS;

    this.setStatus("載入模型中…");
    try {
      await this.ocr.init();
    } catch (err) {
      this.setStatus("模型載入失敗：" + (err && err.message ? err.message : err));
      return;
    }

    this.setStatus("定位中…");
    await this._relocate();

    this.setStatus("預覽中");
    this.els.btnStart.disabled = false;
    this.els.btnStop.disabled = false;
    this.els.btnDownloadFrame.disabled = false;
    this.grabFailures = 0;
    this._frameStalled = false;

    this.stopFast = every(() => this._fastTick(), this._fastIntervalMs());
    this._scheduleSlowTick(this._slowIntervalMs);
    // 慢迴圈不等 10 秒才第一次跑，連線當下立刻讀一次地圖。
    this._slowTick();
  }

  /** 快迴圈間隔（設定頁可調，100~1000ms，夾住不合法值）。 */
  _fastIntervalMs() {
    const v = Number(this._settings.fastIntervalMs) || DEFAULT_FAST_INTERVAL_MS;
    return Math.min(MAX_FAST_INTERVAL_MS, Math.max(MIN_FAST_INTERVAL_MS, v));
  }

  /** 讀一張模板圖，回傳灰階 {data:Uint8Array, width, height}（主執行緒版，給楓幣圖示比對用）。 */
  async _loadGrayTemplate(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("模板下載失敗：" + url);
    const bitmap = await createImageBitmap(await resp.blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const gray = lumaChannel(data);
    const width = bitmap.width;
    const height = bitmap.height;
    bitmap.close();
    return { data: gray, width, height };
  }

  _scheduleSlowTick(intervalMs) {
    if (this.stopSlow) this.stopSlow();
    this._slowIntervalMs = intervalMs;
    this.stopSlow = every(() => this._slowTick(), intervalMs);
  }

  _onShareEnded() {
    // 分享被停掉（track.onended）→ 等同按「結束」（0071 任務 2）。
    if (this.state === "recording") {
      this._stopRecording();
    }
    this.disconnect();
  }

  disconnectOrStop() {
    if (this.state === "recording") {
      this._stopRecording();
      // 結束後仍在預覽（連線沒斷），不整個 disconnect。
      return;
    }
    this.disconnect();
  }

  disconnect() {
    if (this.state === "recording") this._stopRecording();
    if (this.stopFast) {
      this.stopFast();
      this.stopFast = null;
    }
    if (this.stopSlow) {
      this.stopSlow();
      this.stopSlow = null;
    }
    if (this.captureHandle) {
      this.captureHandle.close();
      this.captureHandle = null;
    }
    this.located = null;
    this.currentRegions = null;
    this.regionCache = { exp: null, level: null, map: null, hp: null, mp: null };
    this.state = "disconnected";
    this.els.btnConnect.disabled = false;
    this.els.btnStart.disabled = true;
    this.els.btnStop.disabled = true;
    this.els.btnDownloadFrame.disabled = true;
    this.lastFullCanvas = null;
    this.lastFrameSize = null;
    this.els.frameSize.textContent = "";
    this.setStatus("未連線");
    this._hideUnreadableBanner();
  }

  /**
   * 地圖區域：永遠用校準值（沒有自動定位，逐字對照 uilocate.py「不涵蓋地圖名稱」
   * 的裁定），校準頁存的座標當有校準值時優先，沒校準過退回 regions.DEFAULTS.map。
   */
  _resolveMapRegion(width, height) {
    if (this._calibration && this._calibration.regions && this._calibration.regions.map) {
      return regions.resolveRelative(this._calibration.regions.map, width, height, this._calibration.frameSize);
    }
    return regions.resolveRelative(regions.DEFAULTS.map, width, height, regions.DEFAULTS.frameSize);
  }

  /** 快捷欄（藥水）三塊：只有校準過才有值，沒校準回 null（potions 功能停用）。 */
  _resolvePotionRegions(width, height) {
    const cal = this._calibration;
    if (!cal || !cal.regions || !cal.regions.panel || !cal.regions.hp || !cal.regions.mp) return null;
    if (!(cal.regions.hp.width > 0) || !(cal.regions.mp.width > 0)) return null;
    return {
      panel: regions.resolveRelative(cal.regions.panel, width, height, cal.frameSize),
      hp: regions.resolveRelative(cal.regions.hp, width, height, cal.frameSize),
      mp: regions.resolveRelative(cal.regions.mp, width, height, cal.frameSize),
    };
  }

  /** exp/level 退路：校準值優先於 regions.DEFAULTS（自動定位失敗時才用）。 */
  _fallbackExpLevelBase() {
    const cal = this._calibration;
    if (cal && cal.regions && cal.regions.exp && cal.regions.level) {
      return { exp: cal.regions.exp, level: cal.regions.level, frameSize: cal.frameSize };
    }
    return { exp: regions.DEFAULTS.exp, level: regions.DEFAULTS.level, frameSize: regions.DEFAULTS.frameSize };
  }

  /** 畫面尺寸跟校準時不一樣 → 橘字警告（計畫書 §9.3，同桌面版）。 */
  _checkFrameSizeWarning(width, height) {
    const cal = this._calibration;
    if (!cal || !cal.frameSize) {
      this.els.frameSizeWarning.style.display = "none";
      return;
    }
    const changed = regions.sizeChanged(width, height, cal.frameSize);
    if (changed) {
      this.els.frameSizeWarning.textContent =
        "⚠ 畫面尺寸跟校準時不一樣（校準時 " + cal.frameSize.width + "×" + cal.frameSize.height + "，現在 " + width + "×" + height + "），座標可能跑掉，建議重新校準。";
      this.els.frameSizeWarning.style.display = "block";
    } else {
      this.els.frameSizeWarning.style.display = "none";
    }
  }

  /** 定位一次 exp/level（自動定位失敗就退回校準值／regions.DEFAULTS + anchor 換算）。 */
  async _relocate() {
    const size = this.captureHandle.size;
    this._checkFrameSizeWarning(size.width, size.height);
    let bitmap;
    try {
      bitmap = await this.captureHandle.grabFrame();
    } catch (err) {
      console.error("[app] 定位前 grabFrame 失敗", err);
      this._applyFallbackRegions(size.width || regions.DEFAULTS.frameSize.width, size.height || regions.DEFAULTS.frameSize.height);
      return;
    }

    this._updatePreviewFromBitmap(bitmap);

    try {
      const { result } = await this.ocr.locate(bitmap);
      if (result) {
        this.located = result;
        // 0075 號工單：locate() 的 NCC 定位精度容差是 ≤1px，這 1px 剛好會切到
        // level 框緊貼邊界的字元（0074-回報.md「等級讀成 5」的查因），上下左右
        // 各多留 1px 吸收這個誤差。Python uilocate.py 沒有這 1px（那邊的
        // level_offset 本來就是算給桌面版 OCR 用的），這是網頁版自己的裁定，
        // 只有 level 這塊需要——exp 框本來裁圖就有留白，不用加。
        const levelBox = regions.expandBox(result.level, 1);
        const potionRegions = this._resolvePotionRegions(size.width, size.height);
        this.currentRegions = {
          exp: { left: result.exp[0], top: result.exp[1], width: result.exp[2] - result.exp[0], height: result.exp[3] - result.exp[1] },
          level: {
            left: levelBox[0],
            top: levelBox[1],
            width: levelBox[2] - levelBox[0],
            height: levelBox[3] - levelBox[1],
          },
          map: this._resolveMapRegion(size.width, size.height),
          panel: potionRegions ? potionRegions.panel : null,
          hp: potionRegions ? potionRegions.hp : null,
          mp: potionRegions ? potionRegions.mp : null,
        };
        return;
      }
    } catch (err) {
      console.error("[app] locate() 失敗", err);
    }

    this._applyFallbackRegions(size.width, size.height);
  }

  _applyFallbackRegions(width, height) {
    this.located = null;
    const base = this._fallbackExpLevelBase();
    const potionRegions = this._resolvePotionRegions(width, height);
    this.currentRegions = {
      exp: regions.resolveRelative(base.exp, width, height, base.frameSize),
      level: regions.resolveRelative(base.level, width, height, base.frameSize),
      map: this._resolveMapRegion(width, height),
      panel: potionRegions ? potionRegions.panel : null,
      hp: potionRegions ? potionRegions.hp : null,
      mp: potionRegions ? potionRegions.mp : null,
    };
  }

  // -------------------------------------------------------------------------
  // 「開始」／「結束」（0071 任務 2，規則摘要 §4「暫停／繼續」）

  start() {
    if (this.state !== "preview" || !this.tracker || !this.rate) return;
    this.tracker.resetBaseline();
    const now = monoNow();
    this.rate.reset(now);
    if (this._currentMapName) this.rate.noteMap(this._currentMapName, now);
    this._lastCountedAt = null;
    this._unreadableStreak = 0;
    this._warnedUnreadable = false;
    this._hideUnreadableBanner();
    if (!this._sessionStartedAt) this._sessionStartedAt = new Date();
    // 規則摘要 §4「暫停／繼續」：開始時新建 PotionTracker（藥水消耗量歸零重算這一場），
    // 楓幣只 reset()（不換實例，物品欄取樣天生稀疏，跟藥水的節奏不同）。
    this._potionTracker = new PotionTracker();
    if (this._mesoTracker) this._mesoTracker.reset();
    this.state = "recording";
    this._scheduleSlowTick(SLOW_INTERVAL_RECORDING_MS);
    this.els.btnStart.disabled = true;
    this.setStatus("記錄中");
  }

  _stopRecording() {
    if (this.state !== "recording") return;
    this.tracker.resetBaseline();
    this.rate.reset(monoNow());
    this._lastCountedAt = null;
    if (this.tracker.maps.size > 0) {
      const potion = this._potionTracker ? this._potionTracker.asDict(this._hpPrice(), this._mpPrice()) : null;
      const meso = this._mesoTracker ? this._mesoTracker.asDict() : null;
      storage.appendSession(this.tracker.maps, this._sessionStartedAt, potion, meso);
      this.tracker = new ExpTracker({ table: this._table, mapAliases: this._aliases });
    }
    // 跟桌面版一致：楓幣不 reset（下一次開物品欄還是有效資料）；藥水累計量
    // 屬於「這一場」的成績，這裡也新建一個乾淨的 PotionTracker，避免「結束」後
    // 回到預覽模式還顯示上一場的水錢數字（跟 ExpTracker 換新實例是同一個理由，
    // 這張單自己的裁定，見回報單「裁定與偏離」）。
    this._potionTracker = new PotionTracker();
    this._sessionStartedAt = null;
    this._currentMapName = null;
    this._unreadableStreak = 0;
    this._warnedUnreadable = false;
    this._hideUnreadableBanner();
    this.state = "preview";
    this._scheduleSlowTick(this.located || this._currentMapName ? SLOW_INTERVAL_HAS_MAP_MS : SLOW_INTERVAL_NO_MAP_MS);
    this.els.btnStart.disabled = false;
    this.setStatus("預覽中");
    this._renderRankingTable();
  }

  // -------------------------------------------------------------------------
  // 快迴圈：250ms 讀一次經驗／等級，畫面沒變就跳過 OCR；記錄中才 push 進 ratebuffer。

  async _fastTick() {
    if (!this.captureHandle || !this.currentRegions) return;
    let bitmap;
    try {
      bitmap = await this.captureHandle.grabFrame();
    } catch (err) {
      this.grabFailures++;
      if (this.grabFailures >= MAX_GRAB_FAILURES) {
        this._frameStalled = true;
        this.setStatus("畫面停住了，重新抓取中…");
      }
      return;
    }
    this.grabFailures = 0;
    // 0082 工單任務 2(c)：「畫面停住了」不能卡死，畫面一回來就要自動恢復狀態文字
    // （舊版這裡只有清 `grabFailures`，狀態文字會一直停在「畫面停住了」直到使用者
    // 自己按了什麼觸發 setStatus 的動作，看起來像整支程式當掉）。
    if (this._frameStalled) {
      this._frameStalled = false;
      this.setStatus(this.state === "recording" ? "記錄中" : "預覽中");
    }
    this._updatePreviewFromBitmap(bitmap, true);

    try {
      await this._readRegion(bitmap, "exp", this.currentRegions.exp, {
        lang: "ch",
        upscale: 3,
        preprocess: "none",
      }).then((text) => {
        if (text === null) return; // 快取命中，畫面沒變，文字沒變不用重算
        const [exp, percent] = parseExpLine(text);
        this._lastExp = exp;
        this._lastPercent = percent;
        this._markHealth("exp_region", exp);
      });

      await this._readRegion(bitmap, "level", this.currentRegions.level, {
        lang: "ch",
        upscale: 6,
        preprocess: "gray_invert",
      }).then((text) => {
        if (text === null) return;
        const digitsOnly = Boolean(this.located); // 自動定位成功時框只剩數字
        this._lastLevel = parseLevel(text, digitsOnly);
        this._markHealth("level_region", this._lastLevel);
      });
    } finally {
      bitmap.close();
    }

    if (this.state === "recording" && this.rate) {
      this.rate.push(this._currentEffSeconds(), this._lastExp, this._lastPercent);
    }
    // 0072 工單任務 2：楓幣圖示掃描（每 MESO_SCAN_EVERY_TICKS 拍一次，計畫書 §6
    // 兩階段設計，見 mesos.mjs）。不需要 `bitmap`（已經 close 掉），用
    // `_updatePreviewFromBitmap()` 剛存好的 `this.lastFullCanvas` 全解析度畫面。
    await this._mesoScanTick();
    this._updateStatsDisplay();
  }

  // -------------------------------------------------------------------------
  // 慢迴圈：地圖 OCR（水平投影分行，ch 模型每行各讀一次，接起來後 mergeMapName）
  // → 預覽期 feedMapOnly，記錄中 tracker.feed()。

  async _slowTick() {
    if (!this.captureHandle || !this.currentRegions) return;
    let bitmap;
    try {
      bitmap = await this.captureHandle.grabFrame();
    } catch (err) {
      console.error("[app] 慢迴圈 grabFrame 失敗", err);
      return;
    }

    let mergedMapName = null;
    let hpCount = null;
    let mpCount = null;
    try {
      const region = this.currentRegions.map;
      const crop = this._cropToCanvas(bitmap, region);

      if (crop) {
        const { imageData } = crop;
        const changed = this._checkAndUpdateCache("map", imageData.data);

        if (changed) {
          const gray = lumaChannel(imageData.data);
          const lines = splitLines(gray, region.width, region.height);
          const lineBoxes = lines.length ? lines : [[0, region.height]];

          // 0071 起地圖只用 ch（簡體）模型讀每一行，upscale 5、不裁欄
          // （計畫書 §5.2）。Python read_region() 是「整塊區域各模型各讀一次，
          // 每個模型內部的多行結果先用一個空白接成一段」再做一次
          // merge_map_name()——這裡只有一顆模型，所以是 " ".join(每行文字)
          // 後把同一份字串餵給 mergeMapName() 的兩個參數（0071 前提澄清 (6)）。
          const chParts = [];
          for (const [y0, y1] of lineBoxes) {
            const lineHeight = y1 - y0;
            const lineCanvas = new OffscreenCanvas(region.width, lineHeight);
            lineCanvas.getContext("2d").putImageData(imageData, 0, -y0);
            const lineBitmap = await createImageBitmap(lineCanvas);
            const result = await this.ocr.recognize(lineBitmap, { lang: "ch", upscale: 5, preprocess: "none" });
            chParts.push(result.text || "");
          }

          let chJoined = chParts.join(" ");
          mergedMapName = mergeMapName(chJoined, chJoined);

          // 0074 工單任務 3：合併後的名字含「川」又抓不到編號 -> 編號被讀壞，對
          // 「那一行」（投影分行後含「川」的那行）用同一顆 ch 模型依序加大倍率
          // 8→10→12 重讀，第一個不再 hasUnreadableNumeral() 的結果就採用。
          // ⚠️ 跟桌面版 ocr.py 的 _retry_broken_numeral() 不同：全部重讀失敗這裡
          // 維持原讀值（不是回傳空字串），這是這張單的裁定，見回報單「裁定與偏離」。
          if (hasUnreadableNumeral(mergedMapName)) {
            const brokenIdx = chParts.findIndex((t) => t.includes(BROKEN_NUMERAL_CHAR));
            if (brokenIdx !== -1) {
              const [ry0, ry1] = lineBoxes[brokenIdx];
              const retryLineHeight = ry1 - ry0;
              for (const retryUpscale of BROKEN_NUMERAL_RETRY_UPSCALES) {
                const retryCanvas = new OffscreenCanvas(region.width, retryLineHeight);
                retryCanvas.getContext("2d").putImageData(imageData, 0, -ry0);
                const retryBitmap = await createImageBitmap(retryCanvas);
                const retryResult = await this.ocr.recognize(retryBitmap, {
                  lang: "ch",
                  upscale: retryUpscale,
                  preprocess: "none",
                });
                const retriedParts = chParts.slice();
                retriedParts[brokenIdx] = retryResult.text || "";
                const retriedJoined = retriedParts.join(" ");
                const retriedMerged = mergeMapName(retriedJoined, retriedJoined);
                if (!hasUnreadableNumeral(retriedMerged)) {
                  chJoined = retriedJoined;
                  mergedMapName = retriedMerged;
                  break;
                }
              }
            }
          }

          this._lastMapRaw = chJoined;
          this._lastMergedMapName = mergedMapName;
          this._markHealth("map_region", mergedMapName && mergedMapName.length > 0 ? mergedMapName : null);
        } else {
          // 畫面沒變：沿用上次合併結果餵給穩定器/tracker，維持「每輪都要 feed
          // 一次」的節奏（掛機判定靠 dt 累積，不能因為畫面沒變就跳過整輪）。
          mergedMapName = this._lastMergedMapName || "";
        }
      }
      // 0072 工單任務 1：藥水數量（只在慢迴圈讀，只有計時中才 feed，計畫書
      // §9.1／規則摘要 §5）。跟地圖同一輪、同一張 bitmap，讀完才 close()。
      if (this._settings.potionsEnabled && this.currentRegions.hp && this.currentRegions.mp) {
        hpCount = await this._readPotionCount(bitmap, "hp", this.currentRegions.hp);
        mpCount = await this._readPotionCount(bitmap, "mp", this.currentRegions.mp);
      }
    } finally {
      // 0082 工單任務 1：診斷欄位（counted／note／rawMap／mapSource／levelTotal／dt）。
      // `dt` 不從 tracker 內部挖（那是 `_prevTs` 的私有狀態，`_feed()` 只有在
      // 真的算到那一步才會用到），改用這裡自己記的「上一次呼叫 feed() 的
      // ts」；因為 `tracker.feed()` 只在這個 finally 區塊呼叫（`_slowTick()`
      // 是唯一入口），這個影子變數天生跟 tracker 內部的 `_prevTs` 同步。
      let diagCounted = null; // true/false/null（null＝這一輪沒呼叫 feed()，只是預覽）
      let diagNote = "";
      let diagDt = null;
      let diagMapSource = null; // "alias"|"known"|"csv"|"raw"|null

      // exp/level 用同一輪讀值（跟快迴圈共用最新一次的解析結果，不在慢迴圈
      // 重新 OCR exp/level——快迴圈已經在跑，這裡只需要目前暫存的數字）。
      if (this.state === "recording" && this.tracker) {
        const ts = monoNow();
        diagDt = this._diagPrevFeedTs !== null && this._diagPrevFeedTs !== undefined ? ts - this._diagPrevFeedTs : null;
        this._diagPrevFeedTs = ts;
        const result = this.tracker.feed(ts, this._lastExp, this._lastPercent, mergedMapName || "", this._lastLevel);
        this._currentMapName = result.mapName;
        diagCounted = result.counted;
        diagNote = result.note;
        if (result.counted) this._lastCountedAt = monoNow();
        if (this._currentMapName) this.rate.noteMap(this._currentMapName, monoNow());
        this._trackUnreadable(this._lastExp, result.mapName);
        if (this._potionTracker) {
          this._potionTracker.feed(monoNow(), hpCount, mpCount, this.tracker.totals().seconds);
        }
      } else if (this.tracker) {
        this._diagPrevFeedTs = null; // 預覽期沒有真的 feed()，dt 影子變數不該延續到下次開始記錄
        const name = this.tracker.feedMapOnly(mergedMapName || "");
        this._currentMapName = name;
        if (name && this._slowIntervalMs !== SLOW_INTERVAL_HAS_MAP_MS) {
          // 預覽期讀到地圖後，從下一輪起把慢迴圈降到 30 秒（規則摘要 §8）。
          this._scheduleSlowTick(SLOW_INTERVAL_HAS_MAP_MS);
        }
      }
      // canonicalWithSource() 是純函式（不會 mutate known/current），這裡另外呼叫
      // 一次純粹是為了拿到「alias/known/csv/raw」這個來源標記給診斷文字用，
      // 不影響上面 feed()／feedMapOnly() 已經跑過的真正判斷。
      if (this.tracker && mergedMapName) {
        try {
          const cleaned = cleanMapName(mergedMapName);
          diagMapSource = cleaned.length >= 2 ? this.tracker._stabilizer.canonicalWithSource(cleaned)[1] : null;
        } catch (err) {
          console.error("[app] 診斷用 canonicalWithSource() 失敗", err);
        }
      }
      // 0078 工單任務 5：冒號照桌面版 `"地圖:{}".format(...)` 改半形（無空格）。
      this.els.statMap.textContent = "地圖:" + (this._currentMapName || "—");
      this._pushDiagSample({
        ts: Date.now(),
        map: this._currentMapName,
        exp: this._lastExp,
        level: this._lastLevel,
        hpCount,
        mpCount,
        mesoIcon: this._lastMesoIcon,
        counted: diagCounted,
        note: diagNote,
        rawMap: this._lastMapRaw || "",
        mapSource: diagMapSource,
        levelTotal: this.tracker ? this.tracker.levelTotal : null,
        dt: diagDt,
      });
      bitmap.close();
    }
  }

  /** 藥水數量框 OCR（upscale 6, gray, ch），走跟 exp/level 一樣的「畫面沒變就跳過」快取。 */
  async _readPotionCount(bitmap, key, region) {
    const text = await this._readRegion(bitmap, key, region, { lang: "ch", upscale: 6, preprocess: "gray" });
    if (text === null) return this._lastPotionCount ? this._lastPotionCount[key] : null; // 快取命中：沿用上次
    const count = parseCount(text);
    this._markHealth("potions." + key + "_count_region", count);
    this._lastPotionCount = this._lastPotionCount || { hp: null, mp: null };
    this._lastPotionCount[key] = count;
    return count;
  }

  _trackUnreadable(exp, mapName) {
    const unreadable = exp === null || exp === undefined || mapName === null || mapName === undefined;
    this._unreadableStreak = unreadable ? this._unreadableStreak + 1 : 0;
    if (this._unreadableStreak >= UNREADABLE_WARN_THRESHOLD && !this._warnedUnreadable) {
      this._warnedUnreadable = true;
      this._showUnreadableBanner(this._unreadableStreak);
    } else if (!unreadable) {
      this._warnedUnreadable = false;
      this._hideUnreadableBanner();
    }
  }

  _showUnreadableBanner(count) {
    this.els.unreadableCount.textContent = String(count);
    this.els.bannerUnreadable.style.display = "block";
  }

  _hideUnreadableBanner() {
    this.els.bannerUnreadable.style.display = "none";
  }

  // -------------------------------------------------------------------------
  // 精簡數據列（0071 任務 3，計畫書 §9.1）

  /** 這張圖的「有效秒數」：慢迴圈最近一次有計入時的 seconds + 距今經過的時間（0071 任務 2）。 */
  _currentEffSeconds() {
    const now = monoNow();
    const stat = this.tracker && this._currentMapName ? this.tracker.maps.get(this._currentMapName) : null;
    if (stat && stat.seconds > 0 && this._lastCountedAt !== null) {
      return stat.seconds + (now - this._lastCountedAt);
    }
    return stat ? stat.seconds : 0;
  }

  /** 本次計時：tracker.totals().seconds + 距最近一次有計入時經過的時間；掛機/讀不到時停住。 */
  _sessionElapsedSeconds() {
    if (!this.tracker) return 0;
    const totals = this.tracker.totals();
    if (totals.seconds > 0 && this._lastCountedAt !== null) {
      return totals.seconds + (monoNow() - this._lastCountedAt);
    }
    return totals.seconds;
  }

  _updateStatsDisplay() {
    const lv = this._lastLevel !== undefined && this._lastLevel !== null ? this._lastLevel : "—";
    const exp = this._lastExp !== undefined && this._lastExp !== null ? this._lastExp.toLocaleString("zh-TW") : "—";
    const pct = this._lastPercent !== undefined && this._lastPercent !== null ? this._lastPercent.toFixed(2) : "—";
    // 0078 工單任務 5：逐字照桌面版 app.py 的 `"{}    {}".format(level, exp)`
    // （`"line1"` 那個 key）——四個半形空白，沒有「經驗」兩個字（規劃時
    // 計畫書 §9.1 寫錯，已一併改過，見那份文件同一行的註記）。
    this.els.statLevelExp.textContent = "Lv." + lv + "    " + exp + "（" + pct + "%）";

    // 經驗/hr 或 經驗/10min（切換勾勾，計畫書 §9.1）
    // 0078 工單任務 5：冒號照桌面版 rate_label（"經驗/hr: {}"）改半形＋空格。
    if (this.state === "recording" && this.rate) {
      const sec = this._rateMode === "recent" ? 600.0 : 3600.0;
      const win = this.rate.window(sec);
      const label = this._rateMode === "recent" ? "經驗/10min" : "經驗/hr";
      this.els.statRate.textContent = label + ": " + (win ? Math.round(win[0]).toLocaleString("zh-TW") : "—");
    } else {
      this.els.statRate.textContent = (this._rateMode === "recent" ? "經驗/10min" : "經驗/hr") + ": —";
    }

    // 距離升級
    if (this.tracker) {
      const seconds = this.tracker.secondsToLevelUp(this._currentMapName);
      this.els.statTimeToLevelup.textContent = "距離升級 " + (seconds !== null ? storage.formatHms(seconds) : "—");
    }

    // 本次計時
    this.els.statSessionTime.textContent = "本次計時 " + storage.formatHms(this._sessionElapsedSeconds());

    this._updatePotionRow();
    this._updateMesoRow();
  }

  /** 水錢那行（計畫書 §9.1）：藥水啟用才顯示；「10min 模式直接用 in_window(600)，
   * hr 模式再 × 6」（逐字對照桌面版 app.py 的裁定，不是直接呼叫 in_window(3600)）。 */
  _updatePotionRow() {
    const show = Boolean(this._settings.potionsEnabled);
    this.els.statPotion.style.display = show ? "" : "none";
    if (!show) return;
    const label = this._rateMode === "recent" ? "水錢/10min" : "水錢/hr";
    let raw = formatPotionRow(null);
    if (this.state === "recording" && this._potionTracker) {
      const win600 = this._potionTracker.inWindow(600, this._hpPrice(), this._mpPrice());
      const display = this._rateMode === "recent" ? win600 : win600 ? [win600[0] * 6, win600[1] * 6, win600[2] * 6] : null;
      raw = formatPotionRow(display);
    }
    // 0077 工單任務 2：「HP:」「MP:」字眼換成桌面版同款的紅／藍藥水小圖示
    // （`ui_skin.potion_icon()` 烤出來的 `assets/ui-built/icons/potion_{hp,mp}.png`）。
    // `raw` 是 `formatPotionRow()` 算出來的字串（數字本身完全沒動），這裡純粹是
    // 換字面 label 的顯示格式，不是新的統計邏輯。
    const withIcons = raw
      .replace("HP:", '<img class="kc-inline-icon" src="assets/ui-built/icons/potion_hp.png" alt="HP" />')
      .replace("MP:", '<img class="kc-inline-icon" src="assets/ui-built/icons/potion_mp.png" alt="MP" />');
    // 0078 工單任務 5：冒號照桌面版 potion_label（"水錢/hr: {}"）改半形＋空格。
    this.els.statPotion.innerHTML = label + ": " + withIcons;
  }

  /** 楓幣那行：永遠顯示（不像水錢那行看 potionsEnabled）。 */
  _updateMesoRow() {
    const label = this._rateMode === "recent" ? "楓幣/10min" : "楓幣/hr";
    const sec = this._rateMode === "recent" ? 600 : 3600;
    let amount = null;
    if (this._mesoTracker) amount = this._mesoTracker.inWindow(sec);
    const amountText = formatMesoAmount(amount);
    const lastTs = this._mesoTracker ? this._mesoTracker.lastTs() : null;
    const stale = lastTs === null || monoNow() - lastTs > MESO_STALE_SEC;
    // 0077 工單任務 2：楓幣圖示（`ui_skin.meso_icon()` 烤出來的
    // `assets/ui-built/icons/meso.png`，取代原本的 🪙 emoji）＋六級顏色（逐字照抄
    // `ui_skin.MESO_TIER_COLORS`，見 `mesos.mjs` 的 `mesoTierColor()`）。amount 是
    // null 時（還沒讀到）不上色（沿用預設文字色），跟桌面版「沒有數字就不上色」
    // 的行為一致。
    const coinImg = '<img class="kc-inline-icon" src="assets/ui-built/icons/meso.png" alt="楓幣" />';
    const amountSpan = amount === null
      ? '<span class="kc-meso-amount">' + amountText + "</span>"
      : '<span class="kc-meso-amount" style="color:' + mesoTierColor(amount) + '">' + amountText + "</span>";
    // 0078 工單任務 5：冒號照桌面版 meso_label（"楓幣/hr: {}"）改半形＋空格；
    // 提示小字的括號照桌面版 `MESO_HINT = "(開物品欄更新)"` 改半形（跟上面
    // 百分比用的全形括號不同，桌面版這兩處括號本來就不一致，逐字照抄）。
    let html = label + ": " + coinImg + " " + amountSpan;
    if (stale) html += '<span class="kc-meso-hint">(開物品欄更新)</span>';
    this.els.statMeso.innerHTML = html;
  }

  _hpPrice() {
    const name = this._calibration && this._calibration.hpType;
    const price = this._potionCatalog.price(name);
    return price === null ? 0 : price;
  }

  _mpPrice() {
    const name = this._calibration && this._calibration.mpType;
    const price = this._potionCatalog.price(name);
    return price === null ? 0 : price;
  }

  // -------------------------------------------------------------------------
  // 健康列（0072 工單任務 4，計畫書 §9.1／CLAUDE.md「健康列」）

  /** 這一塊快捷欄／藥水功能是不是「已經設定好」（校準過 panel/hp/mp 且設定頁打開）。 */
  _potionsReady() {
    if (!this._settings.potionsEnabled) return false;
    const r = this._calibration && this._calibration.regions;
    return Boolean(r && r.hp && r.hp.width > 0 && r.mp && r.mp.width > 0);
  }

  /** 讀到一筆（非 null）markOk；OCR 真的跑過但讀不到（null）markFail。只在「真的做過一次讀取」時呼叫，快取命中（沒重算）不要呼叫。 */
  _markHealth(key, value) {
    const now = Date.now() / 1000;
    if (value !== null && value !== undefined) {
      this._health.markOk(key, now);
    } else {
      this._health.markFail(key, now);
    }
  }

  _renderHealthBar() {
    // 0078 工單任務 3：收合對象改成整個 `.kc-health-window`（`healthPanel`），
    // 不是只清空 `#health-bar` 裡的六列——桌面版收合是「健康列這個浮窗整個消失」
    // （`health_0063_collapsed_x3.png`：收起後只剩標題列上的箭頭鈕），
    // 0077 版只清空內容列，框跟「校準」鈕還留在原地，視覺上沒有「藏起來」。
    this.els.healthPanel.classList.toggle("collapsed", !this._healthVisible);
    this.els.healthToggle.textContent = this._healthVisible ? "收合" : "展開";
    // 0077 工單任務 2：CSS 選 collapse/expand 兩張桌面版摺疊鈕圖靠這個 data 屬性，
    // textContent 還是留著（唯讀顯示用，沒有任何邏輯讀它）。
    this.els.healthToggle.dataset.state = this._healthVisible ? "collapse" : "expand";
  }

  /** 每秒重畫一次（跟桌面版一致），順便跑「全部綠燈自動收合」判斷。 */
  _refreshHealth() {
    const now = Date.now() / 1000;
    const connected = this.state !== "disconnected";
    const potionsReady = this._potionsReady();
    const statuses = {};
    for (const key of HEALTH_KEYS) {
      let enabled;
      let okWithin = HEALTH_OK_WITHIN;
      let coldStartBad = true;
      if (key === "meso") {
        enabled = connected && Boolean(this._settings.mesoEnabled) && Boolean(this._mesoTemplate);
        okWithin = MESO_STALE_SEC;
        coldStartBad = false;
      } else if (key.startsWith("potions.")) {
        enabled = connected && potionsReady;
      } else {
        enabled = connected;
      }
      statuses[key] = this._health.status(key, now, enabled, okWithin, coldStartBad);

      const item = this.els.healthBar.querySelector('.health-item[data-key="' + key + '"]');
      if (!item) continue;
      if (key.startsWith("potions.")) {
        // 0076 前提 (4)：藥水啟用但快捷欄還沒校準時，這顆燈還是要顯示（不再整列藏起來），
        // 灰燈旁邊多一句「未校準」小字，不要噴錯。只有「藥水功能整個沒開」才藏起來。
        const enabledSetting = Boolean(this._settings.potionsEnabled);
        item.style.display = enabledSetting ? "" : "none";
        const hint = item.querySelector(".health-uncalib");
        // 注意：.health-uncalib 在 CSS 預設就是 display:none，這裡顯示要用 "inline"
        // 而不是 ""——清空 inline style 只是「退回 CSS 規則」，退回的規則本身就是 none。
        if (hint) hint.style.display = enabledSetting && !potionsReady ? "inline" : "none";
      }
      const dot = item.querySelector(".health-dot");
      dot.className = "health-dot " + statuses[key];
    }

    // 全部綠燈自動收合（楓幣不算進去，見 health.mjs autoPanelAction()）。
    const shownKeys = HEALTH_KEYS.filter((k) => k !== "meso" && (potionsReady || !k.startsWith("potions.")));
    const allOk = shownKeys.every((k) => statuses[k] === "ok");
    const action = autoPanelAction(this._healthPrevAllOk, allOk);
    this._healthPrevAllOk = allOk;
    if (action === "collapse" && this._healthVisible) {
      this._healthVisible = false;
      storage.saveUi({ healthVisible: false });
      this._renderHealthBar();
    }

    this._lastHealthStatuses = statuses;
  }

  // -------------------------------------------------------------------------
  // 楓幣圖示掃描（0072 工單任務 2，快迴圈每 MESO_SCAN_EVERY_TICKS 拍一次）

  async _mesoScanTick() {
    if (!this._settings.mesoEnabled || !this._mesoTemplate || !this.lastFullCanvas || !this.lastFrameSize) return;
    this._mesoTick++;
    if (this._mesoTick % MESO_SCAN_EVERY_TICKS !== 0) return;

    const { width, height } = this.lastFrameSize;
    const ctx = this.lastFullCanvas.getContext("2d", { willReadFrequently: true });
    const imageData = ctx.getImageData(0, 0, width, height);
    const gray = lumaChannel(imageData.data);
    const result = findIcon(gray, width, height, this._mesoTemplate.data);
    if (result.score < MESO_ICON_THRESHOLD) return;
    this._lastMesoIcon = { x: result.x, y: result.y, score: result.score };

    const now = monoNow();
    if (this._lastMesoOcrAt !== null && now - this._lastMesoOcrAt < MESO_OCR_MIN_INTERVAL_SEC) return;
    this._lastMesoOcrAt = now;

    const [nx, ny, nw, nh] = numberRegion([result.x, result.y]);
    const crop = this._cropToCanvas(this.lastFullCanvas, { left: nx, top: ny, width: nw, height: nh });
    if (!crop) return;
    const ocrBitmap = await createImageBitmap(crop.canvas);
    let text = "";
    try {
      const ocrResult = await this.ocr.recognize(ocrBitmap, { lang: "ch", upscale: 6, preprocess: "gray" });
      text = ocrResult.text;
    } catch (err) {
      console.error("[app] 楓幣 OCR 失敗", err);
      return;
    }
    const amount = parseAmount(text);
    if (amount !== null) {
      if (this._mesoTracker) this._mesoTracker.feed(Date.now() / 1000, amount);
      this._health.markOk("meso", Date.now() / 1000);
    } else {
      // 找到圖示、也做了 OCR 但解析不出來，才算失敗（單純沒找到圖示不算）。
      this._health.markFail("meso", Date.now() / 1000);
    }
  }

  // -------------------------------------------------------------------------
  // 診斷文字（計畫書 §13：不做「檢查更新」「回報問題 zip」，改用這顆鈕）

  _pushDiagSample(sample) {
    this._diagSamples.push(sample);
    if (this._diagSamples.length > 20) this._diagSamples.shift();
  }

  _buildDiagText() {
    const lines = [];
    lines.push("魔龍修仙 診斷文字");
    lines.push("版本：" + VERSION);
    lines.push("狀態：" + this.state + "　" + (this.els.status.textContent || ""));
    lines.push("畫面尺寸：" + (this.lastFrameSize ? this.lastFrameSize.width + "×" + this.lastFrameSize.height : "（未連線）"));
    lines.push("校準時尺寸：" + (this._calibration ? this._calibration.frameSize.width + "×" + this._calibration.frameSize.height : "（未校準）"));
    lines.push("");
    lines.push("六塊最近讀值：");
    lines.push("  經驗值：" + (this._lastExp !== undefined && this._lastExp !== null ? this._lastExp : "—") + "（" + (this._lastPercent !== undefined && this._lastPercent !== null ? this._lastPercent.toFixed(2) : "—") + "%）");
    lines.push("  等級：" + (this._lastLevel !== undefined && this._lastLevel !== null ? this._lastLevel : "—"));
    lines.push("  地圖：" + (this._currentMapName || "—"));
    lines.push("  血水數量：" + (this._lastPotionCount && this._lastPotionCount.hp !== null && this._lastPotionCount.hp !== undefined ? this._lastPotionCount.hp : "—"));
    lines.push("  藍水數量：" + (this._lastPotionCount && this._lastPotionCount.mp !== null && this._lastPotionCount.mp !== undefined ? this._lastPotionCount.mp : "—"));
    lines.push("  楓幣：" + (this._mesoTracker && this._mesoTracker.count() > 0 ? this._mesoTracker.gain() + "（累計，" + this._mesoTracker.count() + " 筆）" : "—") + (this._lastMesoIcon ? "　最後圖示分數 " + this._lastMesoIcon.score.toFixed(3) : ""));
    lines.push("");
    // 0082 工單任務 1(d)：最近 60 秒抓到幾張畫面、失敗幾次（capture.mjs 的
    // frameStats()，查「畫面停住了」這類抓畫面失敗的第一手數字）。
    if (this.captureHandle && typeof this.captureHandle.frameStats === "function") {
      const stats = this.captureHandle.frameStats();
      lines.push(
        "最近 60 秒抓畫面：成功 " + stats.captured + " 張、失敗 " + stats.failed + " 次（" +
          (stats.usingStream ? "stream 模式" : "grabFrame 模式（退路）") + "）"
      );
    } else {
      lines.push("最近 60 秒抓畫面：（未連線）");
    }
    lines.push("");
    // 0082 工單任務 1：地圖穩定器目前狀態與 tracker.maps 累計（查「地圖雜訊
    // 導致永遠換地圖、累不起來」這類問題的第一手數字）。
    if (this.tracker) {
      const stab = this.tracker._stabilizer;
      lines.push("地圖穩定器：目前=" + (stab.current || "—") + "　known=[" + stab.known.join("、") + "]");
      lines.push("tracker.maps 累計（" + this.tracker.maps.size + " 張）：");
      if (this.tracker.maps.size === 0) {
        lines.push("  （空）");
      } else {
        for (const [name, stat] of this.tracker.maps.entries()) {
          lines.push(
            "  " + name + "：exp=" + stat.exp + "　seconds=" + stat.seconds.toFixed(1) + "　samples=" + stat.samples
          );
        }
      }
    } else {
      lines.push("地圖穩定器：（未連線）");
    }
    lines.push("");
    lines.push("最近 20 筆慢迴圈樣本：");
    for (const s of this._diagSamples) {
      lines.push(
        "  " +
          new Date(s.ts).toLocaleTimeString("zh-TW", { hour12: false }) +
          " map=" + (s.map || "—") +
          " rawMap=" + JSON.stringify(s.rawMap || "") +
          " mapSource=" + (s.mapSource || "—") +
          " exp=" + (s.exp ?? "—") +
          " lv=" + (s.level ?? "—") +
          " levelTotal=" + (s.levelTotal ?? "—") +
          " hp=" + (s.hpCount ?? "—") +
          " mp=" + (s.mpCount ?? "—") +
          " counted=" + (s.counted === null || s.counted === undefined ? "—" : s.counted ? "Y" : "N") +
          " dt=" + (s.dt === null || s.dt === undefined ? "—" : s.dt.toFixed(2)) +
          " note=" + JSON.stringify(s.note || "") +
          (s.mesoIcon ? " meso_score=" + s.mesoIcon.score.toFixed(3) : "")
      );
    }
    return lines.join("\n");
  }

  async _copyDiagText() {
    const text = this._buildDiagText();
    try {
      await navigator.clipboard.writeText(text);
      this.els.diagNote.textContent = "已複製到剪貼簿（" + new Date().toLocaleTimeString("zh-TW", { hour12: false }) + "）";
    } catch (err) {
      this.els.diagNote.textContent = "複製失敗：" + (err && err.message ? err.message : err) + "（可以手動選取下面的文字）";
      console.error("[app] clipboard 失敗", err);
    }
  }

  // -------------------------------------------------------------------------
  // 排行紀錄分頁（0071 任務 4，計畫書 §9.2）

  _renderRankingTable() {
    const history = storage.loadHistory();
    const sessionMaps = this.tracker ? this.tracker.maps : new Map();
    // 0072 工單：這一場未存檔的地圖，藥水／楓幣依秒數比例分攤（跟 appendSession() 同一套規則）。
    const sessionExtras = {
      potion: this._potionTracker ? this._potionTracker.asDict(this._hpPrice(), this._mpPrice()) : { hp_used: 0, mp_used: 0, cost: 0 },
      meso: this._mesoTracker ? this._mesoTracker.asDict() : { gain: 0, span_sec: 0 },
    };
    sessionExtras.potion = { hpUsed: sessionExtras.potion.hp_used, mpUsed: sessionExtras.potion.mp_used, cost: sessionExtras.potion.cost };
    sessionExtras.meso = { gain: sessionExtras.meso.gain, spanSec: sessionExtras.meso.span_sec };
    const rows = storage.buildRankingRows(history, sessionMaps, sessionExtras);
    const body = this.els.rankingBody;
    body.textContent = "";
    rows.forEach((row, i) => {
      const tr = document.createElement("tr");
      if (row.source === "session") tr.className = "session-row";
      const cells = [
        String(i + 1),
        row.map,
        row.timeLabel,
        Math.round(row.expPerHour).toLocaleString("zh-TW"),
        Math.round(row.expPer10Min).toLocaleString("zh-TW"),
        row.potionRaw ? formatPotionCell(row.potionRaw.hp, row.potionRaw.mp, row.potionRaw.cost, row.durationSec, 3600) : "—",
        row.potionRaw ? formatPotionCell(row.potionRaw.hp, row.potionRaw.mp, row.potionRaw.cost, row.durationSec, 600) : "—",
        row.mesoRaw ? formatMesoCell(row.mesoRaw.gain, row.mesoRaw.spanSec, 3600) : "—",
        row.mesoRaw ? formatMesoCell(row.mesoRaw.gain, row.mesoRaw.spanSec, 600) : "—",
        storage.formatHms(row.durationSec),
        String(row.samples),
      ];
      for (const text of cells) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.appendChild(td);
      }
      const tdDel = document.createElement("td");
      if (row.source === "history" && row.id) {
        const btn = document.createElement("button");
        btn.textContent = "刪除";
        btn.className = "secondary";
        btn.addEventListener("click", () => {
          storage.deleteRecords([row.id]);
          this._renderRankingTable();
        });
        tdDel.appendChild(btn);
      }
      tr.appendChild(tdDel);
      body.appendChild(tr);
    });
    this.els.rankingNote.textContent = rows.length + " 筆（含這一場未存檔的地圖）";
  }

  _exportCsv() {
    const records = storage.loadHistory();
    const csv = storage.exportCsv(records);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = storage.exportFilename();
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async _importCsv(ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = ""; // 讓同一個檔案可以再選一次
    if (!file) return;
    const text = await file.text();
    const imported = storage.importCsv(text);
    const existing = storage.loadHistory();
    const existingIds = new Set(existing.map((r) => r.id));
    const merged = existing.concat(imported.filter((r) => !existingIds.has(r.id)));
    storage.saveHistory(merged);
    this.els.rankingNote.textContent = "匯入 " + imported.length + " 筆（" + file.name + "）";
    this._renderRankingTable();
  }

  // -------------------------------------------------------------------------
  // 共用工具

  /** 裁一塊區域到小 canvas，回傳 {canvas, imageData}；區域寬高 0 時回 null。 */
  _cropToCanvas(bitmap, region) {
    if (!region || region.width <= 0 || region.height <= 0) return null;
    const canvas = new OffscreenCanvas(region.width, region.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, region.left, region.top, region.width, region.height, 0, 0, region.width, region.height);
    const imageData = ctx.getImageData(0, 0, region.width, region.height);
    return { canvas, imageData };
  }

  /** 逐位元組比對，跟上次一樣回 false（不用重算），不一樣就更新快取回 true。 */
  _checkAndUpdateCache(key, bytes) {
    const prev = this.regionCache[key];
    if (prev && prev.length === bytes.length) {
      let same = true;
      for (let i = 0; i < bytes.length; i++) {
        if (prev[i] !== bytes[i]) {
          same = false;
          break;
        }
      }
      if (same) return false;
    }
    this.regionCache[key] = new Uint8ClampedArray(bytes);
    return true;
  }

  /**
   * 讀一塊快迴圈區域：畫面沒變回傳 null（呼叫端不用更新畫面），
   * 有變就送去 worker OCR，回傳辨識到的文字。
   */
  async _readRegion(bitmap, key, region, opts) {
    const crop = this._cropToCanvas(bitmap, region);
    if (!crop) return "";
    const changed = this._checkAndUpdateCache(key, crop.imageData.data);
    if (!changed) return null;
    const ocrBitmap = await createImageBitmap(crop.canvas);
    const { text } = await this.ocr.recognize(ocrBitmap, opts);
    return text;
  }

  /** 更新小預覽（寬 320），畫上 exp／level／map 三個框；同時存一份全解析度畫面給「下載目前畫面」用。 */
  _updatePreviewFromBitmap(bitmap, drawBoxes) {
    const canvas = this.els.preview;
    const scale = canvas.width / bitmap.width;
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = this.previewCtx;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (drawBoxes && this.currentRegions) {
      const boxColor = { exp: "#2e9e3e", level: "#4da3ff", map: "#e08a2e" };
      ctx.lineWidth = 1;
      for (const key of ["exp", "level", "map"]) {
        const r = this.currentRegions[key];
        if (!r) continue;
        ctx.strokeStyle = boxColor[key];
        ctx.strokeRect(r.left * scale, r.top * scale, r.width * scale, r.height * scale);
      }
    }

    const full = new OffscreenCanvas(bitmap.width, bitmap.height);
    full.getContext("2d").drawImage(bitmap, 0, 0);
    this.lastFullCanvas = full;
    this.lastFrameSize = { width: bitmap.width, height: bitmap.height };
    this.els.frameSize.textContent = "分享畫面尺寸 " + bitmap.width + "×" + bitmap.height;
  }

  /**
   * 把 `lastFullCanvas` 編碼成 PNG blob，回傳 `{blob, width, height}`。
   */
  async _captureFrameBlob() {
    if (!this.lastFullCanvas || !this.lastFrameSize) return null;
    const blob = await this.lastFullCanvas.convertToBlob({ type: "image/png" });
    return { blob, width: this.lastFrameSize.width, height: this.lastFrameSize.height };
  }

  /** 檔名用的時間戳：yyyymmdd-HHMMSS，本機時間（跟畫面上其他時間戳一致）。 */
  _timestampForFilename(date = new Date()) {
    const pad = (n) => String(n).padStart(2, "0");
    return (
      date.getFullYear() +
      pad(date.getMonth() + 1) +
      pad(date.getDate()) +
      "-" +
      pad(date.getHours()) +
      pad(date.getMinutes()) +
      pad(date.getSeconds())
    );
  }

  /** 「下載目前畫面」鈕：把最近一張 grabFrame() 的完整畫面存成 PNG。沒連線時鈕本身就是灰的，不會被呼叫到。 */
  async _downloadFrame() {
    const captured = await this._captureFrameBlob();
    if (!captured) return;
    const filename = "frame-" + captured.width + "x" + captured.height + "-" + this._timestampForFilename() + ".png";
    const url = URL.createObjectURL(captured.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ===========================================================================
  // 設定頁（0072 工單任務 4，計畫書 §9.4）

  _bindSettings() {
    this.els.settingFastInterval.addEventListener("change", () => {
      const v = Math.min(MAX_FAST_INTERVAL_MS, Math.max(MIN_FAST_INTERVAL_MS, Number(this.els.settingFastInterval.value) || DEFAULT_FAST_INTERVAL_MS));
      this.els.settingFastInterval.value = v;
      this._settings.fastIntervalMs = v;
      storage.saveSettings({ fastIntervalMs: v });
      // 連線中的話重開快迴圈計時器套用新間隔（未連線時下次 connect() 會用新值）。
      if (this.stopFast) {
        this.stopFast();
        this.stopFast = every(() => this._fastTick(), this._fastIntervalMs());
      }
    });
    this.els.settingPotionsEnabled.addEventListener("change", () => {
      this._settings.potionsEnabled = this.els.settingPotionsEnabled.checked;
      storage.saveSettings({ potionsEnabled: this._settings.potionsEnabled });
      this._applySettingsToUi();
    });
    this.els.settingMesoEnabled.addEventListener("change", () => {
      this._settings.mesoEnabled = this.els.settingMesoEnabled.checked;
      storage.saveSettings({ mesoEnabled: this._settings.mesoEnabled });
    });
    for (const radio of this.els.settingRateModeRadios) {
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        this._rateMode = radio.value === "recent" ? "recent" : "hour";
        storage.saveSettings({ rateMode: this._rateMode });
        this.els.chkRateMode.checked = this._rateMode === "recent";
        this._updateStatsDisplay();
      });
    }
    // 0077 工單任務 4：zoom 設定（1/2/3），存 `kc:ui.zoom`，純顯示，不影響任何
    // 統計/OCR/定位邏輯——定位／裁圖永遠讀真正的擷取畫面像素，`zoom` 只縮放
    // `<html>` 本身的 CSS 呈現。
    if (this.els.settingZoom) {
      this.els.settingZoom.addEventListener("change", () => {
        const z = Number(this.els.settingZoom.value) || 2;
        storage.saveUi({ zoom: z });
        this._applyZoom(z);
      });
    }
    this.els.btnClearAllData.addEventListener("click", () => {
      this._confirm("確定要清除所有本機資料嗎？紀錄、校準、藥水單價、設定全部清掉，無法復原。", () => {
        storage.clearAllLocalData();
        this._calibration = null;
        this._calibWorking = null;
        this._potionCatalog = PotionCatalog.load();
        this._settings = storage.loadSettings();
        this._rateMode = "hour";
        this.els.chkRateMode.checked = false;
        this._applySettingsToUi();
        this._renderRankingTable();
        this.setStatus(this.state === "disconnected" ? "未連線" : this.els.status.textContent);
      });
    });
  }

  _applySettingsToUi() {
    this.els.settingFastInterval.value = this._fastIntervalMs();
    this.els.settingPotionsEnabled.checked = Boolean(this._settings.potionsEnabled);
    this.els.settingMesoEnabled.checked = Boolean(this._settings.mesoEnabled);
    this.els.settingPotionsHint.textContent = this._calibration && this._calibration.regions && this._calibration.regions.hp && this._calibration.regions.hp.width
      ? ""
      : "（要先在「校準」分頁框好快捷欄才會真的啟用）";
    for (const radio of this.els.settingRateModeRadios) radio.checked = radio.value === this._rateMode;
    if (this.els.settingZoom) this.els.settingZoom.value = String(storage.loadUi().zoom || 1);
    this.els.aboutVersion.textContent = VERSION;
  }

  /** 0077 工單任務 4：套用 `<html>` 的 zoom（1x＝跟桌面版逐像素一樣）。手機寬度
   * （`matchMedia("(max-width: 480px)")`）不管設定值多少一律降到 1，不然精簡窗
   * 225px × zoom 會橫向超出手機螢幕（前提 (3) 最後一條）。 */
  _applyZoom(z) {
    const isNarrow = window.matchMedia && window.matchMedia("(max-width: 480px)").matches;
    document.documentElement.style.zoom = String(isNarrow ? 1 : z || 1);
  }

  // ===========================================================================
  // 校準頁（0080 工單 W4.3：整頁照桌面版 exp-tracker/src/calibration_ui.py 重做，
  // 取代 0072/0077 那版「凍結畫面＋canvas 疊框＋座標表」。不改統計／OCR／定位邏輯，
  // 只重接 UI——OCR 呼叫的還是同一顆 this.ocr.recognize()／locateAll()，地圖投影
  // 分行也是抄主迴圈 _slowTick() 那段的作法（沒有搬桌面版 0074 的「川」重讀）。

  _calibRegionRows() {
    return [["exp", CALIB_ROW_LABELS.exp], ["map", CALIB_ROW_LABELS.map], ["level", CALIB_ROW_LABELS.level]];
  }

  _calibPotionRows() {
    return [["panel", CALIB_ROW_LABELS.panel], ["hp", CALIB_ROW_LABELS.hp], ["mp", CALIB_ROW_LABELS.mp]];
  }

  _calibRows() {
    return [...this._calibRegionRows(), ...this._calibPotionRows()];
  }

  _bindCalibration() {
    // 表格只建一次（保留 canvas/img 元素與事件監聽，之後只更新內容）。
    this._buildCalibRowTable(this.els.calibRowBody, this._calibRegionRows());
    this._buildCalibRowTable(this.els.calibRowBodyPotion, this._calibPotionRows());

    for (const btn of this.els.calibSubtabButtons) {
      btn.addEventListener("click", () => this._switchCalibSubtab(btn.dataset.subtab));
    }

    this.els.btnCalibRepick.addEventListener("click", () => this._openRepickOverlay(this._calibSelected));
    this.els.btnCalibSaveExample.addEventListener("click", () => this._calibSaveExample());
    this.els.btnCalibUp.addEventListener("click", () => this._calibNudge(0, -1));
    this.els.btnCalibLeft.addEventListener("click", () => this._calibNudge(-1, 0));
    this.els.btnCalibRight.addEventListener("click", () => this._calibNudge(1, 0));
    this.els.btnCalibDown.addEventListener("click", () => this._calibNudge(0, 1));
    this.els.btnCalibWMinus.addEventListener("click", () => this._calibResize(-1, 0));
    this.els.btnCalibWPlus.addEventListener("click", () => this._calibResize(1, 0));
    this.els.btnCalibHMinus.addEventListener("click", () => this._calibResize(0, -1));
    this.els.btnCalibHPlus.addEventListener("click", () => this._calibResize(0, 1));
    this.els.btnCalibAutolocate.addEventListener("click", () => this._calibAutoLocate());
    this.els.btnCalibRepickWindow.addEventListener("click", () => this._calibRepickWindow());

    // 0077 工單前提 (3)：校準頁是獨立一個對話框，按「儲存」／「取消」關——網頁版
    // 沒有真的視窗可以關，改成存/取消完直接切回主面板。標題列的 ✕ 等同「取消」
    // （前提 (1)：標題列只是畫成 Windows 風，不是真的視窗系統，✕ 沒有另外的語意）。
    this.els.btnCalibSave.addEventListener("click", () => {
      this._saveCalibration();
      this._switchTab("main");
    });
    this.els.btnCalibCancel.addEventListener("click", () => {
      this._cancelCalibration();
      this._switchTab("main");
    });
    this.els.btnCalibTitlebarClose.addEventListener("click", () => {
      this._cancelCalibration();
      this._switchTab("main");
    });

    this.els.selectHpSlot.addEventListener("change", () => this._onPotionSlotChange());
    this.els.selectMpSlot.addEventListener("change", () => this._onPotionSlotChange());
    this.els.selectHpType.addEventListener("change", () => {
      if (!this._calibWorking) return;
      this._calibWorking.hpType = this.els.selectHpType.value || null;
    });
    this.els.selectMpType.addEventListener("change", () => {
      if (!this._calibWorking) return;
      this._calibWorking.mpType = this.els.selectMpType.value || null;
    });
    this.els.btnPotionAdd.addEventListener("click", () => this._addPotionCatalogEntry());

    // 方向鍵微調（前提澄清同桌面版：↑←→↓ 1px，Shift 5px），只在校準頁開著、
    // 焦點不在輸入框時生效（桌面版是「鍵盤跟著焦點走，要先點這一頁」，網頁版沒有
    // 真的視窗焦點機制，改成「校準頁分頁是作用中的」這個條件，逃生口是使用者正在
    // 打字的輸入框/下拉選單不吃方向鍵，才不會妨礙藥水頁打字）。
    document.addEventListener("keydown", (ev) => this._onCalibKeydown(ev));

    this._bindRepickOverlayEvents();

    for (let i = 0; i < SLOT_COUNT; i++) {
      const optHp = document.createElement("option");
      optHp.value = String(i);
      optHp.textContent = SLOT_KEY_NAMES[i] + "（第 " + i + " 格）";
      this.els.selectHpSlot.appendChild(optHp);
      const optMp = optHp.cloneNode(true);
      this.els.selectMpSlot.appendChild(optMp);
    }
    const unset = document.createElement("option");
    unset.value = "-1";
    unset.textContent = SLOT_UNSET_LABEL;
    this.els.selectHpSlot.insertBefore(unset, this.els.selectHpSlot.firstChild);
    this.els.selectMpSlot.insertBefore(unset.cloneNode(true), this.els.selectMpSlot.firstChild);
  }

  /** 建一次三欄表（列名按鈕圖 / 現在截到 / 範例 / 讀到），之後只更新內容，不重建元素
   * （canvas 一重建 `getContext()` 抓到的畫面就沒了，跟桌面版「PhotoImage 一定要留
   * 參考」是同一種道理）。 */
  _buildCalibRowTable(bodyEl, rows) {
    bodyEl.textContent = "";
    for (const [key, label] of rows) {
      const tr = document.createElement("tr");
      tr.dataset.key = key;

      const tdName = document.createElement("td");
      const btn = document.createElement("img");
      btn.className = "kc-row-name-btn";
      btn.alt = label;
      btn.src = "assets/ui-built/tabs/" + CALIB_ROW_SLUGS[key] + "_normal.png";
      tdName.appendChild(btn);

      const tdLive = document.createElement("td");
      tdLive.className = "kc-live-cell";
      const liveCanvas = document.createElement("canvas");
      liveCanvas.className = "kc-live-thumb";
      liveCanvas.width = 40;
      liveCanvas.height = 18;
      tdLive.appendChild(liveCanvas);

      const tdExample = document.createElement("td");
      tdExample.className = "kc-example-cell";
      const exampleImg = document.createElement("img");
      exampleImg.className = "kc-example-thumb";
      tdExample.appendChild(exampleImg);

      const tdOcr = document.createElement("td");
      const ocrSpan = document.createElement("span");
      ocrSpan.className = "kc-ocr-cell";
      ocrSpan.textContent = "（還沒讀）";
      tdOcr.appendChild(ocrSpan);

      tr.append(tdName, tdLive, tdExample, tdOcr);
      tr.addEventListener("click", () => this._selectCalibRow(key));
      bodyEl.appendChild(tr);
      this._calibRowEls[key] = { tr, btn, liveCanvas, exampleImg, ocrSpan };
    }
  }

  _onEnterCalibrationTab() {
    if (!this._calibWorking) this._initCalibWorking();
    this._refreshCalibRowSelection();
    this._refreshCalibExamples();
    this._updatePotionSlotSelects();
    this._renderPotionCatalogTable();
    this._refreshCalibHeader();
    this._startCalibLiveTimer();
    this._calibLiveTick(); // 立刻畫一次，不等第一個 500ms
  }

  /** `_switchTab()` 離開「校準」分頁時呼叫，停掉即時重裁計時器（前提澄清 (2)：
   * 校準頁沒開就不用一直裁圖跑 OCR）。 */
  _leaveCalibrationTab() {
    this._stopCalibLiveTimer();
    this._closeRepickOverlay();
  }

  _switchCalibSubtab(subtab) {
    for (const btn of this.els.calibSubtabButtons) btn.classList.toggle("active", btn.dataset.subtab === subtab);
    for (const page of this.els.calibSubpages) page.classList.toggle("active", page.dataset.subtab === subtab);
    // 0060 號工單（桌面版）：微調鍵／重新框選／存成範例在設定頁沒有意義，藏起來。
    this.els.calibControlBar.classList.toggle("hidden", subtab === "settings");
    if (subtab === "settings") this._applySettingsToUi();
  }

  _initCalibWorking() {
    const src = this._calibration || {
      frameSize: { ...regions.CALIBRATION_BASE.frameSize },
      regions: {
        exp: { ...regions.CALIBRATION_BASE.regions.exp },
        level: { ...regions.CALIBRATION_BASE.regions.level },
        map: { ...regions.CALIBRATION_BASE.regions.map },
        panel: { ...regions.CALIBRATION_BASE.regions.panel },
        hp: { ...regions.CALIBRATION_BASE.regions.hp },
        mp: { ...regions.CALIBRATION_BASE.regions.mp },
      },
      hpSlot: -1,
      mpSlot: -1,
      hpType: null,
      mpType: null,
    };
    this._calibWorking = {
      frameSize: { ...src.frameSize },
      regions: Object.fromEntries(Object.entries(src.regions).map(([k, v]) => [k, { ...v }])),
      hpSlot: src.hpSlot === undefined ? -1 : src.hpSlot,
      mpSlot: src.mpSlot === undefined ? -1 : src.mpSlot,
      hpType: src.hpType || null,
      mpType: src.mpType || null,
    };
    this._calibOcrCache = {};
  }

  // ---------- 選中的列 ----------

  _selectCalibRow(key) {
    this._calibSelected = key;
    this._refreshCalibRowSelection();
  }

  _refreshCalibRowSelection() {
    for (const [key] of this._calibRows()) {
      const els = this._calibRowEls[key];
      if (!els) continue;
      const selected = key === this._calibSelected;
      els.tr.classList.toggle("selected", selected);
      els.btn.src = "assets/ui-built/tabs/" + CALIB_ROW_SLUGS[key] + "_" + (selected ? "selected" : "normal") + ".png";
    }
    const label = CALIB_ROW_LABELS[this._calibSelected] || "（無）";
    this.els.calibSelectedLabel.textContent = label;
    this._refreshSelectedInfo();
    this._refreshExampleButtonState();
  }

  _refreshSelectedInfo() {
    const region = this._calibWorking ? this._calibWorking.regions[this._calibSelected] : null;
    const sizeText = region && region.width ? region.width + "×" + region.height : "（還沒框）";
    this.els.calibSelectedLabel.textContent = (CALIB_ROW_LABELS[this._calibSelected] || "（無）") + " " + sizeText;
  }

  _refreshExampleButtonState() {
    // 「存成範例」只在選中列有 live 畫面可以存的時候能按（同桌面版：讀錯的畫面
    // 存成範例只會誤導下一個人）。快捷欄沒有 OCR，只要有截到畫面就能存。
    const key = this._calibSelected;
    const hasLive = Boolean(this.lastFullCanvas) && Boolean(this._calibWorking && this._calibWorking.regions[key] && this._calibWorking.regions[key].width);
    this.els.btnCalibSaveExample.disabled = !hasLive;
  }

  // ---------- 標題行：「分享畫面 · 現在 WxH · 校準時 WxH」（前提澄清 (3)） ----------

  _refreshCalibHeader() {
    const el = this.els.calibHeaderRow;
    if (!this.captureHandle || !this.lastFrameSize) {
      el.textContent = "分享畫面 · 尚未連線，先去主面板「連線」";
      el.classList.remove("warn");
      return;
    }
    const now = this.lastFrameSize;
    const cal = this._calibWorking ? this._calibWorking.frameSize : null;
    const calText = cal && cal.width ? cal.width + "x" + cal.height : "（沒紀錄）";
    const same = cal && cal.width && cal.width === now.width && cal.height === now.height;
    el.textContent = "分享畫面 · 現在 " + now.width + "x" + now.height + " · 校準時 " + calText;
    el.classList.toggle("warn", !same);
  }

  // ---------- 即時小截圖（前提澄清 (2)：沒有凍結鈕，用主迴圈最近一張畫面） ----------

  _startCalibLiveTimer() {
    this._stopCalibLiveTimer();
    this._calibLiveTimer = setInterval(() => this._calibLiveTick(), CALIB_LIVE_INTERVAL_MS);
  }

  _stopCalibLiveTimer() {
    if (this._calibLiveTimer) {
      clearInterval(this._calibLiveTimer);
      this._calibLiveTimer = null;
    }
  }

  _calibLiveTick() {
    if (!this.els.tabCalibration.classList.contains("active")) return;
    this._refreshCalibHeader();
    if (!this._calibWorking) return;
    const src = this.lastFullCanvas;
    for (const [key] of this._calibRows()) {
      const els = this._calibRowEls[key];
      if (!els) continue;
      const region = this._calibWorking.regions[key];
      if (!src || !region || !region.width || !region.height) {
        this._paintCalibEmptyThumb(els.liveCanvas, src ? "（還沒框）" : "尚未連線");
        continue;
      }
      const crop = this._cropToCanvas(src, region);
      if (!crop) {
        this._paintCalibEmptyThumb(els.liveCanvas, "裁不出圖");
        continue;
      }
      const zoom = CALIB_ZOOM[key] || 1;
      if (key === "panel") {
        this._calibDrawPotionGrid(els.liveCanvas, crop.canvas, this._calibWorking.hpSlot, this._calibWorking.mpSlot, zoom);
      } else {
        this._calibDrawZoomed(els.liveCanvas, crop.canvas, zoom);
      }
      this._refreshExampleButtonState();

      if (key === "panel") {
        els.ocrSpan.textContent = "（不做 OCR，八格的範圍）";
        els.ocrSpan.className = "kc-ocr-cell";
        continue;
      }
      const changed = this._calibCropChanged(key, crop.imageData.data);
      if (changed && !this._calibOcrPending.has(key)) {
        this._calibRunOcr(key, crop.canvas, region);
      }
    }
  }

  _paintCalibEmptyThumb(canvas, text) {
    canvas.width = 100;
    canvas.height = 24;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#cfd2d8";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#555a66";
    ctx.font = "10px sans-serif";
    ctx.fillText(text, 4, 15);
  }

  _calibDrawZoomed(canvas, cropCanvas, zoom) {
    canvas.width = Math.max(1, Math.round(cropCanvas.width * zoom));
    canvas.height = Math.max(1, Math.round(cropCanvas.height * zoom));
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(cropCanvas, 0, 0, canvas.width, canvas.height);
  }

  /** 快捷欄那格：放大倍率 zoom，疊 2×4 格線＋格名，指定過的格子加綠框＋「血」/「藍」字
   * （同桌面版 `slot_grid_image()`）。 */
  _calibDrawPotionGrid(canvas, cropCanvas, hpSlot, mpSlot, zoom) {
    this._calibDrawZoomed(canvas, cropCanvas, zoom);
    const ctx = canvas.getContext("2d");
    const cols = 4;
    const rows = 2;
    const cellW = canvas.width / cols;
    const cellH = canvas.height / rows;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1;
    for (let c = 1; c < cols; c++) {
      ctx.beginPath();
      ctx.moveTo(Math.round(c * cellW) + 0.5, 0);
      ctx.lineTo(Math.round(c * cellW) + 0.5, canvas.height);
      ctx.stroke();
    }
    for (let r = 1; r < rows; r++) {
      ctx.beginPath();
      ctx.moveTo(0, Math.round(r * cellH) + 0.5);
      ctx.lineTo(canvas.width, Math.round(r * cellH) + 0.5);
      ctx.stroke();
    }
    ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#ffffff";
    for (let i = 0; i < SLOT_COUNT; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      ctx.fillText(SLOT_KEY_NAMES[i], col * cellW + 2, row * cellH + 10);
    }
    for (const [slot, label] of [[hpSlot, "血"], [mpSlot, "藍"]]) {
      if (slot < 0 || slot >= SLOT_COUNT) continue;
      const col = slot % cols;
      const row = Math.floor(slot / cols);
      ctx.strokeStyle = "#00ff66";
      ctx.lineWidth = 2;
      ctx.strokeRect(col * cellW + 1, row * cellH + 1, cellW - 2, cellH - 2);
      ctx.fillStyle = "#00ff66";
      ctx.font = "bold 10px sans-serif";
      ctx.fillText(label, col * cellW + 3, row * cellH + cellH - 3);
    }
  }

  /** 裁圖跟上次是否一樣（逐位元組比對，同主迴圈 `_checkAndUpdateCache()` 的快取規則，
   * 但用**獨立的**快取物件，不動主迴圈那份，見工單「只重接 UI」。） */
  _calibCropChanged(key, bytes) {
    const prev = this._calibOcrCache[key];
    if (prev && prev.length === bytes.length) {
      let same = true;
      for (let i = 0; i < bytes.length; i++) {
        if (prev[i] !== bytes[i]) {
          same = false;
          break;
        }
      }
      if (same) return false;
    }
    this._calibOcrCache[key] = new Uint8ClampedArray(bytes);
    return true;
  }

  /** 「讀到」欄：對即時裁圖做 OCR，格式照桌面版 `_set_ocr_result()`／`judge()`／
   * `ocr_display_text()`（見 calibration_ui.py）。地圖那列走投影分行（同 `_slowTick()`
   * 那段，複製過來而不是共用同一個函式，因為主迴圈那份還耦合著 tracker/健康列的
   * 副作用，這裡只要「讀出文字」，見工單前提 (3)）。 */
  async _calibRunOcr(key, cropCanvas, region) {
    this._calibOcrPending.add(key);
    const els = this._calibRowEls[key];
    if (els) {
      els.ocrSpan.textContent = "（讀取中…）";
      els.ocrSpan.className = "kc-ocr-cell";
    }
    try {
      let rawText;
      let mergedMapName = null;
      if (key === "map") {
        const ctx = cropCanvas.getContext("2d", { willReadFrequently: true });
        const imageData = ctx.getImageData(0, 0, cropCanvas.width, cropCanvas.height);
        const gray = lumaChannel(imageData.data);
        const lines = splitLines(gray, region.width, region.height);
        const lineBoxes = lines.length ? lines : [[0, region.height]];
        const parts = [];
        for (const [y0, y1] of lineBoxes) {
          const lineHeight = y1 - y0;
          const lineCanvas = new OffscreenCanvas(region.width, Math.max(1, lineHeight));
          lineCanvas.getContext("2d").putImageData(imageData, 0, -y0);
          const lineBitmap = await createImageBitmap(lineCanvas);
          const result = await this.ocr.recognize(lineBitmap, { lang: "ch", upscale: 5, preprocess: "none" });
          parts.push(result.text || "");
        }
        rawText = parts.join(" ");
        mergedMapName = mergeMapName(rawText, rawText);
      } else {
        const opts =
          key === "exp"
            ? { lang: "ch", upscale: 3, preprocess: "none" }
            : key === "level"
            ? { lang: "ch", upscale: 6, preprocess: "gray_invert" }
            : { lang: "ch", upscale: 6, preprocess: "gray" };
        const bitmap = await createImageBitmap(cropCanvas);
        const result = await this.ocr.recognize(bitmap, opts);
        rawText = result.text || "";
      }
      const [ok, note] = this._calibJudge(key, rawText, mergedMapName);
      if (els) {
        els.ocrSpan.textContent = this._calibOcrDisplayText(ok, note, rawText);
        els.ocrSpan.className = "kc-ocr-cell " + (ok ? "ok" : "fail");
      }
    } catch (err) {
      if (els) {
        els.ocrSpan.textContent = "✗ OCR 失敗：" + String(err && err.message ? err.message : err).slice(0, 40);
        els.ocrSpan.className = "kc-ocr-cell fail";
      }
    } finally {
      this._calibOcrPending.delete(key);
    }
  }

  /** OCR 原文 -> (讀得對嗎, 一句人話)。逐字照桌面版 `calibration_ui.judge()`。 */
  _calibJudge(key, text, mergedMapName) {
    if (key === "exp") {
      const [exp, pct] = parseExpLine(text);
      if (exp !== null && pct !== null) return [true, exp.toLocaleString("zh-TW") + "（" + pct.toFixed(2) + "%）"];
      if (exp === null && pct === null) return [false, "經驗值跟百分比都讀不到，框可能沒對到"];
      if (pct === null) return [false, "讀不到百分比，往右加寬"];
      return [false, "讀不到經驗值，往左加寬"];
    }
    if (key === "map") {
      const name = cleanMapName(mergedMapName || "");
      if (name.length < 2) return [false, "地圖名太短，框太窄或沒對到"];
      if (hasUnreadableNumeral(name)) return [false, "編號讀壞（讀成「" + BROKEN_NUMERAL_CHAR + "」），往右加寬"];
      // 0071 起地圖只用 ch（簡體）模型讀，raw 合併結果本身是簡體字——跟主迴圈
      // `MapNameStabilizer` 的優先序一致（計畫書 §7：alias > CSV 總表 > 原讀值），
      // 對照總表/別名表換回繁體正式名稱給人看，比對不到才顯示簡體原文。
      const canonical = (this._aliases && this._aliases[name]) || mapdb.bestMatch(name) || name;
      return [true, canonical];
    }
    if (key === "level") {
      const level = parseLevel(text, false);
      if (level === null) return [false, "讀不到等級數字，框沒對到或太小"];
      return [true, "Lv." + level];
    }
    if (key === "hp" || key === "mp") {
      const count = parseCount(text);
      if (count === null) return [false, "讀不到數量，框沒對到或太小"];
      return [true, count.toLocaleString("zh-TW") + " 瓶"];
    }
    return [false, ""];
  }

  /** `judge()` 的結果 -> 「讀到」欄一行文字。逐字照桌面版 `ocr_display_text()`。 */
  _calibOcrDisplayText(ok, note, rawText) {
    if (ok) return "✓ " + note;
    const prefix = "✗ " + note;
    const trimmed = (rawText || "").trim();
    if (!trimmed) return prefix;
    const short = trimmed.length > CALIB_RAW_PREVIEW_LEN ? trimmed.slice(0, CALIB_RAW_PREVIEW_LEN) : trimmed;
    return prefix + "（讀到「" + short + "」）";
  }

  // ---------- 範例欄 ----------

  /** 範例圖網址：使用者自己存過（`kc:examples`，dataURL）優先，沒存過退回
   * `assets/calib_examples/` 那份桌面版同款預設圖（同桌面版 `load_example()` 的
   * 「使用者自己存的優先，沒有才退回打包進來的預設」）。 */
  _calibExampleUrl(key) {
    const saved = storage.loadExamples();
    if (saved[key]) return saved[key];
    return "assets/calib_examples/" + CALIB_EXAMPLE_FILES[key];
  }

  _refreshCalibExamples() {
    for (const [key] of this._calibRows()) {
      const els = this._calibRowEls[key];
      if (!els) continue;
      const url = this._calibExampleUrl(key);
      els.exampleImg.src = url;
      els.exampleImg.classList.remove("kc-empty");
      els.exampleImg.onerror = () => {
        els.exampleImg.removeAttribute("src");
        els.exampleImg.classList.add("kc-empty");
      };
      const zoom = CALIB_ZOOM[key] || 1;
      els.exampleImg.style.width = "";
      els.exampleImg.style.imageRendering = zoom > 1 ? "pixelated" : "auto";
    }
  }

  /** 「存成範例」：把選中列現在的 live 裁圖存成 dataURL 進 `kc:examples`，立刻換掉
   * 範例欄那張圖（同桌面版 `save_current_as_example()`，只是存的是 dataURL 不是檔案）。 */
  async _calibSaveExample() {
    const key = this._calibSelected;
    if (!this._calibWorking || !this.lastFullCanvas) return;
    const region = this._calibWorking.regions[key];
    if (!region || !region.width || !region.height) return;
    const crop = this._cropToCanvas(this.lastFullCanvas, region);
    if (!crop) return;
    try {
      const blob = await crop.canvas.convertToBlob({ type: "image/png" });
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      storage.saveExample(key, dataUrl);
      this._refreshCalibExamples();
      this.els.calibPageStatus.textContent = "已存成範例（" + CALIB_ROW_LABELS[key] + "）。";
    } catch (err) {
      this.els.calibPageStatus.textContent = "存範例失敗：" + (err && err.message ? err.message : err);
    }
  }

  // ---------- 微調（方向鍵 / 寬高按鈕） ----------

  _onCalibKeydown(ev) {
    if (!this.els.tabCalibration.classList.contains("active")) return;
    if (this.els.calibRepickOverlay.classList.contains("show")) return; // 遮罩自己處理 Esc
    const tag = document.activeElement ? document.activeElement.tagName : "";
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    const step = ev.shiftKey ? 5 : 1;
    let dx = 0;
    let dy = 0;
    if (ev.key === "ArrowLeft") dx = -step;
    else if (ev.key === "ArrowRight") dx = step;
    else if (ev.key === "ArrowUp") dy = -step;
    else if (ev.key === "ArrowDown") dy = step;
    else return;
    ev.preventDefault();
    this._calibNudge(dx, dy);
  }

  _calibNudge(dx, dy) {
    if (!this._calibWorking) return;
    const key = this._calibSelected;
    const r = this._calibWorking.regions[key];
    if (!r || !r.width) return;
    this._calibWorking.regions[key] = regions.nudgeRegion(r, dx, dy);
    if (key === "panel") this._recomputePotionCountRegions();
    this._refreshSelectedInfo();
  }

  _calibResize(dw, dh) {
    if (!this._calibWorking) return;
    const key = this._calibSelected;
    const r = this._calibWorking.regions[key];
    if (!r || !r.width) return;
    this._calibWorking.regions[key] = regions.resizeRegion(r, dw, dh);
    if (key === "panel") this._recomputePotionCountRegions();
    this._refreshSelectedInfo();
  }

  // ---------- 重新框選（前提澄清 (4)：彈出凍結畫面＋半透明遮罩拖框） ----------

  _openRepickOverlay(key) {
    if (!this.lastFullCanvas || !this.lastFrameSize) {
      this.els.calibPageStatus.textContent = "還沒連線，抓不到畫面可以框——先去主面板「連線」。";
      return;
    }
    this._calibSelected = key;
    this._refreshCalibRowSelection();
    const canvas = this.els.calibRepickCanvas;
    canvas.width = this.lastFrameSize.width;
    canvas.height = this.lastFrameSize.height;
    // 只在打開的這一刻畫一次，之後不再更新——這就是「凍結」：使用者拖框的過程中
    // 底圖不會被主迴圈的新畫面蓋掉。
    canvas.getContext("2d").drawImage(this.lastFullCanvas, 0, 0);
    this.els.calibRepickHint.textContent = "拖出「" + (CALIB_ROW_LABELS[key] || key) + "」那塊的範圍（放開就完成）　·　Esc 取消";
    this.els.calibRepickOverlay.classList.add("show");
    this._calibRepickDrag = null;
  }

  _closeRepickOverlay() {
    this.els.calibRepickOverlay.classList.remove("show");
    this._calibRepickDrag = null;
  }

  _bindRepickOverlayEvents() {
    const canvas = this.els.calibRepickCanvas;
    const toImageCoords = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      return [Math.round((ev.clientX - rect.left) * scaleX), Math.round((ev.clientY - rect.top) * scaleY)];
    };
    canvas.addEventListener("mousedown", (ev) => {
      this._calibRepickDrag = { start: toImageCoords(ev) };
    });
    canvas.addEventListener("mousemove", (ev) => {
      if (!this._calibRepickDrag) return;
      const [x, y] = toImageCoords(ev);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(this.lastFullCanvas, 0, 0); // 重畫底圖再疊框（不留殘影）
      const [sx, sy] = this._calibRepickDrag.start;
      ctx.strokeStyle = "#00ff66";
      ctx.lineWidth = 2;
      ctx.strokeRect(sx, sy, x - sx, y - sy);
    });
    window.addEventListener("mouseup", (ev) => {
      if (!this._calibRepickDrag || !this.els.calibRepickOverlay.classList.contains("show")) {
        this._calibRepickDrag = null;
        return;
      }
      const [x, y] = toImageCoords(ev);
      const [sx, sy] = this._calibRepickDrag.start;
      this._calibRepickDrag = null;
      if (Math.abs(x - sx) < 2 || Math.abs(y - sy) < 2) return; // 點一下就放開：不套用
      if (!this._calibWorking) this._initCalibWorking();
      const key = this._calibSelected;
      this._calibWorking.regions[key] = regions.boxToRegion([sx, sy, x, y], canvas.width, canvas.height);
      if (key === "panel") this._recomputePotionCountRegions();
      delete this._calibOcrCache[key];
      this._refreshSelectedInfo();
      this._closeRepickOverlay();
      this._calibLiveTick();
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && this.els.calibRepickOverlay.classList.contains("show")) {
        this._closeRepickOverlay();
      }
    });
  }

  // ---------- 重選遊戲視窗（前提澄清 (4)：重新 getDisplayMedia） ----------

  async _calibRepickWindow() {
    this.els.calibPageStatus.textContent = "重新選擇分享畫面…";
    this.disconnect();
    await this.connect();
    this._refreshCalibHeader();
    this.els.calibPageStatus.textContent = this.captureHandle ? "已重新連線。" : "沒有選新的分享畫面（保留原本的座標）。";
  }

  // ---------- 自動定位（模板比對） ----------

  async _calibAutoLocate() {
    if (!this.lastFullCanvas || !this.lastFrameSize) {
      this.els.calibPageStatus.textContent = "要先連線、抓得到畫面才能自動定位。";
      return;
    }
    this.els.calibPageStatus.textContent = "定位中…（可能要幾秒）";
    this.els.btnCalibAutolocate.disabled = true;
    try {
      if (!this._anchorTemplates) {
        const names = ["lv", "shop", "minimap", "quick", "quick_mask"];
        const loaded = await Promise.all(names.map((n) => this._loadGrayTemplate("./templates/anchors/" + n + ".png")));
        this._anchorTemplates = Object.fromEntries(names.map((n, i) => [n, loaded[i]]));
      }
      const { width, height } = this.lastFrameSize;
      const ctx = this.lastFullCanvas.getContext("2d", { willReadFrequently: true });
      const imageData = ctx.getImageData(0, 0, width, height);
      const gray = lumaChannel(imageData.data);
      const result = locateAll(gray, width, height, this._anchorTemplates, regions.CALIBRATION_BASE);
      if (!result) {
        this.els.calibPageStatus.textContent = "找不到商店鈕，請用「重新框選」手動對齊。";
        return;
      }
      if (!this._calibWorking) this._initCalibWorking();
      for (const key of ["exp", "level", "map", "panel", "hp", "mp"]) {
        this._calibWorking.regions[key] = regions.boxToRegion(result.regions[key], width, height);
        delete this._calibOcrCache[key];
      }
      this._calibWorking.frameSize = { ...this.lastFrameSize };
      this.els.calibPageStatus.textContent = result.approx
        ? "部分成功：" + result.fallback.map((k) => CALIB_ROW_LABELS[k] || k).join("、") + " 沒找到對應錨點，改用推算位置，其餘已對齊（scale=" + result.scale.toFixed(2) + "），請逐塊核對「現在截到」。"
        : "六塊都對齊了（scale=" + result.scale.toFixed(2) + "），請看「現在截到」逐塊核對後再儲存。";
      this._refreshSelectedInfo();
      this._refreshCalibHeader();
      this._calibLiveTick();
    } catch (err) {
      console.error("[app] locateAll 失敗", err);
      this.els.calibPageStatus.textContent = "自動定位失敗：" + (err && err.message ? err.message : err);
    } finally {
      this.els.btnCalibAutolocate.disabled = false;
    }
  }

  // ---------- 藥水分頁 ----------

  _updatePotionSlotSelects() {
    if (!this._calibWorking) return;
    this.els.selectHpSlot.value = String(this._calibWorking.hpSlot);
    this.els.selectMpSlot.value = String(this._calibWorking.mpSlot);
    this._renderPotionTypeSelects();
    this._refreshPotionSlotSummary();
  }

  _renderPotionTypeSelects() {
    const hpNames = this._potionCatalog.names("hp");
    const mpNames = this._potionCatalog.names("mp");
    const fill = (select, names, current) => {
      select.textContent = "";
      for (const name of names) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
      }
      if (current && names.includes(current)) select.value = current;
      else if (names.length > 0) select.value = names[0];
    };
    fill(this.els.selectHpType, hpNames, this._calibWorking ? this._calibWorking.hpType : null);
    fill(this.els.selectMpType, mpNames, this._calibWorking ? this._calibWorking.mpType : null);
    if (this._calibWorking) {
      this._calibWorking.hpType = this.els.selectHpType.value || null;
      this._calibWorking.mpType = this.els.selectMpType.value || null;
    }
  }

  _onPotionSlotChange() {
    if (!this._calibWorking) return;
    this._calibWorking.hpSlot = Number(this.els.selectHpSlot.value);
    this._calibWorking.mpSlot = Number(this.els.selectMpSlot.value);
    this._recomputePotionCountRegions();
    this._refreshPotionSlotSummary();
    delete this._calibOcrCache.hp;
    delete this._calibOcrCache.mp;
    this._calibLiveTick();
  }

  /** 指定格子後，依 slotBox()/countRegionForSlot() 算出血水／藍水數量框的起始值（可再微調）。 */
  _recomputePotionCountRegions() {
    const w = this._calibWorking;
    if (!w) return;
    const panel = w.regions.panel;
    const sized = panel && panel.width > 0 && panel.height > 0;
    if (sized && w.hpSlot >= 0 && w.hpSlot < SLOT_COUNT) {
      w.regions.hp = countRegionForSlot(panel, w.hpSlot);
    }
    if (sized && w.mpSlot >= 0 && w.mpSlot < SLOT_COUNT) {
      w.regions.mp = countRegionForSlot(panel, w.mpSlot);
    }
  }

  _refreshPotionSlotSummary() {
    const w = this._calibWorking;
    if (!w) return;
    const hp = w.hpSlot >= 0 && w.hpSlot < SLOT_COUNT ? SLOT_KEY_NAMES[w.hpSlot] + " 格" : "還沒指定";
    const mp = w.mpSlot >= 0 && w.mpSlot < SLOT_COUNT ? SLOT_KEY_NAMES[w.mpSlot] + " 格" : "還沒指定";
    const ready = w.hpSlot >= 0 && w.hpSlot < SLOT_COUNT && w.mpSlot >= 0 && w.mpSlot < SLOT_COUNT;
    this.els.potionSlotSummary.textContent =
      "血水：" + hp + "　藍水：" + mp + "　" + (ready ? "兩格都指定好了，儲存後（且設定頁打開藥水啟用）藥水功能會生效。" : "兩格都指定好之後，藥水功能才會啟用。");
  }

  _renderPotionCatalogTable() {
    const body = this.els.potionCatalogBody;
    body.textContent = "";
    for (const entry of this._potionCatalog.list()) {
      const tr = document.createElement("tr");
      const tdName = document.createElement("td");
      tdName.textContent = entry.name;
      const tdKind = document.createElement("td");
      tdKind.textContent = entry.kind;
      const tdPrice = document.createElement("td");
      const priceInput = document.createElement("input");
      priceInput.type = "number";
      priceInput.min = "0";
      priceInput.style.width = "80px";
      priceInput.value = String(entry.price);
      priceInput.addEventListener("change", () => {
        this._potionCatalog.upsert(entry.name, Number(priceInput.value) || 0, entry.kind);
        this._potionCatalog.save();
      });
      tdPrice.appendChild(priceInput);
      const tdDel = document.createElement("td");
      const delBtn = document.createElement("button");
      delBtn.textContent = "刪除";
      delBtn.className = "secondary tiny";
      delBtn.addEventListener("click", () => {
        this._potionCatalog.remove(entry.name);
        this._potionCatalog.save();
        this._renderPotionCatalogTable();
        this._renderPotionTypeSelects();
      });
      tdDel.appendChild(delBtn);
      tr.append(tdName, tdKind, tdPrice, tdDel);
      body.appendChild(tr);
    }
  }

  _addPotionCatalogEntry() {
    const name = this.els.newPotionName.value.trim();
    if (!name) return;
    const kind = this.els.newPotionKind.value === "mp" ? "mp" : "hp";
    const price = Number(this.els.newPotionPrice.value) || 0;
    this._potionCatalog.upsert(name, price, kind);
    this._potionCatalog.save();
    this.els.newPotionName.value = "";
    this.els.newPotionPrice.value = "";
    this._renderPotionCatalogTable();
    this._renderPotionTypeSelects();
  }

  // ---------- 儲存／取消 ----------

  _saveCalibration() {
    if (!this._calibWorking) return;
    this._calibration = {
      frameSize: { ...this._calibWorking.frameSize },
      regions: Object.fromEntries(Object.entries(this._calibWorking.regions).map(([k, v]) => [k, { ...v }])),
      hpSlot: this._calibWorking.hpSlot,
      mpSlot: this._calibWorking.mpSlot,
      hpType: this._calibWorking.hpType,
      mpType: this._calibWorking.mpType,
    };
    storage.saveCalibration(this._calibration);
    this.els.calibPageStatus.textContent = "已儲存。連線中的話下一輪讀取就會用新座標。";
    // 連線中的話立即重算目前使用的區域（不用重新連線）。
    if (this.captureHandle) {
      const size = this.captureHandle.size;
      if (this.located) {
        const potionRegions = this._resolvePotionRegions(size.width, size.height);
        this.currentRegions.map = this._resolveMapRegion(size.width, size.height);
        this.currentRegions.panel = potionRegions ? potionRegions.panel : null;
        this.currentRegions.hp = potionRegions ? potionRegions.hp : null;
        this.currentRegions.mp = potionRegions ? potionRegions.mp : null;
      } else {
        this._applyFallbackRegions(size.width, size.height);
      }
      this._checkFrameSizeWarning(size.width, size.height);
    }
    this._applySettingsToUi();
  }

  _cancelCalibration() {
    this._calibWorking = null;
    this._initCalibWorking();
    this._refreshCalibRowSelection();
    this._updatePotionSlotSelects();
    this.els.calibPageStatus.textContent = "已取消，恢復成上次儲存的樣子。";
  }
}

function boot() {
  // window.__app 只是給 tests/frame.html／tests/frame-anim.html 那套「不用
  // 真的開遊戲」的手動驗收流程用（getDisplayMedia 的分享視窗選單需要真人
  // 點選，自動化工具點不到，見 0070-回報單），不影響正式使用流程。
  window.__app = new App();
  // window.__capture 同上，0082 工單新增：讓 tests/frame-anim.html 可以呼叫
  // `capture.connectFromTrack(canvas.captureStream(fps).getVideoTracks()[0])`，
  // 走新的 MediaStreamTrackProcessor stream 讀取路徑（不是假的 grabFrame handle），
  // 驗證分頁背景時慢迴圈樣本還是每 10 秒一筆。
  window.__capture = capture;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

export { App, OcrClient };

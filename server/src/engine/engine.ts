import { EventEmitter } from "events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { config } from "../config.js";
import type { FeedManager } from "../feeds/manager.js";
import {
  fetchCurrentBtc5mWindow,
  formatWindowTitle,
} from "../polymarket/markets.js";
import {
  executeSignal,
  executeDualBuy,
  getOrderBook,
  calculateFee,
  effectiveFeeRate,
} from "../polymarket/orders.js";
import { isConnected } from "../polymarket/client.js";
import { AutoRedeemer } from "../polymarket/redeemer.js";
import { ArbStrategy } from "../strategies/arb.js";
import { EfficiencyStrategy } from "../strategies/efficiency.js";
import { WhaleHuntStrategy } from "../strategies/whale-hunt.js";
import { MomentumStrategy } from "../strategies/mean-reversion.js";
import { RiskManager } from "./risk.js";
import { PnLTracker } from "./tracker.js";
import { FillSimulator } from "./fill-simulator.js";
import type { SimulatorOpts } from "./fill-simulator.js";
import { PositionSizer } from "./position-sizer.js";
import { RegimeDetector } from "./regime-detector.js";
import type {
  MarketWindow,
  MarketContext,
  OrderBookState,
  PricePoint,
  StrategyState,
  Signal,
  TradeRecord,
  RegimeState,
  StrategyDiagnostics,
  EngineMetrics,
  OrderBookSide,
  RiskSnapshot,
} from "../types.js";

let tradeCounter = 0;
const STRATEGY_STATE_PATH = resolve(
  process.cwd(),
  "data",
  "strategy-state.json",
);

const STRATEGY_COOLDOWN_MS: Record<string, number> = {
  arb: 3000,
  efficiency: 5000,
  "whale-hunt": 6000,
  momentum: 4000,
};

const MAX_ENTRIES_PER_WINDOW: Record<string, number> = {
  arb: 3,
  efficiency: 2,
  "whale-hunt": 2,
  momentum: 2,
};

const MIN_FILL_RATIO_BY_STRATEGY: Record<string, number> = {
  arb: 0.5,
  efficiency: 0.6,
  "whale-hunt": 0.5,
  momentum: 0.5,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function zeroDiagnostics(): StrategyDiagnostics {
  return {
    signals: 0,
    riskRejected: 0,
    liveRejected: 0,
    dynamicWindowUsed: 0,
    earlyEntryAccepted: 0,
    earlyEntryRejected: 0,
    probabilityRejected: 0,
    submitted: 0,
    queueMiss: 0,
    liquidityFail: 0,
    partialFill: 0,
    fullFill: 0,
    wins: 0,
    losses: 0,
  };
}

function emptyReconciliation() {
  return {
    updatedAt: 0,
    liveTotalTrades: 0,
    shadowTotalTrades: 0,
    liveWinRate: 0,
    shadowWinRate: 0,
    liveTotalPnl: 0,
    shadowTotalPnl: 0,
    strategies: [],
  };
}

export class TradingEngine extends EventEmitter {
  private feedManager: FeedManager;
  private riskManager = new RiskManager();
  readonly tracker = new PnLTracker();
  private simulator = new FillSimulator();
  private positionSizer: PositionSizer;
  private regimeDetector = new RegimeDetector();
  readonly redeemer: AutoRedeemer;

  readonly strategies = {
    arb: new ArbStrategy(),
    efficiency: new EfficiencyStrategy(),
    "whale-hunt": new WhaleHuntStrategy(),
    momentum: new MomentumStrategy(),
  };

  private currentWindow: MarketWindow | null = null;
  private windowTitle = "";
  private orderBook: OrderBookState = {
    up: { bids: [], asks: [] },
    down: { bids: [], asks: [] },
    bestAskUp: null,
    bestAskDown: null,
    bestBidUp: null,
    bestBidDown: null,
  };

  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private marketPollInterval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private _tradingActive = false;
  private tickInFlight = false;
  private _mode: "live" | "shadow";
  private _regime: RegimeState = {
    volatilityRegime: "normal",
    trendRegime: "chop",
    liquidityRegime: "normal",
    spreadRegime: "normal",
    volatilityValue: 0,
    trendStrength: 0,
    liquidityDepth: 0,
    spreadValue: 0,
  };
  private inFlightByCondition = new Map<string, number>();
  private retryBackoffUntil = new Map<string, number>();
  private retryBackoffCount = new Map<string, number>();
  private lastSignalFingerprint = new Map<string, string>();
  private lastStrategyExecution = new Map<string, number>();
  private entriesThisWindow = new Map<string, number>();
  private windowSideByStrategy = new Map<string, "UP" | "DOWN">();
  private lastOrderbookUpdateTs = 0;
  private windowEndPriceSnapshot: number | null = null;
  private windowEndSnapshotTs = 0;
  private recentSignalLatencies: number[] = [];
  private windowDiagnostics: Record<string, StrategyDiagnostics> = {};
  private rollingDiagnostics: Record<string, StrategyDiagnostics> = {};
  private liveModeDiagnostics: Record<string, StrategyDiagnostics> = {};
  private shadowModeDiagnostics: Record<string, StrategyDiagnostics> = {};
  private metrics: EngineMetrics = {
    windowConditionId: null,
    rolling: {},
    window: {},
    latency: {
      lastSignalToSubmitMs: 0,
      avgSignalToSubmitMs: 0,
      avgRecentSignalToSubmitMs: 0,
      samples: 0,
      lastSampleAt: 0,
      priceDataAgeMs: 0,
      orderbookAgeMs: 0,
    },
    reconciliation: emptyReconciliation(),
  };

  constructor(feedManager: FeedManager) {
    super();
    this.feedManager = feedManager;
    this._mode = config.trading.mode;
    this.redeemer = new AutoRedeemer(config.redemption.polygonRpcUrl);
    this.positionSizer = new PositionSizer({
      baseSize: Math.min(10, config.risk.maxTradeSize),
      maxSize: config.risk.maxTradeSize,
      minSize: Math.min(2, config.risk.maxTradeSize),
    });
    for (const name of Object.keys(this.strategies)) {
      this.windowDiagnostics[name] = zeroDiagnostics();
      this.rollingDiagnostics[name] = zeroDiagnostics();
      this.liveModeDiagnostics[name] = zeroDiagnostics();
      this.shadowModeDiagnostics[name] = zeroDiagnostics();
    }
    this.metrics = {
      ...this.metrics,
      rolling: this.rollingDiagnostics,
      window: this.windowDiagnostics,
    };
    this.loadPersistedStrategyState();
  }

  private loadPersistedStrategyState(): void {
    try {
      if (!existsSync(STRATEGY_STATE_PATH)) return;
      const raw = readFileSync(STRATEGY_STATE_PATH, "utf-8");
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<
        string,
        {
          enabled?: boolean;
          config?: Record<string, unknown>;
          regimeFilter?: Record<string, unknown>;
        }
      >;
      if (!parsed || typeof parsed !== "object") return;

      for (const [name, state] of Object.entries(parsed)) {
        const strategy =
          this.strategies[name as keyof typeof this.strategies];
        if (!strategy || !state || typeof state !== "object") continue;
        if (typeof state.enabled === "boolean") {
          strategy.enabled = state.enabled;
        }
        if (state.config && typeof state.config === "object") {
          strategy.updateConfig(state.config);
        }
        if (state.regimeFilter && typeof state.regimeFilter === "object") {
          strategy.updateRegimeFilter(state.regimeFilter as any);
        }
      }
      console.log("[Engine] Loaded persisted strategy state");
    } catch (err) {
      console.warn("[Engine] Failed to load persisted strategy state:", err);
    }
  }

  private persistStrategyState(): void {
    try {
      mkdirSync(resolve(process.cwd(), "data"), { recursive: true });
      const snapshot = Object.fromEntries(
        Object.values(this.strategies).map((strategy) => [
          strategy.name,
          {
            enabled: strategy.enabled,
            config: strategy.config,
            regimeFilter: strategy.regimeFilter,
          },
        ]),
      );
      writeFileSync(STRATEGY_STATE_PATH, JSON.stringify(snapshot, null, 2));
    } catch (err) {
      console.warn("[Engine] Failed to persist strategy state:", err);
    }
  }

  start(): void {
    this.running = true;

    this.feedManager.on("price", (p: PricePoint) => {
      this.strategies["momentum"].addPrice(p);
      this.regimeDetector.addPrice(p);
    });

    this.tickInterval = setInterval(() => this.tick(), 500);
    this.marketPollInterval = setInterval(
      () => this.adaptivePollMarkets(),
      3_000,
    );
    this.pollMarkets();

    if (config.redemption.enabled && config.poly.privateKey) {
      this.redeemer
        .start(config.redemption.intervalMs)
        .catch((err) =>
          console.error("[Engine] Redeemer failed to start:", err),
        );
    }

    console.log(`[Engine] Started in ${this._mode.toUpperCase()} mode`);
  }

  stop(): void {
    this.running = false;
    if (this.tickInterval) clearInterval(this.tickInterval);
    if (this.marketPollInterval) clearInterval(this.marketPollInterval);
    this.redeemer.stop();
    console.log("[Engine] Stopped");
  }

  // ── Market polling ──

  private lastPoll = 0;

  private async adaptivePollMarkets(): Promise<void> {
    const now = Date.now();
    const nearBoundary =
      !this.currentWindow ||
      this.currentWindow.endTime - now < 10_000 ||
      now - this.currentWindow.startTime < 5_000;
    const interval = nearBoundary ? 3_000 : 15_000;
    if (now - this.lastPoll < interval) return;
    await this.pollMarkets();
  }

  private async pollMarkets(): Promise<void> {
    this.lastPoll = Date.now();
    try {
      const current = await fetchCurrentBtc5mWindow();

      if (
        current &&
        current.conditionId !== this.currentWindow?.conditionId
      ) {
        if (current.priceToBeat === null) {
          const openPrice = this.feedManager.getCurrentBtcPrice();
          if (openPrice > 0) {
            current.priceToBeat = openPrice;
            console.warn(
              `[Engine] priceToBeat not in market metadata — using local feed $${openPrice.toFixed(2)} (may drift)`,
            );
          }
        }
        this.windowTitle = current.title ?? formatWindowTitle(current);
        console.log(
          `[Engine] New window: ${this.windowTitle} | Price to beat: $${current.priceToBeat?.toFixed(2) ?? "unknown"}`,
        );
        this.currentWindow = current;
        this.metrics.windowConditionId = current.conditionId;
        this.entriesThisWindow.clear();
        this.windowSideByStrategy.clear();
        this.windowEndPriceSnapshot = null;
        this.windowEndSnapshotTs = 0;
        this.inFlightByCondition.clear();
        this.retryBackoffUntil.clear();
        this.retryBackoffCount.clear();
        for (const name of Object.keys(this.windowDiagnostics)) {
          this.windowDiagnostics[name] = zeroDiagnostics();
        }
        this.riskManager.onNewWindow(current.conditionId);
        this.emit("market", current);
      }

      if (current && (isConnected() || this._mode === "shadow")) {
        try {
          await this.refreshOrderBook(current);
        } catch {
          /* orderbook fetch may fail without CLOB credentials in shadow mode */
        }
      }
    } catch (err) {
      console.error("[Engine] Market poll error:", err);
    }
  }

  private async refreshOrderBook(window: MarketWindow): Promise<void> {
    try {
      if (!window.upTokenId || !window.downTokenId) return;

      const [upBook, downBook] = await Promise.all([
        getOrderBook(window.upTokenId),
        getOrderBook(window.downTokenId),
      ]);

      if (!upBook && !downBook) return;

      if (upBook) {
        this.orderBook.up = {
          bids: (upBook.bids ?? []).map((b: any) => ({
            price: parseFloat(b.price),
            size: parseFloat(b.size),
          })),
          asks: (upBook.asks ?? []).map((a: any) => ({
            price: parseFloat(a.price),
            size: parseFloat(a.size),
          })),
        };
        this.orderBook.bestAskUp =
          this.orderBook.up.asks.length > 0
            ? Math.min(...this.orderBook.up.asks.map((a) => a.price))
            : null;
        this.orderBook.bestBidUp =
          this.orderBook.up.bids.length > 0
            ? Math.max(...this.orderBook.up.bids.map((b) => b.price))
            : null;
      }

      if (downBook) {
        this.orderBook.down = {
          bids: (downBook.bids ?? []).map((b: any) => ({
            price: parseFloat(b.price),
            size: parseFloat(b.size),
          })),
          asks: (downBook.asks ?? []).map((a: any) => ({
            price: parseFloat(a.price),
            size: parseFloat(a.size),
          })),
        };
        this.orderBook.bestAskDown =
          this.orderBook.down.asks.length > 0
            ? Math.min(...this.orderBook.down.asks.map((a) => a.price))
            : null;
        this.orderBook.bestBidDown =
          this.orderBook.down.bids.length > 0
            ? Math.max(...this.orderBook.down.bids.map((b) => b.price))
            : null;
      }

      this.lastOrderbookUpdateTs = Date.now();
      this.emit("orderbook", this.orderBook);
    } catch {
      /* ignore order book errors */
    }
  }

  // ── Tick loop ──

  private async tick(): Promise<void> {
    if (!this.running || this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      await this.tickInner();
    } finally {
      this.tickInFlight = false;
    }
  }

  private async tickInner(): Promise<void> {
    const isShadow = this._mode === "shadow";
    this.updateLiveLatencyMetrics();
    const now = Date.now();
    const liveBtcPrice = this.feedManager.getCurrentBtcPrice();

    // Capture a price snapshot near window end for resolution accuracy.
    // Once captured, it won't be overwritten so post-expiry drift doesn't affect results.
    if (
      this.currentWindow &&
      liveBtcPrice > 0 &&
      now >= this.currentWindow.endTime - 5_000
    ) {
      if (
        this.windowEndPriceSnapshot === null ||
        (now <= this.currentWindow.endTime + 2_000 && liveBtcPrice > 0)
      ) {
        this.windowEndPriceSnapshot = liveBtcPrice;
        this.windowEndSnapshotTs = now;
      }
    }

    const closingBtcPrice =
      this.windowEndPriceSnapshot && this.windowEndPriceSnapshot > 0
        ? this.windowEndPriceSnapshot
        : liveBtcPrice;

    this.cleanupStaleUnconfirmedTrades(now);
    this.reconcileExpiredUntrackedOpenTrades(now, closingBtcPrice);

    const expired = this.riskManager.resolveExpired(now);
    for (const trade of expired) {
      if (closingBtcPrice <= 0) {
        console.warn(
          `[Engine] Skipping resolution of ${trade.id} — no valid settlement price`,
        );
        continue;
      }
      const tradeShadow = trade.id.startsWith("shadow-");
      this.tracker.expireTrade(trade.id, closingBtcPrice, tradeShadow);
      trade.closingBtcPrice = closingBtcPrice;
      const won = this.didTradeWin(trade);
      this.tracker.resolveTrade(trade.id, won, tradeShadow);
      const resolved = this.tracker.getTradeById(trade.id, tradeShadow);
      if (resolved) {
        trade.status = "resolved";
        trade.outcome = resolved.outcome;
        trade.pnl = resolved.pnl;
      } else {
        trade.status = "resolved";
        trade.outcome = won ? "win" : "loss";
        trade.pnl = 0;
      }
      for (const s of Object.values(this.strategies)) {
        s.onTrade(trade);
      }
      if (trade.outcome === "win") {
        this.bumpDiag(trade.strategy, "wins", 1, tradeShadow);
        if (!tradeShadow && config.redemption.enabled) {
          this.redeemer.queueRedemption(trade.conditionId);
        }
      } else if (trade.outcome === "loss") {
        this.bumpDiag(trade.strategy, "losses", 1, tradeShadow);
      }
      this.riskManager.onTradeClosed(trade, tradeShadow);
      this.emit("trade", trade);
    }

    if (!this.currentWindow) {
      this.setEnabledStrategiesIdleReason("No active market window");
      this.emit("strategies", this.getStrategyStates());
      this.emit("regime", this._regime);
      this.emit("metrics", this.getMetrics());
      return;
    }

    if (now >= this.currentWindow.endTime) {
      this.setEnabledStrategiesIdleReason("Window ended — awaiting resolution");
      this.emit("strategies", this.getStrategyStates());
      this.emit("pnl", this.tracker.getSummary());
      this.emit("shadowPnl", this.tracker.getSummary(true));
      this.emit("metrics", this.getMetrics());
      return;
    }

    const ctx: MarketContext = {
      currentWindow: this.currentWindow,
      orderBook: this.orderBook,
      prices: this.feedManager.getLatestPrices(),
      oracleEstimate: this.feedManager.getOracleEstimate(),
      oracleTimestamp: this.feedManager.getOracleTimestamp(),
      windowElapsedMs: now - this.currentWindow.startTime,
      windowRemainingMs: this.currentWindow.endTime - now,
      priceToBeat: this.currentWindow.priceToBeat,
      currentBtcPrice: this.feedManager.getCurrentBtcPrice(),
    };
    this.updateLiveLatencyMetrics(ctx);

    this.regimeDetector.update(ctx);
    this._regime = this.regimeDetector.getRegime();

    if (!isShadow && !isConnected()) {
      this.setEnabledStrategiesIdleReason("Live mode is disconnected");
      this.emit("strategies", this.getStrategyStates());
      this.emit("pnl", this.tracker.getSummary(false));
      this.emit("shadowPnl", this.tracker.getSummary(true));
      this.emit("regime", this._regime);
      this.emit("killswitch", this.riskManager.getKillSwitchStatus());
      this.emit("risk", this.getRiskSnapshot());
      this.emit("metrics", this.getMetrics());
      return;
    }

    const dataHealth = this.riskManager.checkDataHealth(ctx);
    if (!dataHealth.healthy) {
      this.setEnabledStrategiesIdleReason(dataHealth.reason);
      this.emit("strategies", this.getStrategyStates());
      this.emit("pnl", this.tracker.getSummary(false));
      this.emit("shadowPnl", this.tracker.getSummary(true));
      this.emit("regime", this._regime);
      this.emit("killswitch", this.riskManager.getKillSwitchStatus());
      this.emit("risk", this.getRiskSnapshot());
      this.emit("metrics", this.getMetrics());
      return;
    }

    for (const strategy of Object.values(this.strategies)) {
      strategy.statusReason = null;
      if (!strategy.enabled) {
        strategy.status = "idle";
        strategy.statusReason = "Strategy disabled";
        continue;
      }
      if (!this._tradingActive) {
        strategy.status = "idle";
        strategy.statusReason = "Trading is stopped";
        continue;
      }

      if (!strategy.shouldRunInRegime(this._regime)) {
        strategy.status = "regime_blocked";
        strategy.statusReason = strategy.regimeBlockReason;
        continue;
      }

      try {
        // Default to watching while enabled, active, and regime-allowed.
        // Individual strategies can still elevate to "trading" or set
        // their own status during evaluation.
        strategy.status = "watching";
        if (this.currentWindow) {
          const lockUntil = this.inFlightByCondition.get(this.currentWindow.conditionId) ?? 0;
          if (lockUntil > now) {
            strategy.status = "idle";
            strategy.statusReason = "Order in flight for this market";
            continue;
          }
        }
        const cooldownMs = STRATEGY_COOLDOWN_MS[strategy.name] ?? 3000;
        const lastExec = this.lastStrategyExecution.get(strategy.name) ?? 0;
        if (now - lastExec < cooldownMs) {
          strategy.status = "idle";
          strategy.statusReason = `Cooldown ${Math.ceil((cooldownMs - (now - lastExec)) / 1000)}s`;
          continue;
        }
        const backoffKey = `${strategy.name}:${this.currentWindow.conditionId}`;
        const backoffUntil = this.retryBackoffUntil.get(backoffKey) ?? 0;
        if (backoffUntil > now) {
          strategy.status = "idle";
          strategy.statusReason = `Backoff ${Math.ceil((backoffUntil - now) / 1000)}s`;
          continue;
        }
        const maxEntries = MAX_ENTRIES_PER_WINDOW[strategy.name] ?? 2;
        const configuredCap = Math.floor(
          strategy.config["maxEntriesPerWindow"] ?? NaN,
        );
        const maxEntriesPerWindow = Number.isFinite(configuredCap)
          ? clamp(configuredCap, 1, 20)
          : maxEntries;
        const entries = this.entriesThisWindow.get(strategy.name) ?? 0;
        if (entries >= maxEntriesPerWindow) {
          strategy.status = "idle";
          strategy.statusReason = `Window entry cap reached (${maxEntriesPerWindow})`;
          continue;
        }
        const lockedSide = this.windowSideByStrategy.get(strategy.name);
        const signal = strategy.evaluate(ctx);
        if (signal && lockedSide && signal.side !== lockedSide) {
          strategy.status = "idle";
          strategy.statusReason = `Opposing side blocked (locked ${lockedSide})`;
          continue;
        }
        if (!signal) {
          if (strategy.name === "whale-hunt") {
            const reason =
              typeof strategy.statusReason === "string"
                ? strategy.statusReason
                : "";
            if (reason.startsWith("whale:early_entry_rejected")) {
              this.bumpDiag(strategy.name, "earlyEntryRejected", 1, isShadow);
            }
            if (reason.startsWith("whale:probability_rejected")) {
              this.bumpDiag(strategy.name, "probabilityRejected", 1, isShadow);
            }
          }
          continue;
        }
        this.bumpDiag(strategy.name, "signals", 1, isShadow);
        if (signal.strategy === "whale-hunt" && signal.telemetry) {
          if (signal.telemetry.usedDynamicWindow) {
            this.bumpDiag(strategy.name, "dynamicWindowUsed", 1, isShadow);
          }
          if (signal.telemetry.earlyEntry) {
            this.bumpDiag(strategy.name, "earlyEntryAccepted", 1, isShadow);
          }
        }

        const fingerprint = `${this.currentWindow.conditionId}:${signal.strategy}:${signal.side}:${signal.maxPrice.toFixed(3)}:${Math.round(signal.confidence * 100)}`;
        const prevFingerprint = this.lastSignalFingerprint.get(strategy.name);
        if (prevFingerprint === fingerprint) {
          strategy.status = "idle";
          strategy.statusReason = "Duplicate signal suppressed";
          continue;
        }

        const recentPrices = this.feedManager.getRecentPrices(
          "binance",
          300_000,
        );
        signal.size = this.positionSizer.computeSize(
          signal,
          recentPrices,
          strategy.getWinRate(),
        );
        const sideBook = signal.side === "UP" ? this.orderBook.up : this.orderBook.down;
        const sharesRequested = signal.maxPrice > 0 ? signal.size / signal.maxPrice : 0;
        const depthShares = this.capSharesByDepth(signal, sideBook, sharesRequested);
        if (depthShares <= 0) {
          strategy.status = "idle";
          strategy.statusReason = "Insufficient top-book depth";
          continue;
        }
        signal.size = Math.min(signal.size, depthShares * signal.maxPrice);

        if (!this.passesCostFloor(signal, ctx)) {
          strategy.status = "idle";
          strategy.statusReason = "Estimated edge below fee/slippage floor";
          continue;
        }

        const positionSlots = signal.strategy === "efficiency" ? 2 : 1;
        const check = this.riskManager.approve(signal, ctx, positionSlots);
        if (!check.approved) {
          this.bumpDiag(strategy.name, "riskRejected", 1, isShadow);
          strategy.status = "idle";
          strategy.statusReason = check.reason;
          console.log(
            `[Engine] Risk rejected ${signal.strategy}: ${check.reason}`,
          );
          continue;
        }
        this.lastStrategyExecution.set(strategy.name, now);
        this.inFlightByCondition.set(this.currentWindow.conditionId, now + 2000);
        const executed = await this.executeStrategy(signal, isShadow, ctx);
        this.inFlightByCondition.delete(this.currentWindow.conditionId);
        if (executed) {
          this.entriesThisWindow.set(strategy.name, entries + 1);
          this.windowSideByStrategy.set(strategy.name, signal.side);
          this.lastSignalFingerprint.set(strategy.name, fingerprint);
        } else if (!isShadow) {
          this.bumpDiag(strategy.name, "liveRejected", 1, false);
          strategy.status = "idle";
          strategy.statusReason = "Order not accepted by CLOB";
        }
      } catch (err) {
        console.error(`[Engine] Strategy ${strategy.name} error:`, err);
        strategy.status = "idle";
        strategy.statusReason = "Strategy evaluation error";
        if (this.currentWindow) {
          this.inFlightByCondition.delete(this.currentWindow.conditionId);
        }
      }
    }

    this.emit("strategies", this.getStrategyStates());
    this.emit("pnl", this.tracker.getSummary(false));
    this.emit("shadowPnl", this.tracker.getSummary(true));
    this.emit("regime", this._regime);
    this.emit("killswitch", this.riskManager.getKillSwitchStatus());
    this.emit("risk", this.getRiskSnapshot());
    this.emit("metrics", this.getMetrics());
  }

  private cleanupStaleUnconfirmedTrades(now: number): void {
    for (const shadow of [false, true]) {
      const open = this.tracker.getOpenTrades(shadow);
      for (const t of open) {
        if (
          now >= t.windowEnd &&
          (t.status === "pending" || t.status === "submitted")
        ) {
          this.tracker.cancelTrade(t.id, "window_closed_unconfirmed_order", shadow);
          const updated = this.tracker.getTradeRecordById(t.id, shadow);
          if (updated) {
            this.emit("trade", updated);
          }
        }
      }
    }
  }

  /**
   * On server restart, RiskManager has no in-memory open positions, but TradeStore
   * replays persisted fills that may already be past window end. Reconcile those
   * here so they don't stay "active" forever with fee-only PnL.
   */
  private reconcileExpiredUntrackedOpenTrades(
    now: number,
    closingBtcPrice: number,
  ): void {
    if (closingBtcPrice <= 0) return;

    const riskTrackedIds = new Set(
      this.riskManager.getOpenPositions().map((t) => t.id),
    );

    for (const shadow of [false, true]) {
      const open = this.tracker.getOpenTrades(shadow);
      for (const t of open) {
        if (riskTrackedIds.has(t.id)) continue;
        if (t.windowEnd <= 0 || now < t.windowEnd) continue;
        if (
          t.status !== "filled" &&
          t.status !== "partial" &&
          t.status !== "expired"
        ) {
          continue;
        }

        if (t.status !== "expired") {
          this.tracker.expireTrade(t.id, closingBtcPrice, shadow);
        }
        const current = this.tracker.getTradeRecordById(t.id, shadow);
        if (!current) continue;
        const won = this.didTradeWin(current);
        this.tracker.resolveTrade(t.id, won, shadow);
        const resolved = this.tracker.getTradeRecordById(t.id, shadow);
        if (resolved) {
          this.emit("trade", resolved);
        }
      }
    }
  }

  private setEnabledStrategiesIdleReason(reason: string): void {
    for (const strategy of Object.values(this.strategies)) {
      if (!strategy.enabled) continue;
      strategy.status = "idle";
      strategy.statusReason = reason;
    }
  }

  // ── Execution ──

  private async executeStrategy(
    signal: Signal,
    shadow: boolean,
    ctx: MarketContext,
  ): Promise<boolean> {
    if (!this.currentWindow) return false;
    const conditionId = this.currentWindow.conditionId;
    const priceToBeatAtEntry = this.currentWindow.priceToBeat ?? 0;

    if (shadow) {
      return await this.executeShadow(
        signal,
        conditionId,
        priceToBeatAtEntry,
        ctx,
      );
    } else {
      return await this.executeLive(signal, conditionId, priceToBeatAtEntry);
    }
  }

  private async executeShadow(
    signal: Signal,
    conditionId: string,
    priceToBeatAtEntry: number,
    ctx: MarketContext,
  ): Promise<boolean> {
    if (!this.currentWindow) return false;
    if (signal.strategy === "efficiency") {
      return this.executeShadowEfficiency(
        signal,
        conditionId,
        priceToBeatAtEntry,
        ctx,
      );
    }
    const tokenId =
      signal.side === "UP"
        ? this.currentWindow.upTokenId
        : this.currentWindow.downTokenId;
    const notional = signal.size;
    const shares = Math.floor((notional / signal.maxPrice) * 100) / 100;

    const book =
      signal.side === "UP" ? this.orderBook.up : this.orderBook.down;
    const simOpts = this.buildAdaptiveSimulatorOpts(signal, book, shares, ctx);
    const result = this.simulator.simulate(
      "BUY",
      tokenId,
      shares,
      signal.maxPrice,
      book,
      simOpts,
    );

    const tradeId = `shadow-${++tradeCounter}-${Date.now()}`;
    const store = this.tracker.getStore(true);
    const backoffKey = `${signal.strategy}:${conditionId}`;
    const signalToSubmitMs = Math.max(0, Date.now() - signal.timestamp);
    this.recordSignalLatency(signalToSubmitMs);

    store.createTrade({
      id: tradeId,
      conditionId,
      strategy: signal.strategy,
      side: signal.side,
      tokenId,
      priceToBeatAtEntry,
      windowEnd: this.currentWindow.endTime,
      shadow: true,
      size: notional,
      requestedShares: shares,
    });

    store.appendEvent(tradeId, "signal_generated", {
      conditionId,
      strategy: signal.strategy,
      side: signal.side,
      tokenId,
      priceToBeatAtEntry,
      windowEnd: this.currentWindow.endTime,
      shadow: true,
      size: notional,
      requestedShares: shares,
    });

    store.appendEvent(tradeId, "order_submitted", {
      shares,
      price: signal.maxPrice,
    });
    this.bumpDiag(signal.strategy, "submitted", 1, true);

    if (!result.filled) {
      store.appendEvent(tradeId, "cancel", { reason: result.reason });
      const reason = result.reason ?? "cancelled";
      this.handleMicrostructureBackoff(signal.strategy, conditionId, reason);
      if (reason === "queue_position_miss") this.bumpDiag(signal.strategy, "queueMiss", 1, true);
      if (reason === "insufficient_liquidity") this.bumpDiag(signal.strategy, "liquidityFail", 1, true);
      console.log(
        `[Shadow] ${signal.strategy} ${signal.side} cancelled: ${result.reason}`,
      );
      return false;
    }

    const fillRatio = shares > 0 ? result.filledShares / shares : 0;
    const minFillRatio = MIN_FILL_RATIO_BY_STRATEGY[signal.strategy] ?? 0.5;
    if (fillRatio < minFillRatio) {
      store.appendEvent(tradeId, "cancel", {
        reason: "low_fill_ratio",
        fillRatio,
        minFillRatio,
      });
      this.bumpDiag(signal.strategy, "liquidityFail", 1, true);
      this.handleMicrostructureBackoff(signal.strategy, conditionId, "low_fill_ratio");
      console.log(
        `[Shadow] ${signal.strategy} cancelled low fill ratio ${(fillRatio * 100).toFixed(1)}%`,
      );
      return false;
    }

    if (result.filledShares < shares) {
      store.appendEvent(tradeId, "partial_fill", {
        shares: result.filledShares,
        price: result.avgPrice,
        fee: result.fee,
      });
      this.bumpDiag(signal.strategy, "partialFill", 1, true);
    } else {
      store.appendEvent(tradeId, "fill", {
        shares: result.filledShares,
        price: result.avgPrice,
        fee: result.fee,
      });
      this.bumpDiag(signal.strategy, "fullFill", 1, true);
    }

    const record = store.toTradeRecord(store.getTrade(tradeId)!);
    (record as any).shadow = true;
    this.riskManager.onTradeOpened(record, true);
    this.emit("trade", record);
    this.retryBackoffCount.delete(backoffKey);
    this.retryBackoffUntil.delete(backoffKey);

    console.log(
      `[Shadow] ${signal.strategy} ${signal.side} filled ${result.filledShares} @ $${result.avgPrice.toFixed(4)}`,
    );
    return true;
  }

  private async executeLive(
    signal: Signal,
    conditionId: string,
    priceToBeatAtEntry: number,
  ): Promise<boolean> {
    if (!this.currentWindow) return false;
    const backoffKey = `${signal.strategy}:${conditionId}`;

    if (signal.strategy === "efficiency") {
      const signalToSubmitMs = Math.max(0, Date.now() - signal.timestamp);
      this.recordSignalLatency(signalToSubmitMs);
      const trades = await executeDualBuy(
        this.currentWindow.upTokenId,
        this.currentWindow.downTokenId,
        this.orderBook.bestAskUp!,
        this.orderBook.bestAskDown!,
        signal.size,
        this.currentWindow.endTime,
        conditionId,
        priceToBeatAtEntry,
      );
      for (const trade of trades) {
        this.bumpDiag(signal.strategy, "submitted", 1, false);
        this.tracker.addTrade(trade);
        this.riskManager.onTradeOpened(trade);
        this.bumpDiag(signal.strategy, "fullFill", 1, false);
        this.emit("trade", trade);
      }
      this.retryBackoffCount.delete(backoffKey);
      this.retryBackoffUntil.delete(backoffKey);
      return trades.length > 0;
    } else {
      const signalToSubmitMs = Math.max(0, Date.now() - signal.timestamp);
      this.recordSignalLatency(signalToSubmitMs);
      const trade = await executeSignal(
        signal,
        this.currentWindow.upTokenId,
        this.currentWindow.downTokenId,
        this.currentWindow.endTime,
        conditionId,
        priceToBeatAtEntry,
      );
      if (trade) {
        this.bumpDiag(signal.strategy, "submitted", 1, false);
        this.tracker.addTrade(trade);
        if (trade.status === "filled") {
          this.riskManager.onTradeOpened(trade);
          this.bumpDiag(signal.strategy, "fullFill", 1, false);
        }
        this.emit("trade", trade);
        this.retryBackoffCount.delete(backoffKey);
        this.retryBackoffUntil.delete(backoffKey);
        return true;
      }
      return false;
    }
  }

  private async executeShadowEfficiency(
    signal: Signal,
    conditionId: string,
    priceToBeatAtEntry: number,
    ctx: MarketContext,
  ): Promise<boolean> {
    if (!this.currentWindow) return false;
    if (
      this.orderBook.bestAskUp === null ||
      this.orderBook.bestAskDown === null ||
      this.orderBook.bestAskUp <= 0 ||
      this.orderBook.bestAskDown <= 0
    ) {
      return false;
    }

    // Equal shares for both legs — same logic as live executeDualBuy
    const askUp = this.orderBook.bestAskUp;
    const askDown = this.orderBook.bestAskDown;
    const equalShares =
      askUp > 0 && askDown > 0
        ? Math.floor((signal.size / (askUp + askDown)) * 100) / 100
        : 0;
    if (equalShares <= 0) return false;

    const legs: Array<{
      side: "UP" | "DOWN";
      tokenId: string;
      limitPrice: number;
      book: OrderBookSide;
    }> = [
      {
        side: "UP",
        tokenId: this.currentWindow.upTokenId,
        limitPrice: askUp,
        book: this.orderBook.up,
      },
      {
        side: "DOWN",
        tokenId: this.currentWindow.downTokenId,
        limitPrice: askDown,
        book: this.orderBook.down,
      },
    ];
    const backoffKey = `${signal.strategy}:${conditionId}`;
    const signalToSubmitMs = Math.max(0, Date.now() - signal.timestamp);
    this.recordSignalLatency(signalToSubmitMs);

    const created: Array<{ tradeId: string; full: boolean }> = [];
    let secondLegFailed = false;

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i]!;
      const requestedShares = equalShares;
      const simOpts = this.buildAdaptiveSimulatorOpts(
        signal,
        leg.book,
        requestedShares,
        ctx,
      );
      const result = this.simulator.simulate(
        "BUY",
        leg.tokenId,
        requestedShares,
        leg.limitPrice,
        leg.book,
        simOpts,
      );

      if (!result.filled) {
        if (i === 1 && created.length === 1) {
          secondLegFailed = true;
        }
        const reason = result.reason ?? "cancelled";
        this.handleMicrostructureBackoff(signal.strategy, conditionId, reason);
        if (reason === "queue_position_miss") {
          this.bumpDiag(signal.strategy, "queueMiss", 1, true);
        }
        if (reason === "insufficient_liquidity") {
          this.bumpDiag(signal.strategy, "liquidityFail", 1, true);
        }
        break;
      }

      const fillRatio =
        requestedShares > 0 ? result.filledShares / requestedShares : 0;
      const minFillRatio = MIN_FILL_RATIO_BY_STRATEGY[signal.strategy] ?? 0.6;
      if (fillRatio < minFillRatio) {
        this.bumpDiag(signal.strategy, "liquidityFail", 1, true);
        this.handleMicrostructureBackoff(
          signal.strategy,
          conditionId,
          "low_fill_ratio",
        );
        break;
      }

      const tradeId = `shadow-${++tradeCounter}-${Date.now()}-${leg.side.toLowerCase()}`;
      const store = this.tracker.getStore(true);
      store.createTrade({
        id: tradeId,
        conditionId,
        strategy: signal.strategy,
        side: leg.side,
        tokenId: leg.tokenId,
        priceToBeatAtEntry,
        windowEnd: this.currentWindow.endTime,
        shadow: true,
        size: Math.floor(equalShares * leg.limitPrice * 100) / 100,
        requestedShares,
      });

      store.appendEvent(tradeId, "signal_generated", {
        conditionId,
        strategy: signal.strategy,
        side: leg.side,
        tokenId: leg.tokenId,
        priceToBeatAtEntry,
        windowEnd: this.currentWindow.endTime,
        shadow: true,
        size: Math.floor(equalShares * leg.limitPrice * 100) / 100,
        requestedShares,
      });
      store.appendEvent(tradeId, "order_submitted", {
        shares: requestedShares,
        price: leg.limitPrice,
      });
      this.bumpDiag(signal.strategy, "submitted", 1, true);

      if (result.filledShares < requestedShares) {
        store.appendEvent(tradeId, "partial_fill", {
          shares: result.filledShares,
          price: result.avgPrice,
          fee: result.fee,
        });
        this.bumpDiag(signal.strategy, "partialFill", 1, true);
        created.push({ tradeId, full: false });
      } else {
        store.appendEvent(tradeId, "fill", {
          shares: result.filledShares,
          price: result.avgPrice,
          fee: result.fee,
        });
        this.bumpDiag(signal.strategy, "fullFill", 1, true);
        created.push({ tradeId, full: true });
      }
    }

    if (created.length === 0) return false;

    const store = this.tracker.getStore(true);
    if (secondLegFailed && created.length === 1) {
      // Mirror live behavior where one successful leg leaves directional exposure.
      const first = store.getTrade(created[0]!.tradeId);
      if (first) {
        first.strategy = "efficiency-partial";
      }
    }

    for (const { tradeId } of created) {
      const record = store.toTradeRecord(store.getTrade(tradeId)!);
      (record as any).shadow = true;
      this.riskManager.onTradeOpened(record, true);
      this.emit("trade", record);
    }
    this.retryBackoffCount.delete(backoffKey);
    this.retryBackoffUntil.delete(backoffKey);
    return true;
  }

  private buildAdaptiveSimulatorOpts(
    signal: Signal,
    book: OrderBookSide,
    requestedShares: number,
    ctx: MarketContext,
  ): SimulatorOpts {
    const bestAsk =
      book.asks.length > 0
        ? Math.min(...book.asks.map((l) => l.price))
        : signal.maxPrice;
    const bestBid =
      book.bids.length > 0
        ? Math.max(...book.bids.map((l) => l.price))
        : Math.max(0, bestAsk - 0.01);
    const spread = Math.max(0, bestAsk - bestBid);
    const spreadBps = bestAsk > 0 ? (spread / bestAsk) * 10_000 : 0;

    const topDepth = [...book.asks]
      .sort((a, b) => a.price - b.price)
      .filter((l) => l.price <= signal.maxPrice)
      .slice(0, 3)
      .reduce((s, l) => s + Math.max(0, l.size), 0);
    const depthPressure =
      topDepth > 0 && requestedShares > 0 ? requestedShares / topDepth : 1;

    const ageMs = Math.max(
      this.metrics.latency.orderbookAgeMs > 0
        ? this.metrics.latency.orderbookAgeMs
        : 0,
      this.metrics.latency.priceDataAgeMs > 0
        ? this.metrics.latency.priceDataAgeMs
        : 0,
    );
    const agePenalty = clamp(ageMs / 3000, 0, 1.5);

    const regimePenalty =
      (ctx.windowRemainingMs < 30_000 ? 0.06 : 0) +
      (ctx.windowRemainingMs < 10_000 ? 0.05 : 0);

    const fillProbability = clamp(
      0.92 -
        clamp(spreadBps / 120, 0, 0.35) -
        clamp((depthPressure - 0.6) * 0.45, 0, 0.4) -
        agePenalty * 0.18 -
        regimePenalty,
      0.18,
      0.98,
    );

    const slippageBps = clamp(
      2 +
        spreadBps * 0.18 +
        clamp((depthPressure - 0.5) * 18, 0, 14) +
        agePenalty * 6,
      1,
      45,
    );

    const minLiquidityPct = clamp(0.14 + agePenalty * 0.06, 0.1, 0.4);
    return {
      fillProbability,
      slippageBps,
      minLiquidityPct,
    };
  }

  private bumpDiag(
    strategy: string,
    key: keyof StrategyDiagnostics,
    delta = 1,
    isShadowMode?: boolean,
  ): void {
    if (!this.windowDiagnostics[strategy]) this.windowDiagnostics[strategy] = zeroDiagnostics();
    if (!this.rollingDiagnostics[strategy]) this.rollingDiagnostics[strategy] = zeroDiagnostics();
    this.windowDiagnostics[strategy]![key] += delta;
    this.rollingDiagnostics[strategy]![key] += delta;
    if (typeof isShadowMode === "boolean") {
      const modeDiag = isShadowMode
        ? this.shadowModeDiagnostics
        : this.liveModeDiagnostics;
      if (!modeDiag[strategy]) modeDiag[strategy] = zeroDiagnostics();
      modeDiag[strategy]![key] += delta;
    }
  }

  private recordSignalLatency(ms: number): void {
    const latency = this.metrics.latency;
    latency.lastSignalToSubmitMs = ms;
    const total = latency.avgSignalToSubmitMs * latency.samples + ms;
    latency.samples += 1;
    latency.avgSignalToSubmitMs = total / latency.samples;
    latency.lastSampleAt = Date.now();
    this.recentSignalLatencies.push(ms);
    if (this.recentSignalLatencies.length > 20) {
      this.recentSignalLatencies = this.recentSignalLatencies.slice(-20);
    }
    latency.avgRecentSignalToSubmitMs =
      this.recentSignalLatencies.reduce((s, v) => s + v, 0) /
      this.recentSignalLatencies.length;
  }

  private updateLiveLatencyMetrics(ctx?: MarketContext): void {
    const prices = ctx?.prices ?? this.feedManager.getLatestPrices();
    let latestPriceTs = 0;
    for (const p of Object.values(prices)) {
      if (Number.isFinite(p.timestamp) && p.timestamp > latestPriceTs) {
        latestPriceTs = p.timestamp;
      }
    }
    const now = Date.now();
    this.metrics.latency.priceDataAgeMs =
      latestPriceTs > 0 ? Math.max(0, now - latestPriceTs) : -1;
    this.metrics.latency.orderbookAgeMs =
      this.lastOrderbookUpdateTs > 0
        ? Math.max(0, now - this.lastOrderbookUpdateTs)
        : -1;
    if (this.recentSignalLatencies.length === 0) {
      this.metrics.latency.avgRecentSignalToSubmitMs = 0;
    }
  }

  private handleMicrostructureBackoff(
    strategy: string,
    conditionId: string,
    reason: string,
  ): void {
    if (reason !== "queue_position_miss" && reason !== "insufficient_liquidity" && reason !== "low_fill_ratio") {
      return;
    }
    const key = `${strategy}:${conditionId}`;
    const prev = this.retryBackoffCount.get(key) ?? 0;
    const next = Math.min(5, prev + 1);
    this.retryBackoffCount.set(key, next);
    const delayMs = Math.min(8000, 1000 * 2 ** (next - 1));
    this.retryBackoffUntil.set(key, Date.now() + delayMs);
  }

  private capSharesByDepth(
    signal: Signal,
    book: OrderBookSide,
    requestedShares: number,
  ): number {
    if (!Number.isFinite(requestedShares) || requestedShares <= 0) return 0;
    const levels = [...book.asks]
      .sort((a, b) => a.price - b.price)
      .filter((l) => l.price <= signal.maxPrice)
      .slice(0, 3);
    if (levels.length === 0) return 0;
    const topDepth = levels.reduce((s, l) => s + Math.max(0, l.size), 0);
    const participationCap = topDepth * 0.6;
    return Math.max(0, Math.min(requestedShares, participationCap));
  }

  private passesCostFloor(signal: Signal, ctx: MarketContext): boolean {
    if (signal.strategy !== "arb" && signal.strategy !== "efficiency") {
      return true;
    }
    const feeBps = effectiveFeeRate(signal.maxPrice) * 10_000;
    const slippageReserveBps = 8;
    const totalCostBps = feeBps * 2 + slippageReserveBps;

    let expectedEdgeBps = 0;
    if (signal.strategy === "efficiency") {
      const m = /profit=([0-9]+)bps/.exec(signal.reason);
      expectedEdgeBps = m ? Number(m[1]) : 0;
    } else {
      const binance = ctx.prices["binance"];
      if (binance && ctx.oracleEstimate > 0) {
        expectedEdgeBps =
          Math.abs((binance.price - ctx.oracleEstimate) / ctx.oracleEstimate) * 10_000;
      }
    }

    return expectedEdgeBps >= totalCostBps;
  }

  private didTradeWin(trade: TradeRecord): boolean {
    const btcPrice =
      trade.closingBtcPrice ??
      this.windowEndPriceSnapshot ??
      this.feedManager.getCurrentBtcPrice();
    const priceToBeat = trade.priceToBeatAtEntry;
    if (priceToBeat <= 0 || btcPrice <= 0) return false;

    const btcWentUp = btcPrice >= priceToBeat;
    return trade.side === "UP" ? btcWentUp : !btcWentUp;
  }

  // ── Public API ──

  getStrategyStates(): StrategyState[] {
    return Object.values(this.strategies).map((s) => s.getState());
  }

  getOrderBookState(): OrderBookState {
    return this.orderBook;
  }

  getCurrentWindow(): MarketWindow | null {
    return this.currentWindow;
  }

  getWindowTitle(): string {
    return this.windowTitle;
  }

  get tradingActive(): boolean {
    return this._tradingActive;
  }

  setTradingActive(active: boolean): void {
    this._tradingActive = active;
    console.log(`[Engine] Trading ${active ? "STARTED" : "STOPPED"}`);
    this.emit("tradingActive", active);
  }

  get mode(): "live" | "shadow" {
    return this._mode;
  }

  setMode(mode: "live" | "shadow"): void {
    this._mode = mode;
    console.log(`[Engine] Mode switched to ${mode.toUpperCase()}`);
    this.emit("mode", mode);
  }

  getRegime(): RegimeState {
    return {
      volatilityRegime: this._regime.volatilityRegime,
      trendRegime: this._regime.trendRegime,
      liquidityRegime: this._regime.liquidityRegime,
      spreadRegime: this._regime.spreadRegime,
      volatilityValue: this._regime.volatilityValue ?? 0,
      trendStrength: this._regime.trendStrength ?? 0,
      liquidityDepth: this._regime.liquidityDepth ?? 0,
      spreadValue: this._regime.spreadValue ?? 0,
    };
  }

  getKillSwitchStatus() {
    return this.riskManager.getKillSwitchStatus();
  }

  getRiskSnapshot(): RiskSnapshot {
    return {
      openPositions: this.riskManager.getOpenPositions().length,
      maxConcurrentPositions: config.risk.maxConcurrentPositions,
      openExposure: this.riskManager.getOpenExposure(),
      maxTotalExposure: config.risk.maxTotalExposure,
      dailyPnl: this.riskManager.getDailyPnl(),
      maxDailyLoss: config.risk.maxDailyLoss,
      hourlyPnl: this.riskManager.getHourlyPnl(),
      maxHourlyLoss: config.risk.maxHourlyLoss,
      consecutiveLosses: this.riskManager.getConsecutiveLosses(),
      maxConsecutiveLosses: config.risk.maxConsecutiveLosses,
      windowLosses: this.riskManager.getWindowLosses(),
      maxLossPerWindow: config.risk.maxLossPerWindow,
      pauseRemainingSec: this.riskManager.getPauseRemainingSec(),
    };
  }

  getMetrics(): EngineMetrics {
    return {
      windowConditionId: this.metrics.windowConditionId,
      rolling: this.rollingDiagnostics,
      window: this.windowDiagnostics,
      latency: this.metrics.latency,
      reconciliation: this.buildReconciliationMetrics(),
    };
  }

  private buildReconciliationMetrics() {
    const liveSummary = this.tracker.getSummary(false);
    const shadowSummary = this.tracker.getSummary(true);
    const names = Object.keys(this.strategies);
    const strategies = names.map((strategy) => {
      const live = this.liveModeDiagnostics[strategy] ?? zeroDiagnostics();
      const shadow = this.shadowModeDiagnostics[strategy] ?? zeroDiagnostics();
      const liveSignals = live.signals;
      const shadowSignals = shadow.signals;
      const liveSubmitted = live.submitted;
      const shadowSubmitted = shadow.submitted;
      const liveFillRate =
        liveSubmitted > 0
          ? (live.fullFill + live.partialFill) / liveSubmitted
          : 0;
      const shadowFillRate =
        shadowSubmitted > 0
          ? (shadow.fullFill + shadow.partialFill) / shadowSubmitted
          : 0;
      const liveRejectRate =
        liveSignals > 0
          ? (live.riskRejected + live.liveRejected) / liveSignals
          : 0;
      const shadowRejectRate =
        shadowSignals > 0
          ? (shadow.riskRejected + shadow.queueMiss + shadow.liquidityFail) /
            shadowSignals
          : 0;
      const livePnl = liveSummary.byStrategy[strategy]?.pnl ?? 0;
      const shadowPnl = shadowSummary.byStrategy[strategy]?.pnl ?? 0;
      return {
        strategy,
        liveSignals,
        shadowSignals,
        liveSubmitted,
        shadowSubmitted,
        liveFillRate,
        shadowFillRate,
        liveRejectRate,
        shadowRejectRate,
        livePnl,
        shadowPnl,
        signalDelta: liveSignals - shadowSignals,
        fillRateDelta: liveFillRate - shadowFillRate,
        pnlDelta: livePnl - shadowPnl,
      };
    });
    return {
      updatedAt: Date.now(),
      liveTotalTrades: liveSummary.totalTrades,
      shadowTotalTrades: shadowSummary.totalTrades,
      liveWinRate: liveSummary.winRate,
      shadowWinRate: shadowSummary.winRate,
      liveTotalPnl: liveSummary.totalPnl,
      shadowTotalPnl: shadowSummary.totalPnl,
      strategies,
    };
  }

  resetKillSwitchPause(): void {
    this.riskManager.resetPause();
  }

  toggleStrategy(name: string): boolean {
    const strategy = this.strategies[name as keyof typeof this.strategies];
    if (!strategy) return false;
    strategy.enabled = !strategy.enabled;
    this.persistStrategyState();
    this.emit("strategies", this.getStrategyStates());
    return strategy.enabled;
  }

  updateStrategyConfig(
    name: string,
    cfg: Record<string, unknown>,
  ): "ok" | "not_found" | "invalid" {
    const strategy = this.strategies[name as keyof typeof this.strategies];
    if (!strategy) return "not_found";
    const valid = strategy.updateConfig(cfg);
    if (valid) {
      this.persistStrategyState();
      this.emit("strategies", this.getStrategyStates());
    }
    return valid ? "ok" : "invalid";
  }

  updateStrategyRegimeFilter(
    name: string,
    filter: Record<string, unknown>,
  ): "ok" | "not_found" {
    const strategy = this.strategies[name as keyof typeof this.strategies];
    if (!strategy) return "not_found";
    strategy.updateRegimeFilter(filter as any);
    this.persistStrategyState();
    this.emit("strategies", this.getStrategyStates());
    return "ok";
  }
}

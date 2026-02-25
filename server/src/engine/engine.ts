import { Effect, Ref, Schedule } from "effect";
import { FileSystem } from "@effect/platform";
import { AppConfig } from "../config.js";
import { FeedService } from "../feeds/manager.js";
import { MarketService, formatWindowTitle } from "../polymarket/markets.js";
import { OrderService, calculateFeeStatic, effectiveFeeRateStatic } from "../polymarket/orders.js";
import { PolymarketClient } from "../polymarket/client.js";
import { AutoRedeemer } from "../polymarket/redeemer.js";
import { RiskManager } from "./risk.js";
import { PnLTracker } from "./tracker.js";
import { FillSimulator, type SimulatorOpts } from "./fill-simulator.js";
import { PositionSizer } from "./position-sizer.js";
import { RegimeDetector } from "./regime-detector.js";
import { preflightShadowBuy } from "./shadow-preflight.js";
import { EventBus } from "./event-bus.js";
import { makeArbStrategy } from "../strategies/arb.js";
import { makeEfficiencyStrategy } from "../strategies/efficiency.js";
import { makeWhaleHuntStrategy } from "../strategies/whale-hunt.js";
import { makeMomentumStrategy } from "../strategies/momentum.js";
import type { Strategy } from "../strategies/base.js";
import { shouldRunInRegime } from "../strategies/base.js";
import type {
  MarketWindow,
  MarketContext,
  OrderBookState,
  StrategyState,
  Signal,
  TradeRecord,
  RegimeState,
  StrategyDiagnostics,
  EngineMetrics,
  OrderBookSide,
  RiskSnapshot,
  EngineEvent,
  EntryContext,
} from "../types.js";

let tradeCounter = 0;

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

const SHADOW_SIM_OPTS_BY_STRATEGY: Record<string, SimulatorOpts> = {
  arb: { slippageBps: 4, fillProbability: 0.78, minLiquidityPct: 0.08 },
  efficiency: { slippageBps: 3, fillProbability: 0.82, minLiquidityPct: 0.1 },
  "whale-hunt": { slippageBps: 6, fillProbability: 0.75, minLiquidityPct: 0.08 },
  momentum: { slippageBps: 7, fillProbability: 0.86, minLiquidityPct: 0.05 },
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function adjustMomentumMaxPrice(signal: Signal, regime: RegimeState, ctx: MarketContext): number {
  const base = signal.maxPrice;
  if (signal.strategy !== "momentum") return base;

  let allowance = 0;
  if (regime.trendRegime === "strong_up" || regime.trendRegime === "strong_down") allowance += 0.05;
  else if (regime.trendRegime === "up" || regime.trendRegime === "down") allowance += 0.03;

  if (signal.confidence >= 0.75) allowance += 0.02;
  if (ctx.windowRemainingMs <= 120_000) allowance += 0.02;

  if (regime.liquidityRegime === "thin") allowance -= 0.02;
  if (regime.spreadRegime === "blowout") allowance -= 0.03;

  return Math.round(clamp(base + allowance, 0.5, 0.78) * 1000) / 1000;
}

function zeroDiagnostics(): StrategyDiagnostics {
  return {
    signals: 0, riskRejected: 0, liveRejected: 0, dynamicWindowUsed: 0,
    earlyEntryAccepted: 0, earlyEntryRejected: 0, probabilityRejected: 0,
    submitted: 0, queueMiss: 0, liquidityFail: 0, lowFillCancel: 0, partialFill: 0, fullFill: 0,
    wins: 0, losses: 0,
  };
}

function emptyReconciliation() {
  return {
    updatedAt: 0, liveTotalTrades: 0, shadowTotalTrades: 0,
    liveWinRate: 0, shadowWinRate: 0, liveTotalPnl: 0, shadowTotalPnl: 0,
    strategies: [],
  };
}

interface EngineState {
  currentWindow: MarketWindow | null;
  windowTitle: string;
  orderBook: OrderBookState;
  running: boolean;
  tradingActive: boolean;
  tickInFlight: boolean;
  mode: "live" | "shadow";
  regime: RegimeState;
  inFlightByCondition: Map<string, number>;
  retryBackoffUntil: Map<string, number>;
  retryBackoffCount: Map<string, number>;
  lastSignalFingerprint: Map<string, string>;
  lastStrategyExecution: Map<string, number>;
  entriesThisWindow: Map<string, number>;
  windowSideByStrategy: Map<string, "UP" | "DOWN">;
  lastOrderbookUpdateTs: number;
  windowEndPriceSnapshot: number | null;
  windowEndSnapshotTs: number;
  recentSignalLatencies: number[];
  windowDiagnostics: Record<string, StrategyDiagnostics>;
  rollingDiagnostics: Record<string, StrategyDiagnostics>;
  liveModeDiagnostics: Record<string, StrategyDiagnostics>;
  shadowModeDiagnostics: Record<string, StrategyDiagnostics>;
  metrics: EngineMetrics;
  lastPoll: number;
  efficiencyIncidentBlocked: boolean;
}

function initialEngineState(mode: "live" | "shadow"): EngineState {
  return {
    currentWindow: null,
    windowTitle: "",
    orderBook: {
      up: { bids: [], asks: [] }, down: { bids: [], asks: [] },
      bestAskUp: null, bestAskDown: null, bestBidUp: null, bestBidDown: null,
    },
    running: false,
    tradingActive: false,
    tickInFlight: false,
    mode,
    regime: {
      volatilityRegime: "normal", trendRegime: "chop",
      liquidityRegime: "normal", spreadRegime: "normal",
      volatilityValue: 0, trendStrength: 0, liquidityDepth: 0, spreadValue: 0,
    },
    inFlightByCondition: new Map(),
    retryBackoffUntil: new Map(),
    retryBackoffCount: new Map(),
    lastSignalFingerprint: new Map(),
    lastStrategyExecution: new Map(),
    entriesThisWindow: new Map(),
    windowSideByStrategy: new Map(),
    lastOrderbookUpdateTs: 0,
    windowEndPriceSnapshot: null,
    windowEndSnapshotTs: 0,
    recentSignalLatencies: [],
    windowDiagnostics: {},
    rollingDiagnostics: {},
    liveModeDiagnostics: {},
    shadowModeDiagnostics: {},
    metrics: {
      windowConditionId: null, rolling: {}, window: {},
      latency: {
        lastSignalToSubmitMs: 0, avgSignalToSubmitMs: 0, avgRecentSignalToSubmitMs: 0,
        samples: 0, lastSampleAt: 0, priceDataAgeMs: 0, orderbookAgeMs: 0,
      },
      reconciliation: emptyReconciliation(),
    },
    lastPoll: 0,
    efficiencyIncidentBlocked: false,
  };
}

export class TradingEngine extends Effect.Service<TradingEngine>()("TradingEngine", {
  scoped: Effect.gen(function* () {
    const config = yield* AppConfig;
    const feedService = yield* FeedService;
    const marketService = yield* MarketService;
    const orderService = yield* OrderService;
    const polyClient = yield* PolymarketClient;
    const riskManager = yield* RiskManager;
    const tracker = yield* PnLTracker;
    const fillSimulator = yield* FillSimulator;
    const positionSizer = yield* PositionSizer;
    const regimeDetector = yield* RegimeDetector;
    const eventBus = yield* EventBus;
    const fs = yield* FileSystem.FileSystem;

    const arb = yield* makeArbStrategy;
    const efficiency = yield* makeEfficiencyStrategy;
    const whaleHunt = yield* makeWhaleHuntStrategy;
    const momentumResult = yield* makeMomentumStrategy;
    const momentum = momentumResult;

    const strategies: Strategy[] = [arb, efficiency, whaleHunt, momentum];
    const strategyMap = new Map<string, Strategy>(strategies.map((s) => [s.name, s]));

    const stateRef = yield* Ref.make<EngineState>(initialEngineState(config.trading.mode));

    for (const s of strategies) {
      yield* Ref.update(stateRef, (st) => {
        st.windowDiagnostics[s.name] = zeroDiagnostics();
        st.rollingDiagnostics[s.name] = zeroDiagnostics();
        st.liveModeDiagnostics[s.name] = zeroDiagnostics();
        st.shadowModeDiagnostics[s.name] = zeroDiagnostics();
        return st;
      });
    }

    const emit = (event: EngineEvent) => eventBus.publish(event);

    const bumpDiag = (st: EngineState, strategy: string, key: keyof StrategyDiagnostics, delta: number, isShadowMode?: boolean) => {
      if (!st.windowDiagnostics[strategy]) st.windowDiagnostics[strategy] = zeroDiagnostics();
      if (!st.rollingDiagnostics[strategy]) st.rollingDiagnostics[strategy] = zeroDiagnostics();
      st.windowDiagnostics[strategy]![key] += delta;
      st.rollingDiagnostics[strategy]![key] += delta;
      if (typeof isShadowMode === "boolean") {
        const modeDiag = isShadowMode ? st.shadowModeDiagnostics : st.liveModeDiagnostics;
        if (!modeDiag[strategy]) modeDiag[strategy] = zeroDiagnostics();
        modeDiag[strategy]![key] += delta;
      }
    };

    const recordSignalLatency = (st: EngineState, ms: number) => {
      const lat = st.metrics.latency;
      lat.lastSignalToSubmitMs = ms;
      const total = lat.avgSignalToSubmitMs * lat.samples + ms;
      lat.samples += 1;
      lat.avgSignalToSubmitMs = total / lat.samples;
      lat.lastSampleAt = Date.now();
      st.recentSignalLatencies.push(ms);
      if (st.recentSignalLatencies.length > 20) st.recentSignalLatencies = st.recentSignalLatencies.slice(-20);
      lat.avgRecentSignalToSubmitMs = st.recentSignalLatencies.reduce((s, v) => s + v, 0) / st.recentSignalLatencies.length;
    };

    const recomputeReconciliation = Effect.gen(function* () {
      const [liveTrades, shadowTrades] = yield* Effect.all([
        tracker.getAllTradeRecords(false),
        tracker.getAllTradeRecords(true),
      ]);
      const liveResolved = liveTrades.filter((t) => t.status === "resolved");
      const shadowResolved = shadowTrades.filter((t) => t.status === "resolved");
      const liveWins = liveResolved.filter((t) => t.outcome === "win").length;
      const shadowWins = shadowResolved.filter((t) => t.outcome === "win").length;
      const strategyNames = strategies.map((s) => s.name);
      const byStrategy = strategyNames.map((strategy) => {
        const ls = liveTrades.filter((t) => t.strategy === strategy);
        const ss = shadowTrades.filter((t) => t.strategy === strategy);
        const lsResolved = ls.filter((t) => t.status === "resolved");
        const ssResolved = ss.filter((t) => t.status === "resolved");
        const liveSubmitted = ls.filter((t) => t.status !== "pending").length;
        const shadowSubmitted = ss.filter((t) => t.status !== "pending").length;
        const liveFilled = ls.filter((t) => t.status === "filled" || t.status === "partial" || t.status === "resolved").length;
        const shadowFilled = ss.filter((t) => t.status === "filled" || t.status === "partial" || t.status === "resolved").length;
        const liveRejected = ls.filter((t) => t.status === "cancelled" || t.status === "rejected").length;
        const shadowRejected = ss.filter((t) => t.status === "cancelled" || t.status === "rejected").length;
        const livePnl = lsResolved.reduce((acc, t) => acc + t.pnl, 0);
        const shadowPnl = ssResolved.reduce((acc, t) => acc + t.pnl, 0);
        const liveFillRate = liveSubmitted > 0 ? liveFilled / liveSubmitted : 0;
        const shadowFillRate = shadowSubmitted > 0 ? shadowFilled / shadowSubmitted : 0;
        const liveRejectRate = liveSubmitted > 0 ? liveRejected / liveSubmitted : 0;
        const shadowRejectRate = shadowSubmitted > 0 ? shadowRejected / shadowSubmitted : 0;
        return {
          strategy,
          liveSignals: ls.length,
          shadowSignals: ss.length,
          liveSubmitted,
          shadowSubmitted,
          liveFillRate,
          shadowFillRate,
          liveRejectRate,
          shadowRejectRate,
          livePnl,
          shadowPnl,
          signalDelta: ls.length - ss.length,
          fillRateDelta: liveFillRate - shadowFillRate,
          pnlDelta: livePnl - shadowPnl,
        };
      });

      yield* Ref.update(stateRef, (s) => ({
        ...s,
        metrics: {
          ...s.metrics,
          reconciliation: {
            updatedAt: Date.now(),
            liveTotalTrades: liveResolved.length,
            shadowTotalTrades: shadowResolved.length,
            liveWinRate: liveResolved.length > 0 ? (liveWins / liveResolved.length) * 100 : 0,
            shadowWinRate: shadowResolved.length > 0 ? (shadowWins / shadowResolved.length) * 100 : 0,
            liveTotalPnl: liveResolved.reduce((acc, t) => acc + t.pnl, 0),
            shadowTotalPnl: shadowResolved.reduce((acc, t) => acc + t.pnl, 0),
            strategies: byStrategy,
          },
        },
      }));
    });

    const reconcileSubmittedLiveOrders = Effect.gen(function* () {
      const openTrades = yield* tracker.getOpenTrades(false);
      for (const trade of openTrades) {
        if (trade.status !== "submitted" || !trade.clobOrderId) continue;
        const status = yield* orderService.getOrderStatusById(trade.clobOrderId);
        if (!status.mappedStatus || status.mappedStatus === "submitted") continue;

        if (status.mappedStatus === "cancelled" || status.mappedStatus === "rejected") {
          const eventType = status.mappedStatus === "rejected" ? "order_rejected" : "cancel";
          yield* tracker.liveStore.appendEvent(trade.id, eventType, {
            orderId: trade.clobOrderId,
            result: status.rawStatus ?? status.mappedStatus,
            reason: status.reason ?? `Order ${status.mappedStatus}`,
          });
          const updated = yield* tracker.getTradeRecordById(trade.id, false);
          if (updated) {
            yield* emit({ _tag: "Trade", data: updated });
            yield* Ref.update(stateRef, (s) => {
              bumpDiag(s, updated.strategy, "liveRejected", 1, false);
              return s;
            });
          }
          continue;
        }

        const fullTrade = yield* tracker.getTradeById(trade.id, false);
        if (!fullTrade) continue;
        const cumulativeFilled = status.filledShares ?? fullTrade.requestedShares;
        const deltaShares = Math.max(0, cumulativeFilled - fullTrade.filledShares);
        const price = (status.avgPrice ?? fullTrade.avgFillPrice) || trade.avgFillPrice || 0;
        const fee = deltaShares > 0 ? calculateFeeStatic(deltaShares, price) : 0;

        if (status.mappedStatus === "partial") {
          if (deltaShares <= 0) continue;
          yield* tracker.liveStore.appendEvent(trade.id, "partial_fill", {
            shares: deltaShares,
            price,
            fee,
            orderId: trade.clobOrderId,
            result: status.rawStatus ?? "partial",
            reason: status.reason ?? undefined,
          });
        } else if (status.mappedStatus === "filled") {
          yield* tracker.liveStore.appendEvent(trade.id, "fill", {
            shares: deltaShares,
            price,
            fee,
            orderId: trade.clobOrderId,
            result: status.rawStatus ?? "filled",
            reason: status.reason ?? undefined,
          });
        }

        const updated = yield* tracker.getTradeRecordById(trade.id, false);
        if (updated) {
          if (trade.status === "submitted" && (updated.status === "partial" || updated.status === "filled")) {
            yield* riskManager.onTradeOpened(updated);
          }
          yield* emit({ _tag: "Trade", data: updated });
        }
      }
    });

    const didTradeWin = (trade: TradeRecord, st: EngineState, currentBtcPrice: number) => {
      const btcPrice = trade.closingBtcPrice ?? st.windowEndPriceSnapshot ?? currentBtcPrice;
      const ptb = trade.priceToBeatAtEntry;
      if (ptb <= 0 || btcPrice <= 0) return false;
      return trade.side === "UP" ? btcPrice >= ptb : btcPrice < ptb;
    };

    const refreshOrderBook = (window: MarketWindow) =>
      Effect.gen(function* () {
        if (!window.upTokenId || !window.downTokenId) return;
        const [upBook, downBook] = yield* Effect.all([
          orderService.getOrderBook(window.upTokenId),
          orderService.getOrderBook(window.downTokenId),
        ]);
        if (!upBook && !downBook) return;

        yield* Ref.update(stateRef, (st) => {
          const ob = { ...st.orderBook };
          if (upBook) {
            const ub = upBook as any;
            ob.up = {
              bids: (ub.bids ?? []).map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
              asks: (ub.asks ?? []).map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) })),
            };
            ob.bestAskUp = ob.up.asks.length > 0 ? Math.min(...ob.up.asks.map((a) => a.price)) : null;
            ob.bestBidUp = ob.up.bids.length > 0 ? Math.max(...ob.up.bids.map((b) => b.price)) : null;
          }
          if (downBook) {
            const db = downBook as any;
            ob.down = {
              bids: (db.bids ?? []).map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
              asks: (db.asks ?? []).map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) })),
            };
            ob.bestAskDown = ob.down.asks.length > 0 ? Math.min(...ob.down.asks.map((a) => a.price)) : null;
            ob.bestBidDown = ob.down.bids.length > 0 ? Math.max(...ob.down.bids.map((b) => b.price)) : null;
          }
          return { ...st, orderBook: ob, lastOrderbookUpdateTs: Date.now() };
        });
        const s = yield* Ref.get(stateRef);
        yield* emit({ _tag: "OrderBook", data: s.orderBook });
      }).pipe(Effect.catchAll(() => Effect.void));

    const pollMarkets = Effect.gen(function* () {
      yield* Ref.update(stateRef, (st) => ({ ...st, lastPoll: Date.now() }));
      const current = yield* marketService.fetchCurrentBtc5mWindow;
      const st = yield* Ref.get(stateRef);

      if (current && current.conditionId !== st.currentWindow?.conditionId) {
        let ptb = current.priceToBeat;
        if (ptb === null) {
          const openPrice = yield* feedService.getCurrentBtcPrice;
          if (openPrice > 0) {
            ptb = openPrice;
            yield* Effect.logWarning(`[Engine] priceToBeat not in market metadata — using local feed $${openPrice.toFixed(2)}`);
          }
        }
        const updatedWindow: MarketWindow = { ...current, priceToBeat: ptb };
        const title = current.title ?? formatWindowTitle(current);
        yield* Effect.log(`[Engine] New window: ${title} | Price to beat: $${ptb?.toFixed(2) ?? "unknown"}`);

        yield* Ref.update(stateRef, (s) => ({
          ...s,
          currentWindow: updatedWindow,
          windowTitle: title,
          entriesThisWindow: new Map(),
          windowSideByStrategy: new Map(),
          windowEndPriceSnapshot: null,
          windowEndSnapshotTs: 0,
          inFlightByCondition: new Map(),
          retryBackoffUntil: new Map(),
          retryBackoffCount: new Map(),
          metrics: { ...s.metrics, windowConditionId: current.conditionId },
          windowDiagnostics: Object.fromEntries(strategies.map((s) => [s.name, zeroDiagnostics()])),
        }));
        yield* riskManager.onNewWindow(current.conditionId);
        yield* emit({ _tag: "Market", data: updatedWindow });
      }

      const afterSt = yield* Ref.get(stateRef);
      const connected = yield* polyClient.isConnected;
      if (afterSt.currentWindow && (connected || afterSt.mode === "shadow")) {
        yield* refreshOrderBook(afterSt.currentWindow);
      }
    }).pipe(Effect.catchAll((err) => Effect.logError(`[Engine] Market poll error: ${err}`)));

    const tick = Effect.gen(function* () {
      const st = yield* Ref.get(stateRef);
      if (!st.running || st.tickInFlight) return;
      yield* Ref.update(stateRef, (s) => ({ ...s, tickInFlight: true }));

      yield* tickInner.pipe(
        Effect.withSpan("Engine.tick"),
        Effect.ensuring(Ref.update(stateRef, (s) => ({ ...s, tickInFlight: false }))),
      );
    });

    const tickInner = Effect.gen(function* () {
      const st = yield* Ref.get(stateRef);
      const isShadow = st.mode === "shadow";
      const now = Date.now();
      const liveBtcPrice = yield* feedService.getCurrentBtcPrice;
      const connected = yield* polyClient.isConnected;

      if (st.currentWindow && liveBtcPrice > 0 && now >= st.currentWindow.endTime - 5_000) {
        if (st.windowEndPriceSnapshot === null || (now <= st.currentWindow.endTime + 2_000 && liveBtcPrice > 0)) {
          yield* Ref.update(stateRef, (s) => ({ ...s, windowEndPriceSnapshot: liveBtcPrice, windowEndSnapshotTs: now }));
        }
      }

      const sNow = yield* Ref.get(stateRef);
      const closingBtcPrice = sNow.windowEndPriceSnapshot && sNow.windowEndPriceSnapshot > 0
        ? sNow.windowEndPriceSnapshot : liveBtcPrice;

      // Resolve expired trades
      const expired = yield* riskManager.resolveExpired(now);
      for (const trade of expired) {
        if (closingBtcPrice <= 0) {
          yield* Effect.logWarning(`[Engine] Skipping resolution of ${trade.id} — no valid settlement price`);
          continue;
        }
        const tradeShadow = trade.id.startsWith("shadow-");
        yield* tracker.expireTrade(trade.id, closingBtcPrice, tradeShadow);
        trade.closingBtcPrice = closingBtcPrice;
        const won = didTradeWin(trade, sNow, liveBtcPrice);
        yield* tracker.resolveTrade(trade.id, won, tradeShadow);
        const resolved = yield* tracker.getTradeRecordById(trade.id, tradeShadow);
        if (resolved) {
          trade.status = "resolved";
          trade.outcome = resolved.outcome;
          trade.pnl = resolved.pnl;
        } else {
          trade.status = "resolved";
          trade.outcome = won ? "win" : "loss";
          trade.pnl = 0;
        }
        for (const s of strategies) {
          yield* s.onTrade(trade);
        }
        yield* Ref.update(stateRef, (stUpd) => {
          bumpDiag(stUpd, trade.strategy, trade.outcome === "win" ? "wins" : "losses", 1, tradeShadow);
          return stUpd;
        });
        yield* riskManager.onTradeClosed(trade, tradeShadow);
        yield* emit({ _tag: "Trade", data: trade });
      }

      if (!isShadow && connected) {
        yield* reconcileSubmittedLiveOrders;
      }

      if (!sNow.currentWindow) {
        yield* emitTick(isShadow);
        return;
      }

      if (now >= sNow.currentWindow.endTime) {
        yield* emitTick(isShadow);
        return;
      }

      const prices = yield* feedService.getLatestPrices;
      const oracleEst = yield* feedService.getOracleEstimate;
      const oracleTs = yield* feedService.getOracleTimestamp;
      const currentBtc = yield* feedService.getCurrentBtcPrice;
      const currentOB = (yield* Ref.get(stateRef)).orderBook;
      const latestPriceTs = Object.values(prices).reduce((max, p) => Math.max(max, p.timestamp), 0);
      yield* Ref.update(stateRef, (s) => ({
        ...s,
        metrics: {
          ...s.metrics,
          latency: {
            ...s.metrics.latency,
            priceDataAgeMs: latestPriceTs > 0 ? now - latestPriceTs : -1,
            orderbookAgeMs: s.lastOrderbookUpdateTs > 0 ? now - s.lastOrderbookUpdateTs : -1,
          },
        },
      }));

      const ctx: MarketContext = {
        currentWindow: sNow.currentWindow,
        orderBook: currentOB,
        prices,
        oracleEstimate: oracleEst,
        oracleTimestamp: oracleTs,
        windowElapsedMs: now - sNow.currentWindow.startTime,
        windowRemainingMs: sNow.currentWindow.endTime - now,
        priceToBeat: sNow.currentWindow.priceToBeat,
        currentBtcPrice: currentBtc,
      };

      yield* regimeDetector.update(ctx);
      const regime = yield* regimeDetector.getRegime;
      yield* Ref.update(stateRef, (s) => ({ ...s, regime }));

      if (!isShadow && !connected) {
        yield* emitTick(isShadow);
        return;
      }

      // Evaluate strategies
      for (const strategy of strategies) {
        const sState = yield* Ref.get(strategy.stateRef);
        if (!sState.enabled) continue;

        const sCurrent = yield* Ref.get(stateRef);
        if (!sCurrent.tradingActive) continue;
        if (strategy.name === "efficiency" && sCurrent.efficiencyIncidentBlocked) {
          yield* Ref.update(strategy.stateRef, (s) => ({
            ...s,
            status: "regime_blocked" as const,
            statusReason: "Blocked: unresolved efficiency dual-leg incident",
          }));
          continue;
        }

        const regimeCheck = shouldRunInRegime(sState.regimeFilter, regime);
        if (!regimeCheck.allowed) {
          yield* Ref.update(strategy.stateRef, (s) => ({
            ...s, status: "regime_blocked" as const, statusReason: regimeCheck.reason,
          }));
          continue;
        }

        const cooldownMs = STRATEGY_COOLDOWN_MS[strategy.name] ?? 3000;
        const lastExec = sCurrent.lastStrategyExecution.get(strategy.name) ?? 0;
        if (now - lastExec < cooldownMs) continue;

        const maxEntries = MAX_ENTRIES_PER_WINDOW[strategy.name] ?? 2;
        const entries = sCurrent.entriesThisWindow.get(strategy.name) ?? 0;
        if (entries >= maxEntries) continue;

        const signal = yield* strategy.evaluate(ctx);
        if (!signal) continue;

        if (signal.strategy === "momentum") {
          signal.maxPrice = adjustMomentumMaxPrice(signal, regime, ctx);
        }

        yield* Ref.update(stateRef, (stUpd) => {
          bumpDiag(stUpd, strategy.name, "signals", 1, isShadow);
          return stUpd;
        });

        const configuredTradeSize = signal.size;
        const recentPrices = yield* feedService.getRecentPrices(300_000, "binance");
        const computedSize = positionSizer.computeSize(signal, recentPrices);
        const alignedSize = Math.min(computedSize, config.risk.maxTradeSize);
        signal.size = Math.round(alignedSize * 100) / 100;

        const posSlots = signal.strategy === "efficiency" ? 2 : 1;
        const check = yield* riskManager.approve(signal, ctx, posSlots);
        if (!check.approved) {
          yield* Ref.update(stateRef, (stUpd) => {
            bumpDiag(stUpd, strategy.name, "riskRejected", 1, isShadow);
            return stUpd;
          });
          yield* Effect.log(`[Engine] Risk rejected ${signal.strategy}: ${check.reason}`);
          continue;
        }

        const riskSnap = yield* riskManager.getSnapshot;
        const entryContext: EntryContext = {
          strategyName: strategy.name,
          mode: isShadow ? "shadow" : "live",
          regime: { ...regime },
          strategyConfig: { ...sState.config },
          regimeFilter: { ...sState.regimeFilter },
          signal: {
            side: signal.side,
            confidence: signal.confidence,
            reason: signal.reason,
            maxPrice: signal.maxPrice,
            timestamp: signal.timestamp,
            telemetry: signal.telemetry ? { ...signal.telemetry } : undefined,
          },
          window: {
            conditionId: ctx.currentWindow?.conditionId ?? "",
            windowStart: ctx.currentWindow?.startTime ?? 0,
            windowEnd: ctx.currentWindow?.endTime ?? 0,
            priceToBeat: ctx.priceToBeat,
          },
          microstructure: {
            bestAskUp: ctx.orderBook.bestAskUp,
            bestAskDown: ctx.orderBook.bestAskDown,
            bestBidUp: ctx.orderBook.bestBidUp,
            bestBidDown: ctx.orderBook.bestBidDown,
            oracleEstimate: ctx.oracleEstimate,
            currentBtcPrice: ctx.currentBtcPrice,
          },
          riskAtEntry: {
            openPositions: riskSnap.openPositions,
            openExposure: riskSnap.openExposure,
            dailyPnl: riskSnap.dailyPnl,
            hourlyPnl: riskSnap.hourlyPnl,
            consecutiveLosses: riskSnap.consecutiveLosses,
          },
          sizing: {
            configuredTradeSize,
            computedSize,
            finalNotional: signal.size,
          },
        };

        yield* Ref.update(stateRef, (s) => {
          s.lastStrategyExecution.set(strategy.name, now);
          return s;
        });

        const executed = yield* executeStrategy(signal, isShadow, ctx, entryContext);
        if (executed) {
          yield* Ref.update(stateRef, (s) => {
            s.entriesThisWindow.set(strategy.name, (s.entriesThisWindow.get(strategy.name) ?? 0) + 1);
            s.windowSideByStrategy.set(strategy.name, signal.side);
            return s;
          });
        }
      }

      yield* emitTick(isShadow);
    });

    const emitTick = (isShadow: boolean) =>
      Effect.gen(function* () {
        const now = Date.now();
        const stBefore = yield* Ref.get(stateRef);
        if (now - stBefore.metrics.reconciliation.updatedAt > 5_000) {
          yield* recomputeReconciliation;
        }
        const stratStates = yield* Effect.all(strategies.map((s) => s.getState));
        yield* emit({ _tag: "Strategies", data: stratStates });
        const livePnl = yield* tracker.getSummary(false);
        yield* emit({ _tag: "Pnl", data: livePnl });
        const shadowPnl = yield* tracker.getSummary(true);
        yield* emit({ _tag: "ShadowPnl", data: shadowPnl });
        const regime = (yield* Ref.get(stateRef)).regime;
        yield* emit({ _tag: "Regime", data: regime });
        const killSwitch = yield* riskManager.getKillSwitchStatus;
        yield* emit({ _tag: "KillSwitch", data: killSwitch });
        const risk = yield* riskManager.getSnapshot;
        yield* emit({ _tag: "Risk", data: risk });
        const st = yield* Ref.get(stateRef);
        yield* emit({
          _tag: "Metrics",
          data: { ...st.metrics, rolling: st.rollingDiagnostics, window: st.windowDiagnostics },
        });
      });

    const executeStrategy = (signal: Signal, shadow: boolean, ctx: MarketContext, entryCtx: EntryContext) =>
      Effect.gen(function* () {
        const st = yield* Ref.get(stateRef);
        if (!st.currentWindow) return false;
        const conditionId = st.currentWindow.conditionId;
        const ptb = st.currentWindow.priceToBeat ?? 0;

        if (shadow) {
          return yield* executeShadow(signal, conditionId, ptb, ctx, entryCtx);
        }
        return yield* executeLive(signal, conditionId, ptb, entryCtx);
      });

    const executeShadow = (signal: Signal, conditionId: string, ptb: number, ctx: MarketContext, entryCtx: EntryContext) =>
      Effect.gen(function* () {
        const st = yield* Ref.get(stateRef);
        if (!st.currentWindow) return false;

        const tokenId = signal.side === "UP" ? st.currentWindow.upTokenId : st.currentWindow.downTokenId;
        const notional = signal.size;
        const book = signal.side === "UP" ? st.orderBook.up : st.orderBook.down;
        const preflight = preflightShadowBuy(notional, signal.maxPrice, book);
        if (!preflight.allowed) {
          yield* Ref.update(stateRef, (s) => {
            bumpDiag(s, signal.strategy, "liquidityFail", 1, true);
            return s;
          });
          yield* Effect.log(
            `[Shadow] ${signal.strategy} ${signal.side} skipped: ${preflight.reason}`,
          );
          return false;
        }

        const shares = Math.floor(preflight.requestedShares * 100) / 100;

        const simOpts = SHADOW_SIM_OPTS_BY_STRATEGY[signal.strategy];
        const result = fillSimulator.simulate("BUY", tokenId, shares, signal.maxPrice, book, simOpts);

        const tradeId = `shadow-${++tradeCounter}-${Date.now()}`;
        const signalToSubmitMs = Math.max(0, Date.now() - signal.timestamp);

        yield* tracker.shadowStore.createTrade({
          id: tradeId, conditionId, strategy: signal.strategy, side: signal.side,
          tokenId, priceToBeatAtEntry: ptb, windowEnd: st.currentWindow.endTime,
          shadow: true, size: notional, requestedShares: shares,
          entryContext: entryCtx,
        });
        yield* tracker.shadowStore.appendEvent(tradeId, "signal_generated", {
          conditionId, strategy: signal.strategy, side: signal.side, tokenId,
          priceToBeatAtEntry: ptb, windowEnd: st.currentWindow.endTime,
          shadow: true, size: notional, requestedShares: shares,
          entryContext: entryCtx,
        });
        yield* tracker.shadowStore.appendEvent(tradeId, "order_submitted", { shares, price: signal.maxPrice });
        const submittedRecord = yield* tracker.getTradeRecordById(tradeId, true);
        if (submittedRecord) {
          (submittedRecord as any).shadow = true;
          yield* emit({ _tag: "Trade", data: submittedRecord });
        }

        yield* Ref.update(stateRef, (s) => {
          bumpDiag(s, signal.strategy, "submitted", 1, true);
          recordSignalLatency(s, signalToSubmitMs);
          return s;
        });

        if (!result.filled) {
          yield* tracker.shadowStore.appendEvent(tradeId, "cancel", { reason: result.reason });
          yield* Ref.update(stateRef, (s) => {
            if (result.reason === "queue_position_miss") {
              bumpDiag(s, signal.strategy, "queueMiss", 1, true);
            } else if (result.reason === "insufficient_liquidity" || result.reason === "no_liquidity") {
              bumpDiag(s, signal.strategy, "liquidityFail", 1, true);
            }
            return s;
          });
          const cancelledRecord = yield* tracker.getTradeRecordById(tradeId, true);
          if (cancelledRecord) {
            (cancelledRecord as any).shadow = true;
            yield* emit({ _tag: "Trade", data: cancelledRecord });
          }
          yield* Effect.log(`[Shadow] ${signal.strategy} ${signal.side} cancelled: ${result.reason}`);
          return false;
        }

        const fillRatio = shares > 0 ? result.filledShares / shares : 0;
        const minFill = MIN_FILL_RATIO_BY_STRATEGY[signal.strategy] ?? 0.5;
        if (fillRatio < minFill) {
          yield* tracker.shadowStore.appendEvent(tradeId, "cancel", { reason: "low_fill_ratio", fillRatio, minFillRatio: minFill });
          yield* Ref.update(stateRef, (s) => {
            bumpDiag(s, signal.strategy, "lowFillCancel", 1, true);
            return s;
          });
          const cancelledRecord = yield* tracker.getTradeRecordById(tradeId, true);
          if (cancelledRecord) {
            (cancelledRecord as any).shadow = true;
            yield* emit({ _tag: "Trade", data: cancelledRecord });
          }
          return false;
        }

        if (result.filledShares < shares) {
          yield* tracker.shadowStore.appendEvent(tradeId, "partial_fill", { shares: result.filledShares, price: result.avgPrice, fee: result.fee });
          yield* Ref.update(stateRef, (s) => { bumpDiag(s, signal.strategy, "partialFill", 1, true); return s; });
        } else {
          yield* tracker.shadowStore.appendEvent(tradeId, "fill", { shares: result.filledShares, price: result.avgPrice, fee: result.fee });
          yield* Ref.update(stateRef, (s) => { bumpDiag(s, signal.strategy, "fullFill", 1, true); return s; });
        }

        const record = yield* tracker.getTradeRecordById(tradeId, true);
        if (record) {
          (record as any).shadow = true;
          yield* riskManager.onTradeOpened(record, true);
          yield* emit({ _tag: "Trade", data: record });
        }

        yield* Effect.log(`[Shadow] ${signal.strategy} ${signal.side} filled ${result.filledShares} @ $${result.avgPrice.toFixed(4)}`);
        return true;
      });

    const executeLive = (signal: Signal, conditionId: string, ptb: number, entryCtx: EntryContext) =>
      Effect.gen(function* () {
        const st = yield* Ref.get(stateRef);
        if (!st.currentWindow) return false;

        const signalToSubmitMs = Math.max(0, Date.now() - signal.timestamp);
        yield* Ref.update(stateRef, (s) => { recordSignalLatency(s, signalToSubmitMs); return s; });

        if (signal.strategy === "efficiency") {
          const trades = yield* orderService.executeDualBuy(
            st.currentWindow.upTokenId, st.currentWindow.downTokenId,
            st.orderBook.bestAskUp!, st.orderBook.bestAskDown!,
            signal.size, st.currentWindow.endTime, conditionId, ptb,
          );
          let incident = false;
          for (const trade of trades) {
            trade.entryContext = entryCtx;
            if (trade.strategy === "efficiency-partial") {
              incident = true;
            }
            yield* Ref.update(stateRef, (s) => { bumpDiag(s, signal.strategy, "submitted", 1, false); return s; });
            yield* tracker.addTrade(trade);
            if (trade.status === "filled" || trade.status === "partial") {
              yield* riskManager.onTradeOpened(trade);
              yield* Ref.update(stateRef, (s) => {
                bumpDiag(s, signal.strategy, trade.status === "partial" ? "partialFill" : "fullFill", 1, false);
                return s;
              });
            } else if (trade.status === "cancelled" || trade.status === "rejected") {
              yield* Ref.update(stateRef, (s) => {
                bumpDiag(s, signal.strategy, "liveRejected", 1, false);
                return s;
              });
            }
            yield* emit({ _tag: "Trade", data: trade });
          }
          if (incident) {
            yield* Ref.update(stateRef, (s) => ({
              ...s,
              efficiencyIncidentBlocked: true,
              tradingActive: false,
            }));
            yield* emit({ _tag: "TradingActive", data: { tradingActive: false } });
            yield* Effect.logError(
              "[Engine] Efficiency dual-leg incident detected. Trading paused and efficiency strategy blocked until manual restart.",
            );
            return false;
          }
          return trades.some(
            (t) => t.status === "submitted" || t.status === "partial" || t.status === "filled",
          );
        }

        const trade = yield* orderService.executeSignal(
          signal, st.currentWindow.upTokenId, st.currentWindow.downTokenId,
          st.currentWindow.endTime, conditionId, ptb,
        );
        if (trade) {
          trade.entryContext = entryCtx;
          yield* Ref.update(stateRef, (s) => { bumpDiag(s, signal.strategy, "submitted", 1, false); return s; });
          yield* tracker.addTrade(trade);
          if (trade.status === "filled" || trade.status === "partial") {
            yield* riskManager.onTradeOpened(trade);
            yield* Ref.update(stateRef, (s) => {
              bumpDiag(s, signal.strategy, trade.status === "partial" ? "partialFill" : "fullFill", 1, false);
              return s;
            });
          } else if (trade.status === "cancelled" || trade.status === "rejected") {
            yield* Ref.update(stateRef, (s) => { bumpDiag(s, signal.strategy, "liveRejected", 1, false); return s; });
          }
          yield* emit({ _tag: "Trade", data: trade });
          return trade.status === "submitted" || trade.status === "partial" || trade.status === "filled";
        }
        yield* Ref.update(stateRef, (s) => { bumpDiag(s, signal.strategy, "liveRejected", 1, false); return s; });
        return false;
      });

    // Start loops
    yield* Ref.update(stateRef, (s) => ({ ...s, running: true }));

    // Periodically feed latest prices into regime detector and momentum strategy
    yield* Effect.gen(function* () {
      const feedState = yield* feedService.getLatestPrices;
      for (const p of Object.values(feedState)) {
        yield* regimeDetector.addPrice(p);
        yield* momentum.addPrice(p);
      }
    }).pipe(
      Effect.repeat(Schedule.fixed("500 millis")),
      Effect.catchAll(() => Effect.void),
      Effect.forkScoped,
    );

    yield* pollMarkets;

    yield* Effect.gen(function* () {
      const windowId = (yield* Ref.get(stateRef)).currentWindow?.conditionId ?? "";
      const liveTrades = yield* tracker.getAllTradeRecords(false);
      yield* riskManager.rehydrate(liveTrades, windowId);
      const snap = yield* riskManager.getSnapshot;
      yield* Effect.log(
        `[Engine] Risk rehydrated: open=${snap.openPositions}, exposure=$${snap.openExposure.toFixed(2)}, dailyPnl=$${snap.dailyPnl.toFixed(2)}, hourlyPnl=$${snap.hourlyPnl.toFixed(2)}`,
      );
    });

    yield* tick.pipe(
      Effect.repeat(Schedule.fixed("500 millis")),
      Effect.catchAll((err) => Effect.logError(`[Engine] Tick error: ${err}`)),
      Effect.forkScoped,
    );

    yield* pollMarkets.pipe(
      Effect.repeat(Schedule.fixed("3 seconds")),
      Effect.catchAll(() => Effect.void),
      Effect.forkScoped,
    );

    yield* Effect.log(`[Engine] Started in ${config.trading.mode.toUpperCase()} mode`);

    // Public API
    const getStrategyStates = Effect.all(strategies.map((s) => s.getState));

    const getOrderBookState = Ref.get(stateRef).pipe(Effect.map((s) => s.orderBook));
    const getCurrentWindow = Ref.get(stateRef).pipe(Effect.map((s) => s.currentWindow));
    const getWindowTitle = Ref.get(stateRef).pipe(Effect.map((s) => s.windowTitle));

    const isTradingActive = Ref.get(stateRef).pipe(Effect.map((s) => s.tradingActive));
    const setTradingActive = (active: boolean) =>
      Effect.gen(function* () {
        yield* Ref.update(stateRef, (s) => ({
          ...s,
          tradingActive: active,
          efficiencyIncidentBlocked: active ? false : s.efficiencyIncidentBlocked,
        }));
        yield* Effect.log(`[Engine] Trading ${active ? "STARTED" : "STOPPED"}`);
        yield* emit({ _tag: "TradingActive", data: { tradingActive: active } });
      });

    const getMode = Ref.get(stateRef).pipe(Effect.map((s) => s.mode));
    const setMode = (mode: "live" | "shadow") =>
      Effect.gen(function* () {
        yield* Ref.update(stateRef, (s) => ({ ...s, mode }));
        yield* Effect.log(`[Engine] Mode switched to ${mode.toUpperCase()}`);
        yield* emit({ _tag: "Mode", data: { mode } });
      });

    const getRegime = Ref.get(stateRef).pipe(Effect.map((s) => s.regime));

    const getRiskSnapshot = riskManager.getSnapshot;
    const getKillSwitchStatus = riskManager.getKillSwitchStatus;
    const resetKillSwitchPause = riskManager.resetPause;

    const getMetrics: Effect.Effect<EngineMetrics> = Ref.get(stateRef).pipe(
      Effect.map((s) => ({
        windowConditionId: s.metrics.windowConditionId,
        rolling: s.rollingDiagnostics,
        window: s.windowDiagnostics,
        latency: s.metrics.latency,
        reconciliation: s.metrics.reconciliation,
      })),
    );

    const toggleStrategy = (name: string) =>
      Effect.gen(function* () {
        const s = strategyMap.get(name);
        if (!s) return false;
        const current = yield* Ref.get(s.stateRef);
        yield* s.setEnabled(!current.enabled);
        const states = yield* getStrategyStates;
        yield* emit({ _tag: "Strategies", data: states });
        return !current.enabled;
      });

    const updateStrategyConfig = (name: string, cfg: Record<string, unknown>) =>
      Effect.gen(function* () {
        const s = strategyMap.get(name);
        if (!s) return { status: "not_found" as const };
        const result = yield* s.updateConfig(cfg);
        if (result.ok) {
          const states = yield* getStrategyStates;
          yield* emit({ _tag: "Strategies", data: states });
        }
        return result.ok
          ? { status: "ok" as const }
          : {
              status: "invalid" as const,
              error: result.error ?? "Invalid config values",
              appliedKeys: result.appliedKeys,
              rejectedKeys: result.rejectedKeys,
            };
      });

    const updateStrategyRegimeFilter = (name: string, filter: Record<string, unknown>) =>
      Effect.gen(function* () {
        const s = strategyMap.get(name);
        if (!s) return "not_found" as const;
        yield* s.updateRegimeFilter(filter as any);
        const states = yield* getStrategyStates;
        yield* emit({ _tag: "Strategies", data: states });
        return "ok" as const;
      });

    return {
      tracker,
      getStrategyStates,
      getOrderBookState,
      getCurrentWindow,
      getWindowTitle,
      isTradingActive,
      setTradingActive,
      getMode,
      setMode,
      getRegime,
      getRiskSnapshot,
      getKillSwitchStatus,
      resetKillSwitchPause,
      getMetrics,
      toggleStrategy,
      updateStrategyConfig,
      updateStrategyRegimeFilter,
    } as const;
  }),
}) {}

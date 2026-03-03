import { Effect, Ref, Schedule, Option } from "effect";
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
import {
  adjustMomentumMaxPrice,
  initialEngineState,
  type EngineState,
  zeroDiagnostics,
} from "./state.js";
import { makeSnapshotEmitter } from "./snapshot-emitter.js";
import { makeAccountReconciler } from "./account-reconciliation.js";
import { makeMarketPoller } from "./window-manager.js";
import { makeExecutionHandlers } from "./execution.js";
import { makeStrategyRunner } from "./strategy-runner.js";
import { AccountActivityStore } from "../activity/store.js";
import { CriticalIncidentStore } from "../incident/store.js";
import { PostgresStorage } from "../storage/postgres.js";
import { ObservabilityStore } from "../observability/store.js";
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

const STRATEGY_COOLDOWN_MS: Record<string, number> = {
  arb: 3000,
  efficiency: 5000,
  "whale-hunt": 6000,
  momentum: 4000,
};

const MAX_ENTRIES_PER_WINDOW: Record<string, number> = {
  arb: 2,
  efficiency: 1,
  "whale-hunt": 1,
  momentum: 2, // fallback: 1 UP + 1 DOWN. Overridden by sState.config["maxEntriesPerWindow"].
};

// Strategies in this set split their entry budget evenly across UP and DOWN directions.
// Per-side limit = Math.ceil(totalMax / 2), so:
//   totalMax=2 → 1 per side | totalMax=4 → 2 per side | totalMax=3 → 2 per side (total caps at 3)
const PER_SIDE_STRATEGIES = new Set(["momentum"]);

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

const STRATEGY_STATE_DIR = "data";
const STRATEGY_STATE_FILE = "data/strategy-state.json";

interface PersistedStrategyStateEntry {
  enabled?: boolean;
  config?: Record<string, unknown>;
  regimeFilter?: Record<string, unknown>;
}

type PersistedStrategyState = Record<string, PersistedStrategyStateEntry>;

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
    const activityStore = yield* AccountActivityStore;
    const incidentStore = yield* CriticalIncidentStore;
    const observabilityOpt = yield* Effect.serviceOption(ObservabilityStore);
    const observability = Option.getOrUndefined(observabilityOpt);
    const postgresOpt = yield* Effect.serviceOption(PostgresStorage);
    const postgres = Option.getOrUndefined(postgresOpt);
    const fs = yield* FileSystem.FileSystem;
    const useFileStorage = config.storage.backend === "file" || config.storage.backend === "dual";
    const usePostgresStorage =
      !!postgres && (config.storage.backend === "postgres" || config.storage.backend === "dual");

    const arb = yield* makeArbStrategy;
    const efficiency = yield* makeEfficiencyStrategy;
    const whaleHunt = yield* makeWhaleHuntStrategy;
    const momentumResult = yield* makeMomentumStrategy;
    const momentum = momentumResult;

    const strategies: Strategy[] = [arb, efficiency, whaleHunt, momentum];
    const strategyMap = new Map<string, Strategy>(strategies.map((s) => [s.name, s]));

    const readPersistedStrategyState = Effect.gen(function* () {
      const fromDb: PersistedStrategyState = {};
      if (usePostgresStorage) {
        const rows = yield* postgres!.query<{ strategy_name: string; payload: unknown }>(
          "select strategy_name, payload from strategy_state",
        ).pipe(Effect.catchAll(() => Effect.succeed([])));
        for (const row of rows) {
          if (typeof row.strategy_name === "string" && row.strategy_name.length > 0) {
            fromDb[row.strategy_name] =
              row.payload && typeof row.payload === "object" ? (row.payload as PersistedStrategyStateEntry) : {};
          }
        }
      }
      const fromFile: PersistedStrategyState = {};
      if (useFileStorage) {
        const exists = yield* fs.exists(STRATEGY_STATE_FILE);
        if (exists) {
          const raw = yield* fs.readFileString(STRATEGY_STATE_FILE);
          const parsed = yield* Effect.try({
            try: () => JSON.parse(raw),
            catch: (err) => new Error(String(err)),
          });
          if (parsed && typeof parsed === "object") {
            Object.assign(fromFile, parsed as PersistedStrategyState);
          }
        }
      }
      return {
        ...fromFile,
        ...fromDb,
      } as PersistedStrategyState;
    }).pipe(
      Effect.catchAll((err) =>
        Effect.logError(`[Engine] Failed to load strategy state from ${STRATEGY_STATE_FILE}: ${String(err)}`).pipe(
          Effect.as({} as PersistedStrategyState),
        ),
      ),
    );

    const persistStrategyStates = Effect.gen(function* () {
      const entries = yield* Effect.forEach(strategies, (strategy) =>
        Ref.get(strategy.stateRef).pipe(
          Effect.map((state) => [
            strategy.name,
            {
              enabled: state.enabled,
              config: { ...state.config },
              regimeFilter: { ...state.regimeFilter },
            } satisfies PersistedStrategyStateEntry,
          ] as const),
        ),
      );

      const payload = Object.fromEntries(entries) as PersistedStrategyState;
      if (useFileStorage) {
        yield* fs.makeDirectory(STRATEGY_STATE_DIR, { recursive: true }).pipe(
          Effect.catchAll(() => Effect.void),
        );
        yield* fs.writeFileString(STRATEGY_STATE_FILE, JSON.stringify(payload, null, 2));
      }
      if (usePostgresStorage) {
        yield* Effect.forEach(
          Object.entries(payload),
          ([name, entry]) =>
            postgres!.execute(
              `insert into strategy_state (strategy_name, payload, updated_at_ms)
               values ($1, $2::jsonb, $3)
               on conflict (strategy_name) do update set payload = excluded.payload, updated_at_ms = excluded.updated_at_ms`,
              [name, JSON.stringify(entry ?? {}), Date.now()],
            ).pipe(Effect.catchAll(() => Effect.void)),
          { discard: true },
        );
      }
    });

    const applyPersistedStrategyState = (persisted: PersistedStrategyState) =>
      Effect.forEach(strategies, (strategy) =>
        Effect.gen(function* () {
          const entry = persisted[strategy.name];
          if (!entry || typeof entry !== "object") return;

          if (typeof entry.enabled === "boolean") {
            yield* strategy.setEnabled(entry.enabled);
          }

          if (entry.config && typeof entry.config === "object") {
            const result = yield* strategy.updateConfig(entry.config);
            if (!result.ok) {
              yield* Effect.logWarning(
                `[Engine] Persisted config for ${strategy.name} was invalid: ${result.error ?? "Invalid config values"}`,
              );
            }
          }

          if (entry.regimeFilter && typeof entry.regimeFilter === "object") {
            yield* strategy.updateRegimeFilter(entry.regimeFilter as any);
          }
        }),
      ).pipe(Effect.asVoid);

    const persistedStrategyState = yield* readPersistedStrategyState;
    yield* applyPersistedStrategyState(persistedStrategyState);
    yield* persistStrategyStates;

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
    const obs = (
      input: Parameters<NonNullable<typeof observability>["append"]>[0],
    ) =>
      observability
        ? observability.append(input).pipe(Effect.catchAll(() => Effect.void))
        : Effect.void;

    const haltTradingWithIncident = (incident: {
      kind: "unmatched_account_fill" | "oversize_account_fill" | "efficiency_partial_incident" | "reconciler_error";
      message: string;
      fingerprint: string;
      details: Record<string, unknown>;
    }) =>
      Effect.gen(function* () {
        const created = yield* incidentStore.create({
          kind: incident.kind,
          severity: "critical",
          message: incident.message,
          fingerprint: incident.fingerprint,
          details: incident.details,
        });
        yield* Ref.update(stateRef, (s) => ({ ...s, tradingActive: false }));
        yield* emit({ _tag: "TradingActive", data: { tradingActive: false } });
        yield* emit({ _tag: "CriticalIncident", data: created });
        yield* obs({
          category: "incident",
          source: "engine",
          action: "trading_halted_by_incident",
          entityType: "incident",
          entityId: created.id,
          status: "critical",
          mode: null,
          payload: {
            kind: created.kind,
            message: created.message,
            details: created.details,
          },
        });
        yield* Effect.logError(`[Engine] CRITICAL INCIDENT: ${created.kind} - ${created.message}`);
      });

    const runAccountReconciliation = makeAccountReconciler({
      maxTradeSize: config.risk.maxTradeSize,
      listRecentOrders: (sinceMs, limit) => orderService.listRecentOrders(sinceMs, limit),
      listLiveTrades: (args) => tracker.listTrades(args),
      listActivity: (args) => activityStore.list(args),
      obs,
      haltTradingWithIncident,
    }).pipe(
      Effect.catchAll((err) =>
        obs({
          category: "risk",
          source: "reconciler",
          action: "reconciler_error",
          entityType: "system",
          entityId: "account_reconciler",
          status: "error",
          mode: "live",
          payload: { error: String(err) },
        }).pipe(
          Effect.zipRight(
            haltTradingWithIncident({
              kind: "reconciler_error",
              message: `Account reconciler failed: ${String(err)}`,
              fingerprint: `reconciler-error:${String(err)}`,
              details: { error: String(err) },
            }),
          ),
        ),
      ),
    );

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
        const liveWins = lsResolved.filter((t) => t.outcome === "win").length;
        const shadowWins = ssResolved.filter((t) => t.outcome === "win").length;
        const liveWinRate = lsResolved.length > 0 ? (liveWins / lsResolved.length) * 100 : 0;
        const shadowWinRate = ssResolved.length > 0 ? (shadowWins / ssResolved.length) * 100 : 0;
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
          liveWinRate,
          shadowWinRate,
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

    const didTradeWin = (trade: TradeRecord, st: EngineState, currentAssetPrice: number) => {
      const assetPrice = trade.closingAssetPrice ?? st.windowEndPriceSnapshot ?? currentAssetPrice;
      const ptb = trade.priceToBeatAtEntry;
      if (ptb <= 0 || assetPrice <= 0) return false;
      return trade.side === "UP" ? assetPrice >= ptb : assetPrice < ptb;
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

    const pollMarkets = makeMarketPoller({
      stateRef,
      strategies,
      fetchCurrentWindow: marketService.fetchCurrentBtc5mWindow,
      fetchCurrentAssetPrice: feedService.getCurrentAssetPrice,
      isConnected: polyClient.isConnected,
      onNewWindow: (conditionId) => riskManager.onNewWindow(conditionId),
      emit,
      obs,
      refreshOrderBook,
      formatWindowTitle,
    });

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
      if (!isShadow && now - st.lastReconcileAt >= 15_000) {
        yield* runAccountReconciliation;
        yield* Ref.update(stateRef, (s) => ({ ...s, lastReconcileAt: Date.now() }));
      }
      const liveAssetPrice = yield* feedService.getCurrentAssetPrice;
      const connected = yield* polyClient.isConnected;

      if (st.currentWindow && liveAssetPrice > 0 && now >= st.currentWindow.endTime - 5_000) {
        if (st.windowEndPriceSnapshot === null || (now <= st.currentWindow.endTime + 2_000 && liveAssetPrice > 0)) {
          yield* Ref.update(stateRef, (s) => ({ ...s, windowEndPriceSnapshot: liveAssetPrice, windowEndSnapshotTs: now }));
        }
      }

      const sNow = yield* Ref.get(stateRef);
      const closingAssetPrice = sNow.windowEndPriceSnapshot && sNow.windowEndPriceSnapshot > 0
        ? sNow.windowEndPriceSnapshot : liveAssetPrice;

      // Resolve expired trades for both live and shadow books.
      // Risk manager only tracks live exposure, so shadow expiries must
      // come from the tracker directly to avoid stuck "active" shadow trades.
      const [openLiveTrades, openShadowTrades] = yield* Effect.all([
        tracker.getOpenTrades(false),
        tracker.getOpenTrades(true),
      ]);
      const expired = [...openLiveTrades, ...openShadowTrades].filter(
        (trade) =>
          (trade.status === "filled" || trade.status === "partial") &&
          now >= trade.windowEnd,
      );
      for (const trade of expired) {
        if (closingAssetPrice <= 0) {
          yield* Effect.logWarning(`[Engine] Skipping resolution of ${trade.id} — no valid settlement price`);
          continue;
        }
        const tradeShadow = trade.shadow === true;
        const tradeRecord = yield* tracker.getTradeRecordById(trade.id, tradeShadow);
        if (!tradeRecord) continue;
        yield* tracker.expireTrade(trade.id, closingAssetPrice, tradeShadow);
        const settlement = yield* marketService.fetchSettlementByCondition(trade.conditionId).pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        );
        const hasVenueWinner = settlement?.resolved === true && settlement.winnerSide !== null;
        const won = hasVenueWinner
          ? trade.side === settlement!.winnerSide
          : didTradeWin(
            { ...tradeRecord, closingAssetPrice },
            sNow,
            liveAssetPrice,
          );
        const outcomeSource: "venue" | "estimated" = hasVenueWinner ? "venue" : "estimated";
        yield* tracker.resolveTrade(trade.id, won, tradeShadow, {
          outcomeSource,
          settlementWinnerSide: settlement?.winnerSide ?? null,
        });
        const resolved =
          (yield* tracker.getTradeRecordById(trade.id, tradeShadow)) ?? {
            ...tradeRecord,
            status: "resolved" as const,
            outcome: won ? ("win" as const) : ("loss" as const),
            resolutionSource: outcomeSource,
            settlementWinnerSide: settlement?.winnerSide ?? null,
            pnl: 0,
            closingAssetPrice,
          };
        for (const s of strategies) {
          yield* s.onTrade(resolved);
        }
        yield* Ref.update(stateRef, (stUpd) => {
          bumpDiag(
            stUpd,
            resolved.strategy,
            resolved.outcome === "win" ? "wins" : "losses",
            1,
            tradeShadow,
          );
          return stUpd;
        });
        yield* riskManager.onTradeClosed(resolved, tradeShadow);
        yield* emit({ _tag: "Trade", data: resolved });
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
      const currentAsset = yield* feedService.getCurrentAssetPrice;
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
        currentAssetPrice: currentAsset,
        marketId: "btc",
      };

      yield* regimeDetector.update(ctx);
      const regime = yield* regimeDetector.getRegime;
      yield* Ref.update(stateRef, (s) => ({ ...s, regime }));

      if (!isShadow && !connected) {
        yield* emitTick(isShadow);
        return;
      }

      yield* runStrategies(ctx, regime, isShadow, now);

      yield* emitTick(isShadow);
    });

    const emitTick = makeSnapshotEmitter({
      stateRef,
      strategies,
      emit,
      recomputeReconciliation,
      getLiveSummary: tracker.getSummary(false),
      getShadowSummary: tracker.getSummary(true),
      getKillSwitchStatus: riskManager.getKillSwitchStatus,
      getRiskSnapshot: riskManager.getSnapshot,
    });

    const { executeStrategy } = makeExecutionHandlers({
      stateRef,
      minFillRatioByStrategy: MIN_FILL_RATIO_BY_STRATEGY,
      shadowSimOptsByStrategy: SHADOW_SIM_OPTS_BY_STRATEGY,
      fillSimulator,
      tracker,
      orderService,
      riskManager,
      emit,
      bumpDiag,
      recordSignalLatency,
      haltTradingWithIncident,
    });

    const runStrategies = makeStrategyRunner({
      stateRef,
      strategies,
      strategyCooldownMs: STRATEGY_COOLDOWN_MS,
      maxEntriesPerWindow: MAX_ENTRIES_PER_WINDOW,
      perSideStrategies: PER_SIDE_STRATEGIES,
      maxTradeSize: config.risk.maxTradeSize,
      getRecentPrices: (windowMs, source) => feedService.getRecentPrices(windowMs, source),
      computeSize: (signal, recentPrices, winRate) => positionSizer.computeSize(signal, recentPrices, winRate),
      approveRisk: (signal, ctx, posSlots) => riskManager.approve(signal, ctx, posSlots),
      getRiskSnapshot: riskManager.getSnapshot,
      executeStrategy,
      adjustMomentumMaxPrice: (signal, regime, ctx, config) =>
        adjustMomentumMaxPrice(signal, regime, ctx, config),
      bumpDiag,
      obs,
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

    yield* Effect.gen(function* () {
      const windowId = (yield* Ref.get(stateRef)).currentWindow?.conditionId ?? "";
      const liveTrades = yield* tracker.getAllTradeRecords(false);
      yield* riskManager.rehydrate(liveTrades, windowId);
      const snap = yield* riskManager.getSnapshot;
      yield* Effect.log(
        `[Engine] Risk rehydrated: open=${snap.openPositions}, exposure=$${snap.openExposure.toFixed(2)}, dailyPnl=$${snap.dailyPnl.toFixed(2)}, hourlyPnl=$${snap.hourlyPnl.toFixed(2)}`,
      );

      if (windowId) {
        const windowTrades = liveTrades.filter((t) => t.conditionId === windowId);
        const restoredEntries = new Map<string, number>();
        for (const t of windowTrades) {
          restoredEntries.set(t.strategy, (restoredEntries.get(t.strategy) ?? 0) + 1);
          if (PER_SIDE_STRATEGIES.has(t.strategy)) {
            const sideKey = `${t.strategy}:${t.side}`;
            restoredEntries.set(sideKey, (restoredEntries.get(sideKey) ?? 0) + 1);
          }
        }
        yield* Ref.update(stateRef, (s) => ({ ...s, entriesThisWindow: restoredEntries }));
        yield* Effect.log(
          `[Engine] Restored entriesThisWindow from ${windowTrades.length} existing trades: ${JSON.stringify(Object.fromEntries(restoredEntries))}`,
        );
      }
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
        yield* obs({
          category: "operator",
          source: "engine",
          action: active ? "trading_started" : "trading_stopped",
          entityType: "system",
          entityId: "trading_active",
          status: active ? "active" : "inactive",
          mode: null,
          payload: { tradingActive: active },
        });
      });

    const getMode = Ref.get(stateRef).pipe(Effect.map((s) => s.mode));
    const setMode = (mode: "live" | "shadow") =>
      Effect.gen(function* () {
        yield* Ref.update(stateRef, (s) => ({ ...s, mode }));
        yield* Effect.log(`[Engine] Mode switched to ${mode.toUpperCase()}`);
        yield* emit({ _tag: "Mode", data: { mode } });
        yield* obs({
          category: "operator",
          source: "engine",
          action: "mode_changed",
          entityType: "system",
          entityId: "engine_mode",
          status: mode,
          mode,
          payload: { mode },
        });
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
        yield* persistStrategyStates;
        const states = yield* getStrategyStates;
        yield* emit({ _tag: "Strategies", data: states });
        yield* obs({
          category: "operator",
          source: "engine",
          action: "strategy_toggled",
          entityType: "strategy",
          entityId: name,
          status: !current.enabled ? "enabled" : "disabled",
          strategy: name,
          mode: null,
          payload: { enabled: !current.enabled },
        });
        return !current.enabled;
      });

    const updateStrategyConfig = (name: string, cfg: Record<string, unknown>) =>
      Effect.gen(function* () {
        const s = strategyMap.get(name);
        if (!s) return { status: "not_found" as const };
        const result = yield* s.updateConfig(cfg);
        if (result.ok) {
          yield* persistStrategyStates;
          const states = yield* getStrategyStates;
          yield* emit({ _tag: "Strategies", data: states });
          yield* obs({
            category: "operator",
            source: "engine",
            action: "strategy_config_updated",
            entityType: "strategy",
            entityId: name,
            status: "ok",
            strategy: name,
            mode: null,
            payload: { config: cfg },
          });
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
        yield* persistStrategyStates;
        const states = yield* getStrategyStates;
        yield* emit({ _tag: "Strategies", data: states });
        yield* obs({
          category: "operator",
          source: "engine",
          action: "strategy_regime_filter_updated",
          entityType: "strategy",
          entityId: name,
          status: "ok",
          strategy: name,
          mode: null,
          payload: { regimeFilter: filter },
        });
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

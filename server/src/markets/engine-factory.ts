/**
 * Standalone market engine factory.
 *
 * Creates a self-contained MarketEngineInstance for any asset (XRP, ETH, …).
 * Each instance has its own feeds, market poller, risk manager, trade stores,
 * strategies, and regime detector. It shares stateless services (FillSimulator,
 * PositionSizer) and stateful shared services (OrderService, PolymarketClient,
 * EventBus, CriticalIncidentStore) from the calling context.
 */

import { Effect, Ref, Schedule, Scope } from "effect";
import { FileSystem } from "@effect/platform";
import type { MarketAssetConfig } from "./registry.js";
import type { MarketEngineInstance } from "./market-engine.js";
import type { AppConfigShape } from "../config.js";
import { createFeedsForMarket } from "../feeds/feed-factory.js";
import { createMarketFeedManager } from "../feeds/market-feed-manager.js";
import { createMarketPoller } from "../polymarket/markets.js";
import { createRiskManager } from "../engine/risk.js";
import { makeTradeStore, toTradeRecord } from "../engine/trade-store.js";
import { makeMarketPoller } from "../engine/window-manager.js";
import { makeExecutionHandlers } from "../engine/execution.js";
import { makeStrategyRunner } from "../engine/strategy-runner.js";
import { makeSnapshotEmitter } from "../engine/snapshot-emitter.js";
import {
  initialEngineState,
  zeroDiagnostics,
  adjustMomentumMaxPrice,
} from "../engine/state.js";
import { createRegimeDetector } from "../engine/regime-detector.js";
import { makeArbStrategy } from "../strategies/arb.js";
import { makeEfficiencyStrategy } from "../strategies/efficiency.js";
import { makeWhaleHuntStrategy } from "../strategies/whale-hunt.js";
import { makeMomentumStrategy } from "../strategies/momentum.js";
import { makeOrderFlowImbalanceStrategy } from "../strategies/orderflow-imbalance.js";
import {
  mergeWhaleHuntConfig,
  toWhaleHuntStrategyConfig,
} from "../strategies/whale-hunt-config.js";
import type { Strategy } from "../strategies/base.js";
import { calculateFeeStatic } from "../polymarket/orders.js";
import type {
  EngineEvent,
  MarketContext,
  MarketWindow,
  TradeRecord,
  StrategyDiagnostics,
} from "../types.js";
import type { TradeListQuery, TradeListResult } from "../engine/tracker.js";
import type { ObservabilityEventInput } from "../observability/store.js";

// ── Strategy constants (mirrored from engine.ts) ─────────────────────────────

const STRATEGY_COOLDOWN_MS: Record<string, number> = {
  arb: 3000,
  efficiency: 5000,
  "whale-hunt": 6000,
  momentum: 4000,
  "orderflow-imbalance": 4500,
};

const MAX_ENTRIES_PER_WINDOW: Record<string, number> = {
  arb: 2,
  efficiency: 1,
  "whale-hunt": 1,
  momentum: 2,
  "orderflow-imbalance": 1,
};

const PER_SIDE_STRATEGIES = new Set(["momentum"]);

const MIN_FILL_RATIO_BY_STRATEGY: Record<string, number> = {
  arb: 0.5,
  efficiency: 0.6,
  "whale-hunt": 0.5,
  momentum: 0.5,
  "orderflow-imbalance": 0.5,
};

const SHADOW_SIM_OPTS_BY_STRATEGY: Record<string, { slippageBps: number; fillProbability: number; minLiquidityPct: number }> = {
  arb: { slippageBps: 4, fillProbability: 0.78, minLiquidityPct: 0.08 },
  efficiency: { slippageBps: 3, fillProbability: 0.82, minLiquidityPct: 0.1 },
  "whale-hunt": { slippageBps: 6, fillProbability: 0.75, minLiquidityPct: 0.08 },
  momentum: { slippageBps: 7, fillProbability: 0.86, minLiquidityPct: 0.05 },
  "orderflow-imbalance": { slippageBps: 5, fillProbability: 0.82, minLiquidityPct: 0.08 },
};

const STRATEGY_FACTORIES: Record<string, Effect.Effect<Strategy>> = {
  arb: makeArbStrategy,
  efficiency: makeEfficiencyStrategy,
  "whale-hunt": makeWhaleHuntStrategy,
  momentum: makeMomentumStrategy,
  "orderflow-imbalance": makeOrderFlowImbalanceStrategy,
};

// ── Cursor helpers (mirrors tracker.ts) ──────────────────────────────────────

function encodeCursor(t: TradeRecord): string {
  return Buffer.from(JSON.stringify({ ts: t.timestamp, id: t.id }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { ts: number; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { ts: unknown; id: unknown };
    if (typeof parsed.ts === "number" && Number.isFinite(parsed.ts) && typeof parsed.id === "string" && parsed.id.length > 0) {
      return { ts: parsed.ts, id: parsed.id };
    }
  } catch { /* ignore */ }
  return null;
}

function sortTradesDesc(a: TradeRecord, b: TradeRecord): number {
  if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
  return b.id.localeCompare(a.id);
}

// ── Shared deps interface ─────────────────────────────────────────────────────

export interface StandaloneEngineSharedDeps {
  config: AppConfigShape;
  orderService: {
    getOrderBook: (tokenId: string) => Effect.Effect<any, any, never>;
    getOrderStatusById: (orderId: string) => Effect.Effect<any, any, never>;
    executeSignal: (...args: any[]) => Effect.Effect<any, any, never>;
    executeDualBuy: (...args: any[]) => Effect.Effect<any[], any, never>;
  };
  polyClient: {
    isConnected: Effect.Effect<boolean, never, never>;
  };
  eventBus: {
    publish: (event: EngineEvent) => Effect.Effect<void, never, never>;
  };
  fillSimulator: {
    simulate: (
      side: "BUY" | "SELL",
      tokenId: string,
      requestedShares: number,
      limitPrice: number,
      orderBook: any,
      opts?: any,
    ) => { filled: boolean; filledShares: number; avgPrice: number; fee: number; reason?: string };
  };
  positionSizer: {
    computeSize: (signal: any, recentPrices: any, winRate?: number) => number;
  };
  incidentStore: {
    create: (input: any) => Effect.Effect<any, any, never>;
  };
  observability?: {
    append: (input: ObservabilityEventInput) => Effect.Effect<void, any, never>;
  };
  postgres?: {
    query: <T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]) => Effect.Effect<T[], any, never>;
    execute: (text: string, values?: unknown[]) => Effect.Effect<void, any, never>;
  };
}

// ── Main factory ──────────────────────────────────────────────────────────────

export function createStandaloneMarketEngine(
  marketConfig: MarketAssetConfig,
  shared: StandaloneEngineSharedDeps,
): Effect.Effect<MarketEngineInstance, never, FileSystem.FileSystem | Scope.Scope> {
  // TypeScript can struggle to infer the combined R type from a complex Effect.gen body,
  // so we double-cast to assert the correct requirement set.
  return Effect.gen(function* () {
    const { config, orderService, polyClient, eventBus, fillSimulator, positionSizer, incidentStore, observability, postgres } = shared;
    const marketId = marketConfig.id;
    const DATA_DIR = "data";
    const STRATEGY_STATE_FILE = `data/${marketId}-strategy-state.json`;
    const fs = yield* FileSystem.FileSystem;
    const useFileStorage = config.storage.backend === "file" || config.storage.backend === "dual";
    const usePostgresStorage = !!postgres && (config.storage.backend === "postgres" || config.storage.backend === "dual");

    yield* Effect.log(`[Engine:${marketId}] Initializing standalone engine`);

    // ── Per-market feeds ────────────────────────────────────────────────────

    const { streams, names } = createFeedsForMarket(marketConfig.feeds);
    const feedManager = yield* createMarketFeedManager(marketId, streams, names);

    // ── Per-market market poller ────────────────────────────────────────────

    const marketPoller = yield* createMarketPoller(marketConfig.slugPrefix, marketConfig.windowTitlePrefix);

    // ── Per-market risk manager ─────────────────────────────────────────────

    const riskConfig = marketConfig.riskOverrides
      ? { ...config.risk, ...marketConfig.riskOverrides }
      : config.risk;
    const riskManager = yield* createRiskManager(riskConfig, marketId);

    // ── Per-market trade stores ─────────────────────────────────────────────

    const liveStore = yield* makeTradeStore(false, marketId);
    const shadowStore = yield* makeTradeStore(true, marketId);

    // ── Inline tracker ──────────────────────────────────────────────────────

    const getStoreFor = (shadow: boolean) => (shadow ? shadowStore : liveStore);

    const addTrade = (trade: TradeRecord) =>
      Effect.gen(function* () {
        const shadow = (trade as any).shadow === true;
        const s = getStoreFor(shadow);
        const existing = yield* s.getTrade(trade.id);
        if (existing) return;
        yield* s.createTrade({
          id: trade.id,
          conditionId: trade.conditionId,
          strategy: trade.strategy,
          side: trade.side,
          tokenId: trade.tokenId,
          priceToBeatAtEntry: trade.priceToBeatAtEntry,
          windowEnd: trade.windowEnd,
          shadow,
          size: trade.size,
          requestedShares: trade.shares,
          clobOrderId: trade.clobOrderId,
          clobResult: trade.clobResult,
          clobReason: trade.clobReason,
          entryContext: trade.entryContext,
        });
        yield* s.appendEvent(trade.id, "signal_generated", {
          conditionId: trade.conditionId, strategy: trade.strategy, side: trade.side,
          tokenId: trade.tokenId, priceToBeatAtEntry: trade.priceToBeatAtEntry,
          windowEnd: trade.windowEnd, shadow, size: trade.size,
          requestedShares: trade.shares, entryContext: trade.entryContext,
        });
        if (trade.status === "filled") {
          yield* s.appendEvent(trade.id, "fill", { shares: trade.shares, price: trade.entryPrice, fee: trade.fee, orderId: trade.clobOrderId, result: trade.clobResult, reason: trade.clobReason });
        } else if (trade.status === "partial") {
          yield* s.appendEvent(trade.id, "partial_fill", { shares: trade.shares, price: trade.entryPrice, fee: trade.fee, orderId: trade.clobOrderId, result: trade.clobResult ?? "partial", reason: trade.clobReason });
        } else if (trade.status === "rejected") {
          yield* s.appendEvent(trade.id, "order_rejected", { shares: trade.shares, price: trade.entryPrice, orderId: trade.clobOrderId, result: trade.clobResult ?? "rejected", reason: trade.clobReason ?? "Order rejected by venue" });
        } else {
          yield* s.appendEvent(trade.id, "order_submitted", { shares: trade.shares, price: trade.entryPrice, orderId: trade.clobOrderId, result: trade.clobResult, reason: trade.clobReason });
        }
      });

    const resolveTrade = (id: string, won: boolean, shadow = false, details?: { outcomeSource?: "venue" | "estimated"; settlementWinnerSide?: "UP" | "DOWN" | null }) =>
      getStoreFor(shadow).appendEvent(id, "resolved", {
        won,
        outcomeSource: details?.outcomeSource ?? "estimated",
        settlementWinnerSide: details?.settlementWinnerSide ?? null,
      });

    const expireTrade = (id: string, closingAssetPrice: number, shadow = false) =>
      getStoreFor(shadow).appendEvent(id, "expired", { closingAssetPrice });

    const getOpenTrades = (shadow = false) => getStoreFor(shadow).getOpenTrades;

    const getAllTradeRecords = (shadow = false) =>
      Effect.gen(function* () {
        const all = yield* getStoreFor(shadow).getAllTrades;
        return all.map((t) => ({ ...toTradeRecord(t), marketId }));
      });

    const getTradeById = (id: string, shadow = false) => getStoreFor(shadow).getTrade(id);

    const getTradeRecordById = (id: string, shadow = false) =>
      Effect.gen(function* () {
        const trade = yield* getStoreFor(shadow).getTrade(id);
        return trade ? { ...toTradeRecord(trade), marketId } : undefined;
      });

    const listTrades = (query: TradeListQuery = {}): Effect.Effect<TradeListResult> =>
      Effect.gen(function* () {
        const limit = Math.max(1, Math.min(query.limit ?? 100, 1000));
        const mode = query.mode ?? "all";
        const liveAll = yield* liveStore.getAllTrades;
        const shadowAll = yield* shadowStore.getAllTrades;
        let combined: TradeRecord[] = [];
        if (mode === "all" || mode === "live") combined.push(...liveAll.map((t) => ({ ...toTradeRecord(t), marketId })));
        if (mode === "all" || mode === "shadow") combined.push(...shadowAll.map((t) => ({ ...toTradeRecord(t), marketId })));
        if (typeof query.sinceMs === "number" && Number.isFinite(query.sinceMs)) {
          combined = combined.filter((t) => t.timestamp >= query.sinceMs!);
        }
        combined.sort(sortTradesDesc);
        const decodedCursor = query.cursor ? decodeCursor(query.cursor) : null;
        if (decodedCursor) {
          combined = combined.filter(
            (t) => t.timestamp < decodedCursor.ts || (t.timestamp === decodedCursor.ts && t.id.localeCompare(decodedCursor.id) < 0),
          );
        }
        const items = combined.slice(0, limit);
        const hasMore = combined.length > limit;
        const nextCursor = hasMore && items.length > 0 ? encodeCursor(items[items.length - 1]!) : null;
        return { items, hasMore, nextCursor };
      });

    // ── Strategies ──────────────────────────────────────────────────────────

    const strategies: Strategy[] = [];
    for (const name of marketConfig.strategies) {
      const factory = STRATEGY_FACTORIES[name];
      if (factory) {
        strategies.push(yield* factory);
      } else {
        yield* Effect.logWarning(`[Engine:${marketId}] Unknown strategy '${name}' — skipping`);
      }
    }
    const strategyMap = new Map(strategies.map((s) => [s.name, s]));
    const whaleHuntConfig = mergeWhaleHuntConfig(
      config.trading.whaleHunt,
      marketConfig.whaleHuntOverrides,
    );

    // ── Per-market regime detector ──────────────────────────────────────────

    const regimeDetector = yield* createRegimeDetector();

    // ── Engine state ────────────────────────────────────────────────────────

    type PersistedStrategyStateEntry = { enabled?: boolean; config?: Record<string, unknown>; regimeFilter?: Record<string, unknown> };
    type PersistedStrategyState = Record<string, PersistedStrategyStateEntry>;

    const stateRef = yield* Ref.make(initialEngineState(config.trading.mode));
    for (const s of strategies) {
      yield* Ref.update(stateRef, (st) => {
        st.windowDiagnostics[s.name] = zeroDiagnostics();
        st.rollingDiagnostics[s.name] = zeroDiagnostics();
        st.liveModeDiagnostics[s.name] = zeroDiagnostics();
        st.shadowModeDiagnostics[s.name] = zeroDiagnostics();
        return st;
      });
    }

    // ── Strategy state persistence ──────────────────────────────────────────

    const readPersistedStrategyState: Effect.Effect<PersistedStrategyState> = Effect.gen(function* () {
      const fromDb: PersistedStrategyState = {};
      if (usePostgresStorage) {
        const rows = yield* postgres!.query<{ strategy_name: string; payload: unknown }>(
          "select strategy_name, payload from strategy_state where market_id = $1",
          [marketId],
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
        Effect.logError(`[Engine:${marketId}] Failed to load strategy state from ${STRATEGY_STATE_FILE}: ${String(err)}`).pipe(
          Effect.as({} as PersistedStrategyState),
        ),
      ),
    );

    const persistStrategyStates: Effect.Effect<void> = Effect.gen(function* () {
      const entries = yield* Effect.forEach(strategies, (strategy) =>
        Ref.get(strategy.stateRef).pipe(
          Effect.map((state) => [strategy.name, { enabled: state.enabled, config: { ...state.config }, regimeFilter: { ...state.regimeFilter } }] as const),
        ),
      );
      const payload = Object.fromEntries(entries) as PersistedStrategyState;
      if (useFileStorage) {
        yield* fs.makeDirectory(DATA_DIR, { recursive: true }).pipe(Effect.catchAll(() => Effect.void));
        yield* fs.writeFileString(STRATEGY_STATE_FILE, JSON.stringify(payload, null, 2)).pipe(Effect.catchAll(() => Effect.void));
      }
      if (usePostgresStorage) {
        yield* Effect.forEach(
          Object.entries(payload),
          ([name, entry]) =>
            postgres!.execute(
              `insert into strategy_state (market_id, strategy_name, payload, updated_at_ms)
               values ($1, $2, $3::jsonb, $4)
               on conflict (market_id, strategy_name) do update set payload = excluded.payload, updated_at_ms = excluded.updated_at_ms`,
              [marketId, name, JSON.stringify(entry ?? {}), Date.now()],
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
          if (typeof entry.enabled === "boolean") yield* strategy.setEnabled(entry.enabled);
          if (entry.config && typeof entry.config === "object") {
            const result = yield* strategy.updateConfig(entry.config);
            if (!result.ok) {
              yield* Effect.logWarning(`[Engine:${marketId}] Persisted config for ${strategy.name} was invalid: ${result.error ?? "Invalid config values"}`);
            }
          }
          if (entry.regimeFilter && typeof entry.regimeFilter === "object") {
            yield* strategy.updateRegimeFilter(entry.regimeFilter as any);
          }
        }),
      ).pipe(Effect.asVoid);

    const applyWhaleHuntRuntimeConfig = Effect.gen(function* () {
      const strategy = strategyMap.get("whale-hunt");
      if (!strategy) return;
      const result = yield* strategy.updateConfig(toWhaleHuntStrategyConfig(whaleHuntConfig));
      if (!result.ok) {
        yield* Effect.logWarning(
          `[Engine:${marketId}] Failed to apply whale-hunt runtime config: ${result.error ?? "invalid values"}`,
        );
      }
    });

    const persistedStrategyState = yield* readPersistedStrategyState;
    yield* applyPersistedStrategyState(persistedStrategyState);
    yield* applyWhaleHuntRuntimeConfig;
    yield* persistStrategyStates;

    // ── Helper functions ────────────────────────────────────────────────────

    const emit = (event: EngineEvent) => eventBus.publish({ ...event, marketId });

    const obs = (input: ObservabilityEventInput) =>
      observability
        ? observability.append(input).pipe(Effect.catchAll(() => Effect.void))
        : Effect.void;

    const bumpDiag = (
      st: import("../engine/state.js").EngineState,
      strategy: string,
      key: keyof StrategyDiagnostics,
      delta: number,
      isShadowMode?: boolean,
    ) => {
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

    const recordSignalLatency = (st: import("../engine/state.js").EngineState, ms: number) => {
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

    const haltTradingWithIncident = (incident: {
      kind: "unmatched_account_fill" | "oversize_account_fill" | "efficiency_partial_incident" | "reconciler_error";
      message: string;
      fingerprint: string;
      details: Record<string, unknown>;
    }) =>
      Effect.gen(function* () {
        const created = yield* incidentStore.create({ kind: incident.kind, severity: "critical", message: incident.message, fingerprint: incident.fingerprint, details: incident.details });
        yield* Ref.update(stateRef, (s) => ({ ...s, tradingActive: false }));
        yield* emit({ _tag: "TradingActive", data: { tradingActive: false } });
        yield* emit({ _tag: "CriticalIncident", data: created });
        yield* Effect.logError(`[Engine:${marketId}] CRITICAL INCIDENT: ${incident.kind} - ${incident.message}`);
      });

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

    // ── Reconcile submitted live orders ─────────────────────────────────────

    const reconcileSubmittedLiveOrders = Effect.gen(function* () {
      const openTrades = yield* liveStore.getOpenTrades;
      for (const trade of openTrades) {
        if (trade.status !== "submitted" || !trade.clobOrderId) continue;
        const status = yield* orderService.getOrderStatusById(trade.clobOrderId);
        if (!status.mappedStatus || status.mappedStatus === "submitted") continue;

        if (status.mappedStatus === "cancelled" || status.mappedStatus === "rejected") {
          const eventType = status.mappedStatus === "rejected" ? "order_rejected" : "cancel";
          yield* liveStore.appendEvent(trade.id, eventType, {
            orderId: trade.clobOrderId, result: status.rawStatus ?? status.mappedStatus,
            reason: status.reason ?? `Order ${status.mappedStatus}`,
          });
          const updated = yield* getTradeRecordById(trade.id, false);
          if (updated) {
            yield* emit({ _tag: "Trade", data: updated });
            yield* Ref.update(stateRef, (s) => { bumpDiag(s, updated.strategy, "liveRejected", 1, false); return s; });
          }
          continue;
        }

        const fullTrade = yield* liveStore.getTrade(trade.id);
        if (!fullTrade) continue;
        const cumulativeFilled = status.filledShares ?? fullTrade.requestedShares;
        const deltaShares = Math.max(0, cumulativeFilled - fullTrade.filledShares);
        const price = (status.avgPrice ?? fullTrade.avgFillPrice) || trade.avgFillPrice || 0;
        const fee = deltaShares > 0 ? calculateFeeStatic(deltaShares, price) : 0;

        if (status.mappedStatus === "partial") {
          if (deltaShares <= 0) continue;
          yield* liveStore.appendEvent(trade.id, "partial_fill", {
            shares: deltaShares, price, fee, orderId: trade.clobOrderId,
            result: status.rawStatus ?? "partial", reason: status.reason ?? undefined,
          });
        } else if (status.mappedStatus === "filled") {
          yield* liveStore.appendEvent(trade.id, "fill", {
            shares: deltaShares, price, fee, orderId: trade.clobOrderId,
            result: status.rawStatus ?? "filled", reason: status.reason ?? undefined,
          });
        }

        const updated = yield* getTradeRecordById(trade.id, false);
        if (updated) {
          if (trade.status === "submitted" && (updated.status === "partial" || updated.status === "filled")) {
            yield* riskManager.onTradeOpened(updated);
          }
          yield* emit({ _tag: "Trade", data: updated });
        }
      }
    });

    // ── Reconciliation metrics ──────────────────────────────────────────────

    const recomputeReconciliation = Effect.gen(function* () {
      const [liveTrades, shadowTrades] = yield* Effect.all([getAllTradeRecords(false), getAllTradeRecords(true)]);
      const liveResolved = liveTrades.filter((t) => t.status === "resolved");
      const shadowResolved = shadowTrades.filter((t) => t.status === "resolved");
      const liveWins = liveResolved.filter((t) => t.outcome === "win").length;
      const shadowWins = shadowResolved.filter((t) => t.outcome === "win").length;
      const byStrategy = strategies.map((strategy) => {
        const ls = liveTrades.filter((t) => t.strategy === strategy.name);
        const ss = shadowTrades.filter((t) => t.strategy === strategy.name);
        const lsResolved = ls.filter((t) => t.status === "resolved");
        const ssResolved = ss.filter((t) => t.status === "resolved");
        const liveWins = lsResolved.filter((t) => t.outcome === "win").length;
        const shadowWins = ssResolved.filter((t) => t.outcome === "win").length;
        return {
          strategy: strategy.name,
          liveSignals: ls.length, shadowSignals: ss.length,
          liveSubmitted: ls.filter((t) => t.status !== "pending").length,
          shadowSubmitted: ss.filter((t) => t.status !== "pending").length,
          liveFillRate: 0, shadowFillRate: 0, liveRejectRate: 0, shadowRejectRate: 0,
          liveWinRate: lsResolved.length > 0 ? (liveWins / lsResolved.length) * 100 : 0,
          shadowWinRate: ssResolved.length > 0 ? (shadowWins / ssResolved.length) * 100 : 0,
          livePnl: lsResolved.reduce((acc, t) => acc + t.pnl, 0),
          shadowPnl: ssResolved.reduce((acc, t) => acc + t.pnl, 0),
          signalDelta: ls.length - ss.length, fillRateDelta: 0, pnlDelta: 0,
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

    // ── Tick wiring ─────────────────────────────────────────────────────────

    const settlementPendingLastLog = new Map<string, number>();

    const emitTick = makeSnapshotEmitter({
      stateRef, strategies, emit, recomputeReconciliation,
      getLiveSummary: liveStore.getSummary,
      getShadowSummary: shadowStore.getSummary,
      getKillSwitchStatus: riskManager.getKillSwitchStatus,
      getRiskSnapshot: riskManager.getSnapshot,
    });

    const { executeStrategy } = makeExecutionHandlers({
      stateRef,
      minFillRatioByStrategy: MIN_FILL_RATIO_BY_STRATEGY,
      shadowSimOptsByStrategy: SHADOW_SIM_OPTS_BY_STRATEGY,
      fillSimulator,
      tracker: { shadowStore, getTradeRecordById, addTrade },
      orderService,
      riskManager,
      emit,
      bumpDiag,
      recordSignalLatency,
      haltTradingWithIncident,
      whaleHuntConfig,
      logPrefix: `[Engine:${marketId}]`,
    });

    const runStrategies = makeStrategyRunner({
      stateRef, strategies,
      strategyCooldownMs: STRATEGY_COOLDOWN_MS,
      maxEntriesPerWindow: MAX_ENTRIES_PER_WINDOW,
      perSideStrategies: PER_SIDE_STRATEGIES,
      maxTradeSize: riskConfig.maxTradeSize,
      getRecentPrices: (windowMs, source) => feedManager.getRecentPrices(windowMs, source),
      computeSize: (signal, recentPrices, winRate) => positionSizer.computeSize(signal, recentPrices, winRate),
      approveRisk: (signal, ctx, posSlots) => riskManager.approve(signal, ctx, posSlots),
      getRiskSnapshot: riskManager.getSnapshot,
      executeStrategy,
      adjustMomentumMaxPrice: (signal, regime, ctx, cfg) => adjustMomentumMaxPrice(signal, regime, ctx, cfg),
      bumpDiag,
      obs,
      whaleHuntConfig,
      logPrefix: `[Engine:${marketId}]`,
    });

    const pollMarkets = makeMarketPoller({
      stateRef, strategies,
      fetchCurrentWindow: marketPoller.fetchCurrentWindow,
      isConnected: polyClient.isConnected,
      onNewWindow: (conditionId) => riskManager.onNewWindow(conditionId),
      emit, obs, refreshOrderBook,
      formatWindowTitle: marketPoller.formatWindowTitle,
      logPrefix: `[Engine:${marketId}]`,
    });

    const tick = Effect.gen(function* () {
      const st = yield* Ref.get(stateRef);
      if (!st.running || st.tickInFlight) return;
      yield* Ref.update(stateRef, (s) => ({ ...s, tickInFlight: true }));
      yield* tickInner.pipe(
        Effect.withSpan(`Engine:${marketId}.tick`),
        Effect.ensuring(Ref.update(stateRef, (s) => ({ ...s, tickInFlight: false }))),
      );
    });

    const tickInner = Effect.gen(function* () {
      const st = yield* Ref.get(stateRef);
      const isShadow = st.mode === "shadow";
      const now = Date.now();
      const liveAssetPrice = yield* feedManager.getCurrentAssetPrice;
      const connected = yield* polyClient.isConnected;

      if (st.currentWindow && liveAssetPrice > 0 && now >= st.currentWindow.endTime - 5_000) {
        if (st.windowEndPriceSnapshot === null || (now <= st.currentWindow.endTime + 2_000 && liveAssetPrice > 0)) {
          yield* Ref.update(stateRef, (s) => ({ ...s, windowEndPriceSnapshot: liveAssetPrice, windowEndSnapshotTs: now }));
        }
      }

      const sNow = yield* Ref.get(stateRef);
      const closingAssetPrice = sNow.windowEndPriceSnapshot && sNow.windowEndPriceSnapshot > 0
        ? sNow.windowEndPriceSnapshot : liveAssetPrice;

      const [openLiveTrades, openShadowTrades] = yield* Effect.all([
        liveStore.getOpenTrades,
        shadowStore.getOpenTrades,
      ]);
      const expired = [...openLiveTrades, ...openShadowTrades].filter(
        (trade) => (trade.status === "filled" || trade.status === "partial") && now >= trade.windowEnd,
      );
      for (const trade of expired) {
        const tradeShadow = trade.shadow === true;
        const tradeRecord = yield* getTradeRecordById(trade.id, tradeShadow);
        if (!tradeRecord) continue;
        const settlement = yield* marketPoller.fetchSettlementByCondition(trade.conditionId).pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        );
        const hasVenueWinner = settlement?.resolved === true && settlement.winnerSide !== null;
        if (!hasVenueWinner) {
          const lastLog = settlementPendingLastLog.get(trade.id) ?? 0;
          const pendingMs = now - trade.windowEnd;
          const logInterval = pendingMs > 5 * 60_000 ? 60_000 : pendingMs > 60_000 ? 30_000 : 0;
          if (now - lastLog >= logInterval) {
            settlementPendingLastLog.set(trade.id, now);
            const msg = `[Engine:${marketId}] Settlement pending for ${trade.id} (${trade.conditionId}) — waiting for venue winner`;
            yield* pendingMs > 5 * 60_000 ? Effect.logWarning(msg) : Effect.log(msg);
          }
          continue;
        }
        settlementPendingLastLog.delete(trade.id);
        if (closingAssetPrice > 0) {
          yield* expireTrade(trade.id, closingAssetPrice, tradeShadow);
        }
        const won = trade.side === settlement!.winnerSide;
        const outcomeSource: "venue" = "venue";
        yield* resolveTrade(trade.id, won, tradeShadow, { outcomeSource, settlementWinnerSide: settlement?.winnerSide ?? null });
        const resolved = (yield* getTradeRecordById(trade.id, tradeShadow)) ?? {
          ...tradeRecord, status: "resolved" as const,
          outcome: won ? ("win" as const) : ("loss" as const),
          resolutionSource: outcomeSource,
          settlementWinnerSide: settlement?.winnerSide ?? null,
          pnl: 0, closingAssetPrice,
        };
        for (const s of strategies) yield* s.onTrade(resolved);
        yield* Ref.update(stateRef, (stUpd) => {
          bumpDiag(stUpd, resolved.strategy, resolved.outcome === "win" ? "wins" : "losses", 1, tradeShadow);
          return stUpd;
        });
        yield* riskManager.onTradeClosed(resolved, tradeShadow);
        yield* emit({ _tag: "Trade", data: resolved });
      }

      if (!isShadow && connected) yield* reconcileSubmittedLiveOrders;

      if (!sNow.currentWindow) { yield* emitTick(isShadow); return; }
      if (now >= sNow.currentWindow.endTime) { yield* emitTick(isShadow); return; }

      const prices = yield* feedManager.getLatestPrices;
      const oracleEst = yield* feedManager.getOracleEstimate;
      const oracleTs = yield* feedManager.getOracleTimestamp;
      const currentAsset = yield* feedManager.getCurrentAssetPrice;
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
        marketId,
      };

      yield* regimeDetector.update(ctx);
      const regime = yield* regimeDetector.getRegime;
      yield* Ref.update(stateRef, (s) => ({ ...s, regime }));

      if (!isShadow && !connected) { yield* emitTick(isShadow); return; }

      yield* runStrategies(ctx, regime, isShadow, now);
      yield* emitTick(isShadow);
    });

    // ── Start loops ─────────────────────────────────────────────────────────

    yield* Ref.update(stateRef, (s) => ({ ...s, running: true }));

    yield* Effect.gen(function* () {
      const feedState = yield* feedManager.getLatestPrices;
      const momentumStrategy = strategyMap.get("momentum");
      for (const p of Object.values(feedState)) {
        yield* regimeDetector.addPrice(p);
        if (momentumStrategy && "addPrice" in momentumStrategy) {
          yield* (momentumStrategy as any).addPrice(p);
        }
      }
    }).pipe(
      Effect.repeat(Schedule.fixed("500 millis")),
      Effect.catchAll(() => Effect.void),
      Effect.forkScoped,
    );

    // Rehydrate risk state from existing trades
    yield* Effect.gen(function* () {
      const windowId = (yield* Ref.get(stateRef)).currentWindow?.conditionId ?? "";
      const liveTrades = yield* getAllTradeRecords(false);
      yield* riskManager.rehydrate(liveTrades, windowId);
      const snap = yield* riskManager.getSnapshot;
      yield* Effect.log(`[Engine:${marketId}] Risk rehydrated: open=${snap.openPositions}, exposure=$${snap.openExposure.toFixed(2)}, dailyPnl=$${snap.dailyPnl.toFixed(2)}`);

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
      }
    });

    yield* tick.pipe(
      Effect.repeat(Schedule.fixed("500 millis")),
      Effect.catchAll((err) => Effect.logError(`[Engine:${marketId}] Tick error: ${err}`)),
      Effect.forkScoped,
    );

    yield* pollMarkets.pipe(
      Effect.repeat(Schedule.fixed("3 seconds")),
      Effect.catchAll(() => Effect.void),
      Effect.forkScoped,
    );

    yield* Effect.log(`[Engine:${marketId}] Started in ${config.trading.mode.toUpperCase()} mode`);

    // ── Public API ───────────────────────────────────────────────────────────

    const getStrategyStates = Effect.all(strategies.map((s) => s.getState));
    const getOrderBookState = Ref.get(stateRef).pipe(Effect.map((s) => s.orderBook));
    const getCurrentWindow = Ref.get(stateRef).pipe(Effect.map((s) => s.currentWindow));
    const getWindowTitle = Ref.get(stateRef).pipe(Effect.map((s) => s.windowTitle));
    const isTradingActive = Ref.get(stateRef).pipe(Effect.map((s) => s.tradingActive));

    const setTradingActive = (active: boolean) =>
      Effect.gen(function* () {
        yield* Ref.update(stateRef, (s) => ({ ...s, tradingActive: active, efficiencyIncidentBlocked: active ? false : s.efficiencyIncidentBlocked }));
        yield* Effect.log(`[Engine:${marketId}] Trading ${active ? "STARTED" : "STOPPED"}`);
        yield* emit({ _tag: "TradingActive", data: { tradingActive: active } });
        yield* obs({ category: "operator", source: "engine", action: active ? "trading_started" : "trading_stopped", entityType: "system", entityId: "trading_active", status: active ? "active" : "inactive", mode: null, payload: { tradingActive: active } });
      });

    const getMode = Ref.get(stateRef).pipe(Effect.map((s) => s.mode));
    const setMode = (mode: "live" | "shadow") =>
      Effect.gen(function* () {
        yield* Ref.update(stateRef, (s) => ({ ...s, mode }));
        yield* Effect.log(`[Engine:${marketId}] Mode switched to ${mode.toUpperCase()}`);
        yield* emit({ _tag: "Mode", data: { mode } });
        yield* obs({ category: "operator", source: "engine", action: "mode_changed", entityType: "system", entityId: "engine_mode", status: mode, mode, payload: { mode } });
      });

    const getRegime = Ref.get(stateRef).pipe(Effect.map((s) => s.regime));
    const getRiskSnapshot = riskManager.getSnapshot;
    const getKillSwitchStatus = riskManager.getKillSwitchStatus;
    const resetKillSwitchPause = riskManager.resetPause;

    const getMetrics = Ref.get(stateRef).pipe(
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
        }
        return result.ok ? { status: "ok" as const } : { status: "invalid" as const, error: result.error ?? "Invalid config values", appliedKeys: result.appliedKeys, rejectedKeys: result.rejectedKeys };
      });

    const updateStrategyRegimeFilter = (name: string, filter: Record<string, unknown>) =>
      Effect.gen(function* () {
        const s = strategyMap.get(name);
        if (!s) return "not_found" as const;
        yield* s.updateRegimeFilter(filter as any);
        yield* persistStrategyStates;
        const states = yield* getStrategyStates;
        yield* emit({ _tag: "Strategies", data: states });
        return "ok" as const;
      });

    const getFeedHealth = feedManager.getFeedHealth;

    return {
      marketId,
      displayName: marketConfig.displayName,
      feedManager,
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
      listTrades,
      getTradeRecords: (limit?: number) => listTrades({ mode: "all", limit: limit ?? 100 }).pipe(Effect.map((r) => r.items)),
      getPnLSummary: liveStore.getSummary,
      getShadowPnLSummary: shadowStore.getSummary,
      getFeedHealth,
    } satisfies MarketEngineInstance;
  }) as unknown as Effect.Effect<MarketEngineInstance, never, FileSystem.FileSystem | Scope.Scope>;
}

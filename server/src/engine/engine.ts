import { Effect, Ref, Schedule, Option } from "effect";
import { FileSystem } from "@effect/platform";
import { AppConfig } from "../config.js";
import { FeedService } from "../feeds/manager.js";
import { MarketService, formatWindowTitle } from "../polymarket/markets.js";
import { OrderService, ORDER_PRECISION_GUARD_VERSION, calculateFeeStatic, effectiveFeeRateStatic } from "../polymarket/orders.js";
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
import { makeOrderFlowImbalanceStrategy } from "../strategies/orderflow-imbalance.js";
import {
  mergeWhaleHuntConfig,
  toWhaleHuntStrategyConfig,
} from "../strategies/whale-hunt-config.js";
import type { Strategy } from "../strategies/base.js";
import { shouldRunInRegime } from "../strategies/base.js";
import { getMarketConfig } from "../markets/definitions.js";
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
  "orderflow-imbalance": 4500,
};

const MAX_ENTRIES_PER_WINDOW: Record<string, number> = {
  arb: 2,
  efficiency: 1,
  "whale-hunt": 1,
  momentum: 2, // fallback: 1 UP + 1 DOWN. Overridden by sState.config["maxEntriesPerWindow"].
  "orderflow-imbalance": 1,
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
  "orderflow-imbalance": 0.5,
};

const SHADOW_SIM_OPTS_BY_STRATEGY: Record<string, SimulatorOpts> = {
  arb: { slippageBps: 4, fillProbability: 0.78, minLiquidityPct: 0.08 },
  efficiency: { slippageBps: 3, fillProbability: 0.82, minLiquidityPct: 0.1 },
  "whale-hunt": { slippageBps: 6, fillProbability: 0.75, minLiquidityPct: 0.08 },
  momentum: { slippageBps: 7, fillProbability: 0.86, minLiquidityPct: 0.05 },
  "orderflow-imbalance": { slippageBps: 5, fillProbability: 0.82, minLiquidityPct: 0.08 },
};

function settlementPendingPollIntervalMs(pendingMs: number): number {
  if (pendingMs > 5 * 60_000) return 60_000;
  if (pendingMs > 60_000) return 20_000;
  return 10_000;
}

const STRATEGY_STATE_DIR = "data";
const STRATEGY_STATE_FILE = "data/strategy-state.json";
const MARKET_ID = "btc";
const ENGINE_LOG_PREFIX = `[Engine:${MARKET_ID}]`;

interface PersistedStrategyStateEntry {
  enabled?: boolean;
  config?: Record<string, unknown>;
  regimeFilter?: Record<string, unknown>;
}

type PersistedStrategyState = Record<string, PersistedStrategyStateEntry>;
type StrategyStateSchema = "market_scoped" | "legacy";

export class TradingEngine extends Effect.Service<TradingEngine>()("TradingEngine", {
  scoped: Effect.gen(function* () {
    const config = yield* AppConfig;
    const feedService = yield* FeedService;
    const marketService = yield* MarketService;
    const orderService = yield* OrderService;
    const defaultOrderPrecisionGuardInfo = {
      version: ORDER_PRECISION_GUARD_VERSION,
      quantizedSingleLegBuy: true,
      quantizedDualLegBuy: true,
      localPrecisionValidation: true,
    } as const;
    const orderPrecisionGuardInfo = yield* (
      "getPrecisionGuardInfo" in orderService
      && (orderService as { getPrecisionGuardInfo?: Effect.Effect<typeof defaultOrderPrecisionGuardInfo> }).getPrecisionGuardInfo
        ? (orderService as { getPrecisionGuardInfo: Effect.Effect<typeof defaultOrderPrecisionGuardInfo> }).getPrecisionGuardInfo
        : Effect.succeed(defaultOrderPrecisionGuardInfo)
    ).pipe(Effect.catchAll(() => Effect.succeed(defaultOrderPrecisionGuardInfo)));
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
    const orderFlowImbalance = yield* makeOrderFlowImbalanceStrategy;

    const strategies: Strategy[] = [arb, efficiency, whaleHunt, momentum, orderFlowImbalance];
    const strategyMap = new Map<string, Strategy>(strategies.map((s) => [s.name, s]));
    const marketConfig = getMarketConfig(MARKET_ID);
    const whaleHuntConfig = mergeWhaleHuntConfig(
      config.trading.whaleHunt,
      marketConfig?.whaleHuntOverrides,
    );
    const strategyStateSchema = yield* Effect.gen(function* () {
      if (!usePostgresStorage) return null as StrategyStateSchema | null;
      const rows = yield* postgres!.query<{ has_market_id: boolean }>(
        `select exists(
          select 1
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'strategy_state'
            and column_name = 'market_id'
        ) as has_market_id`,
      );
      return rows[0]?.has_market_id ? "market_scoped" as const : "legacy" as const;
    }).pipe(
      Effect.catchAll((err) => {
        if (config.storage.backend === "postgres") {
          return Effect.fail(new Error(`${ENGINE_LOG_PREFIX} Failed to inspect strategy_state schema: ${String(err)}`));
        }
        return Effect.logWarning(
          `${ENGINE_LOG_PREFIX} Failed to inspect strategy_state schema; falling back to file strategy state: ${String(err)}`,
        ).pipe(Effect.as(null as StrategyStateSchema | null));
      }),
    );

    const readPersistedStrategyState = Effect.gen(function* () {
      const fromDb: PersistedStrategyState = {};
      if (usePostgresStorage && strategyStateSchema !== null) {
        const rows = yield* postgres!.query<{ strategy_name: string; payload: unknown }>(
          strategyStateSchema === "market_scoped"
            ? "select strategy_name, payload from strategy_state where market_id = $1"
            : "select strategy_name, payload from strategy_state",
          strategyStateSchema === "market_scoped" ? [MARKET_ID] : [],
        ).pipe(
          Effect.catchAll((err) =>
            Effect.logError(`${ENGINE_LOG_PREFIX} Failed to read strategy state from database: ${String(err)}`).pipe(
              Effect.as([]),
            ),
          ),
        );
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
        Effect.logError(`${ENGINE_LOG_PREFIX} Failed to load strategy state from ${STRATEGY_STATE_FILE}: ${String(err)}`).pipe(
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
        const fileErr = yield* fs.writeFileString(STRATEGY_STATE_FILE, JSON.stringify(payload, null, 2)).pipe(
          Effect.as(null as string | null),
          Effect.catchAll((err) => Effect.succeed(String(err))),
        );
        if (fileErr) {
          yield* Effect.logError(`${ENGINE_LOG_PREFIX} Failed to persist strategy states to file: ${fileErr}`);
          return { ok: false as const, error: fileErr };
        }
      }
      if (usePostgresStorage) {
        if (strategyStateSchema === null) {
          return {
            ok: false as const,
            error: "strategy_state schema unavailable while postgres storage is enabled",
          };
        }
        const dbErr = yield* Effect.forEach(
          Object.entries(payload),
          ([name, entry]) =>
            strategyStateSchema === "market_scoped"
              ? postgres!.execute(
                  `insert into strategy_state (market_id, strategy_name, payload, updated_at_ms)
                   values ($1, $2, $3::jsonb, $4)
                   on conflict (market_id, strategy_name) do update set payload = excluded.payload, updated_at_ms = excluded.updated_at_ms`,
                  [MARKET_ID, name, JSON.stringify(entry ?? {}), Date.now()],
                )
              : postgres!.execute(
                  `insert into strategy_state (strategy_name, payload, updated_at_ms)
                   values ($1, $2::jsonb, $3)
                   on conflict (strategy_name) do update set payload = excluded.payload, updated_at_ms = excluded.updated_at_ms`,
                  [name, JSON.stringify(entry ?? {}), Date.now()],
                ),
          { discard: true },
        ).pipe(
          Effect.as(null as string | null),
          Effect.catchAll((err) => Effect.succeed(String(err))),
        );
        if (dbErr) {
          yield* Effect.logError(`${ENGINE_LOG_PREFIX} Failed to persist strategy states to postgres: ${dbErr}`);
          return { ok: false as const, error: dbErr };
        }
      }
      return { ok: true as const };
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
                `${ENGINE_LOG_PREFIX} Persisted config for ${strategy.name} was invalid: ${result.error ?? "Invalid config values"}`,
              );
            }
          }

          if (entry.regimeFilter && typeof entry.regimeFilter === "object") {
            yield* strategy.updateRegimeFilter(entry.regimeFilter as any);
          }
        }),
      ).pipe(Effect.asVoid);

    const applyStrategyRuntimeConfig = (strategyName: string, overrides: Record<string, number> | undefined) =>
      Effect.gen(function* () {
        if (!overrides || Object.keys(overrides).length === 0) return;
        const strategy = strategyMap.get(strategyName);
        if (!strategy) return;
        const result = yield* strategy.updateConfig(overrides);
        if (!result.ok) {
          yield* Effect.logWarning(
            `${ENGINE_LOG_PREFIX} Failed to apply ${strategyName} runtime config: ${result.error ?? "invalid values"}`,
          );
        }
      });

    const applyWhaleHuntRuntimeConfig = Effect.gen(function* () {
      yield* applyStrategyRuntimeConfig("whale-hunt", toWhaleHuntStrategyConfig(whaleHuntConfig));
    });

    const applyMarketStrategyRuntimeConfig = Effect.forEach(
      Object.entries(marketConfig?.strategyConfigOverrides ?? {}),
      ([strategyName, overrides]) => applyStrategyRuntimeConfig(strategyName, overrides),
      { discard: true },
    );

    yield* applyWhaleHuntRuntimeConfig;
    yield* applyMarketStrategyRuntimeConfig;
    const persistedStrategyState = yield* readPersistedStrategyState;
    yield* applyPersistedStrategyState(persistedStrategyState);
    const bootPersistResult = yield* persistStrategyStates;
    if (!bootPersistResult.ok) {
      if (config.storage.backend === "postgres") {
        return yield* Effect.fail(new Error(`${ENGINE_LOG_PREFIX} Startup strategy state persist failed: ${bootPersistResult.error}`));
      }
      yield* Effect.logWarning(
        `${ENGINE_LOG_PREFIX} Startup strategy state persist failed: ${bootPersistResult.error}`,
      );
    }

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

    const emit = (event: EngineEvent) => eventBus.publish({ ...event, marketId: MARKET_ID });
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
        yield* Effect.logError(`${ENGINE_LOG_PREFIX} CRITICAL INCIDENT: ${created.kind} - ${created.message}`);
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
        const signalToStatusMs = Math.max(0, Date.now() - (trade.events[0]?.timestamp ?? Date.now()));
        yield* obs({
          category: "trade_lifecycle",
          source: "engine",
          action: "order_status_polled",
          entityType: "trade",
          entityId: trade.id,
          status: status.mappedStatus ?? "unknown",
          strategy: trade.strategy,
          mode: "live",
          payload: {
            tradeId: trade.id,
            orderId: trade.clobOrderId,
            signalToStatusMs,
            mappedStatus: status.mappedStatus,
            rawStatus: status.rawStatus,
            filledShares: status.filledShares,
            avgPrice: status.avgPrice,
            reason: status.reason,
          },
        });
        if (!status.mappedStatus || status.mappedStatus === "submitted") {
          const staleThresholdMs = 30_000;
          if (status.mappedStatus === "submitted" && signalToStatusMs >= staleThresholdMs) {
            const lastAlertAt = submittedStaleLastAlertAt.get(trade.id) ?? 0;
            if (Date.now() - lastAlertAt >= 30_000) {
              submittedStaleLastAlertAt.set(trade.id, Date.now());
              yield* obs({
                category: "trade_lifecycle",
                source: "engine",
                action: "order_submitted_stale",
                entityType: "trade",
                entityId: trade.id,
                status: "submitted",
                strategy: trade.strategy,
                mode: "live",
                payload: {
                  tradeId: trade.id,
                  orderId: trade.clobOrderId,
                  signalToStatusMs,
                  staleThresholdMs,
                  mappedStatus: status.mappedStatus,
                  rawStatus: status.rawStatus,
                },
              });
            }
          }
          continue;
        }
        submittedStaleLastAlertAt.delete(trade.id);

        if (status.mappedStatus === "cancelled" || status.mappedStatus === "rejected") {
          const eventType = status.mappedStatus === "rejected" ? "order_rejected" : "cancel";
          yield* tracker.liveStore.appendEvent(trade.id, eventType, {
            orderId: trade.clobOrderId,
            result: status.rawStatus ?? status.mappedStatus,
            reason: status.reason ?? `Order ${status.mappedStatus}`,
          });
          const updated = yield* tracker.getTradeRecordById(trade.id, false);
          if (updated) {
            yield* obs({
              category: "trade_lifecycle",
              source: "engine",
              action: "order_lifecycle_transition",
              entityType: "trade",
              entityId: trade.id,
              status: updated.status,
              strategy: updated.strategy,
              mode: "live",
              payload: {
                tradeId: trade.id,
                orderId: trade.clobOrderId,
                fromStatus: trade.status,
                toStatus: updated.status,
                signalToStatusMs,
                mappedStatus: status.mappedStatus,
                rawStatus: status.rawStatus,
                reason: status.reason,
              },
            });
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
          yield* obs({
            category: "trade_lifecycle",
            source: "engine",
            action: "order_lifecycle_transition",
            entityType: "trade",
            entityId: trade.id,
            status: updated.status,
            strategy: updated.strategy,
            mode: "live",
            payload: {
              tradeId: trade.id,
              orderId: trade.clobOrderId,
              fromStatus: trade.status,
              toStatus: updated.status,
              signalToStatusMs,
              mappedStatus: status.mappedStatus,
              rawStatus: status.rawStatus,
              cumulativeFilled: cumulativeFilled,
              deltaShares,
              avgPrice: price,
              fee,
            },
          });
          if (trade.status === "submitted" && (updated.status === "partial" || updated.status === "filled")) {
            yield* riskManager.onTradeOpened(updated);
          }
          yield* emit({ _tag: "Trade", data: updated });
        }
      }
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

    const settlementPendingLastLog = new Map<string, number>();
    const settlementPendingLastCheck = new Map<string, number>();
    const submittedStaleLastAlertAt = new Map<string, number>();
    let lastActivityFreshnessCheckAt = 0;
    let activityFreshnessStaleActive = false;

    const pollMarkets = makeMarketPoller({
      stateRef,
      strategies,
      fetchCurrentWindow: marketService.fetchCurrentBtc5mWindow,
      isConnected: polyClient.isConnected,
      onNewWindow: (conditionId) => riskManager.onNewWindow(conditionId),
      emit,
      obs,
      refreshOrderBook,
      formatWindowTitle,
      logPrefix: ENGINE_LOG_PREFIX,
    });

    const tick = Effect.gen(function* () {
      const st = yield* Ref.get(stateRef);
      if (!st.running || st.tickInFlight) return;
      yield* Ref.update(stateRef, (s) => ({ ...s, tickInFlight: true }));

      yield* tickInner.pipe(
        Effect.withSpan(`Engine:${MARKET_ID}.tick`),
        Effect.ensuring(Ref.update(stateRef, (s) => ({ ...s, tickInFlight: false }))),
      );
    });

    const tickInner = Effect.gen(function* () {
      const st = yield* Ref.get(stateRef);
      const isShadow = st.mode === "shadow";
      const now = Date.now();
      if (!isShadow && now - lastActivityFreshnessCheckAt >= 60_000) {
        lastActivityFreshnessCheckAt = now;
        const freshness = yield* activityStore.getFreshness().pipe(
          Effect.catchAll(() =>
            Effect.succeed({
              latestActivityTimestampSec: null,
              latestImportedAtMs: null,
              ageSinceLatestActivitySec: null,
              ageSinceLatestImportSec: null,
              stale: true,
              staleThresholdSec: 600,
            }),
          ),
        );
        if (freshness.stale && !activityFreshnessStaleActive) {
          activityFreshnessStaleActive = true;
          yield* obs({
            category: "activity",
            source: "engine",
            action: "activity_freshness_stale",
            entityType: "system",
            entityId: "account_activity",
            status: "stale",
            mode: st.mode,
            payload: freshness,
          });
          yield* Effect.logWarning(
            `${ENGINE_LOG_PREFIX} Account activity data is stale (import age: ${freshness.ageSinceLatestImportSec ?? "unknown"}s)`,
          );
        } else if (!freshness.stale && activityFreshnessStaleActive) {
          activityFreshnessStaleActive = false;
          yield* obs({
            category: "activity",
            source: "engine",
            action: "activity_freshness_recovered",
            entityType: "system",
            entityId: "account_activity",
            status: "ok",
            mode: st.mode,
            payload: freshness,
          });
        }
      }
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
        const pendingMs = now - trade.windowEnd;
        const pollIntervalMs = settlementPendingPollIntervalMs(pendingMs);
        const lastCheck = settlementPendingLastCheck.get(trade.id) ?? 0;
        if (now - lastCheck < pollIntervalMs) continue;
        settlementPendingLastCheck.set(trade.id, now);

        const tradeShadow = trade.shadow === true;
        const tradeRecord = yield* tracker.getTradeRecordById(trade.id, tradeShadow);
        if (!tradeRecord) continue;
        const settlement = yield* marketService.fetchSettlementByCondition(trade.conditionId).pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        );
        const hasVenueWinner = settlement?.resolved === true && settlement.winnerSide !== null;
        if (!hasVenueWinner) {
          const lastLog = settlementPendingLastLog.get(trade.id) ?? 0;
          const logInterval = pollIntervalMs;
          if (now - lastLog >= logInterval) {
            settlementPendingLastLog.set(trade.id, now);
            const msg = `${ENGINE_LOG_PREFIX} Settlement pending for ${trade.id} (${trade.conditionId}) — waiting for venue winner`;
            yield* pendingMs > 5 * 60_000 ? Effect.logWarning(msg) : Effect.log(msg);
          }
          continue;
        }
        settlementPendingLastLog.delete(trade.id);
        settlementPendingLastCheck.delete(trade.id);
        if (closingAssetPrice > 0) {
          yield* tracker.expireTrade(trade.id, closingAssetPrice, tradeShadow);
        }
        const won = trade.side === settlement!.winnerSide;
        const outcomeSource: "venue" = "venue";
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
        windowDurationMs: sNow.currentWindow.endTime - sNow.currentWindow.startTime,
        windowElapsedMs: now - sNow.currentWindow.startTime,
        windowRemainingMs: sNow.currentWindow.endTime - now,
        priceToBeat: sNow.currentWindow.priceToBeat,
        currentAssetPrice: currentAsset,
        marketId: MARKET_ID,
      };

      yield* regimeDetector.update(ctx);
      const regime = yield* regimeDetector.getRegime;
      const prevRegime = sNow.regime;
      yield* Ref.update(stateRef, (s) => ({ ...s, regime }));
      if (
        prevRegime.trendRegime !== regime.trendRegime
        || prevRegime.volatilityRegime !== regime.volatilityRegime
        || prevRegime.liquidityRegime !== regime.liquidityRegime
        || prevRegime.spreadRegime !== regime.spreadRegime
      ) {
        yield* obs({
          category: "engine",
          source: "engine",
          action: "regime_transition",
          entityType: "system",
          entityId: "regime",
          status: "updated",
          mode: isShadow ? "shadow" : "live",
          payload: {
            from: {
              trend: prevRegime.trendRegime,
              volatility: prevRegime.volatilityRegime,
              liquidity: prevRegime.liquidityRegime,
              spread: prevRegime.spreadRegime,
            },
            to: {
              trend: regime.trendRegime,
              volatility: regime.volatilityRegime,
              liquidity: regime.liquidityRegime,
              spread: regime.spreadRegime,
            },
            trendStrength: regime.trendStrength ?? null,
            trendSampleCount: regime.trendSampleCount ?? null,
            trendSlope: regime.trendSlope ?? null,
            trendResidualStddev: regime.trendResidualStddev ?? null,
            volatilityValue: regime.volatilityValue ?? null,
            spreadValue: regime.spreadValue ?? null,
            liquidityDepth: regime.liquidityDepth ?? null,
          },
        });
      }

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
      whaleHuntConfig,
      efficiencyRecovery: {
        maxLegImbalanceMs: config.risk.maxLegImbalanceMs,
        maxHedgeRetries: config.risk.maxHedgeRetries,
        maxResidualExposureUsd: config.risk.maxResidualExposureUsd,
        maxUnwindSlippageBps: config.risk.maxUnwindSlippageBps,
      },
      logPrefix: ENGINE_LOG_PREFIX,
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
      whaleHuntConfig,
      logPrefix: ENGINE_LOG_PREFIX,
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
        `${ENGINE_LOG_PREFIX} Risk rehydrated: open=${snap.openPositions}, exposure=$${snap.openExposure.toFixed(2)}, dailyPnl=$${snap.dailyPnl.toFixed(2)}, hourlyPnl=$${snap.hourlyPnl.toFixed(2)}`,
      );

      if (windowId) {
        const windowTrades = liveTrades.filter((t) => t.conditionId === windowId);
        const restoredEntries = new Map<string, number>();
        for (const t of windowTrades) {
          restoredEntries.set(t.strategy, (restoredEntries.get(t.strategy) ?? 0) + 1);
          const sideKey = `${t.strategy}:${t.side}`;
          restoredEntries.set(sideKey, (restoredEntries.get(sideKey) ?? 0) + 1);
        }
        yield* Ref.update(stateRef, (s) => ({ ...s, entriesThisWindow: restoredEntries }));
        yield* Effect.log(
          `${ENGINE_LOG_PREFIX} Restored entriesThisWindow from ${windowTrades.length} existing trades: ${JSON.stringify(Object.fromEntries(restoredEntries))}`,
        );
      }
    });

    yield* tick.pipe(
      Effect.repeat(Schedule.fixed("500 millis")),
      Effect.catchAll((err) => Effect.logError(`${ENGINE_LOG_PREFIX} Tick error: ${err}`)),
      Effect.forkScoped,
    );

    yield* pollMarkets.pipe(
      Effect.repeat(Schedule.fixed("3 seconds")),
      Effect.catchAll(() => Effect.void),
      Effect.forkScoped,
    );

    yield* Effect.log(`${ENGINE_LOG_PREFIX} Started in ${config.trading.mode.toUpperCase()} mode`);

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
        yield* Effect.log(`${ENGINE_LOG_PREFIX} Trading ${active ? "STARTED" : "STOPPED"}`);
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
        yield* Effect.log(`${ENGINE_LOG_PREFIX} Mode switched to ${mode.toUpperCase()}`);
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
        orderPrecisionGuard: orderPrecisionGuardInfo,
      })),
    );

    const toggleStrategy = (name: string) =>
      Effect.gen(function* () {
        const s = strategyMap.get(name);
        if (!s) return false;
        const current = yield* Ref.get(s.stateRef);
        yield* s.setEnabled(!current.enabled);
        const persisted = yield* persistStrategyStates;
        if (!persisted.ok) {
          yield* Effect.logError(`${ENGINE_LOG_PREFIX} Failed to persist strategy toggle for ${name}: ${persisted.error}`);
          yield* obs({
            category: "operator",
            source: "engine",
            action: "strategy_state_persist_failed",
            entityType: "strategy",
            entityId: name,
            status: "error",
            strategy: name,
            mode: null,
            payload: { operation: "toggle", error: persisted.error ?? "unknown" },
          });
          return current.enabled;
        }
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
          const persisted = yield* persistStrategyStates;
          if (!persisted.ok) {
            yield* obs({
              category: "operator",
              source: "engine",
              action: "strategy_state_persist_failed",
              entityType: "strategy",
              entityId: name,
              status: "error",
              strategy: name,
              mode: null,
              payload: { operation: "config_update", error: persisted.error ?? "unknown" },
            });
            return {
              status: "persist_failed" as const,
              error: persisted.error ?? "Failed to persist strategy state",
            };
          }
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
        if (!s) return { status: "not_found" as const };
        yield* s.updateRegimeFilter(filter as any);
        const persisted = yield* persistStrategyStates;
        if (!persisted.ok) {
          yield* obs({
            category: "operator",
            source: "engine",
            action: "strategy_state_persist_failed",
            entityType: "strategy",
            entityId: name,
            status: "error",
            strategy: name,
            mode: null,
            payload: { operation: "regime_filter_update", error: persisted.error ?? "unknown" },
          });
          return {
            status: "persist_failed" as const,
            error: persisted.error ?? "Failed to persist strategy state",
          };
        }
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
        return { status: "ok" as const };
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

import { Effect, Ref } from "effect";
import type { Strategy } from "../strategies/base.js";
import { shouldRunInRegime } from "../strategies/base.js";
import type { EntryContext, MarketContext, RegimeState, Signal, StrategyDiagnostics } from "../types.js";
import type { EngineState } from "./state.js";

interface StrategyRunnerDeps {
  stateRef: Ref.Ref<EngineState>;
  strategies: ReadonlyArray<Strategy>;
  strategyCooldownMs: Record<string, number>;
  maxEntriesPerWindow: Record<string, number>;
  perSideStrategies: Set<string>;
  maxTradeSize: number;
  getRecentPrices: (windowMs: number, source: string) => Effect.Effect<any, any, never>;
  computeSize: (
    signal: Signal,
    recentPrices: any,
    winRate?: number,
  ) => number;
  approveRisk: (
    signal: Signal,
    ctx: MarketContext,
    posSlots?: number,
  ) => Effect.Effect<{ approved: boolean; reason: string }, any, never>;
  getRiskSnapshot: Effect.Effect<{
    openPositions: number;
    openExposure: number;
    dailyPnl: number;
    hourlyPnl: number;
    consecutiveLosses: number;
  }, any, never>;
  executeStrategy: (
    signal: Signal,
    shadow: boolean,
    ctx: MarketContext,
    entryCtx: EntryContext,
  ) => Effect.Effect<boolean, any, never>;
  adjustMomentumMaxPrice: (
    signal: Signal,
    regime: RegimeState,
    ctx: MarketContext,
    config: Record<string, number>,
  ) => number;
  bumpDiag: (
    st: EngineState,
    strategy: string,
    key: keyof StrategyDiagnostics,
    delta: number,
    isShadowMode?: boolean,
  ) => void;
  obs: (input: any) => Effect.Effect<void, never, never>;
}

const PTB_REQUIRED_STRATEGIES = new Set(["arb", "momentum", "whale-hunt"]);

export function makeStrategyRunner(deps: StrategyRunnerDeps) {
  return (ctx: MarketContext, regime: RegimeState, isShadow: boolean, now: number) =>
    Effect.gen(function* () {
      for (const strategy of deps.strategies) {
        const sState = yield* Ref.get(strategy.stateRef);
        if (!sState.enabled) continue;

        const sCurrent = yield* Ref.get(deps.stateRef);
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
            ...s,
            status: "regime_blocked" as const,
            statusReason: regimeCheck.reason,
          }));
          continue;
        }

        const cooldownMs = deps.strategyCooldownMs[strategy.name] ?? 3000;
        const lastExec = sCurrent.lastStrategyExecution.get(strategy.name) ?? 0;
        if (now - lastExec < cooldownMs) continue;

        // Read from the strategy's own config (set via UI) first; fall back to the hardcoded constant.
        const maxEntries = (sState.config["maxEntriesPerWindow"] as number | undefined)
          ?? deps.maxEntriesPerWindow[strategy.name]
          ?? 2;
        const entries = sCurrent.entriesThisWindow.get(strategy.name) ?? 0;
        if (entries >= maxEntries) continue;

        if (PTB_REQUIRED_STRATEGIES.has(strategy.name) && ctx.priceToBeat === null) {
          const reason = ctx.currentWindow?.priceToBeatReason ?? "price_to_beat_unavailable";
          yield* Ref.update(deps.stateRef, (stUpd) => {
            deps.bumpDiag(stUpd, strategy.name, "riskRejected", 1, isShadow);
            return stUpd;
          });
          yield* deps.obs({
            category: "signal",
            source: "engine",
            action: "signal_rejected_preflight",
            entityType: "signal",
            entityId: `${strategy.name}:${now}`,
            status: "rejected",
            strategy: strategy.name,
            mode: isShadow ? "shadow" : "live",
            payload: {
              reason,
              gate: "missing_price_to_beat",
              priceToBeatStatus: ctx.currentWindow?.priceToBeatStatus ?? "pending",
              priceToBeatSource: ctx.currentWindow?.priceToBeatSource ?? "unavailable",
            },
          });
          yield* Effect.log(
            `[Engine] ${strategy.name} skipped: priceToBeat unavailable (${reason})`,
          );
          continue;
        }

        const signal = yield* strategy.evaluate(ctx);
        if (!signal) continue;

        // Per-side limit: for strategies in perSideStrategies, the entry budget is split evenly
        // across UP and DOWN — perSideMax = ceil(totalMax / 2). Checked post-evaluate because
        // we need the signal's side. Examples: totalMax=2→1/side, totalMax=4→2/side, totalMax=3→2/side.
        if (deps.perSideStrategies.has(strategy.name)) {
          const perSideMax = Math.ceil(maxEntries / 2);
          const sideKey = `${strategy.name}:${signal.side}`;
          const sideEntries = sCurrent.entriesThisWindow.get(sideKey) ?? 0;
          if (sideEntries >= perSideMax) {
            yield* Effect.log(
              `[Engine] ${strategy.name} ${signal.side} skipped: side entry limit reached (${sideEntries}/${perSideMax})`,
            );
            continue;
          }
        }
        yield* deps.obs({
          category: "signal",
          source: "engine",
          action: "signal_generated",
          entityType: "signal",
          entityId: `${strategy.name}:${signal.timestamp}`,
          status: "generated",
          strategy: strategy.name,
          mode: isShadow ? "shadow" : "live",
          payload: {
            side: signal.side,
            confidence: signal.confidence,
            reason: signal.reason,
            maxPrice: signal.maxPrice,
            size: signal.size,
          },
        });

        if (signal.strategy === "momentum") {
          signal.maxPrice = deps.adjustMomentumMaxPrice(signal, regime, ctx, sState.config);
        }

        // Skip signal immediately if our limit price is below the current best ask.
        // The scale loop only reduces size, never price — all FOK/FAK attempts at
        // this price would fail for the same reason, wasting CLOB calls and backoff.
        const bestAskForSide = signal.side === "UP" ? ctx.orderBook.bestAskUp : ctx.orderBook.bestAskDown;
        if (bestAskForSide !== null && signal.maxPrice < bestAskForSide) {
          yield* Ref.update(deps.stateRef, (stUpd) => {
            deps.bumpDiag(stUpd, strategy.name, "riskRejected", 1, isShadow);
            return stUpd;
          });
          yield* Effect.log(
            `[Engine] ${strategy.name} ${signal.side} skipped: maxPrice $${signal.maxPrice.toFixed(2)} < bestAsk $${bestAskForSide.toFixed(2)}`,
          );
          continue;
        }

        yield* Ref.update(deps.stateRef, (stUpd) => {
          deps.bumpDiag(stUpd, strategy.name, "signals", 1, isShadow);
          return stUpd;
        });

        const configuredTradeSize = signal.size;
        const recentPrices = yield* deps.getRecentPrices(300_000, "binance");

        const strategyMetrics = sCurrent.metrics.reconciliation.strategies.find((m) => m.strategy === strategy.name);
        const winRate = isShadow ? strategyMetrics?.shadowWinRate : strategyMetrics?.liveWinRate;
        const computedSize = deps.computeSize(signal, recentPrices, winRate);
        const alignedSize = Math.min(computedSize, deps.maxTradeSize);
        signal.size = Math.round(alignedSize * 100) / 100;

        const posSlots = signal.strategy === "efficiency" ? 2 : 1;
        const check = yield* deps.approveRisk(signal, ctx, posSlots);
        if (!check.approved) {
          yield* Ref.update(deps.stateRef, (stUpd) => {
            deps.bumpDiag(stUpd, strategy.name, "riskRejected", 1, isShadow);
            return stUpd;
          });
          yield* Effect.log(`[Engine] Risk rejected ${signal.strategy}: ${check.reason}`);
          yield* deps.obs({
            category: "risk",
            source: "risk_manager",
            action: "signal_rejected",
            entityType: "signal",
            entityId: `${signal.strategy}:${signal.timestamp}`,
            status: "rejected",
            strategy: signal.strategy,
            mode: isShadow ? "shadow" : "live",
            payload: {
              reason: check.reason,
              side: signal.side,
              confidence: signal.confidence,
              size: signal.size,
            },
          });
          continue;
        }
        yield* deps.obs({
          category: "risk",
          source: "risk_manager",
          action: "signal_approved",
          entityType: "signal",
          entityId: `${signal.strategy}:${signal.timestamp}`,
          status: "approved",
          strategy: signal.strategy,
          mode: isShadow ? "shadow" : "live",
          payload: {
            side: signal.side,
            confidence: signal.confidence,
            size: signal.size,
          },
        });

        const riskSnap = yield* deps.getRiskSnapshot;
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
            currentAssetPrice: ctx.currentAssetPrice,
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

        yield* Ref.update(deps.stateRef, (s) => ({
          ...s,
          lastStrategyExecution: new Map([...s.lastStrategyExecution, [strategy.name, now]]),
        }));

        const executed = yield* deps.executeStrategy(signal, isShadow, ctx, entryContext);
        yield* deps.obs({
          category: "signal",
          source: "engine",
          action: "signal_execution_result",
          entityType: "signal",
          entityId: `${signal.strategy}:${signal.timestamp}`,
          status: executed ? "executed" : "not_executed",
          strategy: signal.strategy,
          mode: isShadow ? "shadow" : "live",
          payload: {
            executed,
            side: signal.side,
            finalSize: signal.size,
          },
        });
        if (executed) {
          yield* Ref.update(deps.stateRef, (s) => {
            const newMap = new Map(s.entriesThisWindow);
            newMap.set(strategy.name, (newMap.get(strategy.name) ?? 0) + 1);
            if (deps.perSideStrategies.has(strategy.name)) {
              const sideKey = `${strategy.name}:${signal.side}`;
              newMap.set(sideKey, (newMap.get(sideKey) ?? 0) + 1);
            }
            return { ...s, entriesThisWindow: newMap };
          });
        }
      }
    });
}

import { Effect, Ref } from "effect";
import type { Strategy } from "../strategies/base.js";
import { shouldRunInRegime } from "../strategies/base.js";
import type { EntryContext, MarketContext, RegimeState, Signal, StrategyDiagnostics } from "../types.js";
import type { WhaleHuntConfig } from "../strategies/whale-hunt-config.js";
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
  ) => Effect.Effect<{
    executed: boolean;
    rejectClass?: string;
    rejectReason?: string;
  }, any, never>;
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
  whaleHuntConfig: WhaleHuntConfig;
  logPrefix: string;
}

const PTB_REQUIRED_STRATEGIES = new Set(["arb", "momentum", "whale-hunt"]);
const CHOP_SENSITIVE_STRATEGIES = new Set(["momentum", "orderflow-imbalance", "whale-hunt"]);
const PTB_REJECT_THROTTLE_MS = 15_000;

interface PtbRejectState {
  lastReason: string;
  lastAt: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getPtbDistancePct(ctx: MarketContext): number {
  if (ctx.priceToBeat === null || ctx.priceToBeat <= 0) return 0;
  return Math.abs((ctx.currentAssetPrice - ctx.priceToBeat) / ctx.priceToBeat) * 100;
}

function getSideSpreadPct(ctx: MarketContext, side: "UP" | "DOWN"): number | null {
  const bid = side === "UP" ? ctx.orderBook.bestBidUp : ctx.orderBook.bestBidDown;
  const ask = side === "UP" ? ctx.orderBook.bestAskUp : ctx.orderBook.bestAskDown;
  if (bid === null || ask === null || bid <= 0 || ask <= 0 || ask < bid) return null;
  const mid = (bid + ask) / 2;
  if (mid <= 0) return null;
  return (ask - bid) / mid;
}

function bucketWindowRemainingMs(windowRemainingMs: number): "<30s" | "30-60s" | "60-90s" | "90-120s" | ">=120s" {
  if (windowRemainingMs < 30_000) return "<30s";
  if (windowRemainingMs < 60_000) return "30-60s";
  if (windowRemainingMs < 90_000) return "60-90s";
  if (windowRemainingMs < 120_000) return "90-120s";
  return ">=120s";
}

function computeLatencyGuardLeadMs(observedLatencyMs: number, cfg: WhaleHuntConfig): number {
  return Math.max(
    cfg.minRequiredLeadMs,
    observedLatencyMs * cfg.latencyMultiplier + cfg.latencyBufferMs,
  );
}

function isPtbCheckRelevant(
  strategyName: string,
  config: Record<string, number>,
  ctx: MarketContext,
): boolean {
  if (!PTB_REQUIRED_STRATEGIES.has(strategyName)) return false;
  if (ctx.priceToBeat !== null) return false;
  if (!ctx.currentWindow) return false;

  const elapsedSec = ctx.windowElapsedMs / 1000;
  const remainingSec = ctx.windowRemainingMs / 1000;

  const minWindowElapsedSec = config["minWindowElapsedSec"];
  if (typeof minWindowElapsedSec === "number" && Number.isFinite(minWindowElapsedSec) && elapsedSec < minWindowElapsedSec) {
    return false;
  }

  const maxWindowElapsedSec = config["maxWindowElapsedSec"];
  if (typeof maxWindowElapsedSec === "number" && Number.isFinite(maxWindowElapsedSec) && elapsedSec > maxWindowElapsedSec) {
    return false;
  }

  const minWindowRemainingSec = config["minWindowRemainingSec"];
  if (typeof minWindowRemainingSec === "number" && Number.isFinite(minWindowRemainingSec) && remainingSec <= minWindowRemainingSec) {
    return false;
  }

  if (strategyName === "whale-hunt" && remainingSec < 3) {
    return false;
  }

  return true;
}

export function makeStrategyRunner(deps: StrategyRunnerDeps) {
  const ptbRejectStateByKey = new Map<string, PtbRejectState>();

  const shouldEmitPtbReject = (strategy: string, conditionId: string, reason: string, now: number): boolean => {
    const key = `${strategy}:${conditionId}`;
    const previous = ptbRejectStateByKey.get(key);
    if (!previous) {
      ptbRejectStateByKey.set(key, { lastReason: reason, lastAt: now });
      return true;
    }
    if (previous.lastReason !== reason || now - previous.lastAt >= PTB_REJECT_THROTTLE_MS) {
      ptbRejectStateByKey.set(key, { lastReason: reason, lastAt: now });
      return true;
    }
    return false;
  };

  return (ctx: MarketContext, regime: RegimeState, isShadow: boolean, now: number) =>
    Effect.gen(function* () {
      const emitPreflightReject = (
        strategyName: string,
        entitySuffix: string,
        payload: Record<string, unknown>,
      ) =>
        deps.obs({
          category: "signal",
          source: "engine",
          action: "signal_rejected_preflight",
          entityType: "signal",
          entityId: `${strategyName}:${entitySuffix}`,
          status: "rejected",
          strategy: strategyName,
          mode: isShadow ? "shadow" : "live",
          payload: {
            ...payload,
            regimeTrend: regime.trendRegime,
            regimeTrendStrength: regime.trendStrength ?? null,
            regimeVolatility: regime.volatilityRegime,
            regimeLiquidity: regime.liquidityRegime,
            regimeSpread: regime.spreadRegime,
          },
        });

      for (const strategy of deps.strategies) {
        const sState = yield* Ref.get(strategy.stateRef);
        if (!sState.enabled) continue;

        const sCurrent = yield* Ref.get(deps.stateRef);
        if (!sCurrent.tradingActive) continue;
        if (strategy.name === "efficiency" && sCurrent.efficiencyIncidentBlocked) {
          if (sCurrent.efficiencyIncidentCooldownUntil > 0 && now >= sCurrent.efficiencyIncidentCooldownUntil) {
            yield* Ref.update(deps.stateRef, (s) => ({
              ...s,
              efficiencyIncidentBlocked: false,
              efficiencyIncidentCooldownUntil: 0,
            }));
            yield* Effect.log(`${deps.logPrefix} Efficiency cooldown expired — auto-unblocking`);
          } else {
            yield* Ref.update(strategy.stateRef, (s) => ({
              ...s,
              status: "regime_blocked" as const,
              statusReason: "Blocked: unresolved efficiency dual-leg incident",
            }));
            yield* emitPreflightReject(strategy.name, String(now), {
              reason: "efficiency_incident_blocked",
              gate: "efficiency_incident_blocked",
            });
            continue;
          }
        }

        const regimeCheck = shouldRunInRegime(sState.regimeFilter, regime);
        if (!regimeCheck.allowed) {
          yield* Ref.update(strategy.stateRef, (s) => ({
            ...s,
            status: "regime_blocked" as const,
            statusReason: regimeCheck.reason,
          }));
          yield* emitPreflightReject(strategy.name, String(now), {
            reason: regimeCheck.reason ?? "regime_blocked",
            gate: "regime_filter",
            regimeFilter: { ...sState.regimeFilter },
          });
          continue;
        }

        if (sState.lossCooldownUntil > 0 && now < sState.lossCooldownUntil) {
          const remainingMin = Math.ceil((sState.lossCooldownUntil - now) / 60_000);
          yield* Ref.update(strategy.stateRef, (s) => ({
            ...s,
            status: "regime_blocked" as const,
            statusReason: `Loss cooldown: ${remainingMin}min remaining (${sState.consecutiveLosses} consecutive losses)`,
          }));
          yield* emitPreflightReject(strategy.name, String(now), {
            reason: "loss_cooldown_active",
            gate: "loss_cooldown",
            remainingMin,
            consecutiveLosses: sState.consecutiveLosses,
          });
          continue;
        }
        if (sState.lossCooldownUntil > 0 && now >= sState.lossCooldownUntil) {
          yield* Ref.update(strategy.stateRef, (s) => ({
            ...s,
            consecutiveLosses: 0,
            lossCooldownUntil: 0,
          }));
        }

        const cooldownMs = deps.strategyCooldownMs[strategy.name] ?? 3000;
        const lastExec = sCurrent.lastStrategyExecution.get(strategy.name) ?? 0;
        if (now - lastExec < cooldownMs) {
          yield* emitPreflightReject(strategy.name, String(now), {
            reason: "strategy_cooldown_active",
            gate: "strategy_cooldown",
            cooldownMs,
            elapsedMs: now - lastExec,
          });
          continue;
        }

        // Read from the strategy's own config (set via UI) first; fall back to the hardcoded constant.
        const maxEntries = (sState.config["maxEntriesPerWindow"] as number | undefined)
          ?? deps.maxEntriesPerWindow[strategy.name]
          ?? 2;
        const entries = sCurrent.entriesThisWindow.get(strategy.name) ?? 0;
        if (entries >= maxEntries) {
          yield* emitPreflightReject(strategy.name, String(now), {
            reason: "max_entries_per_window_reached",
            gate: "max_entries_per_window",
            entries,
            maxEntries,
          });
          continue;
        }

        if (isPtbCheckRelevant(strategy.name, sState.config, ctx)) {
          const reason = ctx.currentWindow?.priceToBeatReason ?? "price_to_beat_unavailable";
          yield* Ref.update(deps.stateRef, (stUpd) => {
            deps.bumpDiag(stUpd, strategy.name, "riskRejected", 1, isShadow);
            return stUpd;
          });
          const conditionId = ctx.currentWindow?.conditionId ?? "no_window";
          if (shouldEmitPtbReject(strategy.name, conditionId, reason, now)) {
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
              `${deps.logPrefix} ${strategy.name} skipped: priceToBeat unavailable (${reason})`,
            );
          }
          continue;
        }

        if (!isShadow && strategy.name === "whale-hunt") {
          const latency = sCurrent.metrics.latency;
          const observedLatencyMs = Math.max(latency.lastSignalToSubmitMs, latency.avgRecentSignalToSubmitMs);
          if (observedLatencyMs > 0) {
            const requiredLeadMs = computeLatencyGuardLeadMs(observedLatencyMs, deps.whaleHuntConfig);
            if (ctx.windowRemainingMs <= requiredLeadMs) {
              yield* Ref.update(strategy.stateRef, (s) => ({
                ...s,
                status: "watching" as const,
                statusReason: `Latency guard (${Math.round(observedLatencyMs)}ms latency, ${Math.round(ctx.windowRemainingMs)}ms left)`,
              }));
              yield* Ref.update(deps.stateRef, (stUpd) => {
                deps.bumpDiag(stUpd, strategy.name, "riskRejected", 1, false);
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
                mode: "live",
                payload: {
                  reason: "latency_guard",
                  gate: "latency_guard",
                  observedLatencyMs: Math.round(observedLatencyMs),
                  requiredLeadMs: Math.round(requiredLeadMs),
                  windowRemainingMs: Math.round(ctx.windowRemainingMs),
                },
              });
              yield* Effect.log(
                `${deps.logPrefix} whale-hunt skipped: latency ${Math.round(observedLatencyMs)}ms, remaining ${Math.round(ctx.windowRemainingMs)}ms, required lead ${Math.round(requiredLeadMs)}ms`,
              );
              continue;
            }
          }
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
            yield* emitPreflightReject(strategy.name, String(signal.timestamp), {
              reason: "per_side_entry_limit_reached",
              gate: "per_side_entries",
              side: signal.side,
              sideEntries,
              perSideMax,
            });
            yield* Effect.log(
              `${deps.logPrefix} ${strategy.name} ${signal.side} skipped: side entry limit reached (${sideEntries}/${perSideMax})`,
            );
            continue;
          }
        }

        const allowSameSideStacking = (sState.config["allowSameSideStacking"] ?? 0) >= 1;
        const configuredMaxSameSide = Math.max(1, Math.floor(sState.config["maxSameSideEntriesPerWindow"] ?? 1));
        const maxSameSideEntries = allowSameSideStacking ? configuredMaxSameSide : 1;
        const sideKey = `${strategy.name}:${signal.side}`;
        const sideEntries = sCurrent.entriesThisWindow.get(sideKey) ?? 0;
        if (sideEntries >= maxSameSideEntries) {
          yield* Ref.update(deps.stateRef, (stUpd) => {
            deps.bumpDiag(stUpd, strategy.name, "riskRejected", 1, isShadow);
            return stUpd;
          });
          yield* deps.obs({
            category: "signal",
            source: "engine",
            action: "signal_rejected_preflight",
            entityType: "signal",
            entityId: `${strategy.name}:${signal.timestamp}`,
            status: "rejected",
            strategy: strategy.name,
            mode: isShadow ? "shadow" : "live",
            payload: {
              reason: "same_window_stack_blocked",
              gate: "same_window_stack_blocked",
              side: signal.side,
              sideEntries,
              maxSameSideEntries,
            },
          });
          yield* Effect.log(
            `${deps.logPrefix} ${strategy.name} ${signal.side} skipped: same-window side stacking blocked (${sideEntries}/${maxSameSideEntries})`,
          );
          continue;
        }

        const ptbDistancePct = getPtbDistancePct(ctx);
        const basePtbDistancePct = Math.max(0, sState.config["minPtbDistancePct"] ?? 0);
        const ptbChopMultiplier = regime.trendRegime === "chop" ? 1.75 : 1;
        const minPtbDistancePct = basePtbDistancePct * ptbChopMultiplier;
        if (minPtbDistancePct > 0 && ptbDistancePct < minPtbDistancePct) {
          yield* Ref.update(deps.stateRef, (stUpd) => {
            deps.bumpDiag(stUpd, strategy.name, "riskRejected", 1, isShadow);
            return stUpd;
          });
          yield* deps.obs({
            category: "signal",
            source: "engine",
            action: "signal_rejected_preflight",
            entityType: "signal",
            entityId: `${strategy.name}:${signal.timestamp}`,
            status: "rejected",
            strategy: strategy.name,
            mode: isShadow ? "shadow" : "live",
            payload: {
              reason: "ptb_too_close",
              gate: "ptb_distance",
              ptbDistancePct,
              minPtbDistancePct,
            },
          });
          continue;
        }

        if (regime.trendRegime === "chop" && CHOP_SENSITIVE_STRATEGIES.has(strategy.name)) {
          const baseChopFloor = clamp(sState.config["chopConfidenceFloor"] ?? 0.55, 0, 1);
          const downChopFloor = clamp(sState.config["downChopConfidenceFloor"] ?? baseChopFloor, 0, 1);
          const chopConfidenceFloor = signal.side === "DOWN" ? Math.max(baseChopFloor, downChopFloor) : baseChopFloor;
          if (signal.confidence < chopConfidenceFloor) {
            yield* Ref.update(deps.stateRef, (stUpd) => {
              deps.bumpDiag(stUpd, strategy.name, "riskRejected", 1, isShadow);
              return stUpd;
            });
            yield* deps.obs({
              category: "signal",
              source: "engine",
              action: "signal_rejected_preflight",
              entityType: "signal",
              entityId: `${strategy.name}:${signal.timestamp}`,
              status: "rejected",
              strategy: strategy.name,
              mode: isShadow ? "shadow" : "live",
              payload: {
                reason: "chop_confidence_too_low",
                gate: "chop_confidence_floor",
                confidence: signal.confidence,
                required: chopConfidenceFloor,
                side: signal.side,
              },
            });
            continue;
          }
        }

        if (signal.side === "DOWN" && strategy.name === "momentum") {
          const downMinTrendStrength = Math.max(0, sState.config["downMinTrendStrength"] ?? 0);
          const currentTrendStrength = regime.trendStrength ?? 0;
          if (downMinTrendStrength > 0 && currentTrendStrength < downMinTrendStrength && regime.trendRegime === "chop") {
            yield* Ref.update(deps.stateRef, (stUpd) => {
              deps.bumpDiag(stUpd, strategy.name, "riskRejected", 1, isShadow);
              return stUpd;
            });
            yield* deps.obs({
              category: "signal",
              source: "engine",
              action: "signal_rejected_preflight",
              entityType: "signal",
              entityId: `${strategy.name}:${signal.timestamp}`,
              status: "rejected",
              strategy: strategy.name,
              mode: isShadow ? "shadow" : "live",
              payload: {
                reason: "down_trend_strength_too_low",
                gate: "down_min_trend_strength",
                trendStrength: currentTrendStrength,
                required: downMinTrendStrength,
              },
            });
            yield* Effect.log(
              `${deps.logPrefix} momentum DOWN skipped: trendStrength ${currentTrendStrength.toFixed(4)} < ${downMinTrendStrength} in chop`,
            );
            continue;
          }

          const spreadRegimeRank = regime.spreadRegime === "tight" ? 0
            : regime.spreadRegime === "normal" ? 1
            : regime.spreadRegime === "wide" ? 2
            : 3;
          const downMaxSpreadRegime = Math.floor(sState.config["downMaxSpreadRegime"] ?? 2);
          if (spreadRegimeRank > downMaxSpreadRegime) {
            yield* Ref.update(deps.stateRef, (stUpd) => {
              deps.bumpDiag(stUpd, strategy.name, "riskRejected", 1, isShadow);
              return stUpd;
            });
            yield* deps.obs({
              category: "signal",
              source: "engine",
              action: "signal_rejected_preflight",
              entityType: "signal",
              entityId: `${strategy.name}:${signal.timestamp}`,
              status: "rejected",
              strategy: strategy.name,
              mode: isShadow ? "shadow" : "live",
              payload: {
                reason: "down_spread_too_wide",
                gate: "down_max_spread_regime",
                spreadRegime: regime.spreadRegime,
                maxAllowed: downMaxSpreadRegime,
              },
            });
            yield* Effect.log(
              `${deps.logPrefix} momentum DOWN skipped: spread regime ${regime.spreadRegime} exceeds limit`,
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
            windowRemainingMs: ctx.windowRemainingMs,
            windowRemainingBucket: bucketWindowRemainingMs(ctx.windowRemainingMs),
            ptbDistancePct,
            sideSpreadPct: getSideSpreadPct(ctx, signal.side),
            regimeTrend: regime.trendRegime,
            regimeVolatility: regime.volatilityRegime,
            telemetry: signal.telemetry ? { ...signal.telemetry } : null,
          },
        });

        if (signal.strategy === "momentum") {
          signal.maxPrice = deps.adjustMomentumMaxPrice(signal, regime, ctx, sState.config);
        }
        const maxExecutionPrice = sState.config["maxExecutionPrice"];
        if (typeof maxExecutionPrice === "number" && Number.isFinite(maxExecutionPrice) && maxExecutionPrice > 0) {
          signal.maxPrice = Math.min(signal.maxPrice, maxExecutionPrice);
        }

        const sideSpreadPct = getSideSpreadPct(ctx, signal.side);
        const spreadPenaltyK = Math.max(0, sState.config["spreadPenaltyK"] ?? 8);
        const spreadQuality = sideSpreadPct === null ? 1 : clamp(1 - sideSpreadPct * spreadPenaltyK, 0.4, 1.1);
        const ptbReference = Math.max(minPtbDistancePct, 0.01);
        const ptbQuality = minPtbDistancePct > 0 ? clamp(ptbDistancePct / ptbReference, 0.4, 1.2) : 1;
        const confidenceQuality = clamp(signal.confidence, 0.35, 1.1);
        const baseChopMultiplier = clamp(sState.config["chopSizeMultiplier"] ?? 0.75, 0.1, 1);
        const downChopMultiplier = clamp(sState.config["chopDownSizeMultiplier"] ?? baseChopMultiplier, 0.1, 1);
        const chopSizeMultiplier =
          regime.trendRegime === "chop" && CHOP_SENSITIVE_STRATEGIES.has(strategy.name)
            ? (signal.side === "DOWN" ? Math.min(baseChopMultiplier, downChopMultiplier) : baseChopMultiplier)
            : 1;
        const qualityMinMultiplier = clamp(sState.config["qualityMinMultiplier"] ?? 0.5, 0.1, 1);
        const qualityMaxMultiplier = clamp(sState.config["qualityMaxMultiplier"] ?? 1.15, qualityMinMultiplier, 2);
        const qualityMultiplier = clamp(
          confidenceQuality * ptbQuality * spreadQuality * chopSizeMultiplier,
          qualityMinMultiplier,
          qualityMaxMultiplier,
        );
        signal.size = Math.max(0.01, Math.round(signal.size * qualityMultiplier * 100) / 100);

        // Skip signal immediately if our limit price is below the current best ask.
        // The scale loop only reduces size, never price — all FOK/FAK attempts at
        // this price would fail for the same reason, wasting CLOB calls and backoff.
        const bestAskForSide = signal.side === "UP" ? ctx.orderBook.bestAskUp : ctx.orderBook.bestAskDown;
        if (bestAskForSide !== null && signal.maxPrice < bestAskForSide) {
          yield* Ref.update(deps.stateRef, (stUpd) => {
            deps.bumpDiag(stUpd, strategy.name, "riskRejected", 1, isShadow);
            return stUpd;
          });
          yield* deps.obs({
            category: "signal",
            source: "engine",
            action: "signal_rejected_preflight",
            entityType: "signal",
            entityId: `${strategy.name}:${signal.timestamp}`,
            status: "rejected",
            strategy: strategy.name,
            mode: isShadow ? "shadow" : "live",
            payload: {
              reason: "price_too_high",
              gate: "max_price_vs_best_ask",
              maxPrice: signal.maxPrice,
              bestAsk: bestAskForSide,
            },
          });
          yield* Effect.log(
            `${deps.logPrefix} ${strategy.name} ${signal.side} skipped: maxPrice $${signal.maxPrice.toFixed(2)} < bestAsk $${bestAskForSide.toFixed(2)}`,
          );
          continue;
        }

        // Don't overpay — buy at best available price, capped by maxPrice
        if (bestAskForSide !== null && signal.maxPrice > bestAskForSide) {
          signal.maxPrice = bestAskForSide;
        }

        yield* Ref.update(deps.stateRef, (stUpd) => {
          deps.bumpDiag(stUpd, strategy.name, "signals", 1, isShadow);
          return stUpd;
        });

        const configuredTradeSize = signal.size;
        const recentPrices = yield* deps.getRecentPrices(ctx.windowDurationMs, "binance");

        const strategyMetrics = sCurrent.metrics.reconciliation.strategies.find((m) => m.strategy === strategy.name);
        // Live sizing is intentionally based only on live execution stats and only
        // after enough submitted live samples; shadow metrics are excluded.
        const useLivePerformanceSizing =
          !isShadow &&
          strategyMetrics !== undefined &&
          strategyMetrics.liveSubmitted >= deps.whaleHuntConfig.minLiveSubmittedForSizing;
        const winRate = useLivePerformanceSizing ? strategyMetrics?.liveWinRate : undefined;
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
          yield* Effect.log(`${deps.logPrefix} Risk rejected ${signal.strategy}: ${check.reason}`);
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

        const execution = yield* deps.executeStrategy(signal, isShadow, ctx, entryContext);
        const executed = execution.executed;
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
            rejectClass: execution.rejectClass ?? null,
            rejectReason: execution.rejectReason ?? null,
            regimeTrend: regime.trendRegime,
            regimeTrendStrength: regime.trendStrength ?? null,
            regimeVolatility: regime.volatilityRegime,
            regimeLiquidity: regime.liquidityRegime,
            regimeSpread: regime.spreadRegime,
            trendSampleCount: regime.trendSampleCount ?? null,
            trendSlope: regime.trendSlope ?? null,
            trendResidualStddev: regime.trendResidualStddev ?? null,
          },
        });
        if (executed) {
          yield* Ref.update(deps.stateRef, (s) => {
            const newMap = new Map(s.entriesThisWindow);
            newMap.set(strategy.name, (newMap.get(strategy.name) ?? 0) + 1);
            const sideKey = `${strategy.name}:${signal.side}`;
            newMap.set(sideKey, (newMap.get(sideKey) ?? 0) + 1);
            return { ...s, entriesThisWindow: newMap };
          });
        }
      }
    });
}

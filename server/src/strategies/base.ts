import { Effect, Ref } from "effect";
import type { MarketContext, Signal, TradeRecord, StrategyState, RegimeState, RegimeFilter } from "../types.js";

export interface StrategyInternalState {
  enabled: boolean;
  status: "idle" | "watching" | "trading" | "regime_blocked";
  statusReason: string | null;
  lastSignal: Signal | null;
  config: Record<string, number>;
  wins: number;
  losses: number;
  totalPnl: number;
  regimeBlockReason: string | null;
  regimeFilter: RegimeFilter;
}

export interface Strategy {
  readonly name: string;
  readonly evaluate: (ctx: MarketContext) => Effect.Effect<Signal | null>;
  readonly getState: Effect.Effect<StrategyState>;
  readonly onTrade: (trade: TradeRecord) => Effect.Effect<void>;
  readonly updateConfig: (newConfig: Record<string, unknown>) => Effect.Effect<StrategyConfigUpdateResult>;
  readonly updateRegimeFilter: (filter: RegimeFilter) => Effect.Effect<void>;
  readonly setEnabled: (enabled: boolean) => Effect.Effect<void>;
  readonly stateRef: Ref.Ref<StrategyInternalState>;
}

export interface StrategyConfigUpdateResult {
  ok: boolean;
  appliedKeys: string[];
  rejectedKeys: string[];
  error?: string;
}

export function shouldRunInRegime(filter: RegimeFilter, regime: RegimeState): { allowed: boolean; reason: string | null } {
  if (filter.allowedVolatility && !filter.allowedVolatility.includes(regime.volatilityRegime)) {
    return { allowed: false, reason: `Vol: ${regime.volatilityRegime}` };
  }
  if (filter.allowedTrend && !filter.allowedTrend.includes(regime.trendRegime)) {
    return { allowed: false, reason: `Trend: ${regime.trendRegime}` };
  }
  if (filter.allowedLiquidity && !filter.allowedLiquidity.includes(regime.liquidityRegime)) {
    return { allowed: false, reason: `Liquidity: ${regime.liquidityRegime}` };
  }
  if (filter.allowedSpread && !filter.allowedSpread.includes(regime.spreadRegime)) {
    return { allowed: false, reason: `Spread: ${regime.spreadRegime}` };
  }
  return { allowed: true, reason: null };
}

export function makeStrategyBase(
  name: string,
  defaultConfig: Record<string, number>,
  defaultRegimeFilter: RegimeFilter,
  ref: Ref.Ref<StrategyInternalState>,
) {
  const getState: Effect.Effect<StrategyState> = Ref.get(ref).pipe(
    Effect.map((s) => ({
      name,
      enabled: s.enabled,
      status: s.status,
      statusReason: s.statusReason,
      lastSignal: s.lastSignal,
      config: { ...s.config },
      wins: s.wins,
      losses: s.losses,
      totalPnl: s.totalPnl,
      regimeBlockReason: s.regimeBlockReason,
      regimeFilter: {
        allowedVolatility: s.regimeFilter.allowedVolatility ? [...s.regimeFilter.allowedVolatility] : undefined,
        allowedTrend: s.regimeFilter.allowedTrend ? [...s.regimeFilter.allowedTrend] : undefined,
        allowedLiquidity: s.regimeFilter.allowedLiquidity ? [...s.regimeFilter.allowedLiquidity] : undefined,
        allowedSpread: s.regimeFilter.allowedSpread ? [...s.regimeFilter.allowedSpread] : undefined,
      },
    })),
  );

  const onTrade = (trade: TradeRecord) =>
    Ref.update(ref, (s) => {
      if (trade.strategy !== name) return s;
      if (trade.outcome === "win") {
        return { ...s, wins: s.wins + 1, totalPnl: s.totalPnl + trade.pnl };
      } else if (trade.outcome === "loss") {
        return { ...s, losses: s.losses + 1, totalPnl: s.totalPnl + trade.pnl };
      }
      return s;
    });

  const updateConfig = (newConfig: Record<string, unknown>) =>
    Ref.modify(ref, (s): readonly [StrategyConfigUpdateResult, StrategyInternalState] => {
      const keys = Object.keys(newConfig);
      if (keys.length === 0) {
        return [{ ok: false, appliedKeys: [], rejectedKeys: [], error: "Empty config payload" }, s] as const;
      }
      const validated: Record<string, number> = {};
      const appliedKeys: string[] = [];
      const rejectedKeys: string[] = [];
      for (const [key, value] of Object.entries(newConfig)) {
        if (!(key in s.config)) {
          rejectedKeys.push(key);
          continue;
        }
        const num = Number(value);
        if (!Number.isFinite(num) || num < 0 || num > 1_000_000) {
          rejectedKeys.push(key);
          continue;
        }
        validated[key] = num;
        appliedKeys.push(key);
      }
      if (appliedKeys.length === 0) {
        return [
          {
            ok: false,
            appliedKeys: [],
            rejectedKeys,
            error: rejectedKeys.length > 0 ? "No valid config keys were applied" : "Empty config payload",
          },
          s,
        ] as const;
      }
      return [
        { ok: true, appliedKeys, rejectedKeys },
        { ...s, config: { ...s.config, ...validated } },
      ] as const;
    });

  const updateRegimeFilter = (filter: RegimeFilter) =>
    Ref.update(ref, (s) => ({ ...s, regimeFilter: { ...filter } }));

  const setEnabled = (enabled: boolean) =>
    Ref.update(ref, (s) => ({ ...s, enabled }));

  return { getState, onTrade, updateConfig, updateRegimeFilter, setEnabled };
}

export function makeInitialState(
  config: Record<string, number>,
  regimeFilter: RegimeFilter,
): StrategyInternalState {
  return {
    enabled: false,
    status: "idle",
    statusReason: null,
    lastSignal: null,
    config: { ...config },
    wins: 0,
    losses: 0,
    totalPnl: 0,
    regimeBlockReason: null,
    regimeFilter: { ...regimeFilter },
  };
}

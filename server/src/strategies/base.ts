import type { MarketContext, Signal, TradeRecord, StrategyState, RegimeState, RegimeFilter } from "../types.js";

export abstract class BaseStrategy {
  abstract readonly name: string;
  enabled = false;
  status: "idle" | "watching" | "trading" | "regime_blocked" = "idle";
  config: Record<string, number> = {};
  lastSignal: Signal | null = null;
  statusReason: string | null = null;
  regimeFilter: RegimeFilter = {};
  regimeBlockReason: string | null = null;
  wins = 0;
  losses = 0;
  totalPnl = 0;

  abstract evaluate(ctx: MarketContext): Signal | null;

  shouldRunInRegime(regime: RegimeState): boolean {
    const f = this.regimeFilter;

    if (f.allowedVolatility && !f.allowedVolatility.includes(regime.volatilityRegime)) {
      this.regimeBlockReason = `Vol: ${regime.volatilityRegime}`;
      return false;
    }
    if (f.allowedTrend && !f.allowedTrend.includes(regime.trendRegime)) {
      this.regimeBlockReason = `Trend: ${regime.trendRegime}`;
      return false;
    }
    if (f.allowedLiquidity && !f.allowedLiquidity.includes(regime.liquidityRegime)) {
      this.regimeBlockReason = `Liquidity: ${regime.liquidityRegime}`;
      return false;
    }
    if (f.allowedSpread && !f.allowedSpread.includes(regime.spreadRegime)) {
      this.regimeBlockReason = `Spread: ${regime.spreadRegime}`;
      return false;
    }

    this.regimeBlockReason = null;
    return true;
  }

  onTrade(trade: TradeRecord): void {
    if (trade.strategy !== this.name) return;
    if (trade.outcome === "win") {
      this.wins++;
      this.totalPnl += trade.pnl;
    } else if (trade.outcome === "loss") {
      this.losses++;
      this.totalPnl += trade.pnl;
    }
  }

  getWinRate(): number {
    const total = this.wins + this.losses;
    return total > 0 ? (this.wins / total) * 100 : 0;
  }

  getState(): StrategyState {
    return {
      name: this.name,
      enabled: this.enabled,
      status: this.status,
      statusReason: this.statusReason,
      lastSignal: this.lastSignal,
      config: { ...this.config },
      wins: this.wins,
      losses: this.losses,
      totalPnl: this.totalPnl,
      regimeBlockReason: this.regimeBlockReason,
      regimeFilter: {
        allowedVolatility: this.regimeFilter.allowedVolatility ? [...this.regimeFilter.allowedVolatility] : undefined,
        allowedTrend: this.regimeFilter.allowedTrend ? [...this.regimeFilter.allowedTrend] : undefined,
        allowedLiquidity: this.regimeFilter.allowedLiquidity ? [...this.regimeFilter.allowedLiquidity] : undefined,
        allowedSpread: this.regimeFilter.allowedSpread ? [...this.regimeFilter.allowedSpread] : undefined,
      },
    };
  }

  updateRegimeFilter(filter: RegimeFilter): void {
    this.regimeFilter = { ...filter };
  }

  updateConfig(newConfig: Record<string, unknown>): boolean {
    const validated: Record<string, number> = {};
    for (const [key, value] of Object.entries(newConfig)) {
      if (!(key in this.config)) continue;
      const num = Number(value);
      if (!Number.isFinite(num) || num < 0 || num > 1_000_000) return false;
      validated[key] = num;
    }
    this.config = { ...this.config, ...validated };
    return true;
  }
}

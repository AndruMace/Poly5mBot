import { BaseStrategy } from "./base.js";
import { effectiveFeeRate } from "../polymarket/orders.js";
import type { MarketContext, Signal } from "../types.js";

/**
 * Strategy 2: Market Efficiency Arbitrage (Yes + No < $1.00)
 *
 * When the sum of best ask prices for Up and Down contracts is less than
 * $1.00 minus fees, buy both sides to lock in a risk-free profit.
 */
export class EfficiencyStrategy extends BaseStrategy {
  readonly name = "efficiency";

  constructor() {
    super();
    this.config = {
      minProfitBps: 8,
      tradeSize: 20,
    };
    this.regimeFilter = {
      allowedLiquidity: ["thin", "normal", "deep"],
      allowedSpread: ["tight", "normal", "wide", "blowout"],
    };
  }

  evaluate(ctx: MarketContext): Signal | null {
    if (!ctx.currentWindow) return null;

    const { bestAskUp, bestAskDown } = ctx.orderBook;
    if (bestAskUp === null || bestAskDown === null) return null;

    this.status = "watching";

    const totalCost = bestAskUp + bestAskDown;
    if (totalCost >= 1.0) return null;

    const feeUp = effectiveFeeRate(bestAskUp);
    const feeDown = effectiveFeeRate(bestAskDown);
    const totalFees = feeUp + feeDown;

    const netProfit = 1.0 - totalCost - totalFees;
    const profitBps = netProfit * 10000;

    if (profitBps < this.config["minProfitBps"]!) return null;

    this.status = "trading";
    const signal: Signal = {
      side: "UP",
      confidence: Math.min(1, profitBps / 200),
      size: this.config["tradeSize"]!,
      maxPrice: bestAskUp,
      strategy: this.name,
      reason: `Sum=${totalCost.toFixed(4)}, profit=${profitBps.toFixed(0)}bps after fees`,
      timestamp: Date.now(),
    };
    this.lastSignal = signal;
    return signal;
  }
}

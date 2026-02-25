import { BaseStrategy } from "./base.js";
import type { MarketContext, Signal } from "../types.js";

/**
 * Strategy 1: Price Feed Discrepancy Arbitrage
 *
 * Exploits the lag between leading exchange prices (Binance) and the
 * aggregated oracle estimate (Chainlink proxy). When Binance moves sharply
 * in a direction the oracle hasn't yet reflected, front-run the oracle
 * by buying the expected outcome on Polymarket.
 */
export class ArbStrategy extends BaseStrategy {
  readonly name = "arb";

  constructor() {
    super();
    this.config = {
      minSpreadPct: 0.015,
      maxOracleAgeSec: 2,
      confidenceMultiplier: 1.2,
      maxSharePrice: 0.7,
      tradeSize: 5,
      maxEntriesPerWindow: 3,
    };
    this.regimeFilter = {
      allowedVolatility: ["low", "normal", "high", "extreme"],
      allowedSpread: ["tight", "normal", "wide"],
    };
  }

  evaluate(ctx: MarketContext): Signal | null {
    if (!ctx.currentWindow || !ctx.priceToBeat) return null;

    const binance = ctx.prices["binance"];
    if (!binance) return null;

    this.status = "watching";

    const oraclePrice = ctx.oracleEstimate;
    if (oraclePrice <= 0) return null;

    const spreadPct =
      ((binance.price - oraclePrice) / oraclePrice) * 100;
    const absSpread = Math.abs(spreadPct);

    if (absSpread < this.config["minSpreadPct"]!) return null;

    const side: "UP" | "DOWN" = spreadPct > 0 ? "UP" : "DOWN";

    const confidence = Math.min(
      1,
      (absSpread / this.config["minSpreadPct"]!) *
        (1 / this.config["confidenceMultiplier"]!),
    );

    const priceToBeat = ctx.priceToBeat;
    const btcDelta = ((binance.price - priceToBeat) / priceToBeat) * 100;

    let predictedSide: "UP" | "DOWN";
    if (side === "UP" && btcDelta > 0) {
      predictedSide = "UP";
    } else if (side === "DOWN" && btcDelta < 0) {
      predictedSide = "DOWN";
    } else {
      return null;
    }

    const maxPrice = this.config["maxSharePrice"] ?? 0.7;

    this.status = "trading";
    const signal: Signal = {
      side: predictedSide,
      confidence,
      size: this.config["tradeSize"]!,
      maxPrice,
      strategy: this.name,
      reason: `Binance ${spreadPct > 0 ? "leads" : "lags"} oracle by ${absSpread.toFixed(3)}%`,
      timestamp: Date.now(),
    };
    this.lastSignal = signal;
    return signal;
  }
}

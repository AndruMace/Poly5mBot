import { BaseStrategy } from "./base.js";
import type { MarketContext, Signal, PricePoint } from "../types.js";

/**
 * Strategy 1: Price Feed Discrepancy Arbitrage
 *
 * Exploits sustained divergence between the leading exchange (Binance)
 * and the oracle aggregate. Key safeguards vs the original:
 *
 *   - Higher spread threshold (0.04%) to filter exchange noise
 *   - Requires the spread to persist across multiple ticks
 *   - Requires at least one other exchange to confirm Binance's direction
 *   - Time-gated: only trades after 60s into the window (direction clearer)
 *   - Lower max share price (0.55) for better risk/reward
 */
export class ArbStrategy extends BaseStrategy {
  readonly name = "arb";
  private spreadHistory: Array<{ side: "UP" | "DOWN"; ts: number }> = [];

  constructor() {
    super();
    this.config = {
      minSpreadPct: 0.04,
      persistenceMs: 3000,
      persistenceCount: 4,
      minConfirmingExchanges: 1,
      minWindowElapsedSec: 60,
      maxWindowElapsedSec: 270,
      maxSharePrice: 0.55,
      maxOracleAgeSec: 5,
      tradeSize: 5,
      maxEntriesPerWindow: 2,
    };
    this.regimeFilter = {
      allowedVolatility: ["low", "normal", "high"],
      allowedSpread: ["tight", "normal"],
    };
  }

  evaluate(ctx: MarketContext): Signal | null {
    if (!ctx.currentWindow || !ctx.priceToBeat) return null;

    const elapsedSec = ctx.windowElapsedMs / 1000;
    if (elapsedSec < this.config["minWindowElapsedSec"]!) return null;
    if (elapsedSec > this.config["maxWindowElapsedSec"]!) return null;

    const binance = ctx.prices["binance"];
    if (!binance) return null;

    this.status = "watching";

    const oraclePrice = ctx.oracleEstimate;
    if (oraclePrice <= 0) return null;

    const maxOracleAgeMs = (this.config["maxOracleAgeSec"] ?? 5) * 1000;
    if (ctx.oracleTimestamp > 0 && Date.now() - ctx.oracleTimestamp > maxOracleAgeMs) {
      this.statusReason = `Oracle stale (${((Date.now() - ctx.oracleTimestamp) / 1000).toFixed(1)}s > ${this.config["maxOracleAgeSec"]}s)`;
      return null;
    }

    const spreadPct =
      ((binance.price - oraclePrice) / oraclePrice) * 100;
    const absSpread = Math.abs(spreadPct);

    if (absSpread < this.config["minSpreadPct"]!) {
      this.spreadHistory = [];
      return null;
    }

    const side: "UP" | "DOWN" = spreadPct > 0 ? "UP" : "DOWN";

    // Binance must agree with direction relative to priceToBeat
    const btcDelta = ((binance.price - ctx.priceToBeat) / ctx.priceToBeat) * 100;
    if (side === "UP" && btcDelta <= 0) return null;
    if (side === "DOWN" && btcDelta >= 0) return null;

    // Track spread persistence — same direction must hold for N ticks over M ms
    const now = Date.now();
    this.spreadHistory.push({ side, ts: now });
    const cutoff = now - this.config["persistenceMs"]!;
    this.spreadHistory = this.spreadHistory.filter((s) => s.ts > cutoff);

    const sameSideCount = this.spreadHistory.filter((s) => s.side === side).length;
    if (sameSideCount < this.config["persistenceCount"]!) {
      this.statusReason = `Waiting for spread persistence (${sameSideCount}/${this.config["persistenceCount"]!})`;
      return null;
    }

    // Require at least N other exchanges to confirm Binance's direction
    const confirmers = this.countConfirmingExchanges(ctx, side);
    if (confirmers < this.config["minConfirmingExchanges"]!) {
      this.statusReason = `Insufficient exchange confirmation (${confirmers}/${this.config["minConfirmingExchanges"]!})`;
      return null;
    }

    const confidence = Math.min(
      1,
      (absSpread / this.config["minSpreadPct"]!) * 0.6 +
        (confirmers / 4) * 0.4,
    );

    const maxPrice = this.config["maxSharePrice"] ?? 0.55;

    this.status = "trading";
    this.spreadHistory = [];
    const signal: Signal = {
      side,
      confidence,
      size: this.config["tradeSize"]!,
      maxPrice,
      strategy: this.name,
      reason: `Binance ${spreadPct > 0 ? "leads" : "lags"} oracle by ${absSpread.toFixed(3)}% (${confirmers + 1} exchanges agree, persisted ${sameSideCount} ticks)`,
      timestamp: Date.now(),
    };
    this.lastSignal = signal;
    return signal;
  }

  private countConfirmingExchanges(
    ctx: MarketContext,
    side: "UP" | "DOWN",
  ): number {
    const others = ["bybit", "coinbase", "kraken", "okx"];
    let count = 0;
    const oracle = ctx.oracleEstimate;
    if (oracle <= 0) return 0;

    for (const name of others) {
      const feed = ctx.prices[name];
      if (!feed) continue;
      const feedSpread = ((feed.price - oracle) / oracle) * 100;
      if (side === "UP" && feedSpread > 0.01) count++;
      if (side === "DOWN" && feedSpread < -0.01) count++;
    }
    return count;
  }
}

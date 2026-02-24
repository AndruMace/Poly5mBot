import { EventEmitter } from "events";
import type { PricePoint } from "../types.js";

/**
 * Approximates the Chainlink BTC/USD Data Stream price.
 *
 * Chainlink reports a "Mid-price" — the consensus midpoint of bid/ask
 * across 16 oracle nodes. We replicate this by:
 *  1. Preferring (bid+ask)/2 from each exchange when available
 *  2. Falling back to last trade price when bid/ask unavailable
 *  3. Rejecting outliers beyond 0.15% from preliminary median
 *  4. Computing trimmed mean (drop highest + lowest) of remaining prices
 */
export class OracleApproximator extends EventEmitter {
  private prices: Map<string, PricePoint> = new Map();
  private estimate = 0;
  private emitTimer: ReturnType<typeof setInterval> | null = null;
  private sourceCount = 0;

  private static readonly STALE_MS = 10_000;
  private static readonly OUTLIER_PCT = 0.0015;

  start(): void {
    this.emitTimer = setInterval(() => this.computeAndEmit(), 100);
  }

  stop(): void {
    if (this.emitTimer) clearInterval(this.emitTimer);
  }

  update(point: PricePoint): void {
    this.prices.set(point.exchange, point);
  }

  getEstimate(): number {
    return this.estimate;
  }

  getSourceCount(): number {
    return this.sourceCount;
  }

  private static extractPrice(p: PricePoint): number {
    const bid = Number(p.bid);
    const ask = Number(p.ask);
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
      return (bid + ask) / 2;
    }
    return Number(p.price);
  }

  private computeAndEmit(): void {
    const now = Date.now();
    const recent: number[] = [];

    for (const p of this.prices.values()) {
      if (now - p.timestamp < OracleApproximator.STALE_MS && p.price > 0) {
        recent.push(OracleApproximator.extractPrice(p));
      }
    }

    if (recent.length === 0) return;

    recent.sort((a, b) => a - b);

    const prelimMedian = OracleApproximator.median(recent);

    const filtered = recent.filter((p) => {
      const deviation = Math.abs(p - prelimMedian) / prelimMedian;
      return deviation < OracleApproximator.OUTLIER_PCT;
    });

    const prices = filtered.length >= 3 ? filtered : recent;

    let result: number;
    if (prices.length >= 5) {
      const trimmed = prices.slice(1, -1);
      result = trimmed.reduce((s, v) => s + v, 0) / trimmed.length;
    } else if (prices.length >= 3) {
      result = OracleApproximator.median(prices);
    } else {
      result =
        prices.length === 2
          ? (prices[0]! + prices[1]!) / 2
          : prices[0]!;
    }

    result = Math.round(result * 100) / 100;

    this.sourceCount = prices.length;

    if (result !== this.estimate) {
      this.estimate = result;
      this.emit("estimate", {
        price: result,
        timestamp: now,
        sources: prices.length,
      });
    }
  }

  private static median(sorted: number[]): number {
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1]! + sorted[mid]!) / 2
      : sorted[mid]!;
  }
}

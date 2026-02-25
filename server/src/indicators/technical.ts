import { RSI as RSICalc, EMA } from "technicalindicators";
import type { PricePoint } from "../types.js";

export function computeRSI(prices: number[], period = 14): number | null {
  if (prices.length < period + 1) return null;
  const result = RSICalc.calculate({ values: prices, period });
  return result.length > 0 ? result[result.length - 1]! : null;
}

export function computeEMA(prices: number[], period = 14): number | null {
  if (prices.length < period) return null;
  const result = EMA.calculate({ values: prices, period });
  return result.length > 0 ? result[result.length - 1]! : null;
}

export function computeVolatility(prices: number[]): number {
  if (prices.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i]! - prices[i - 1]!) / prices[i - 1]!);
  }
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance =
    returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

/**
 * Builds candle close prices from raw multi-exchange price points.
 *
 * To avoid RSI instability from noisy multi-exchange data, we first
 * aggregate concurrent exchange prices into median snapshots (one per
 * sub-second bucket), then take the last snapshot's median as each
 * candle's close.
 */
export function buildCandles(
  points: PricePoint[],
  intervalMs: number,
): number[] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a.timestamp - b.timestamp);

  // Aggregate into ~500ms snapshots — take median of exchange prices
  const snapshots = aggregateSnapshots(sorted, 500);
  if (snapshots.length === 0) return [];

  const start = snapshots[0]!.ts;
  const candles: number[] = [];
  let bucketStart = start;
  let lastPrice = snapshots[0]!.price;

  for (const snap of snapshots) {
    if (snap.ts >= bucketStart + intervalMs) {
      candles.push(lastPrice);
      bucketStart += intervalMs * Math.floor((snap.ts - bucketStart) / intervalMs);
    }
    lastPrice = snap.price;
  }
  candles.push(lastPrice);

  return candles;
}

function aggregateSnapshots(
  sorted: PricePoint[],
  windowMs: number,
): Array<{ ts: number; price: number }> {
  const result: Array<{ ts: number; price: number }> = [];
  let bucketStart = sorted[0]!.timestamp;
  let bucketPrices: number[] = [];

  for (const p of sorted) {
    if (p.timestamp >= bucketStart + windowMs) {
      if (bucketPrices.length > 0) {
        bucketPrices.sort((a, b) => a - b);
        const mid = Math.floor(bucketPrices.length / 2);
        const median = bucketPrices.length % 2 === 0
          ? (bucketPrices[mid - 1]! + bucketPrices[mid]!) / 2
          : bucketPrices[mid]!;
        result.push({ ts: bucketStart, price: median });
      }
      bucketStart += windowMs * Math.floor((p.timestamp - bucketStart) / windowMs);
      bucketPrices = [];
    }
    bucketPrices.push(p.price);
  }
  if (bucketPrices.length > 0) {
    bucketPrices.sort((a, b) => a - b);
    const mid = Math.floor(bucketPrices.length / 2);
    const median = bucketPrices.length % 2 === 0
      ? (bucketPrices[mid - 1]! + bucketPrices[mid]!) / 2
      : bucketPrices[mid]!;
    result.push({ ts: bucketStart, price: median });
  }

  return result;
}

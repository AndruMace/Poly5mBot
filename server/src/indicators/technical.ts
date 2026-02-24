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

export function buildCandles(
  points: PricePoint[],
  intervalMs: number,
): number[] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a.timestamp - b.timestamp);
  const start = sorted[0]!.timestamp;
  const candles: number[] = [];
  let bucketStart = start;
  let bucketPrices: number[] = [];

  for (const p of sorted) {
    if (p.timestamp >= bucketStart + intervalMs) {
      if (bucketPrices.length > 0) {
        candles.push(bucketPrices[bucketPrices.length - 1]!);
      }
      bucketStart += intervalMs * Math.floor((p.timestamp - bucketStart) / intervalMs);
      bucketPrices = [];
    }
    bucketPrices.push(p.price);
  }
  if (bucketPrices.length > 0) {
    candles.push(bucketPrices[bucketPrices.length - 1]!);
  }

  return candles;
}

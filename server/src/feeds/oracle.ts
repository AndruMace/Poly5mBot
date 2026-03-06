import type { PricePoint } from "../types.js";
import { DEFAULT_EXCHANGE_WEIGHTS } from "./volume-weights.js";

const STALE_MS = 10_000;
const FRESH_MS = 5_000;
const OUTLIER_PCT = 0.0015;

function extractPrice(p: PricePoint): number {
  const bid = Number(p.bid);
  const ask = Number(p.ask);
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
    return (bid + ask) / 2;
  }
  return Number(p.price);
}

function weightedMean(
  pts: { exchange: string; price: number; staleFactor: number }[],
  weights: Record<string, number>,
): number {
  let wSum = 0, wTotal = 0;
  for (const { exchange, price, staleFactor } of pts) {
    const w = (weights[exchange] ?? 1.0) * staleFactor;
    wSum += price * w;
    wTotal += w;
  }
  return wTotal > 0 ? wSum / wTotal : 0;
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

export function computeOracleEstimate(
  prices: Map<string, PricePoint>,
  weights: Record<string, number> = DEFAULT_EXCHANGE_WEIGHTS,
): { price: number; sourceCount: number } {
  const now = Date.now();
  const recent: { exchange: string; price: number; staleFactor: number }[] = [];

  for (const p of prices.values()) {
    const age = now - p.timestamp;
    if (age < STALE_MS && p.price > 0) {
      const staleFactor = age <= FRESH_MS ? 1 : 1 - (age - FRESH_MS) / (STALE_MS - FRESH_MS);
      recent.push({ exchange: p.exchange, price: extractPrice(p), staleFactor });
    }
  }

  if (recent.length === 0) return { price: 0, sourceCount: 0 };

  recent.sort((a, b) => a.price - b.price);
  const prices_ = recent.map((r) => r.price);
  const prelimMedian = median(prices_);

  const filtered = recent.filter(({ price }) => {
    const deviation = Math.abs(price - prelimMedian) / prelimMedian;
    return deviation < OUTLIER_PCT;
  });

  const vals = filtered.length >= 3 ? filtered : recent;
  const result = weightedMean(vals, weights);

  return { price: Math.round(result * 100) / 100, sourceCount: vals.length };
}

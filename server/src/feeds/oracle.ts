import type { PricePoint } from "../types.js";

const STALE_MS = 10_000;
const OUTLIER_PCT = 0.0015;

function extractPrice(p: PricePoint): number {
  const bid = Number(p.bid);
  const ask = Number(p.ask);
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
    return (bid + ask) / 2;
  }
  return Number(p.price);
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

export function computeOracleEstimate(
  prices: Map<string, PricePoint>,
): { price: number; sourceCount: number } {
  const now = Date.now();
  const recent: number[] = [];

  for (const p of prices.values()) {
    if (now - p.timestamp < STALE_MS && p.price > 0) {
      recent.push(extractPrice(p));
    }
  }

  if (recent.length === 0) return { price: 0, sourceCount: 0 };

  recent.sort((a, b) => a - b);
  const prelimMedian = median(recent);

  const filtered = recent.filter((p) => {
    const deviation = Math.abs(p - prelimMedian) / prelimMedian;
    return deviation < OUTLIER_PCT;
  });

  const vals = filtered.length >= 3 ? filtered : recent;

  let result: number;
  if (vals.length >= 5) {
    const trimmed = vals.slice(1, -1);
    result = trimmed.reduce((s, v) => s + v, 0) / trimmed.length;
  } else if (vals.length >= 3) {
    result = median(vals);
  } else {
    result = vals.length === 2 ? (vals[0]! + vals[1]!) / 2 : vals[0]!;
  }

  return { price: Math.round(result * 100) / 100, sourceCount: vals.length };
}

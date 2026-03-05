import type { PricePoint } from "../types.js";

const STALE_MS = 10_000;
const OUTLIER_PCT = 0.0015;

const EXCHANGE_WEIGHTS: Record<string, number> = {
  binance:  4.0,
  bybit:    2.0,
  coinbase: 2.0,
  okx:      1.0,
  kraken:   1.0,
  bitstamp: 0.5,
};

function extractPrice(p: PricePoint): number {
  const bid = Number(p.bid);
  const ask = Number(p.ask);
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
    return (bid + ask) / 2;
  }
  return Number(p.price);
}

function weightedMean(pts: { exchange: string; price: number }[]): number {
  let wSum = 0, wTotal = 0;
  for (const { exchange, price } of pts) {
    const w = EXCHANGE_WEIGHTS[exchange] ?? 1.0;
    wSum += price * w;
    wTotal += w;
  }
  return wSum / wTotal;
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
  const recent: { exchange: string; price: number }[] = [];

  for (const p of prices.values()) {
    if (now - p.timestamp < STALE_MS && p.price > 0) {
      recent.push({ exchange: p.exchange, price: extractPrice(p) });
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
  const result = weightedMean(vals);

  return { price: Math.round(result * 100) / 100, sourceCount: vals.length };
}

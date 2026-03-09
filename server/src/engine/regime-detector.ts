import { Effect, Ref } from "effect";
import type { MarketContext, RegimeState, PricePoint } from "../types.js";

const VOL_THRESHOLDS = { low: 0.0003, normal: 0.001, high: 0.003 };
const VOL_SMOOTHING_ALPHA = 0.2;
const SPREAD_SMOOTHING_ALPHA = 0.3;
const TREND_STRONG = 1.2;
const TREND_WEAK_ENTER = 0.24;
const TREND_WEAK_EXIT = 0.34;
const TREND_LONG_CONFIRM_MIN = 0.18;
const TREND_SHORT_LOOKBACK_MS = 120_000;
const TREND_LONG_LOOKBACK_MS = 300_000;
const TREND_BUCKET_MS = 5000;

function buildMedianExchangeBuckets(
  priceBuffer: PricePoint[],
  lookbackMs: number,
  bucketMs: number,
): number[] {
  const cutoff = Date.now() - lookbackMs;
  const recent = priceBuffer.filter((p) => p.timestamp >= cutoff && Number.isFinite(p.price) && p.price > 0);
  if (recent.length === 0) return [];
  const sorted = [...recent].sort((a, b) => a.timestamp - b.timestamp);

  const rawBuckets: Array<Array<{ exchange: string; price: number }>> = [];
  let bucketStart = sorted[0]!.timestamp;
  let current: Array<{ exchange: string; price: number }> = [];
  for (const p of sorted) {
    if (p.timestamp - bucketStart >= bucketMs) {
      if (current.length > 0) rawBuckets.push(current);
      bucketStart = p.timestamp;
      current = [{ exchange: p.exchange, price: p.price }];
    } else {
      current.push({ exchange: p.exchange, price: p.price });
    }
  }
  if (current.length > 0) rawBuckets.push(current);

  const buckets: number[] = [];
  for (const bucket of rawBuckets) {
    const byExchange = new Map<string, number[]>();
    for (const pt of bucket) {
      let arr = byExchange.get(pt.exchange);
      if (!arr) {
        arr = [];
        byExchange.set(pt.exchange, arr);
      }
      arr.push(pt.price);
    }
    const exchangeAvgs: number[] = [];
    for (const prices of byExchange.values()) {
      const valid = prices.filter((v) => Number.isFinite(v) && v > 0);
      if (valid.length === 0) continue;
      exchangeAvgs.push(valid.reduce((s, v) => s + v, 0) / valid.length);
    }
    if (exchangeAvgs.length === 0) continue;
    exchangeAvgs.sort((a, b) => a - b);
    const mid = Math.floor(exchangeAvgs.length / 2);
    const median = exchangeAvgs.length % 2 === 1
      ? exchangeAvgs[mid]!
      : (exchangeAvgs[mid - 1]! + exchangeAvgs[mid]!) / 2;
    buckets.push(median);
  }
  return buckets;
}

function classifyVolatilityByValue(vol: number): RegimeState["volatilityRegime"] {
  if (vol < VOL_THRESHOLDS.low) return "low";
  if (vol < VOL_THRESHOLDS.normal) return "normal";
  if (vol < VOL_THRESHOLDS.high) return "high";
  return "extreme";
}

function computeVolatility(
  priceBuffer: PricePoint[],
  smoothedVol: number | null,
): { regime: RegimeState["volatilityRegime"]; vol: number; smoothed: number | null } {
  const buckets = buildMedianExchangeBuckets(priceBuffer, 300_000, 5000);

  if (buckets.length < 6) {
    const fallback = smoothedVol ?? 0;
    return { regime: classifyVolatilityByValue(fallback), vol: fallback, smoothed: smoothedVol };
  }

  const logReturns: number[] = [];
  for (let i = 1; i < buckets.length; i++) {
    const prev = buckets[i - 1]!;
    const curr = buckets[i]!;
    if (prev <= 0 || curr <= 0) continue;
    const lr = Math.log(curr / prev);
    if (Number.isFinite(lr)) logReturns.push(lr);
  }

  if (logReturns.length < 2) {
    const fallback = smoothedVol ?? 0;
    return { regime: classifyVolatilityByValue(fallback), vol: fallback, smoothed: smoothedVol };
  }

  const mean = logReturns.reduce((s, v) => s + v, 0) / logReturns.length;
  const vol = Math.sqrt(logReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / (logReturns.length - 1));
  if (!Number.isFinite(vol)) {
    const fallback = smoothedVol ?? 0;
    return { regime: classifyVolatilityByValue(fallback), vol: fallback, smoothed: smoothedVol };
  }
  const newSmoothed = smoothedVol === null ? vol : VOL_SMOOTHING_ALPHA * vol + (1 - VOL_SMOOTHING_ALPHA) * smoothedVol;
  return { regime: classifyVolatilityByValue(newSmoothed), vol: newSmoothed, smoothed: newSmoothed };
}

function computeTrendStats(priceBuffer: PricePoint[], lookbackMs: number): {
  sampleCount: number;
  slope: number;
  residualStddev: number;
  strength: number;
} {
  const ys = buildMedianExchangeBuckets(priceBuffer, lookbackMs, TREND_BUCKET_MS);
  const n = ys.length;
  if (n < 8) {
    return { sampleCount: n, slope: 0, residualStddev: 0, strength: 0 };
  }

  const xMean = (n - 1) / 2;
  const yMean = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (ys[i]! - yMean);
    den += (i - xMean) ** 2;
  }
  const slope = den > 0 ? num / den : 0;
  const residuals = ys.map((y, i) => y - (yMean + slope * (i - xMean)));
  const stddev = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / Math.max(1, n - 2));
  const normalizedSlope = stddev > 0 ? Math.abs(slope) / stddev : 0;
  const strength = Number.isFinite(normalizedSlope) ? normalizedSlope : 0;
  return {
    sampleCount: n,
    slope,
    residualStddev: stddev,
    strength,
  };
}

function computeTrend(
  priceBuffer: PricePoint[],
  previousTrendRegime: RegimeState["trendRegime"],
  volatilityValue: number,
  spreadValue: number,
): {
  regime: RegimeState["trendRegime"];
  strength: number;
  sampleCount: number;
  slope: number;
  residualStddev: number;
} {
  const short = computeTrendStats(priceBuffer, TREND_SHORT_LOOKBACK_MS);
  const long = computeTrendStats(priceBuffer, TREND_LONG_LOOKBACK_MS);
  if (short.sampleCount < 8) {
    return { regime: "chop", strength: short.strength, sampleCount: short.sampleCount, slope: short.slope, residualStddev: short.residualStddev };
  }
  const shortDir = short.slope > 0 ? 1 : short.slope < 0 ? -1 : 0;
  const longDir = long.slope > 0 ? 1 : long.slope < 0 ? -1 : 0;
  const longAgreement = long.sampleCount >= 12 && shortDir !== 0 && shortDir === longDir && long.strength >= TREND_LONG_CONFIRM_MIN;

  // Adaptive weak threshold: relax chop in low-noise regimes, tighten in noisier conditions.
  const volTightener = volatilityValue > VOL_THRESHOLDS.normal ? 0.03 : 0;
  const spreadTightener = spreadValue > 0.02 ? 0.03 : 0;
  const enterWeak = TREND_WEAK_ENTER + volTightener + spreadTightener;
  const exitWeak = TREND_WEAK_EXIT + volTightener + spreadTightener;
  const weakThreshold = previousTrendRegime === "chop" ? exitWeak : enterWeak;

  if (shortDir === 0) {
    return {
      regime: "chop",
      strength: short.strength,
      sampleCount: short.sampleCount,
      slope: short.slope,
      residualStddev: short.residualStddev,
    };
  }
  if (short.strength < weakThreshold && !longAgreement) {
    return {
      regime: "chop",
      strength: short.strength,
      sampleCount: short.sampleCount,
      slope: short.slope,
      residualStddev: short.residualStddev,
    };
  }
  if (short.strength > TREND_STRONG && longAgreement) {
    return {
      regime: shortDir > 0 ? "strong_up" : "strong_down",
      strength: short.strength,
      sampleCount: short.sampleCount,
      slope: short.slope,
      residualStddev: short.residualStddev,
    };
  }
  return {
    regime: shortDir > 0 ? "up" : "down",
    strength: short.strength,
    sampleCount: short.sampleCount,
    slope: short.slope,
    residualStddev: short.residualStddev,
  };
}

function computeLiquidity(ctx: MarketContext): { regime: RegimeState["liquidityRegime"]; depth: number } {
  const total = ctx.orderBook.up.asks.slice(0, 5).reduce((s, l) => s + l.size, 0)
    + ctx.orderBook.up.bids.slice(0, 5).reduce((s, l) => s + l.size, 0)
    + ctx.orderBook.down.asks.slice(0, 5).reduce((s, l) => s + l.size, 0)
    + ctx.orderBook.down.bids.slice(0, 5).reduce((s, l) => s + l.size, 0);
  if (total < 500) return { regime: "thin", depth: total };
  if (total > 5000) return { regime: "deep", depth: total };
  return { regime: "normal", depth: total };
}

function classifySpreadByValue(spread: number): RegimeState["spreadRegime"] {
  if (spread < 0.02) return "tight";
  if (spread < 0.05) return "normal";
  if (spread < 0.10) return "wide";
  return "blowout";
}

function computeSpread(
  ctx: MarketContext,
  smoothedSpread: number | null,
): { regime: RegimeState["spreadRegime"]; value: number; smoothed: number | null } {
  const spreads: number[] = [];
  if (ctx.orderBook.bestAskUp !== null && ctx.orderBook.bestBidUp !== null)
    spreads.push(ctx.orderBook.bestAskUp - ctx.orderBook.bestBidUp);
  if (ctx.orderBook.bestAskDown !== null && ctx.orderBook.bestBidDown !== null)
    spreads.push(ctx.orderBook.bestAskDown - ctx.orderBook.bestBidDown);
  if (spreads.length === 0) {
    return { regime: smoothedSpread !== null ? classifySpreadByValue(smoothedSpread) : "normal", value: 0, smoothed: smoothedSpread };
  }
  const rawSpread = Math.max(...spreads);
  const newSmoothed = smoothedSpread === null
    ? rawSpread
    : SPREAD_SMOOTHING_ALPHA * rawSpread + (1 - SPREAD_SMOOTHING_ALPHA) * smoothedSpread;
  return { regime: classifySpreadByValue(newSmoothed), value: rawSpread, smoothed: newSmoothed };
}

/** Factory that creates a standalone (non-DI) regime detector instance. Same logic as RegimeDetector.effect. */
export function createRegimeDetector(): Effect.Effect<{
  readonly addPrice: (p: PricePoint) => Effect.Effect<void>;
  readonly update: (ctx: MarketContext) => Effect.Effect<void>;
  readonly getRegime: Effect.Effect<RegimeState>;
}> {
  return Effect.gen(function* () {
    const priceBufferRef = yield* Ref.make<PricePoint[]>([]);
    const smoothedVolRef = yield* Ref.make<number | null>(null);
    const smoothedSpreadRef = yield* Ref.make<number | null>(null);
    const regimeRef = yield* Ref.make<RegimeState>({
      volatilityRegime: "normal",
      trendRegime: "chop",
      liquidityRegime: "normal",
      spreadRegime: "normal",
      volatilityValue: 0,
      trendStrength: 0,
      liquidityDepth: 0,
      spreadValue: 0,
    });

    const addPrice = (p: PricePoint) =>
      Ref.update(priceBufferRef, (buf) => {
        if (!Number.isFinite(p.price) || p.price <= 0 || !Number.isFinite(p.timestamp)) return buf;
        const next = [...buf, p];
        if (next.length > 5000) {
          const cutoff = Date.now() - 600_000;
          return next.filter((pp) => pp.timestamp >= cutoff);
        }
        return next;
      });

    const update = (ctx: MarketContext) =>
      Effect.gen(function* () {
        const buf = yield* Ref.get(priceBufferRef);
        const smoothed = yield* Ref.get(smoothedVolRef);
        const smoothedSpread = yield* Ref.get(smoothedSpreadRef);
        const prevRegime = yield* Ref.get(regimeRef);
        const volResult = computeVolatility(buf, smoothed);
        const liqResult = computeLiquidity(ctx);
        const spreadResult = computeSpread(ctx, smoothedSpread);
        const trendResult = computeTrend(
          buf,
          prevRegime.trendRegime,
          volResult.vol,
          spreadResult.value,
        );

        yield* Ref.set(smoothedVolRef, volResult.smoothed);
        yield* Ref.set(smoothedSpreadRef, spreadResult.smoothed);
        yield* Ref.set(regimeRef, {
          volatilityRegime: volResult.regime,
          trendRegime: trendResult.regime,
          liquidityRegime: liqResult.regime,
          spreadRegime: spreadResult.regime,
          volatilityValue: volResult.vol,
          trendStrength: trendResult.strength,
          trendSampleCount: trendResult.sampleCount,
          trendSlope: trendResult.slope,
          trendResidualStddev: trendResult.residualStddev,
          liquidityDepth: liqResult.depth,
          spreadValue: spreadResult.value,
        });
      });

    const getRegime = Ref.get(regimeRef);

    return { addPrice, update, getRegime } as const;
  });
}

export class RegimeDetector extends Effect.Service<RegimeDetector>()("RegimeDetector", {
  effect: Effect.gen(function* () {
    const priceBufferRef = yield* Ref.make<PricePoint[]>([]);
    const smoothedVolRef = yield* Ref.make<number | null>(null);
    const smoothedSpreadRef = yield* Ref.make<number | null>(null);
    const regimeRef = yield* Ref.make<RegimeState>({
      volatilityRegime: "normal",
      trendRegime: "chop",
      liquidityRegime: "normal",
      spreadRegime: "normal",
      volatilityValue: 0,
      trendStrength: 0,
      liquidityDepth: 0,
      spreadValue: 0,
    });

    const addPrice = (p: PricePoint) =>
      Ref.update(priceBufferRef, (buf) => {
        if (!Number.isFinite(p.price) || p.price <= 0 || !Number.isFinite(p.timestamp)) return buf;
        const next = [...buf, p];
        if (next.length > 5000) {
          const cutoff = Date.now() - 600_000;
          return next.filter((pp) => pp.timestamp >= cutoff);
        }
        return next;
      });

    const update = (ctx: MarketContext) =>
      Effect.gen(function* () {
        const buf = yield* Ref.get(priceBufferRef);
        const smoothed = yield* Ref.get(smoothedVolRef);
        const smoothedSpread = yield* Ref.get(smoothedSpreadRef);
        const prevRegime = yield* Ref.get(regimeRef);
        const volResult = computeVolatility(buf, smoothed);
        const liqResult = computeLiquidity(ctx);
        const spreadResult = computeSpread(ctx, smoothedSpread);
        const trendResult = computeTrend(
          buf,
          prevRegime.trendRegime,
          volResult.vol,
          spreadResult.value,
        );

        yield* Ref.set(smoothedVolRef, volResult.smoothed);
        yield* Ref.set(smoothedSpreadRef, spreadResult.smoothed);
        yield* Ref.set(regimeRef, {
          volatilityRegime: volResult.regime,
          trendRegime: trendResult.regime,
          liquidityRegime: liqResult.regime,
          spreadRegime: spreadResult.regime,
          volatilityValue: volResult.vol,
          trendStrength: trendResult.strength,
          trendSampleCount: trendResult.sampleCount,
          trendSlope: trendResult.slope,
          trendResidualStddev: trendResult.residualStddev,
          liquidityDepth: liqResult.depth,
          spreadValue: spreadResult.value,
        });
      });

    const getRegime = Ref.get(regimeRef);

    return { addPrice, update, getRegime } as const;
  }),
}) {}

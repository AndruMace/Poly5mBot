import type { MarketContext, RegimeState, PricePoint } from "../types.js";

const VOL_THRESHOLDS = {
  low: 0.0003,
  normal: 0.001,
  high: 0.003,
};
const VOL_SMOOTHING_ALPHA = 0.2;

const TREND_STRONG = 2.0;
const TREND_WEAK = 0.5;

export class RegimeDetector {
  private priceBuffer: PricePoint[] = [];
  private smoothedVol: number | null = null;
  private regime: RegimeState = {
    volatilityRegime: "normal",
    trendRegime: "chop",
    liquidityRegime: "normal",
    spreadRegime: "normal",
    volatilityValue: 0,
    trendStrength: 0,
    liquidityDepth: 0,
    spreadValue: 0,
  };

  addPrice(p: PricePoint): void {
    if (
      !Number.isFinite(p.price) ||
      p.price <= 0 ||
      !Number.isFinite(p.timestamp)
    ) {
      return;
    }
    this.priceBuffer.push(p);
    const cutoff = Date.now() - 600_000;
    if (this.priceBuffer.length > 5000) {
      this.priceBuffer = this.priceBuffer.filter(
        (pp) => pp.timestamp >= cutoff,
      );
    }
  }

  update(ctx: MarketContext): void {
    this.regime.volatilityRegime = this.classifyVolatility();
    this.regime.trendRegime = this.classifyTrend();
    this.regime.liquidityRegime = this.classifyLiquidity(ctx);
    this.regime.spreadRegime = this.classifySpread(ctx);
  }

  getRegime(): RegimeState {
    return { ...this.regime };
  }

  private classifyVolatility(): RegimeState["volatilityRegime"] {
    const cutoff = Date.now() - 300_000;
    const recent = this.priceBuffer.filter(
      (p) =>
        p.timestamp >= cutoff &&
        Number.isFinite(p.price) &&
        p.price > 0 &&
        Number.isFinite(p.timestamp),
    );
    if (recent.length < 10) {
      const fallbackVol = this.smoothedVol ?? 0;
      this.regime.volatilityValue = fallbackVol;
      return this.classifyVolatilityByValue(fallbackVol);
    }

    const sorted = [...recent].sort((a, b) => a.timestamp - b.timestamp);

    const rawBuckets: Array<{ exchange: string; price: number }[]> = [];
    let bucketStart = sorted[0]!.timestamp;
    let current: Array<{ exchange: string; price: number }> = [];

    for (const p of sorted) {
      if (p.timestamp - bucketStart >= 5000) {
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
      const median =
        exchangeAvgs.length % 2 === 1
          ? exchangeAvgs[mid]!
          : (exchangeAvgs[mid - 1]! + exchangeAvgs[mid]!) / 2;
      buckets.push(median);
    }

    if (buckets.length < 6) {
      const fallbackVol = this.smoothedVol ?? 0;
      this.regime.volatilityValue = fallbackVol;
      return this.classifyVolatilityByValue(fallbackVol);
    }

    const logReturns: number[] = [];
    for (let i = 1; i < buckets.length; i++) {
      const prev = buckets[i - 1]!;
      const curr = buckets[i]!;
      if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev <= 0 || curr <= 0) {
        continue;
      }
      const lr = Math.log(curr / prev);
      if (Number.isFinite(lr)) logReturns.push(lr);
    }

    if (logReturns.length < 2) {
      const fallbackVol = this.smoothedVol ?? 0;
      this.regime.volatilityValue = Number.isFinite(fallbackVol) ? fallbackVol : 0;
      return this.classifyVolatilityByValue(this.regime.volatilityValue);
    }

    const mean = logReturns.reduce((s, v) => s + v, 0) / logReturns.length;
    const vol = Math.sqrt(
      logReturns.reduce((s, v) => s + (v - mean) ** 2, 0) /
        (logReturns.length - 1),
    );
    if (!Number.isFinite(vol)) {
      const fallbackVol = this.smoothedVol ?? 0;
      this.regime.volatilityValue = Number.isFinite(fallbackVol) ? fallbackVol : 0;
      return this.classifyVolatilityByValue(this.regime.volatilityValue);
    }
    if (this.smoothedVol === null) {
      this.smoothedVol = vol;
    } else {
      this.smoothedVol =
        VOL_SMOOTHING_ALPHA * vol + (1 - VOL_SMOOTHING_ALPHA) * this.smoothedVol;
    }
    this.regime.volatilityValue = Number.isFinite(this.smoothedVol) ? this.smoothedVol : 0;
    return this.classifyVolatilityByValue(this.regime.volatilityValue);
  }

  private classifyVolatilityByValue(
    vol: number,
  ): RegimeState["volatilityRegime"] {
    if (vol < VOL_THRESHOLDS.low) return "low";
    if (vol < VOL_THRESHOLDS.normal) return "normal";
    if (vol < VOL_THRESHOLDS.high) return "high";
    return "extreme";
  }

  private classifyTrend(): RegimeState["trendRegime"] {
    const cutoff = Date.now() - 120_000;
    const recent = this.priceBuffer.filter(
      (p) =>
        p.timestamp >= cutoff &&
        Number.isFinite(p.price) &&
        p.price > 0 &&
        Number.isFinite(p.timestamp),
    );
    if (recent.length < 5) {
      this.regime.trendStrength = 0;
      return "chop";
    }

    const sorted = [...recent].sort((a, b) => a.timestamp - b.timestamp);
    const n = sorted.length;
    const xs = sorted.map((_, i) => i);
    const ys = sorted.map((p) => p.price);

    const xMean = (n - 1) / 2;
    const yMean = ys.reduce((s, v) => s + v, 0) / n;

    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i]! - xMean) * (ys[i]! - yMean);
      den += (xs[i]! - xMean) ** 2;
    }
    const slope = den > 0 ? num / den : 0;

    const residuals = ys.map((y, i) => y - (yMean + slope * (xs[i]! - xMean)));
    const stddev = Math.sqrt(
      residuals.reduce((s, r) => s + r * r, 0) / Math.max(1, n - 2),
    );

    const normalizedSlope = stddev > 0 ? Math.abs(slope) / stddev : 0;
    this.regime.trendStrength = Number.isFinite(normalizedSlope)
      ? normalizedSlope
      : 0;

    if (this.regime.trendStrength < TREND_WEAK) return "chop";

    const direction = slope > 0 ? 1 : -1;
    if (this.regime.trendStrength > TREND_STRONG) {
      return direction > 0 ? "strong_up" : "strong_down";
    }
    return direction > 0 ? "up" : "down";
  }

  private classifyLiquidity(ctx: MarketContext): RegimeState["liquidityRegime"] {
    const upAsks = ctx.orderBook.up.asks.slice(0, 5);
    const upBids = ctx.orderBook.up.bids.slice(0, 5);
    const downAsks = ctx.orderBook.down.asks.slice(0, 5);
    const downBids = ctx.orderBook.down.bids.slice(0, 5);

    const total =
      upAsks.reduce((s, l) => s + l.size, 0) +
      upBids.reduce((s, l) => s + l.size, 0) +
      downAsks.reduce((s, l) => s + l.size, 0) +
      downBids.reduce((s, l) => s + l.size, 0);
    this.regime.liquidityDepth = total;

    if (total < 500) return "thin";
    if (total > 5000) return "deep";
    return "normal";
  }

  private classifySpread(ctx: MarketContext): RegimeState["spreadRegime"] {
    const spreads: number[] = [];

    if (ctx.orderBook.bestAskUp !== null && ctx.orderBook.bestBidUp !== null) {
      spreads.push(ctx.orderBook.bestAskUp - ctx.orderBook.bestBidUp);
    }
    if (ctx.orderBook.bestAskDown !== null && ctx.orderBook.bestBidDown !== null) {
      spreads.push(ctx.orderBook.bestAskDown - ctx.orderBook.bestBidDown);
    }

    if (spreads.length === 0) {
      this.regime.spreadValue = 0;
      return "normal";
    }

    const maxSpread = Math.max(...spreads);
    this.regime.spreadValue = maxSpread;

    if (maxSpread < 0.02) return "tight";
    if (maxSpread < 0.05) return "normal";
    if (maxSpread < 0.10) return "wide";
    return "blowout";
  }
}

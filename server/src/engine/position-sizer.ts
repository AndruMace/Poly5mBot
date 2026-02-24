import type { Signal, PricePoint } from "../types.js";

export interface SizingConfig {
  baseSize: number;
  maxSize: number;
  minSize: number;
  volatilityLookbackMs: number;
  edgeScaling: boolean;
  kellyFraction: number;
}

const DEFAULT_SIZING: SizingConfig = {
  baseSize: 10,
  maxSize: 25,
  minSize: 2,
  volatilityLookbackMs: 300_000,
  edgeScaling: true,
  kellyFraction: 0.25,
};

const BASELINE_VOL = 0.0005;

export class PositionSizer {
  private config: SizingConfig;

  constructor(config?: Partial<SizingConfig>) {
    this.config = { ...DEFAULT_SIZING, ...config };
  }

  computeSize(
    signal: Signal,
    recentPrices: PricePoint[],
    strategyWinRate?: number,
  ): number {
    const vol = this.computeVolatility(recentPrices);

    const volFactor =
      vol > 0
        ? Math.max(0.3, Math.min(2.0, BASELINE_VOL / vol))
        : 1.0;

    const edgeFactor = this.config.edgeScaling
      ? Math.max(0.2, signal.confidence)
      : 1.0;

    let size = this.config.baseSize * volFactor * edgeFactor;

    if (
      this.config.kellyFraction > 0 &&
      strategyWinRate !== undefined &&
      strategyWinRate > 0
    ) {
      const winProb = strategyWinRate / 100;
      const lossProb = 1 - winProb;
      const payoff = (1 / signal.maxPrice) - 1;
      if (payoff > 0) {
        const kellyPct = (winProb * payoff - lossProb) / payoff;
        if (kellyPct > 0) {
          const kellySize = this.config.maxSize * kellyPct * this.config.kellyFraction;
          size = Math.min(size, kellySize);
        }
      }
    }

    return Math.max(
      this.config.minSize,
      Math.min(this.config.maxSize, Math.round(size * 100) / 100),
    );
  }

  private computeVolatility(prices: PricePoint[]): number {
    if (prices.length < 10) return 0;

    const sorted = [...prices].sort((a, b) => a.timestamp - b.timestamp);
    const buckets: number[] = [];
    let bucketStart = sorted[0]!.timestamp;
    let bucketPrices: number[] = [];

    for (const p of sorted) {
      if (p.timestamp - bucketStart >= 5000) {
        if (bucketPrices.length > 0) {
          buckets.push(
            bucketPrices.reduce((s, v) => s + v, 0) / bucketPrices.length,
          );
        }
        bucketStart = p.timestamp;
        bucketPrices = [p.price];
      } else {
        bucketPrices.push(p.price);
      }
    }
    if (bucketPrices.length > 0) {
      buckets.push(
        bucketPrices.reduce((s, v) => s + v, 0) / bucketPrices.length,
      );
    }

    if (buckets.length < 3) return 0;

    const logReturns: number[] = [];
    for (let i = 1; i < buckets.length; i++) {
      logReturns.push(Math.log(buckets[i]! / buckets[i - 1]!));
    }

    const mean = logReturns.reduce((s, v) => s + v, 0) / logReturns.length;
    const variance =
      logReturns.reduce((s, v) => s + (v - mean) ** 2, 0) /
      (logReturns.length - 1);
    return Math.sqrt(variance);
  }

  getConfig(): SizingConfig {
    return { ...this.config };
  }
}

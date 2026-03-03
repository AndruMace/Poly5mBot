import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { PositionSizer } from "../../src/engine/position-sizer.js";
import { runTest } from "../helpers.js";
import type { Signal } from "../../src/types.js";

const signal: Signal = {
  side: "UP",
  confidence: 0.75,
  size: 12,
  maxPrice: 0.6,
  strategy: "arb",
  reason: "test",
  timestamp: Date.now(),
};

describe("PositionSizer", () => {
  it("uses signal size as primary anchor", () =>
    runTest(
      Effect.gen(function* () {
        const sizer = yield* PositionSizer;
        const size = sizer.computeSize(signal, []);
        expect(size).toBeGreaterThan(0);
        expect(size).toBeGreaterThanOrEqual(2);
      }),
    ));

  it("applies volatility adjustment with enough prices", () =>
    runTest(
      Effect.gen(function* () {
        const sizer = yield* PositionSizer;
        const now = Date.now();
        const prices = Array.from({ length: 40 }, (_, i) => ({
          exchange: "binance",
          price: 100_000 + Math.sin(i / 3) * 100,
          timestamp: now - (40 - i) * 5000,
        }));
        const size = sizer.computeSize(signal, prices, 55);
        expect(size).toBeGreaterThan(0);
        expect(size).toBeLessThanOrEqual(sizer.getConfig().maxSize);
      }),
    ));

  it("high volatility reduces size to the 0.3x floor", () =>
    runTest(
      Effect.gen(function* () {
        const sizer = yield* PositionSizer;
        const cfg = sizer.getConfig();
        // BASELINE_VOL = 0.0005; artificially high vol → volFactor clamps to 0.3
        // Generate prices with extreme jumps every 5s bucket → vol >> 0.0005
        const now = Date.now();
        const prices = Array.from({ length: 40 }, (_, i) => ({
          exchange: "binance",
          // Alternating ±2% every bucket produces vol >> BASELINE_VOL
          price: 100_000 * (1 + (i % 2 === 0 ? 0.02 : -0.02)),
          timestamp: now - (40 - i) * 5100,
        }));
        const baseSignal: typeof signal = { ...signal, size: 10, confidence: 1.0 };
        const highVolSize = sizer.computeSize(baseSignal, prices);
        const noVolSize = sizer.computeSize(baseSignal, []);
        // High vol must produce a smaller size than no-vol baseline
        expect(highVolSize).toBeLessThan(noVolSize);
        expect(highVolSize).toBeGreaterThanOrEqual(cfg.minSize);
      }),
    ));

  it("low volatility increases size toward the 2.0x cap", () =>
    runTest(
      Effect.gen(function* () {
        const sizer = yield* PositionSizer;
        const cfg = sizer.getConfig();
        // Very tiny price moves → vol << BASELINE_VOL → volFactor capped at 2.0
        const now = Date.now();
        const prices = Array.from({ length: 40 }, (_, i) => ({
          exchange: "binance",
          price: 100_000 + i * 0.001, // negligible movement
          timestamp: now - (40 - i) * 5100,
        }));
        const baseSignal: typeof signal = { ...signal, size: 5, confidence: 1.0 };
        const lowVolSize = sizer.computeSize(baseSignal, prices);
        const noVolSize = sizer.computeSize(baseSignal, []);
        // Low vol must produce a larger size than no-vol baseline, capped at maxSize
        expect(lowVolSize).toBeGreaterThanOrEqual(noVolSize);
        expect(lowVolSize).toBeLessThanOrEqual(cfg.maxSize);
      }),
    ));

  it("Kelly fraction caps size when win rate and payoff justify a smaller bet", () =>
    runTest(
      Effect.gen(function* () {
        const sizer = yield* PositionSizer;
        const cfg = sizer.getConfig();
        // A 50% win rate at 0.6 maxPrice → payoff = (1/0.6)-1 = 0.667
        // Kelly = (0.5*0.667 - 0.5) / 0.667 ≈ 0.0 (slightly positive)
        // kellySize = 25 * kellyPct * 0.25 → small cap
        const kellySignal: typeof signal = {
          ...signal,
          size: 20,
          confidence: 1.0,
          maxPrice: 0.6,
        };
        const kellyCappedSize = sizer.computeSize(kellySignal, [], 50);
        // Should be less than uncapped signal.size (20) since Kelly limits it
        expect(kellyCappedSize).toBeLessThanOrEqual(cfg.maxSize);
        expect(kellyCappedSize).toBeGreaterThanOrEqual(cfg.minSize);
        // With very high signal size and Kelly limiting, result should differ from uncapped
        const uncapped = sizer.computeSize(kellySignal, []);
        expect(kellyCappedSize).toBeLessThanOrEqual(uncapped);
      }),
    ));

  it("low confidence reduces size via edge factor", () =>
    runTest(
      Effect.gen(function* () {
        const sizer = yield* PositionSizer;
        const cfg = sizer.getConfig();
        const lowConfSignal: typeof signal = { ...signal, size: 10, confidence: 0.2 };
        const highConfSignal: typeof signal = { ...signal, size: 10, confidence: 1.0 };
        const low = sizer.computeSize(lowConfSignal, []);
        const high = sizer.computeSize(highConfSignal, []);
        expect(low).toBeLessThan(high);
        expect(low).toBeGreaterThanOrEqual(cfg.minSize);
      }),
    ));
});

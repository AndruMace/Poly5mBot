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
});

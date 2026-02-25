import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { RegimeDetector } from "../src/engine/regime-detector.js";
import { runTest } from "./helpers.js";

describe("RegimeDetector", () => {
  it("starts with default regime state", () =>
    runTest(
      Effect.gen(function* () {
        const detector = yield* RegimeDetector;
        const regime = yield* detector.getRegime;
        expect(regime.volatilityRegime).toBe("normal");
        expect(regime.trendRegime).toBe("chop");
        expect(regime.liquidityRegime).toBe("normal");
        expect(regime.spreadRegime).toBe("normal");
      }),
    ));

  it("accepts price points without error", () =>
    runTest(
      Effect.gen(function* () {
        const detector = yield* RegimeDetector;
        const now = Date.now();
        for (let i = 0; i < 50; i++) {
          yield* detector.addPrice({
            exchange: "binance",
            price: 100_000 + Math.random() * 100,
            timestamp: now - (50 - i) * 1000,
          });
        }
        const regime = yield* detector.getRegime;
        expect(regime.volatilityRegime).toBeDefined();
        expect(regime.trendRegime).toBeDefined();
      }),
    ));
});

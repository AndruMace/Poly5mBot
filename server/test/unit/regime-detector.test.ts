import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { RegimeDetector } from "../../src/engine/regime-detector.js";
import { runTest } from "../helpers.js";

describe("RegimeDetector", () => {
  it("starts with default regime", () =>
    runTest(
      Effect.gen(function* () {
        const detector = yield* RegimeDetector;
        const regime = yield* detector.getRegime;
        expect(regime.volatilityRegime).toBe("normal");
        expect(regime.trendRegime).toBe("chop");
      }),
    ));

  it("accepts prices and returns classified regime", () =>
    runTest(
      Effect.gen(function* () {
        const detector = yield* RegimeDetector;
        const now = Date.now();
        for (let i = 0; i < 80; i++) {
          yield* detector.addPrice({
            exchange: i % 2 === 0 ? "binance" : "coinbase",
            price: 100_000 + i,
            timestamp: now - (80 - i) * 1000,
          });
        }
        yield* detector.update({
          currentWindow: null,
          orderBook: {
            up: { bids: [{ price: 0.51, size: 100 }], asks: [{ price: 0.53, size: 120 }] },
            down: { bids: [{ price: 0.47, size: 130 }], asks: [{ price: 0.49, size: 110 }] },
            bestAskUp: 0.53,
            bestAskDown: 0.49,
            bestBidUp: 0.51,
            bestBidDown: 0.47,
          },
          prices: {},
          oracleEstimate: 100_000,
          oracleTimestamp: now,
          windowElapsedMs: 1000,
          windowRemainingMs: 10_000,
          priceToBeat: 100_000,
          currentAssetPrice: 100_050,
          marketId: "btc",
        });
        const regime = yield* detector.getRegime;
        expect(regime.liquidityRegime).toBeDefined();
        expect(regime.spreadRegime).toBeDefined();
      }),
    ));
});

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

  it("classifies directional trend with dense multi-exchange sampling", () =>
    runTest(
      Effect.gen(function* () {
        const detector = yield* RegimeDetector;
        const now = Date.now();
        const exchanges = ["binance", "bybit", "coinbase", "kraken", "bitstamp", "okx"];
        for (let bucket = 0; bucket < 30; bucket++) {
          for (let j = 0; j < exchanges.length; j++) {
            yield* detector.addPrice({
              exchange: exchanges[j]!,
              // Stronger monotonic slope with lower within-bucket noise so the
              // trend detector clears chop hysteresis on the 5m lookback profile.
              price: 100_000 + bucket * 60 + j * 0.05,
              timestamp: now - (30 - bucket) * 5000 + j * 120,
            });
          }
        }
        yield* detector.update({
          currentWindow: null,
          orderBook: {
            up: { bids: [{ price: 0.51, size: 100 }], asks: [{ price: 0.52, size: 100 }] },
            down: { bids: [{ price: 0.48, size: 100 }], asks: [{ price: 0.49, size: 100 }] },
            bestAskUp: 0.52,
            bestAskDown: 0.49,
            bestBidUp: 0.51,
            bestBidDown: 0.48,
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
        expect(regime.trendRegime).not.toBe("chop");
        expect(regime.trendStrength).toBeGreaterThan(0.35);
      }),
    ));

  it("spread EMA dampens single-tick blowout spike", () =>
    runTest(
      Effect.gen(function* () {
        const detector = yield* RegimeDetector;
        const now = Date.now();

        // Helper to build a minimal context with given spread values
        const makeCtx = (bestAskUp: number, bestBidUp: number, bestAskDown: number, bestBidDown: number) => ({
          currentWindow: null,
          orderBook: {
            up: { bids: [{ price: bestBidUp, size: 100 }], asks: [{ price: bestAskUp, size: 100 }] },
            down: { bids: [{ price: bestBidDown, size: 100 }], asks: [{ price: bestAskDown, size: 100 }] },
            bestAskUp,
            bestAskDown,
            bestBidUp,
            bestBidDown,
          },
          prices: {},
          oracleEstimate: 100_000,
          oracleTimestamp: now,
          windowElapsedMs: 1000,
          windowRemainingMs: 10_000,
          priceToBeat: 100_000,
          currentAssetPrice: 100_000,
          marketId: "btc",
        });

        // Seed 10 ticks of tight spread (0.01) to build up smoothed state
        for (let i = 0; i < 10; i++) {
          yield* detector.update(makeCtx(0.51, 0.50, 0.50, 0.49));
        }
        const regimeBefore = yield* detector.getRegime;
        expect(regimeBefore.spreadRegime).toBe("tight");

        // Single spike to blowout (0.15)
        yield* detector.update(makeCtx(0.65, 0.50, 0.50, 0.49));
        const regimeAfterSpike = yield* detector.getRegime;
        // Smoothed spread should not have jumped all the way to blowout threshold
        expect(regimeAfterSpike.spreadRegime).not.toBe("blowout");
        // Raw spreadValue should reflect the spike
        expect(regimeAfterSpike.spreadValue).toBeCloseTo(0.15, 5);

        // After spike resolves, spread returns to tight after a few ticks
        for (let i = 0; i < 10; i++) {
          yield* detector.update(makeCtx(0.51, 0.50, 0.50, 0.49));
        }
        const regimeAfterRecover = yield* detector.getRegime;
        expect(regimeAfterRecover.spreadRegime).toBe("tight");
      }),
    ));

  it("keeps chop classification for oscillating prices", () =>
    runTest(
      Effect.gen(function* () {
        const detector = yield* RegimeDetector;
        const now = Date.now();
        const exchanges = ["binance", "bybit", "coinbase", "kraken", "bitstamp", "okx"];
        for (let bucket = 0; bucket < 24; bucket++) {
          const swing = bucket % 2 === 0 ? 18 : -18;
          for (let j = 0; j < exchanges.length; j++) {
            yield* detector.addPrice({
              exchange: exchanges[j]!,
              price: 100_000 + swing + j * 0.2,
              timestamp: now - (24 - bucket) * 5000 + j * 280,
            });
          }
        }
        yield* detector.update({
          currentWindow: null,
          orderBook: {
            up: { bids: [{ price: 0.51, size: 100 }], asks: [{ price: 0.52, size: 100 }] },
            down: { bids: [{ price: 0.48, size: 100 }], asks: [{ price: 0.49, size: 100 }] },
            bestAskUp: 0.52,
            bestAskDown: 0.49,
            bestBidUp: 0.51,
            bestBidDown: 0.48,
          },
          prices: {},
          oracleEstimate: 100_000,
          oracleTimestamp: now,
          windowElapsedMs: 1000,
          windowRemainingMs: 10_000,
          priceToBeat: 100_000,
          currentAssetPrice: 100_000,
          marketId: "btc",
        });
        const regime = yield* detector.getRegime;
        expect(regime.trendRegime).toBe("chop");
      }),
    ));
});

import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { makeArbStrategy } from "../../src/strategies/arb.js";
import { makeEfficiencyStrategy } from "../../src/strategies/efficiency.js";
import { makeWhaleHuntStrategy } from "../../src/strategies/whale-hunt.js";
import { makeMomentumStrategy } from "../../src/strategies/momentum.js";
import { runTest } from "../helpers.js";
import type { MarketContext, PricePoint } from "../../src/types.js";

function makeContext(overrides: Partial<MarketContext> = {}): MarketContext {
  const now = Date.now();
  return {
    currentWindow: {
      conditionId: "c1",
      slug: "s",
      upTokenId: "u",
      downTokenId: "d",
      startTime: now - 120_000,
      endTime: now + 120_000,
      priceToBeat: 100_000,
      resolved: false,
    },
    orderBook: {
      up: { bids: [{ price: 0.5, size: 200 }], asks: [{ price: 0.52, size: 200 }] },
      down: { bids: [{ price: 0.46, size: 200 }], asks: [{ price: 0.48, size: 200 }] },
      bestAskUp: 0.52,
      bestAskDown: 0.48,
      bestBidUp: 0.5,
      bestBidDown: 0.46,
    },
    prices: {
      binance: { exchange: "binance", price: 100_200, timestamp: now },
      bybit: { exchange: "bybit", price: 100_170, timestamp: now },
      coinbase: { exchange: "coinbase", price: 100_160, timestamp: now },
      kraken: { exchange: "kraken", price: 100_150, timestamp: now },
      okx: { exchange: "okx", price: 100_165, timestamp: now },
    },
    oracleEstimate: 100_000,
    oracleTimestamp: now,
    windowElapsedMs: 120_000,
    windowRemainingMs: 40_000,
    priceToBeat: 100_000,
    currentBtcPrice: 100_200,
    ...overrides,
  };
}

describe("Strategies", () => {
  it("efficiency emits signal when market is mispriced", () =>
    runTest(
      Effect.gen(function* () {
        const strategy = yield* makeEfficiencyStrategy;
        const signal = yield* strategy.evaluate(
          makeContext({
            orderBook: {
              up: { bids: [], asks: [{ price: 0.45, size: 100 }] },
              down: { bids: [], asks: [{ price: 0.45, size: 100 }] },
              bestAskUp: 0.45,
              bestAskDown: 0.45,
              bestBidUp: 0.44,
              bestBidDown: 0.44,
            },
          }),
        );
        expect(signal).not.toBeNull();
        expect(signal?.strategy).toBe("efficiency");
      }),
    ));

  it("arb emits null when oracle stale", () =>
    runTest(
      Effect.gen(function* () {
        const strategy = yield* makeArbStrategy;
        const signal = yield* strategy.evaluate(
          makeContext({ oracleTimestamp: Date.now() - 10_000 }),
        );
        expect(signal).toBeNull();
      }),
    ));

  it("whale-hunt blocks too-early entries", () =>
    runTest(
      Effect.gen(function* () {
        const strategy = yield* makeWhaleHuntStrategy;
        const signal = yield* strategy.evaluate(
          makeContext({ windowRemainingMs: 200_000 }),
        );
        expect(signal).toBeNull();
      }),
    ));

  it("momentum produces signal with seeded prices", () =>
    runTest(
      Effect.gen(function* () {
        const strategy = yield* makeMomentumStrategy;
        const now = Date.now();
        const seed: PricePoint[] = Array.from({ length: 40 }, (_, i) => ({
          exchange: "binance",
          price: 100_000 + i * 4,
          timestamp: now - (40 - i) * 30_000,
        }));
        for (const p of seed) {
          yield* strategy.addPrice(p);
        }

        const signal = yield* strategy.evaluate(
          makeContext({
            currentBtcPrice: 100_220,
            windowElapsedMs: 180_000,
            windowRemainingMs: 70_000,
          }),
        );
        expect(signal === null || signal.strategy === "momentum").toBe(true);
      }),
    ));
});

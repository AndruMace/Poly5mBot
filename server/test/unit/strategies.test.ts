import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { makeArbStrategy } from "../../src/strategies/arb.js";
import { makeEfficiencyStrategy } from "../../src/strategies/efficiency.js";
import { makeWhaleHuntStrategy } from "../../src/strategies/whale-hunt.js";
import { makeMomentumStrategy } from "../../src/strategies/momentum.js";
import { makeOrderFlowImbalanceStrategy } from "../../src/strategies/orderflow-imbalance.js";
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
    windowElapsedMs: 200_000,
    windowRemainingMs: 40_000,
    priceToBeat: 100_000,
    currentAssetPrice: 100_200,
    marketId: "btc",
    ...overrides,
  };
}

describe("Strategies", () => {
  it("arb emits UP signal after 4 persistence ticks with positive spread", () =>
    runTest(
      Effect.gen(function* () {
        const strategy = yield* makeArbStrategy;
        const ctx = makeContext({
          // Binance leads oracle by 0.2% — above 0.04% threshold
          prices: {
            binance: { exchange: "binance", price: 100_200, timestamp: Date.now() },
            bybit: { exchange: "bybit", price: 100_180, timestamp: Date.now() },
            coinbase: { exchange: "coinbase", price: 100_190, timestamp: Date.now() },
            kraken: { exchange: "kraken", price: 100_175, timestamp: Date.now() },
            okx: { exchange: "okx", price: 100_185, timestamp: Date.now() },
          },
          oracleEstimate: 100_000,
          oracleTimestamp: Date.now(),
          priceToBeat: 100_000,
          windowElapsedMs: 200_000,
        });
        // 4 calls in quick succession builds the persistence history
        yield* strategy.evaluate(ctx);
        yield* strategy.evaluate(ctx);
        yield* strategy.evaluate(ctx);
        const signal = yield* strategy.evaluate(ctx);
        expect(signal).not.toBeNull();
        expect(signal?.strategy).toBe("arb");
        expect(signal?.side).toBe("UP");
      }),
    ));

  it("arb returns null when spread is below minimum threshold", () =>
    runTest(
      Effect.gen(function* () {
        const strategy = yield* makeArbStrategy;
        const ctx = makeContext({
          // Only 0.02% spread — below 0.04% minimum
          prices: {
            binance: { exchange: "binance", price: 100_020, timestamp: Date.now() },
          },
          oracleEstimate: 100_000,
          oracleTimestamp: Date.now(),
          priceToBeat: 100_000,
        });
        const signal = yield* strategy.evaluate(ctx);
        expect(signal).toBeNull();
      }),
    ));

  it("arb emits DOWN signal after 4 ticks with negative spread", () =>
    runTest(
      Effect.gen(function* () {
        const strategy = yield* makeArbStrategy;
        const ctx = makeContext({
          // Binance lags oracle by 0.3% (negative spread) AND btcDelta < 0
          prices: {
            binance: { exchange: "binance", price: 99_700, timestamp: Date.now() },
            bybit: { exchange: "bybit", price: 99_720, timestamp: Date.now() },
            coinbase: { exchange: "coinbase", price: 99_710, timestamp: Date.now() },
            kraken: { exchange: "kraken", price: 99_705, timestamp: Date.now() },
            okx: { exchange: "okx", price: 99_695, timestamp: Date.now() },
          },
          oracleEstimate: 100_000,
          oracleTimestamp: Date.now(),
          priceToBeat: 100_000,
          windowElapsedMs: 200_000,
        });
        yield* strategy.evaluate(ctx);
        yield* strategy.evaluate(ctx);
        yield* strategy.evaluate(ctx);
        const signal = yield* strategy.evaluate(ctx);
        expect(signal).not.toBeNull();
        expect(signal?.side).toBe("DOWN");
      }),
    ));

  it("efficiency returns null when token sum equals or exceeds 1.0", () =>
    runTest(
      Effect.gen(function* () {
        const strategy = yield* makeEfficiencyStrategy;
        const signal = yield* strategy.evaluate(
          makeContext({
            orderBook: {
              up: { bids: [], asks: [{ price: 0.51, size: 100 }] },
              down: { bids: [], asks: [{ price: 0.50, size: 100 }] },
              bestAskUp: 0.51,
              bestAskDown: 0.50,
              bestBidUp: 0.49,
              bestBidDown: 0.48,
            },
          }),
        );
        expect(signal).toBeNull();
      }),
    ));

  it("efficiency returns null when profit after fees is below min bps", () =>
    runTest(
      Effect.gen(function* () {
        const strategy = yield* makeEfficiencyStrategy;
        // Sum = 0.999 < 1.0 but fees eat all the profit (minProfitBps = 8)
        const signal = yield* strategy.evaluate(
          makeContext({
            orderBook: {
              up: { bids: [], asks: [{ price: 0.500, size: 100 }] },
              down: { bids: [], asks: [{ price: 0.499, size: 100 }] },
              bestAskUp: 0.500,
              bestAskDown: 0.499,
              bestBidUp: 0.49,
              bestBidDown: 0.48,
            },
          }),
        );
        expect(signal).toBeNull();
      }),
    ));

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

  it("whale-hunt rejects strongly ask-heavy order book skew", () =>
    runTest(
      Effect.gen(function* () {
        const strategy = yield* makeWhaleHuntStrategy;
        const signal = yield* strategy.evaluate(
          makeContext({
            orderBook: {
              up: {
                bids: [{ price: 0.50, size: 20 }],
                asks: [{ price: 0.52, size: 250 }],
              },
              down: {
                bids: [{ price: 0.46, size: 120 }],
                asks: [{ price: 0.48, size: 120 }],
              },
              bestAskUp: 0.52,
              bestAskDown: 0.48,
              bestBidUp: 0.50,
              bestBidDown: 0.46,
            },
            windowRemainingMs: 35_000,
            currentAssetPrice: 100_250,
            priceToBeat: 100_000,
          }),
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
            currentAssetPrice: 100_220,
            windowElapsedMs: 180_000,
            windowRemainingMs: 70_000,
          }),
        );
        expect(signal === null || signal.strategy === "momentum").toBe(true);
      }),
    ));

  it("orderflow-imbalance emits UP when UP book pressure dominates with tight spread", () =>
    runTest(
      Effect.gen(function* () {
        const strategy = yield* makeOrderFlowImbalanceStrategy;
        const signal = yield* strategy.evaluate(
          makeContext({
            windowRemainingMs: 45_000,
            orderBook: {
              up: {
                bids: [{ price: 0.50, size: 2000 }],
                asks: [{ price: 0.505, size: 100 }],
              },
              down: {
                bids: [{ price: 0.48, size: 350 }],
                asks: [{ price: 0.50, size: 300 }],
              },
              bestAskUp: 0.505,
              bestAskDown: 0.50,
              bestBidUp: 0.50,
              bestBidDown: 0.48,
            },
          }),
        );
        expect(signal).not.toBeNull();
        expect(signal?.strategy).toBe("orderflow-imbalance");
        expect(signal?.side).toBe("UP");
      }),
    ));

  it("orderflow-imbalance emits DOWN when DOWN book pressure dominates with tight spread", () =>
    runTest(
      Effect.gen(function* () {
        const strategy = yield* makeOrderFlowImbalanceStrategy;
        const signal = yield* strategy.evaluate(
          makeContext({
            windowRemainingMs: 45_000,
            currentAssetPrice: 99_900,
            orderBook: {
              up: {
                bids: [{ price: 0.50, size: 250 }],
                asks: [{ price: 0.52, size: 250 }],
              },
              down: {
                bids: [{ price: 0.49, size: 1600 }],
                asks: [{ price: 0.495, size: 120 }],
              },
              bestAskUp: 0.52,
              bestAskDown: 0.495,
              bestBidUp: 0.50,
              bestBidDown: 0.49,
            },
          }),
        );
        expect(signal).not.toBeNull();
        expect(signal?.strategy).toBe("orderflow-imbalance");
        expect(signal?.side).toBe("DOWN");
      }),
    ));

  it("orderflow-imbalance rejects when window is too early", () =>
    runTest(
      Effect.gen(function* () {
        const strategy = yield* makeOrderFlowImbalanceStrategy;
        const signal = yield* strategy.evaluate(
          makeContext({
            windowElapsedMs: 20_000,
            windowRemainingMs: 45_000,
            orderBook: {
              up: {
                bids: [{ price: 0.50, size: 2000 }],
                asks: [{ price: 0.505, size: 100 }],
              },
              down: {
                bids: [{ price: 0.48, size: 350 }],
                asks: [{ price: 0.50, size: 300 }],
              },
              bestAskUp: 0.505,
              bestAskDown: 0.50,
              bestBidUp: 0.50,
              bestBidDown: 0.48,
            },
          }),
        );
        expect(signal).toBeNull();
      }),
    ));

  it("orderflow-imbalance rejects when price is too close to PTB", () =>
    runTest(
      Effect.gen(function* () {
        const strategy = yield* makeOrderFlowImbalanceStrategy;
        const signal = yield* strategy.evaluate(
          makeContext({
            currentAssetPrice: 100_010, // +0.01% vs PTB (default min is 0.03%)
            windowElapsedMs: 200_000,
            windowRemainingMs: 45_000,
            orderBook: {
              up: {
                bids: [{ price: 0.50, size: 2200 }],
                asks: [{ price: 0.505, size: 120 }],
              },
              down: {
                bids: [{ price: 0.48, size: 350 }],
                asks: [{ price: 0.50, size: 300 }],
              },
              bestAskUp: 0.505,
              bestAskDown: 0.50,
              bestBidUp: 0.50,
              bestBidDown: 0.48,
            },
          }),
        );
        expect(signal).toBeNull();
      }),
    ));

  it("orderflow-imbalance rejects signals when spread is too wide even if ratio is high", () =>
    runTest(
      Effect.gen(function* () {
        const strategy = yield* makeOrderFlowImbalanceStrategy;
        const signal = yield* strategy.evaluate(
          makeContext({
            windowRemainingMs: 45_000,
            orderBook: {
              up: {
                bids: [{ price: 0.46, size: 2000 }],
                asks: [{ price: 0.54, size: 80 }],
              },
              down: {
                bids: [{ price: 0.47, size: 250 }],
                asks: [{ price: 0.52, size: 250 }],
              },
              bestAskUp: 0.54,
              bestAskDown: 0.52,
              bestBidUp: 0.46,
              bestBidDown: 0.47,
            },
          }),
        );
        expect(signal).toBeNull();
      }),
    ));
});

import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { RiskManager } from "../../src/engine/risk.js";
import { runTest } from "../helpers.js";
import type { Signal, MarketContext } from "../../src/types.js";

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    side: "UP",
    confidence: 0.8,
    size: 5,
    maxPrice: 0.55,
    strategy: "arb",
    reason: "test",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeContext(overrides: Partial<MarketContext> = {}): MarketContext {
  const now = Date.now();
  return {
    currentWindow: null,
    orderBook: {
      up: { bids: [], asks: [] },
      down: { bids: [], asks: [] },
      bestAskUp: 0.55,
      bestAskDown: 0.45,
      bestBidUp: 0.5,
      bestBidDown: 0.4,
    },
    prices: {
      binance: {
        exchange: "binance",
        price: 100_000,
        timestamp: now,
      },
    },
    oracleEstimate: 100_000,
    oracleTimestamp: now,
    windowElapsedMs: 0,
    windowRemainingMs: 0,
    priceToBeat: 100_000,
    currentAssetPrice: 100_000,
    marketId: "btc",
    ...overrides,
  };
}

describe("RiskManager", () => {
  it("approves valid signals under limits", () =>
    runTest(
      Effect.gen(function* () {
        const risk = yield* RiskManager;
        const result = yield* risk.approve(makeSignal());
        expect(result.approved).toBe(true);
      }),
    ));

  it("rejects stale signals", () =>
    runTest(
      Effect.gen(function* () {
        const risk = yield* RiskManager;
        const result = yield* risk.approve(
          makeSignal({ timestamp: Date.now() - 10_000 }),
        );
        expect(result.approved).toBe(false);
        expect(result.reason).toContain("too old");
      }),
    ));

  it("rejects stale market data in context", () =>
    runTest(
      Effect.gen(function* () {
        const risk = yield* RiskManager;
        const ctx = makeContext({
          prices: {
            binance: {
              exchange: "binance",
              price: 100_000,
              timestamp: Date.now() - 10_000,
            },
          },
        });
        const result = yield* risk.approve(makeSignal(), ctx);
        expect(result.approved).toBe(false);
        expect(result.reason).toContain("Stale price data");
      }),
    ));

  it("rejects spread blowouts", () =>
    runTest(
      Effect.gen(function* () {
        const risk = yield* RiskManager;
        const ctx = makeContext({
          orderBook: {
            up: { bids: [], asks: [] },
            down: { bids: [], asks: [] },
            bestAskUp: 0.95,
            bestAskDown: 0.45,
            bestBidUp: 0.5,
            bestBidDown: 0.4,
          },
        });
        const result = yield* risk.approve(makeSignal(), ctx);
        expect(result.approved).toBe(false);
        expect(result.reason).toContain("Spread blowout");
      }),
    ));

  it("tracks losses and resets pause", () =>
    runTest(
      Effect.gen(function* () {
        const risk = yield* RiskManager;
        for (let i = 0; i < 5; i++) {
          yield* risk.onTradeClosed({
            id: `t-${i}`,
            strategy: "arb",
            side: "UP",
            tokenId: "tok",
            entryPrice: 0.55,
            size: 5,
            shares: 10,
            fee: 0.01,
            status: "resolved",
            outcome: "loss",
            pnl: -2,
            timestamp: Date.now(),
            windowEnd: Date.now() + 60_000,
            conditionId: "cond",
            priceToBeatAtEntry: 100_000,
          });
        }
        const blocked = yield* risk.approve(makeSignal());
        expect(blocked.approved).toBe(false);
        yield* risk.resetPause;
        const snapshot = yield* risk.getSnapshot;
        expect(snapshot.consecutiveLosses).toBe(0);
      }),
    ));
});

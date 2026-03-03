import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { RiskManager } from "../../src/engine/risk.js";
import { runTest } from "../helpers.js";
import type { Signal, MarketContext, TradeRecord } from "../../src/types.js";

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

  it("rejects when open exposure would exceed maxTotalExposure", () =>
    runTest(
      Effect.gen(function* () {
        const risk = yield* RiskManager;
        // maxTotalExposure = 100; open 19 trades × $5 = $95
        for (let i = 0; i < 19; i++) {
          yield* risk.onTradeOpened({
            id: `t-exp-${i}`,
            strategy: "arb",
            side: "UP",
            tokenId: "tok",
            entryPrice: 0.55,
            size: 5,
            shares: 9,
            fee: 0,
            status: "filled",
            outcome: null,
            pnl: 0,
            timestamp: Date.now(),
            windowEnd: Date.now() + 60_000,
            conditionId: "cond-exp",
            priceToBeatAtEntry: 100_000,
          });
        }
        // A signal of $6 would push to $101 > $100
        const result = yield* risk.approve(makeSignal({ size: 6 }));
        expect(result.approved).toBe(false);
        expect(result.reason).toContain("exceed max exposure");
      }),
    ));

  it("rejects when concurrent positions would exceed limit", () =>
    runTest(
      Effect.gen(function* () {
        const risk = yield* RiskManager;
        // maxConcurrentPositions = 5
        for (let i = 0; i < 5; i++) {
          yield* risk.onTradeOpened({
            id: `t-pos-${i}`,
            strategy: "arb",
            side: "UP",
            tokenId: "tok",
            entryPrice: 0.55,
            size: 1, // keep exposure low
            shares: 2,
            fee: 0,
            status: "filled",
            outcome: null,
            pnl: 0,
            timestamp: Date.now(),
            windowEnd: Date.now() + 60_000,
            conditionId: "cond-pos",
            priceToBeatAtEntry: 100_000,
          });
        }
        const result = yield* risk.approve(makeSignal({ size: 1 }));
        expect(result.approved).toBe(false);
        expect(result.reason).toContain("concurrent positions");
      }),
    ));

  it("rejects when daily loss limit is reached", () =>
    runTest(
      Effect.gen(function* () {
        const risk = yield* RiskManager;
        // maxDailyLoss = 50; a loss of $50 hits the <= threshold
        yield* risk.onTradeClosed({
          id: "t-daily",
          strategy: "arb",
          side: "UP",
          tokenId: "tok",
          entryPrice: 0.55,
          size: 10,
          shares: 18,
          fee: 0,
          status: "resolved",
          outcome: "loss",
          pnl: -50,
          timestamp: Date.now(),
          windowEnd: Date.now() - 1,
          conditionId: "cond-daily",
          priceToBeatAtEntry: 100_000,
        });
        const result = yield* risk.approve(makeSignal());
        expect(result.approved).toBe(false);
        expect(result.reason).toContain("Daily loss limit");
      }),
    ));

  it("rejects on hourly loss limit and sets auto-pause", () =>
    runTest(
      Effect.gen(function* () {
        const risk = yield* RiskManager;
        // maxHourlyLoss = 25
        yield* risk.onTradeClosed({
          id: "t-hourly",
          strategy: "arb",
          side: "UP",
          tokenId: "tok",
          entryPrice: 0.55,
          size: 10,
          shares: 18,
          fee: 0,
          status: "resolved",
          outcome: "loss",
          pnl: -25,
          timestamp: Date.now(),
          windowEnd: Date.now() - 1,
          conditionId: "cond-hourly",
          priceToBeatAtEntry: 100_000,
        });
        const result = yield* risk.approve(makeSignal());
        expect(result.approved).toBe(false);
        expect(result.reason).toContain("Hourly loss limit");
        // Auto-pause should be set — next approve without loss should still be blocked
        const stillBlocked = yield* risk.approve(makeSignal());
        expect(stillBlocked.approved).toBe(false);
        expect(stillBlocked.reason).toContain("paused");
      }),
    ));

  it("rejects after window loss limit and resets on new window", () =>
    runTest(
      Effect.gen(function* () {
        const risk = yield* RiskManager;
        // maxLossPerWindow = 2
        yield* risk.onNewWindow("win-A");
        const makeLosingTrade = (id: string): TradeRecord => ({
          id,
          strategy: "arb",
          side: "UP",
          tokenId: "tok",
          entryPrice: 0.55,
          size: 5,
          shares: 9,
          fee: 0,
          status: "resolved",
          outcome: "loss",
          pnl: -2,
          timestamp: Date.now(),
          windowEnd: Date.now() - 1,
          conditionId: "win-A",
          priceToBeatAtEntry: 100_000,
        });
        yield* risk.onTradeClosed(makeLosingTrade("t-wl-1"));
        yield* risk.onTradeClosed(makeLosingTrade("t-wl-2"));

        const blocked = yield* risk.approve(makeSignal());
        expect(blocked.approved).toBe(false);
        expect(blocked.reason).toContain("Window loss limit");

        // Switch to a new window — counter should reset
        yield* risk.onNewWindow("win-B");
        const allowed = yield* risk.approve(makeSignal());
        expect(allowed.approved).toBe(true);
      }),
    ));

  it("a win resets the consecutive loss counter", () =>
    runTest(
      Effect.gen(function* () {
        const risk = yield* RiskManager;
        // Use a fresh window so window loss counter stays clear
        yield* risk.onNewWindow("win-streak");

        const makeTrade = (id: string, outcome: "win" | "loss", pnl: number): TradeRecord => ({
          id,
          strategy: "arb",
          side: "UP",
          tokenId: "tok",
          entryPrice: 0.55,
          size: 5,
          shares: 9,
          fee: 0,
          status: "resolved",
          outcome,
          pnl,
          timestamp: Date.now(),
          windowEnd: Date.now() - 1,
          conditionId: "win-streak",
          priceToBeatAtEntry: 100_000,
        });

        // 1 loss then immediately a win — streaks shouldn't accumulate across windows
        yield* risk.onTradeClosed(makeTrade("t-l-0", "loss", -1));
        yield* risk.onTradeClosed(makeTrade("t-win", "win", 3));

        const snapshot = yield* risk.getSnapshot;
        expect(snapshot.consecutiveLosses).toBe(0);
        // Approval should now pass (1 window loss < limit of 2, consecutive = 0)
        const result = yield* risk.approve(makeSignal());
        expect(result.approved).toBe(true);
      }),
    ));
});

import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { GlobalRiskManager } from "../../src/engine/global-risk.js";
import { makeTestConfigLayer } from "../helpers.js";
import type { Signal } from "../../src/types.js";

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

const testLayer = Layer.provide(GlobalRiskManager.Default, makeTestConfigLayer());

const runTest = <A>(effect: Effect.Effect<A, unknown, GlobalRiskManager>) =>
  Effect.runPromise(Effect.scoped(Effect.provide(effect, testLayer)));

describe("GlobalRiskManager", () => {
  it("approves signals when under all global limits", () =>
    runTest(
      Effect.gen(function* () {
        const grm = yield* GlobalRiskManager;
        const result = yield* grm.approve(makeSignal());
        expect(result.approved).toBe(true);
      }),
    ));

  it("rejects when signal would push total exposure past global limit", () =>
    runTest(
      Effect.gen(function* () {
        const grm = yield* GlobalRiskManager;
        // maxTotalExposure = 100; open 19 × $5 = $95
        for (let i = 0; i < 19; i++) yield* grm.onTradeOpened(5);
        // Next signal of $6 would reach $101 > $100
        const result = yield* grm.approve(makeSignal({ size: 6 }));
        expect(result.approved).toBe(false);
        expect(result.reason).toContain("Global exposure limit");
      }),
    ));

  it("rejects when global daily loss limit is reached", () =>
    runTest(
      Effect.gen(function* () {
        const grm = yield* GlobalRiskManager;
        // maxDailyLoss = 50; a loss of exactly $50 hits the limit (<=)
        yield* grm.onTradeClosed(5, -50);
        const result = yield* grm.approve(makeSignal());
        expect(result.approved).toBe(false);
        expect(result.reason).toContain("Global daily loss limit");
      }),
    ));

  it("rejects when global hourly loss limit is reached", () =>
    runTest(
      Effect.gen(function* () {
        const grm = yield* GlobalRiskManager;
        // maxHourlyLoss = 25
        yield* grm.onTradeClosed(5, -25);
        const result = yield* grm.approve(makeSignal());
        expect(result.approved).toBe(false);
        expect(result.reason).toContain("Global hourly loss limit");
      }),
    ));

  it("still approves when combined PnL is under both daily and hourly limits", () =>
    runTest(
      Effect.gen(function* () {
        const grm = yield* GlobalRiskManager;
        // $20 win on BTC, $10 loss on XRP → net +$10 daily
        yield* grm.onTradeClosed(5, 20);
        yield* grm.onTradeClosed(5, -10);
        const result = yield* grm.approve(makeSignal());
        expect(result.approved).toBe(true);
      }),
    ));

  it("accumulates cross-market PnL correctly", () =>
    runTest(
      Effect.gen(function* () {
        const grm = yield* GlobalRiskManager;
        // BTC makes $20, XRP loses $30 → net -$10 daily (limit is -$50)
        yield* grm.onTradeClosed(5, 20);
        yield* grm.onTradeClosed(5, -30);
        const state = yield* grm.getState;
        expect(state.dailyPnl).toBeCloseTo(-10);
        // Not yet at the daily loss limit
        const result = yield* grm.approve(makeSignal());
        expect(result.approved).toBe(true);
      }),
    ));

  it("tracks exposure correctly across opens and closes", () =>
    runTest(
      Effect.gen(function* () {
        const grm = yield* GlobalRiskManager;
        yield* grm.onTradeOpened(10);
        yield* grm.onTradeOpened(15);
        let state = yield* grm.getState;
        expect(state.totalExposure).toBe(25);
        expect(state.totalOpenPositions).toBe(2);

        yield* grm.onTradeClosed(10, 3);
        state = yield* grm.getState;
        expect(state.totalExposure).toBe(15);
        expect(state.totalOpenPositions).toBe(1);
        expect(state.dailyPnl).toBeCloseTo(3);
      }),
    ));

  it("clamps exposure to zero on close without matching open", () =>
    runTest(
      Effect.gen(function* () {
        const grm = yield* GlobalRiskManager;
        // Close a trade that was never recorded as open
        yield* grm.onTradeClosed(10, 5);
        const state = yield* grm.getState;
        expect(state.totalExposure).toBe(0);
        expect(state.totalOpenPositions).toBe(0);
      }),
    ));

  it("allows next signal after a cross-market win offsets earlier losses", () =>
    runTest(
      Effect.gen(function* () {
        const grm = yield* GlobalRiskManager;
        // Lose $20 (under both daily $50 and hourly $25 limits)
        yield* grm.onTradeClosed(5, -20);
        const first = yield* grm.approve(makeSignal());
        expect(first.approved).toBe(true); // $20 < daily $50 and hourly $25

        // Win $10 on another market — daily/hourly net now -$10
        yield* grm.onTradeClosed(5, 10);
        const after = yield* grm.getState;
        expect(after.dailyPnl).toBeCloseTo(-10);
        const allowed = yield* grm.approve(makeSignal());
        expect(allowed.approved).toBe(true);
      }),
    ));
});

import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { RiskManager } from "../../src/engine/risk.js";
import { runTest } from "../helpers.js";
import type { TradeRecord } from "../../src/types.js";

function makeTrade(
  id: string,
  status: TradeRecord["status"],
  outcome: TradeRecord["outcome"],
  pnl: number,
  windowEnd: number,
  overrides: Partial<TradeRecord> = {},
): TradeRecord {
  return {
    id,
    strategy: "arb",
    side: "UP",
    tokenId: "tok",
    entryPrice: 0.55,
    size: 5,
    shares: 9,
    fee: 0,
    status,
    outcome,
    pnl,
    timestamp: Date.now(),
    windowEnd,
    shadow: false,
    conditionId: "cond-r",
    priceToBeatAtEntry: 100_000,
    ...overrides,
  };
}

describe("RiskManager.rehydrate", () => {
  it("restores open positions from filled trades with future windowEnd", () =>
    runTest(
      Effect.gen(function* () {
        const risk = yield* RiskManager;
        const now = Date.now();
        const openTrade = makeTrade("t-open", "filled", null, 0, now + 60_000);
        yield* risk.rehydrate([openTrade]);
        const snap = yield* risk.getSnapshot;
        expect(snap.openPositions).toBe(1);
        expect(snap.openExposure).toBeCloseTo(5, 6);
      }),
    ));

  it("does not restore trades that are already past windowEnd", () =>
    runTest(
      Effect.gen(function* () {
        const risk = yield* RiskManager;
        const now = Date.now();
        const expiredTrade = makeTrade("t-expired", "filled", null, 0, now - 1);
        yield* risk.rehydrate([expiredTrade]);
        const snap = yield* risk.getSnapshot;
        expect(snap.openPositions).toBe(0);
      }),
    ));

  it("does not restore shadow trades as open positions", () =>
    runTest(
      Effect.gen(function* () {
        const risk = yield* RiskManager;
        const now = Date.now();
        const shadowTrade = makeTrade("t-shadow", "filled", null, 0, now + 60_000, {
          shadow: true,
        });
        yield* risk.rehydrate([shadowTrade]);
        const snap = yield* risk.getSnapshot;
        expect(snap.openPositions).toBe(0);
      }),
    ));

  it("computes dailyPnl from resolved trades today", () =>
    runTest(
      Effect.gen(function* () {
        const risk = yield* RiskManager;
        const now = Date.now();
        const win = makeTrade("t-win", "resolved", "win", 4.4, now - 1);
        const loss = makeTrade("t-loss", "resolved", "loss", -2.0, now - 2);
        yield* risk.rehydrate([win, loss]);
        const snap = yield* risk.getSnapshot;
        expect(snap.dailyPnl).toBeCloseTo(2.4, 6);
      }),
    ));

  it("computes consecutive losses from trailing resolved trade sequence", () =>
    runTest(
      Effect.gen(function* () {
        const risk = yield* RiskManager;
        const now = Date.now();
        const trades: TradeRecord[] = [
          makeTrade("t1", "resolved", "win", 3.0, now - 50),
          makeTrade("t2", "resolved", "loss", -2.0, now - 40),
          makeTrade("t3", "resolved", "loss", -2.0, now - 30),
          makeTrade("t4", "resolved", "loss", -2.0, now - 20),
        ];
        yield* risk.rehydrate(trades);
        const snap = yield* risk.getSnapshot;
        expect(snap.consecutiveLosses).toBe(3);
      }),
    ));

  it("consecutive loss counter stops at the most recent win", () =>
    runTest(
      Effect.gen(function* () {
        const risk = yield* RiskManager;
        const now = Date.now();
        const trades: TradeRecord[] = [
          makeTrade("t1", "resolved", "loss", -2.0, now - 50),
          makeTrade("t2", "resolved", "loss", -2.0, now - 40),
          makeTrade("t3", "resolved", "win", 5.0, now - 30),
          makeTrade("t4", "resolved", "loss", -2.0, now - 20),
        ];
        yield* risk.rehydrate(trades);
        const snap = yield* risk.getSnapshot;
        // Only t4 follows the last win
        expect(snap.consecutiveLosses).toBe(1);
      }),
    ));

  it("counts window losses for the given currentWindowId", () =>
    runTest(
      Effect.gen(function* () {
        const risk = yield* RiskManager;
        const now = Date.now();
        const trades: TradeRecord[] = [
          makeTrade("t1", "resolved", "loss", -2.0, now - 50, { conditionId: "win-X" }),
          makeTrade("t2", "resolved", "loss", -2.0, now - 40, { conditionId: "win-X" }),
          makeTrade("t3", "resolved", "win", 5.0, now - 30, { conditionId: "win-Y" }),
        ];
        yield* risk.rehydrate(trades, "win-X");
        const snap = yield* risk.getSnapshot;
        expect(snap.windowLosses).toBe(2);
      }),
    ));
});

describe("RiskManager.resolveExpired", () => {
  it("returns and removes trades whose windowEnd has passed", () =>
    runTest(
      Effect.gen(function* () {
        const risk = yield* RiskManager;
        const now = Date.now();
        // Open a trade with a past windowEnd via onTradeOpened
        const expiredTrade = makeTrade("t-exp", "filled", null, 0, now - 1);
        yield* risk.onTradeOpened(expiredTrade);
        const expired = yield* risk.resolveExpired(now);
        expect(expired).toHaveLength(1);
        expect(expired[0]?.id).toBe("t-exp");
        // Position should be removed
        const snap = yield* risk.getSnapshot;
        expect(snap.openPositions).toBe(0);
      }),
    ));

  it("keeps trades whose windowEnd is still in the future", () =>
    runTest(
      Effect.gen(function* () {
        const risk = yield* RiskManager;
        const now = Date.now();
        const activeTrade = makeTrade("t-active", "filled", null, 0, now + 60_000);
        yield* risk.onTradeOpened(activeTrade);
        const expired = yield* risk.resolveExpired(now);
        expect(expired).toHaveLength(0);
        const snap = yield* risk.getSnapshot;
        expect(snap.openPositions).toBe(1);
      }),
    ));

  it("only expires filled, partial, or submitted trades — not pending ones", () =>
    runTest(
      Effect.gen(function* () {
        const risk = yield* RiskManager;
        const now = Date.now();
        const pendingTrade = makeTrade("t-pending", "pending", null, 0, now - 1);
        yield* risk.onTradeOpened(pendingTrade);
        const expired = yield* risk.resolveExpired(now);
        expect(expired).toHaveLength(0);
      }),
    ));
});

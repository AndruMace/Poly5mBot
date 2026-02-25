import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { RiskManager } from "../src/engine/risk.js";
import { runTest } from "./helpers.js";
import type { Signal, MarketContext } from "../src/types.js";

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

describe("RiskManager", () => {
  it("approves valid signals under limits", () =>
    runTest(
      Effect.gen(function* () {
        const risk = yield* RiskManager;
        const result = yield* risk.approve(makeSignal());
        expect(result.approved).toBe(true);
      }),
    ));

  it("rejects signals exceeding max trade size", () =>
    runTest(
      Effect.gen(function* () {
        const risk = yield* RiskManager;
        const result = yield* risk.approve(makeSignal({ size: 999 }));
        expect(result.approved).toBe(false);
        expect(result.reason).toContain("exceeds max");
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

  it("tracks consecutive losses and pauses", () =>
    runTest(
      Effect.gen(function* () {
        const risk = yield* RiskManager;
        for (let i = 0; i < 5; i++) {
          yield* risk.onNewWindow(`window-${i}`);
          yield* risk.onTradeClosed({
            id: `t-${i}`,
            strategy: "arb",
            side: "UP" as const,
            tokenId: "tok",
            entryPrice: 0.55,
            size: 5,
            shares: 10,
            fee: 0.01,
            status: "resolved",
            outcome: "loss",
            pnl: -0.5,
            timestamp: Date.now(),
            windowEnd: Date.now() + 60_000,
            conditionId: `window-${i}`,
            priceToBeatAtEntry: 100_000,
          });
        }
        const result = yield* risk.approve(makeSignal());
        expect(result.approved).toBe(false);
        expect(result.reason).toContain("consecutive losses");
      }),
    ));

  it("resets pause correctly", () =>
    runTest(
      Effect.gen(function* () {
        const risk = yield* RiskManager;
        for (let i = 0; i < 5; i++) {
          yield* risk.onTradeClosed({
            id: `t-${i}`,
            strategy: "arb",
            side: "UP" as const,
            tokenId: "tok",
            entryPrice: 0.55,
            size: 5,
            shares: 10,
            fee: 0.01,
            status: "resolved",
            outcome: "loss",
            pnl: -5,
            timestamp: Date.now(),
            windowEnd: Date.now() + 60_000,
            conditionId: "cond",
            priceToBeatAtEntry: 100_000,
          });
        }
        yield* risk.resetPause;
        const snapshot = yield* risk.getSnapshot;
        expect(snapshot.consecutiveLosses).toBe(0);
        expect(snapshot.pauseRemainingSec).toBe(0);
      }),
    ));
});

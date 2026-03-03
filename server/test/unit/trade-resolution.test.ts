import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { FileSystem } from "@effect/platform";
import { TestContext } from "effect";
import { PnLTracker } from "../../src/engine/tracker.js";
import { TradeStore, ShadowTradeStore } from "../../src/engine/trade-store.js";
import { EventBus } from "../../src/engine/event-bus.js";
import { AccountActivityStore } from "../../src/activity/store.js";
import { CriticalIncidentStore } from "../../src/incident/store.js";
import { ObservabilityStore } from "../../src/observability/store.js";
import { makeTestConfigLayer } from "../helpers.js";
import type { TradeRecord } from "../../src/types.js";

// In-memory FS: TradeStore/ActivityStore/IncidentStore all call yield* FileSystem.FileSystem
// but with backend="postgres" (and no postgres provided) they skip file I/O entirely.
// We still need to provide the FileSystem service so the yield* doesn't fail.
const fakeFs = Layer.succeed(FileSystem.FileSystem, {
  exists: (_: string) => Effect.succeed(false),
  readFileString: (_: string) => Effect.fail(new Error("no file")),
  writeFileString: (_: string, _c: string, _o?: unknown) => Effect.void,
  makeDirectory: (_: string, _o?: unknown) => Effect.void,
} as any);

// Mirror the CoreTestLayer structure (Layer.provideMerge chain) so services can
// resolve each other's dependencies at execution time.
const testLayer = EventBus.Default.pipe(
  Layer.provideMerge(PnLTracker.Default),
  Layer.provideMerge(AccountActivityStore.Default),
  Layer.provideMerge(CriticalIncidentStore.Default),
  Layer.provideMerge(ObservabilityStore.Default),
  Layer.provideMerge(TradeStore.Default),
  Layer.provideMerge(ShadowTradeStore.Default),
  Layer.provideMerge(makeTestConfigLayer()),
  Layer.provideMerge(fakeFs),
  Layer.provideMerge(TestContext.TestContext),
);

const runTest = <A>(effect: Effect.Effect<A, unknown, PnLTracker>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(testLayer)));

function makeFilledTrade(id: string, overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id,
    strategy: "arb",
    side: "UP",
    tokenId: "up-token",
    entryPrice: 0.55,
    size: 5.5,
    shares: 10,
    fee: 0.1,
    status: "filled",
    outcome: null,
    pnl: 0,
    timestamp: Date.now(),
    windowEnd: Date.now() + 60_000,
    shadow: false,
    conditionId: "cond-test",
    priceToBeatAtEntry: 100_000,
    ...overrides,
  };
}

describe("Trade resolution PnL", () => {
  it("computes correct win PnL: shares - cost - fees", () =>
    runTest(
      Effect.gen(function* () {
        const tracker = yield* PnLTracker;
        yield* tracker.addTrade(makeFilledTrade("t-win"));
        yield* tracker.resolveTrade("t-win", true);
        const rec = yield* tracker.getTradeRecordById("t-win");
        // 10 shares × $1 payout − 0.55 × 10 cost − 0.1 fee = 4.4
        expect(rec?.pnl).toBeCloseTo(4.4, 6);
        expect(rec?.outcome).toBe("win");
        expect(rec?.status).toBe("resolved");
      }),
    ));

  it("computes correct loss PnL: -(cost + fees)", () =>
    runTest(
      Effect.gen(function* () {
        const tracker = yield* PnLTracker;
        yield* tracker.addTrade(makeFilledTrade("t-loss"));
        yield* tracker.resolveTrade("t-loss", false);
        const rec = yield* tracker.getTradeRecordById("t-loss");
        // -(0.55 × 10) - 0.1 = -5.6
        expect(rec?.pnl).toBeCloseTo(-5.6, 6);
        expect(rec?.outcome).toBe("loss");
      }),
    ));

  it("computes correct PnL for partial fill", () =>
    runTest(
      Effect.gen(function* () {
        const tracker = yield* PnLTracker;
        yield* tracker.addTrade(
          makeFilledTrade("t-partial", {
            status: "partial",
            shares: 6,
            entryPrice: 0.57,
            fee: 0.05,
          }),
        );
        yield* tracker.resolveTrade("t-partial", true);
        const rec = yield* tracker.getTradeRecordById("t-partial");
        // 6 − 0.57×6 − 0.05 = 6 − 3.42 − 0.05 = 2.53
        expect(rec?.pnl).toBeCloseTo(2.53, 6);
      }),
    ));

  it("records venue resolution source when specified", () =>
    runTest(
      Effect.gen(function* () {
        const tracker = yield* PnLTracker;
        yield* tracker.addTrade(makeFilledTrade("t-venue"));
        yield* tracker.resolveTrade("t-venue", true, false, {
          outcomeSource: "venue",
          settlementWinnerSide: "UP",
        });
        const rec = yield* tracker.getTradeRecordById("t-venue");
        expect(rec?.resolutionSource).toBe("venue");
        expect(rec?.settlementWinnerSide).toBe("UP");
      }),
    ));

  it("defaults to estimated resolution source when not specified", () =>
    runTest(
      Effect.gen(function* () {
        const tracker = yield* PnLTracker;
        yield* tracker.addTrade(makeFilledTrade("t-est"));
        yield* tracker.resolveTrade("t-est", true);
        const rec = yield* tracker.getTradeRecordById("t-est");
        expect(rec?.resolutionSource).toBe("estimated");
      }),
    ));

  it("live summary only includes live trades", () =>
    runTest(
      Effect.gen(function* () {
        const tracker = yield* PnLTracker;
        yield* tracker.addTrade(makeFilledTrade("t-live-1", { shadow: false }));
        yield* tracker.addTrade(makeFilledTrade("t-shadow-1", { id: "t-shadow-1", shadow: true }));
        yield* tracker.resolveTrade("t-live-1", true, false);
        yield* tracker.resolveTrade("t-shadow-1", true, true);

        const liveSummary = yield* tracker.getSummary(false);
        const shadowSummary = yield* tracker.getSummary(true);

        expect(liveSummary.totalTrades).toBe(1);
        expect(shadowSummary.totalTrades).toBe(1);
        // Live summary PnL ≈ 4.4; shadow is separate store
        expect(liveSummary.totalPnl).toBeCloseTo(4.4, 6);
        expect(shadowSummary.totalPnl).toBeCloseTo(4.4, 6);
      }),
    ));

  it("shadow trade does not appear in live summary", () =>
    runTest(
      Effect.gen(function* () {
        const tracker = yield* PnLTracker;
        yield* tracker.addTrade(makeFilledTrade("t-shadow-only", { shadow: true }));
        yield* tracker.resolveTrade("t-shadow-only", true, true);

        const liveSummary = yield* tracker.getSummary(false);
        expect(liveSummary.totalTrades).toBe(0);
        expect(liveSummary.totalPnl).toBe(0);
      }),
    ));

  it("aggregates PnL by strategy in summary", () =>
    runTest(
      Effect.gen(function* () {
        const tracker = yield* PnLTracker;
        yield* tracker.addTrade(makeFilledTrade("t-arb-1", { strategy: "arb" }));
        yield* tracker.addTrade(makeFilledTrade("t-arb-2", { id: "t-arb-2", strategy: "arb" }));
        yield* tracker.addTrade(
          makeFilledTrade("t-eff-1", { id: "t-eff-1", strategy: "efficiency" }),
        );
        yield* tracker.resolveTrade("t-arb-1", true);
        yield* tracker.resolveTrade("t-arb-2", false);
        yield* tracker.resolveTrade("t-eff-1", true);

        const summary = yield* tracker.getSummary(false);
        expect(summary.totalTrades).toBe(3);
        expect(summary.byStrategy["arb"]?.trades).toBe(2);
        expect(summary.byStrategy["efficiency"]?.trades).toBe(1);
        // arb: 1 win (4.4) + 1 loss (-5.6) = -1.2
        expect(summary.byStrategy["arb"]?.pnl).toBeCloseTo(-1.2, 6);
        // efficiency: 1 win
        expect(summary.byStrategy["efficiency"]?.pnl).toBeCloseTo(4.4, 6);
      }),
    ));
});

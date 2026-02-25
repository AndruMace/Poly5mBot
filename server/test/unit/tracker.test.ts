import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { PnLTracker } from "../../src/engine/tracker.js";
import { runTest } from "../helpers.js";

describe("PnLTracker", () => {
  it("adds and reads trades", () =>
    runTest(
      Effect.gen(function* () {
        const tracker = yield* PnLTracker;
        const id = `trk-${Date.now()}-${Math.random()}`;
        yield* tracker.addTrade({
          id,
          strategy: "arb",
          side: "UP",
          tokenId: "tok",
          entryPrice: 0.5,
          size: 10,
          shares: 20,
          fee: 0.1,
          status: "filled",
          outcome: null,
          pnl: -0.1,
          timestamp: Date.now(),
          windowEnd: Date.now() + 60_000,
          shadow: false,
          conditionId: "c1",
          priceToBeatAtEntry: 100_000,
        });

        const trades = yield* tracker.getTrades(10);
        expect(trades.some((t) => t.id === id)).toBe(true);

        yield* tracker.expireTrade(id, 100_050, false);
        yield* tracker.resolveTrade(id, true, false);
        const rec = yield* tracker.getTradeRecordById(id, false);
        expect(rec?.status).toBe("resolved");
      }),
    ));
});

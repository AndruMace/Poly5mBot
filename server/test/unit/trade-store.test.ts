import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { TradeStore } from "../../src/engine/trade-store.js";
import { runTest } from "../helpers.js";

describe("TradeStore", () => {
  it("creates and resolves trades through events", () =>
    runTest(
      Effect.gen(function* () {
        const store = yield* TradeStore;
        const id = `test-${Date.now()}-${Math.random()}`;
        yield* store.createTrade({
          id,
          conditionId: "cond-1",
          strategy: "arb",
          side: "UP",
          tokenId: "tok",
          priceToBeatAtEntry: 100_000,
          windowEnd: Date.now() + 60_000,
          shadow: false,
          size: 10,
          requestedShares: 20,
        });
        yield* store.appendEvent(id, "signal_generated", {
          conditionId: "cond-1",
          strategy: "arb",
          side: "UP",
          tokenId: "tok",
          priceToBeatAtEntry: 100_000,
          windowEnd: Date.now() + 60_000,
          shadow: false,
          size: 10,
          requestedShares: 20,
        });
        yield* store.appendEvent(id, "fill", {
          shares: 20,
          price: 0.5,
          fee: 0.1,
        });
        yield* store.appendEvent(id, "resolved", { won: true });

        const trade = yield* store.getTrade(id);
        expect(trade).toBeDefined();
        expect(trade?.status).toBe("resolved");
        expect(trade?.outcome).toBe("win");

        const summary = yield* store.getSummary;
        expect(summary.totalTrades).toBeGreaterThan(0);
      }),
    ));
});

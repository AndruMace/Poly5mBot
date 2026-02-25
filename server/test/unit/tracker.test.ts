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

  it("paginates and filters trades by mode", () =>
    runTest(
      Effect.gen(function* () {
        const tracker = yield* PnLTracker;
        const baseTs = Date.now();
        for (let i = 0; i < 3; i++) {
          yield* tracker.addTrade({
            id: `live-${baseTs}-${i}`,
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
            timestamp: baseTs - i * 1000,
            windowEnd: Date.now() + 60_000,
            shadow: false,
            conditionId: `cl-${i}`,
            priceToBeatAtEntry: 100_000,
          });
          yield* tracker.addTrade({
            id: `shadow-${baseTs}-${i}`,
            strategy: "arb",
            side: "DOWN",
            tokenId: "tok",
            entryPrice: 0.5,
            size: 8,
            shares: 16,
            fee: 0.1,
            status: "filled",
            outcome: null,
            pnl: -0.1,
            timestamp: baseTs - i * 1000 - 100,
            windowEnd: Date.now() + 60_000,
            shadow: true,
            conditionId: `cs-${i}`,
            priceToBeatAtEntry: 100_000,
          });
        }

        const page1 = yield* tracker.listTrades({ mode: "all", limit: 2 });
        expect(page1.items.length).toBe(2);
        expect(page1.hasMore).toBe(true);
        expect(page1.nextCursor).toBeTruthy();

        const page2 = yield* tracker.listTrades({
          mode: "all",
          limit: 2,
          cursor: page1.nextCursor ?? undefined,
        });
        expect(page2.items.length).toBeGreaterThan(0);
        const page1Ids = new Set(page1.items.map((t) => t.id));
        expect(page2.items.some((t) => page1Ids.has(t.id))).toBe(false);

        const liveOnly = yield* tracker.listTrades({ mode: "live", limit: 10 });
        expect(liveOnly.items.every((t) => !t.shadow)).toBe(true);
      }),
    ));
});

import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { FillSimulator } from "../../src/engine/fill-simulator.js";
import { runTest } from "../helpers.js";

describe("FillSimulator", () => {
  it("returns no_liquidity for empty book", () =>
    runTest(
      Effect.gen(function* () {
        const sim = yield* FillSimulator;
        const result = sim.simulate("BUY", "token", 10, 0.55, {
          bids: [],
          asks: [],
        });
        expect(result.filled).toBe(false);
        expect(result.reason).toBe("no_liquidity");
      }),
    ));

  it("respects fill probability", () =>
    runTest(
      Effect.gen(function* () {
        const sim = yield* FillSimulator;
        const result = sim.simulate(
          "BUY",
          "token",
          10,
          0.6,
          {
            bids: [{ price: 0.5, size: 100 }],
            asks: [{ price: 0.52, size: 100 }],
          },
          { fillProbability: 0 },
        );
        expect(result.filled).toBe(false);
        expect(result.reason).toBe("queue_position_miss");
      }),
    ));

  it("fills and computes average price", () =>
    runTest(
      Effect.gen(function* () {
        const sim = yield* FillSimulator;
        const result = sim.simulate(
          "BUY",
          "token",
          10,
          0.6,
          {
            bids: [{ price: 0.5, size: 100 }],
            asks: [
              { price: 0.52, size: 4 },
              { price: 0.54, size: 8 },
            ],
          },
          { fillProbability: 1 },
        );
        expect(result.filled).toBe(true);
        expect(result.filledShares).toBe(10);
        expect(result.avgPrice).toBeGreaterThanOrEqual(0.52);
        expect(result.avgPrice).toBeLessThanOrEqual(0.6);
      }),
    ));
});

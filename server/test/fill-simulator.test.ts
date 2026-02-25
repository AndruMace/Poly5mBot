import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { FillSimulator } from "../src/engine/fill-simulator.js";
import { runTest } from "./helpers.js";

describe("FillSimulator", () => {
  it("returns no_liquidity when order book is empty", () =>
    runTest(
      Effect.gen(function* () {
        const sim = yield* FillSimulator;
        const result = sim.simulate(
          "BUY",
          "token123",
          10,
          0.55,
          { bids: [], asks: [] },
        );
        expect(result.filled).toBe(false);
        expect(result.reason).toBe("no_liquidity");
      }),
    ));

  it("fills when sufficient liquidity exists", () =>
    runTest(
      Effect.gen(function* () {
        const sim = yield* FillSimulator;
        const result = sim.simulate(
          "BUY",
          "token123",
          10,
          0.60,
          {
            bids: [{ price: 0.50, size: 100 }],
            asks: [
              { price: 0.52, size: 50 },
              { price: 0.54, size: 50 },
            ],
          },
          { fillProbability: 1.0 },
        );
        expect(result.filled).toBe(true);
        expect(result.filledShares).toBe(10);
        expect(result.avgPrice).toBeGreaterThan(0);
        expect(result.fee).toBeGreaterThan(0);
      }),
    ));

  it("respects limit price", () =>
    runTest(
      Effect.gen(function* () {
        const sim = yield* FillSimulator;
        const result = sim.simulate(
          "BUY",
          "token123",
          10,
          0.40,
          {
            bids: [],
            asks: [{ price: 0.50, size: 100 }],
          },
          { fillProbability: 1.0 },
        );
        expect(result.filled).toBe(false);
        expect(result.reason).toBe("insufficient_liquidity");
      }),
    ));
});

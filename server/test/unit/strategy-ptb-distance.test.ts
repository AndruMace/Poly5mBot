import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { makeArbStrategy } from "../../src/strategies/arb.js";
import { makeMomentumStrategy } from "../../src/strategies/momentum.js";
import { makeWhaleHuntStrategy } from "../../src/strategies/whale-hunt.js";
import type { MarketContext, PricePoint } from "../../src/types.js";

function baseContext(): MarketContext {
  const now = Date.now();
  return {
    currentWindow: {
      conditionId: "cond-1",
      slug: "btc-5m",
      upTokenId: "up",
      downTokenId: "down",
      startTime: now - 240_000,
      endTime: now + 30_000,
      priceToBeat: 100_000,
      resolved: false,
    },
    orderBook: {
      up: { bids: [{ price: 0.62, size: 120 }], asks: [{ price: 0.63, size: 100 }] },
      down: { bids: [{ price: 0.36, size: 110 }], asks: [{ price: 0.37, size: 130 }] },
      bestAskUp: 0.63,
      bestAskDown: 0.37,
      bestBidUp: 0.62,
      bestBidDown: 0.36,
    },
    prices: {
      binance: { exchange: "binance", price: 100_050, timestamp: now },
      bybit: { exchange: "bybit", price: 100_052, timestamp: now },
    },
    oracleEstimate: 100_000,
    oracleTimestamp: now,
    windowElapsedMs: 220_000,
    windowRemainingMs: 40_000,
    priceToBeat: 100_000,
    currentAssetPrice: 100_050,
    marketId: "btc",
  };
}

describe("strategy PTB distance gating", () => {
  it("blocks and then allows momentum when PTB distance threshold changes", async () => {
    const strategy = await Effect.runPromise(makeMomentumStrategy);
    const now = Date.now();
    const points: PricePoint[] = [
      { exchange: "binance", price: 100_000, timestamp: now - 90_000 },
      { exchange: "binance", price: 100_010, timestamp: now - 60_000 },
      { exchange: "binance", price: 100_020, timestamp: now - 30_000 },
      { exchange: "binance", price: 100_040, timestamp: now - 5_000 },
    ];
    for (const point of points) {
      await Effect.runPromise(strategy.addPrice(point));
    }

    await Effect.runPromise(strategy.updateConfig({
      rsiPeriod: 2,
      rsiOverbought: 50,
      minWindowElapsedSec: 0,
      maxWindowElapsedSec: 295,
      minPriceMovePct: 0,
      minPtbDistancePct: 0.08,
      tradeSize: 5,
    }));
    const blocked = await Effect.runPromise(strategy.evaluate(baseContext()));
    expect(blocked).toBeNull();

    await Effect.runPromise(strategy.updateConfig({ minPtbDistancePct: 0.03 }));
    const allowed = await Effect.runPromise(strategy.evaluate(baseContext()));
    expect(allowed).not.toBeNull();
    expect(allowed?.strategy).toBe("momentum");
  });

  it("respects PTB distance gate in arb strategy", async () => {
    const strategy = await Effect.runPromise(makeArbStrategy);
    await Effect.runPromise(strategy.updateConfig({
      minSpreadPct: 0.01,
      minPtbDistancePct: 0.1,
      persistenceCount: 1,
      persistenceMs: 10_000,
      minWindowElapsedSec: 0,
      maxWindowElapsedSec: 300,
      minConfirmingExchanges: 0,
    }));

    const blocked = await Effect.runPromise(strategy.evaluate(baseContext()));
    expect(blocked).toBeNull();

    await Effect.runPromise(strategy.updateConfig({ minPtbDistancePct: 0.01 }));
    const allowed = await Effect.runPromise(strategy.evaluate(baseContext()));
    expect(allowed).not.toBeNull();
    expect(allowed?.strategy).toBe("arb");
  });

  it("respects PTB distance gate in whale-hunt strategy", async () => {
    const strategy = await Effect.runPromise(makeWhaleHuntStrategy);
    await Effect.runPromise(strategy.updateConfig({
      minWindowElapsedSec: 0,
      minPriceMovePct: 0,
      minPtbDistancePct: 0.1,
      minSharePrice: 0.3,
      maxSharePrice: 0.95,
      probabilityFloor: 0.2,
      entryWindowSec: 60,
      maxDynamicEntryWindowSec: 120,
      minEarlyGapPct: 0.01,
    }));

    const blocked = await Effect.runPromise(strategy.evaluate(baseContext()));
    expect(blocked).toBeNull();

    await Effect.runPromise(strategy.updateConfig({ minPtbDistancePct: 0.01 }));
    const allowed = await Effect.runPromise(strategy.evaluate(baseContext()));
    expect(allowed).not.toBeNull();
    expect(allowed?.strategy).toBe("whale-hunt");
  });
});

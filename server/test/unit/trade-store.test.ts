import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { TradeStore, ShadowTradeStore, toTradeRecord } from "../../src/engine/trade-store.js";
import type { EntryContext } from "../../src/types.js";
import { runTest } from "../helpers.js";

const sampleEntryContext: EntryContext = {
  strategyName: "arb",
  mode: "live",
  regime: {
    volatilityRegime: "normal",
    trendRegime: "chop",
    liquidityRegime: "normal",
    spreadRegime: "tight",
    volatilityValue: 0.0005,
    trendStrength: 0.3,
    liquidityDepth: 50,
    spreadValue: 0.02,
  },
  strategyConfig: { minSpreadPct: 0.02, tradeSize: 5, maxSharePrice: 0.65 },
  regimeFilter: { allowedVolatility: ["normal", "low"] },
  signal: {
    side: "UP",
    confidence: 0.72,
    reason: "spread above threshold",
    maxPrice: 0.6,
    timestamp: Date.now(),
  },
  window: {
    conditionId: "cond-1",
    windowStart: Date.now() - 60_000,
    windowEnd: Date.now() + 240_000,
    priceToBeat: 64000,
  },
  microstructure: {
    bestAskUp: 0.55,
    bestAskDown: 0.48,
    bestBidUp: 0.53,
    bestBidDown: 0.46,
    oracleEstimate: 64010,
    currentAssetPrice: 64015,
  },
  riskAtEntry: {
    openPositions: 2,
    openExposure: 18.5,
    dailyPnl: -3.2,
    hourlyPnl: -1.1,
    consecutiveLosses: 1,
  },
  sizing: {
    configuredTradeSize: 5,
    computedSize: 4.8,
    finalNotional: 4.8,
  },
};

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

  it("persists and projects entryContext on live trades", () =>
    runTest(
      Effect.gen(function* () {
        const store = yield* TradeStore;
        const id = `ctx-live-${Date.now()}-${Math.random()}`;
        yield* store.createTrade({
          id,
          conditionId: "cond-1",
          strategy: "arb",
          side: "UP",
          tokenId: "tok",
          priceToBeatAtEntry: 64000,
          windowEnd: Date.now() + 60_000,
          shadow: false,
          size: 4.8,
          requestedShares: 8,
          entryContext: sampleEntryContext,
        });
        yield* store.appendEvent(id, "signal_generated", {
          conditionId: "cond-1",
          strategy: "arb",
          side: "UP",
          tokenId: "tok",
          priceToBeatAtEntry: 64000,
          windowEnd: Date.now() + 60_000,
          shadow: false,
          size: 4.8,
          requestedShares: 8,
          entryContext: sampleEntryContext,
        });
        yield* store.appendEvent(id, "fill", { shares: 8, price: 0.55, fee: 0.04 });

        const trade = yield* store.getTrade(id);
        expect(trade).toBeDefined();
        expect(trade!.entryContext).toBeDefined();
        expect(trade!.entryContext!.strategyName).toBe("arb");
        expect(trade!.entryContext!.regime.volatilityRegime).toBe("normal");
        expect(trade!.entryContext!.sizing.configuredTradeSize).toBe(5);

        const record = toTradeRecord(trade!);
        expect(record.entryContext).toBeDefined();
        expect(record.entryContext!.mode).toBe("live");
        expect(record.entryContext!.signal.confidence).toBe(0.72);
        expect(record.entryContext!.microstructure.bestAskUp).toBe(0.55);
        expect(record.entryContext!.riskAtEntry.openPositions).toBe(2);
      }),
    ));

  it("persists and projects entryContext on shadow trades", () =>
    runTest(
      Effect.gen(function* () {
        const store = yield* ShadowTradeStore;
        const id = `ctx-shadow-${Date.now()}-${Math.random()}`;
        const shadowCtx: EntryContext = {
          ...sampleEntryContext,
          strategyName: "momentum",
          mode: "shadow",
          window: { ...sampleEntryContext.window, conditionId: "cond-2", priceToBeat: 65000 },
        };
        yield* store.createTrade({
          id,
          conditionId: "cond-2",
          strategy: "momentum",
          side: "DOWN",
          tokenId: "tok-d",
          priceToBeatAtEntry: 65000,
          windowEnd: Date.now() + 60_000,
          shadow: true,
          size: 3.5,
          requestedShares: 6,
          entryContext: shadowCtx,
        });
        yield* store.appendEvent(id, "signal_generated", {
          conditionId: "cond-2",
          strategy: "momentum",
          side: "DOWN",
          tokenId: "tok-d",
          priceToBeatAtEntry: 65000,
          windowEnd: Date.now() + 60_000,
          shadow: true,
          size: 3.5,
          requestedShares: 6,
          entryContext: shadowCtx,
        });
        yield* store.appendEvent(id, "fill", { shares: 6, price: 0.48, fee: 0.03 });

        const trade = yield* store.getTrade(id);
        expect(trade).toBeDefined();
        expect(trade!.entryContext).toBeDefined();
        expect(trade!.entryContext!.mode).toBe("shadow");
        expect(trade!.entryContext!.strategyName).toBe("momentum");

        const record = toTradeRecord(trade!);
        expect(record.entryContext!.window.priceToBeat).toBe(65000);
      }),
    ));

  it("handles replay of old events without entryContext", () =>
    runTest(
      Effect.gen(function* () {
        const store = yield* TradeStore;
        const id = `ctx-old-${Date.now()}-${Math.random()}`;
        yield* store.createTrade({
          id,
          conditionId: "cond-old",
          strategy: "whale-hunt",
          side: "UP",
          tokenId: "tok-old",
          priceToBeatAtEntry: 60000,
          windowEnd: Date.now() + 60_000,
          shadow: false,
          size: 7,
          requestedShares: 12,
        });
        yield* store.appendEvent(id, "signal_generated", {
          conditionId: "cond-old",
          strategy: "whale-hunt",
          side: "UP",
          tokenId: "tok-old",
          priceToBeatAtEntry: 60000,
          windowEnd: Date.now() + 60_000,
          shadow: false,
          size: 7,
          requestedShares: 12,
        });
        yield* store.appendEvent(id, "fill", { shares: 12, price: 0.6, fee: 0.05 });
        yield* store.appendEvent(id, "resolved", { won: false });

        const trade = yield* store.getTrade(id);
        expect(trade).toBeDefined();
        expect(trade!.entryContext).toBeUndefined();
        expect(trade!.status).toBe("resolved");

        const record = toTradeRecord(trade!);
        expect(record.entryContext).toBeUndefined();
        expect(record.outcome).toBe("loss");
      }),
    ));
});

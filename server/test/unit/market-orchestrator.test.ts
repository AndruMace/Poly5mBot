import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { FileSystem } from "@effect/platform";
import { MarketOrchestrator } from "../../src/markets/orchestrator.js";
import { TradingEngine } from "../../src/engine/engine.js";
import { FeedService } from "../../src/feeds/manager.js";
import { GlobalRiskManager } from "../../src/engine/global-risk.js";
import { OrderService } from "../../src/polymarket/orders.js";
import { PolymarketClient } from "../../src/polymarket/client.js";
import { FillSimulator } from "../../src/engine/fill-simulator.js";
import { PositionSizer } from "../../src/engine/position-sizer.js";
import { CriticalIncidentStore } from "../../src/incident/store.js";
import { EventBus } from "../../src/engine/event-bus.js";
import { makeTestConfigLayer } from "../helpers.js";

// Minimal TradingEngine mock — all methods return no-op values.
const fakeEngineLayer = Layer.succeed(TradingEngine, {
  tracker: {
    listTrades: (_query: unknown) =>
      Effect.succeed({ items: [], hasMore: false, nextCursor: null }),
    getSummary: (_shadow = false) =>
      Effect.succeed({
        totalPnl: 0,
        todayPnl: 0,
        totalTrades: 0,
        winRate: 0,
        byStrategy: {},
        history: [],
      }),
  },
  getStrategyStates: Effect.succeed([]),
  getOrderBookState: Effect.succeed({
    up: { bids: [], asks: [] },
    down: { bids: [], asks: [] },
    bestAskUp: null,
    bestAskDown: null,
    bestBidUp: null,
    bestBidDown: null,
  }),
  getCurrentWindow: Effect.succeed(null),
  getWindowTitle: Effect.succeed("BTC/USD 5m"),
  isTradingActive: Effect.succeed(false),
  setTradingActive: (_: boolean) => Effect.void,
  getMode: Effect.succeed("shadow" as const),
  setMode: (_: "live" | "shadow") => Effect.void,
  getRegime: Effect.succeed({
    volatilityRegime: "normal",
    trendRegime: "chop",
    liquidityRegime: "normal",
    spreadRegime: "normal",
  }),
  getRiskSnapshot: Effect.succeed({
    openPositions: 0,
    maxConcurrentPositions: 5,
    openExposure: 0,
    maxTotalExposure: 100,
    dailyPnl: 0,
    maxDailyLoss: 50,
    hourlyPnl: 0,
    maxHourlyLoss: 25,
    consecutiveLosses: 0,
    maxConsecutiveLosses: 5,
    windowLosses: 0,
    maxLossPerWindow: 2,
    pauseRemainingSec: 0,
    windowSpend: 0,
    maxWindowSpend: 15,
    windowTradeCount: 0,
    maxWindowTrades: 6,
  }),
  getKillSwitchStatus: Effect.succeed([]),
  resetKillSwitchPause: Effect.void,
  getMetrics: Effect.succeed({
    windowConditionId: null,
    rolling: {},
    window: {},
    latency: {
      lastSignalToSubmitMs: 0,
      avgSignalToSubmitMs: 0,
      avgRecentSignalToSubmitMs: 0,
      samples: 0,
      lastSampleAt: 0,
      priceDataAgeMs: 0,
      orderbookAgeMs: 0,
    },
    reconciliation: {
      updatedAt: 0,
      liveTotalTrades: 0,
      shadowTotalTrades: 0,
      liveWinRate: 0,
      shadowWinRate: 0,
      liveTotalPnl: 0,
      shadowTotalPnl: 0,
      strategies: [],
    },
  }),
  toggleStrategy: (_: string) => Effect.succeed(false),
  updateStrategyConfig: (_: string, __: Record<string, unknown>) =>
    Effect.succeed({ status: "ok" as const }),
  updateStrategyRegimeFilter: (_: string, __: Record<string, unknown>) =>
    Effect.succeed({ status: "ok" as const }),
} as any);

const fakeFeedLayer = Layer.succeed(FeedService, {
  getLatestPrices: Effect.succeed({}),
  getOracleEstimate: Effect.succeed(100_000),
  getOracleTimestamp: Effect.sync(() => Date.now()),
  getCurrentAssetPrice: Effect.succeed(100_000),
  getFeedHealth: Effect.succeed({
    sources: [],
    healthyCount: 0,
    staleCount: 0,
    downCount: 0,
    oracleEstimate: 0,
    oracleSourceCount: 0,
    updatedAt: Date.now(),
  }),
  getRecentPrices: () => Effect.succeed([]),
  priceChanges: null,
} as any);

const fakeOrderLayer = Layer.succeed(OrderService, {
  executeSignal: () => Effect.succeed(null),
  executeDualBuy: () => Effect.succeed([]),
  executeSell: () => Effect.succeed(null),
  getOrderBook: () => Effect.succeed({ bids: [], asks: [] }),
  getOrderStatusById: () =>
    Effect.succeed({ mappedStatus: null, rawStatus: null, avgPrice: null, filledShares: null, reason: null }),
  listRecentOrders: () => Effect.succeed([]),
} as any);

const fakePolyLayer = Layer.succeed(PolymarketClient, {
  isConnected: Effect.succeed(false),
  getWalletAddress: Effect.succeed(null),
} as any);

// Fake FS required by CriticalIncidentStore (and AccountActivityStore if present)
const fakeFs = Layer.succeed(FileSystem.FileSystem, {
  exists: (_: string) => Effect.succeed(false),
  readFileString: (_: string) => Effect.fail(new Error("no file")),
  writeFileString: (_: string, _c: string, _o?: unknown) => Effect.void,
  makeDirectory: (_: string, _o?: unknown) => Effect.void,
} as any);

function makeOrchestratorLayer(enabledIds: string[]) {
  const configLayer = makeTestConfigLayer({ markets: { enabledIds } });
  return MarketOrchestrator.Default.pipe(
    Layer.provideMerge(fakeEngineLayer),
    Layer.provideMerge(fakeFeedLayer),
    Layer.provideMerge(GlobalRiskManager.Default),
    Layer.provideMerge(fakeOrderLayer),
    Layer.provideMerge(fakePolyLayer),
    Layer.provideMerge(FillSimulator.Default),
    Layer.provideMerge(PositionSizer.Default),
    Layer.provideMerge(CriticalIncidentStore.Default),
    Layer.provideMerge(EventBus.Default),
    Layer.provideMerge(configLayer),
    Layer.provideMerge(fakeFs),
  );
}

const runOrchestrator = <A>(
  enabledIds: string[],
  effect: Effect.Effect<A, unknown, MarketOrchestrator>,
) =>
  Effect.runPromise(
    effect.pipe(Effect.scoped, Effect.provide(makeOrchestratorLayer(enabledIds))),
  );

describe("MarketOrchestrator", () => {
  it("getEngine('btc') returns a non-null engine when btc is enabled", () =>
    runOrchestrator(
      ["btc"],
      Effect.gen(function* () {
        const orch = yield* MarketOrchestrator;
        const engine = orch.getEngine("btc");
        expect(engine).not.toBeNull();
        expect(engine?.marketId).toBe("btc");
      }),
    ));

  it("getEngine returns null for a market not in enabledIds", () =>
    runOrchestrator(
      ["btc"],
      Effect.gen(function* () {
        const orch = yield* MarketOrchestrator;
        expect(orch.getEngine("xrp")).toBeNull();
        expect(orch.getEngine("someRandomMarket")).toBeNull();
      }),
    ));

  it("getAllEngines returns exactly one engine for btc-only config", () =>
    runOrchestrator(
      ["btc"],
      Effect.gen(function* () {
        const orch = yield* MarketOrchestrator;
        const engines = orch.getAllEngines();
        expect(engines).toHaveLength(1);
        expect(engines[0]?.marketId).toBe("btc");
      }),
    ));

  it("getEnabledMarkets returns btc metadata", () =>
    runOrchestrator(
      ["btc"],
      Effect.gen(function* () {
        const orch = yield* MarketOrchestrator;
        const markets = orch.getEnabledMarkets();
        expect(markets).toHaveLength(1);
        expect(markets[0]?.id).toBe("btc");
        expect(markets[0]?.displayName).toBeTruthy();
      }),
    ));

  it("unknown market ids in enabledIds are skipped gracefully", () =>
    runOrchestrator(
      ["btc", "totally-unknown-market-xyz"],
      Effect.gen(function* () {
        const orch = yield* MarketOrchestrator;
        const engines = orch.getAllEngines();
        // Only btc should be present; unknown market is warned + skipped
        expect(engines).toHaveLength(1);
        expect(engines[0]?.marketId).toBe("btc");
        expect(orch.getEngine("totally-unknown-market-xyz")).toBeNull();
      }),
    ));

  it("getEnabledMarketIds returns the active market id list", () =>
    runOrchestrator(
      ["btc"],
      Effect.gen(function* () {
        const orch = yield* MarketOrchestrator;
        const ids = orch.getEnabledMarketIds();
        expect(ids).toContain("btc");
        expect(ids).toHaveLength(1);
      }),
    ));

  it("loads eth and sol when enabled alongside btc", () =>
    runOrchestrator(
      ["btc", "eth", "sol"],
      Effect.gen(function* () {
        const orch = yield* MarketOrchestrator;
        const ids = orch.getEnabledMarketIds();
        expect(ids).toEqual(expect.arrayContaining(["btc", "eth", "sol"]));
        expect(orch.getEngine("eth")).not.toBeNull();
        expect(orch.getEngine("sol")).not.toBeNull();
        const markets = orch.getEnabledMarkets();
        expect(markets.map((m) => m.id)).toEqual(expect.arrayContaining(["btc", "eth", "sol"]));
      }),
    ));
});

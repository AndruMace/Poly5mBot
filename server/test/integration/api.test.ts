import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { handleRequest } from "../../src/api.js";
import { TradingEngine } from "../../src/engine/engine.js";
import { FeedService } from "../../src/feeds/manager.js";
import { PolymarketClient } from "../../src/polymarket/client.js";
import { NotesStore } from "../../src/notes-store.js";
import { AppConfig } from "../../src/config.js";
import type { AppConfigShape } from "../../src/config.js";
import type { WSStatusSnapshot } from "../../src/types.js";

const baseConfig: AppConfigShape = {
  poly: {
    privateKey: "",
    signatureType: 2,
    proxyAddress: "",
    apiKey: "",
    apiSecret: "",
    apiPassphrase: "",
    builderApiKey: "",
    builderSecret: "",
    builderPassphrase: "",
    clobUrl: "https://clob.polymarket.com",
    chainId: 137,
  },
  risk: {
    maxTradeSize: 10,
    maxTotalExposure: 100,
    maxDailyLoss: 50,
    maxConcurrentPositions: 5,
    maxHourlyLoss: 25,
    maxLossPerWindow: 2,
    maxConsecutiveLosses: 5,
    staleDataMs: 5000,
    maxSpreadCents: 15,
    maxSignalAgeMs: 2000,
  },
  trading: { mode: "shadow" },
  redemption: {
    enabled: false,
    intervalMs: 45000,
    polygonRpcUrl: "https://polygon-rpc.com",
  },
  server: {
    port: 3001,
    operatorToken: "secret",
  },
  test: {
    ciLiveIntegration: false,
    liveTestTimeoutMs: 5000,
    playwrightBaseUrl: "http://127.0.0.1:5173",
    testOperatorToken: "secret",
  },
};

const fakeEngine = {
  isTradingActive: Effect.succeed(false),
  getMode: Effect.succeed("shadow" as const),
  getCurrentWindow: Effect.succeed(null),
  getWindowTitle: Effect.succeed("test"),
  getRegime: Effect.succeed({
    volatilityRegime: "normal",
    trendRegime: "chop",
    liquidityRegime: "normal",
    spreadRegime: "normal",
  }),
  getKillSwitchStatus: Effect.succeed([]),
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
  }),
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
  getStrategyStates: Effect.succeed([]),
  getOrderBookState: Effect.succeed({
    up: { bids: [], asks: [] },
    down: { bids: [], asks: [] },
    bestAskUp: null,
    bestAskDown: null,
    bestBidUp: null,
    bestBidDown: null,
  }),
  setTradingActive: (_active: boolean) => Effect.void,
  setMode: (_mode: "live" | "shadow") => Effect.void,
  resetKillSwitchPause: Effect.void,
  toggleStrategy: (_name: string) => Effect.succeed(true),
  updateStrategyConfig: (_name: string, _cfg: Record<string, unknown>) =>
    Effect.succeed({ status: "ok" as const }),
  updateStrategyRegimeFilter: (_name: string, _filter: Record<string, unknown>) =>
    Effect.succeed("ok" as const),
  tracker: {
    getTrades: (_limit = 100) => Effect.succeed([]),
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
};

const fakeFeedService = {
  getLatestPrices: Effect.succeed({}),
  getOracleEstimate: Effect.succeed(0),
  getCurrentBtcPrice: Effect.succeed(0),
  getFeedHealth: Effect.succeed({
    sources: [],
    healthyCount: 0,
    staleCount: 0,
    downCount: 0,
    oracleEstimate: 0,
    oracleSourceCount: 0,
    updatedAt: Date.now(),
  }),
};

const fakePoly = {
  isConnected: Effect.succeed(false),
  getWalletAddress: Effect.succeed(null),
  getClient: Effect.fail("no-client"),
};

const fakeNotes = {
  load: Effect.succeed({ text: "", updatedAt: 0 }),
  save: (text: string) => Effect.succeed({ text, updatedAt: Date.now() }),
};

const testLayer = Layer.mergeAll(
  Layer.succeed(AppConfig, baseConfig as any),
  Layer.succeed(TradingEngine, fakeEngine as any),
  Layer.succeed(FeedService, fakeFeedService as any),
  Layer.succeed(PolymarketClient, fakePoly as any),
  Layer.succeed(NotesStore, fakeNotes as any),
);

describe("API handler integration", () => {
  it("returns status payload", async () => {
    const res = await Effect.runPromise(
      handleRequest("/api/status", "GET", undefined, false, {}).pipe(
        Effect.provide(testLayer),
      ),
    );
    expect(res.status).toBe(200);
    expect((res.body as any).mode).toBe("shadow");
  });

  it("rejects unauthenticated control routes", async () => {
    const res = await Effect.runPromise(
      handleRequest("/api/trading/toggle", "POST", {}, false, {}).pipe(
        Effect.provide(testLayer),
      ),
    );
    expect(res.status).toBe(401);
  });

  it("accepts authenticated mode changes", async () => {
    const res = await Effect.runPromise(
      handleRequest(
        "/api/mode",
        "POST",
        { mode: "live" },
        false,
        { authorization: "Bearer secret" },
      ).pipe(Effect.provide(testLayer)),
    );
    expect(res.status).toBe(200);
    expect((res.body as any).mode).toBe("live");
  });

  it("returns 400 for invalid mode", async () => {
    const res = await Effect.runPromise(
      handleRequest(
        "/api/mode",
        "POST",
        { mode: "bad" },
        false,
        { authorization: "Bearer secret" },
      ).pipe(Effect.provide(testLayer)),
    );
    expect(res.status).toBe(400);
  });
});

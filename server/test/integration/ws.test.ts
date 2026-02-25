import { describe, it, expect, vi } from "vitest";
import { Effect, Layer } from "effect";
import { WebSocketService } from "../../src/ws/server.js";
import { TradingEngine } from "../../src/engine/engine.js";
import { FeedService } from "../../src/feeds/manager.js";
import { PolymarketClient } from "../../src/polymarket/client.js";
import { EventBus } from "../../src/engine/event-bus.js";
import type { TradeRecord } from "../../src/types.js";

const wsMockState = {
  instances: [] as Array<{
    clients: Set<any>;
    handlers: Record<string, (...args: any[]) => void>;
  }>,
};

vi.mock("ws", () => {
  class MockWebSocketServer {
    clients = new Set<any>();
    handlers: Record<string, (...args: any[]) => void> = {};

    constructor(_options: unknown) {
      wsMockState.instances.push(this as any);
    }

    on(event: string, handler: (...args: any[]) => void) {
      this.handlers[event] = handler;
      return this;
    }
  }

  class MockWebSocket {
    static OPEN = 1;
  }

  return {
    WebSocketServer: MockWebSocketServer,
    WebSocket: MockWebSocket,
  };
});

describe("WebSocketService integration", () => {
  it("sends initial status snapshot and forwards events", async () => {
    wsMockState.instances.length = 0;

    const busLayer = EventBus.Default;

    const engineLayer = Layer.succeed(TradingEngine, {
      isTradingActive: Effect.succeed(false),
      getMode: Effect.succeed("shadow" as const),
      getStrategyStates: Effect.succeed([]),
      getCurrentWindow: Effect.succeed(null),
      getOrderBookState: Effect.succeed({
        up: { bids: [], asks: [] },
        down: { bids: [], asks: [] },
        bestAskUp: null,
        bestAskDown: null,
        bestBidUp: null,
        bestBidDown: null,
      }),
      tracker: {
        getSummary: (_shadow = false) =>
          Effect.succeed({
            totalPnl: 0,
            todayPnl: 0,
            totalTrades: 0,
            winRate: 0,
            byStrategy: {},
            history: [],
          }),
        getTrades: (_limit = 50) => Effect.succeed([]),
      },
      getRegime: Effect.succeed({
        volatilityRegime: "normal",
        trendRegime: "chop",
        liquidityRegime: "normal",
        spreadRegime: "normal",
      }),
      getKillSwitchStatus: Effect.succeed([]),
      getRiskSnapshot: Effect.succeed({
        openPositions: 0,
        maxConcurrentPositions: 0,
        openExposure: 0,
        maxTotalExposure: 0,
        dailyPnl: 0,
        maxDailyLoss: 0,
        hourlyPnl: 0,
        maxHourlyLoss: 0,
        consecutiveLosses: 0,
        maxConsecutiveLosses: 0,
        windowLosses: 0,
        maxLossPerWindow: 0,
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
    } as any);

    const feedLayer = Layer.succeed(FeedService, {
      getLatestPrices: Effect.succeed({}),
      getOracleEstimate: Effect.succeed(0),
      getFeedHealth: Effect.succeed({
        sources: [],
        healthyCount: 0,
        staleCount: 0,
        downCount: 0,
        oracleEstimate: 0,
        oracleSourceCount: 0,
        updatedAt: Date.now(),
      }),
    } as any);

    const polyLayer = Layer.succeed(PolymarketClient, {
      isConnected: Effect.succeed(false),
      getWalletAddress: Effect.succeed(null),
    } as any);

    const layer = WebSocketService.Default.pipe(
      Layer.provideMerge(engineLayer),
      Layer.provideMerge(feedLayer),
      Layer.provideMerge(polyLayer),
      Layer.provideMerge(busLayer),
    );

    const messages = await Effect.runPromise(
      Effect.gen(function* () {
        const wsService = yield* WebSocketService;
        const eventBus = yield* EventBus;

        yield* wsService.attach({} as any);

        const wss = wsMockState.instances.at(0);
        if (!wss) {
          throw new Error("websocket server was not created");
        }

        const send = vi.fn((payload: string) => payload);
        const fakeClient = {
          readyState: 1,
          send,
          on: vi.fn(),
        };
        wss.clients.add(fakeClient);

        wss.handlers.connection?.(fakeClient);

        const trade: TradeRecord = {
          id: "t-1",
          strategy: "arb",
          side: "UP",
          tokenId: "tok",
          entryPrice: 0.52,
          size: 10,
          shares: 19.23,
          fee: 0.1,
          status: "pending",
          outcome: null,
          pnl: 0,
          timestamp: Date.now(),
          windowEnd: Date.now() + 60_000,
          shadow: false,
          conditionId: "cond-1",
          priceToBeatAtEntry: 100000,
        };

        yield* eventBus.publish({ _tag: "Trade", data: trade });
        yield* Effect.sleep("120 millis");

        return send.mock.calls.map(([arg]) => JSON.parse(arg));
      }).pipe(Effect.provide(layer), Effect.scoped),
    );

    expect(messages.some((m: any) => m.type === "status")).toBe(true);
    expect(messages.some((m: any) => m.type === "trade" && m.data.id === "t-1")).toBe(true);
  });
});

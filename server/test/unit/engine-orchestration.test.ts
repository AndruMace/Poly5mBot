import { beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer, TestClock, TestContext } from "effect";
import { FileSystem } from "@effect/platform";
import { TradingEngine } from "../../src/engine/engine.js";
import { FeedService } from "../../src/feeds/manager.js";
import { MarketService } from "../../src/polymarket/markets.js";
import { OrderService } from "../../src/polymarket/orders.js";
import { PolymarketClient } from "../../src/polymarket/client.js";
import { RiskManager } from "../../src/engine/risk.js";
import { PnLTracker } from "../../src/engine/tracker.js";
import { FillSimulator } from "../../src/engine/fill-simulator.js";
import { PositionSizer } from "../../src/engine/position-sizer.js";
import { RegimeDetector } from "../../src/engine/regime-detector.js";
import { EventBus } from "../../src/engine/event-bus.js";
import { TradeStore, ShadowTradeStore } from "../../src/engine/trade-store.js";
import { AccountActivityStore } from "../../src/activity/store.js";
import { CriticalIncidentStore } from "../../src/incident/store.js";
import { makeTestConfigLayer } from "../helpers.js";
import { DEFAULT_WHALE_HUNT_CONFIG } from "../../src/strategies/whale-hunt-config.js";
import type { AppConfigShape } from "../../src/config.js";
import type { MarketWindow, Signal, StrategyState, TradeRecord } from "../../src/types.js";

const mockState = vi.hoisted(() => ({
  emitByStrategy: {
    arb: true,
    efficiency: false,
    "whale-hunt": false,
    momentum: false,
  } as Record<string, boolean>,
  signalAgeMsByStrategy: {
    arb: 0,
    efficiency: 0,
    "whale-hunt": 0,
    momentum: 0,
  } as Record<string, number>,
}));

function defaultStrategyState(name: string): StrategyState {
  return {
    name,
    enabled: true,
    status: "watching",
    statusReason: null,
    lastSignal: null,
    config: { tradeSize: 10 },
    wins: 0,
    losses: 0,
    totalPnl: 0,
    regimeBlockReason: null,
    regimeFilter: {},
  };
}

vi.mock("../../src/strategies/arb.js", async () => {
  const { Effect, Ref } = await import("effect");
  const state = defaultStrategyState("arb");
  const makeArbStrategy = Effect.gen(function* () {
    const stateRef = yield* Ref.make(state as any);
    return {
      name: "arb",
      stateRef,
      evaluate: () =>
        Effect.sync(() => {
          if (!mockState.emitByStrategy.arb) return null;
          return {
            side: "UP",
            confidence: 0.82,
            size: 5,
            maxPrice: 0.55,
            strategy: "arb",
            reason: "test",
            timestamp: Date.now() - (mockState.signalAgeMsByStrategy.arb ?? 0),
          };
        }),
      getState: Ref.get(stateRef),
      onTrade: () => Effect.void,
      updateConfig: (cfg: Record<string, unknown>) =>
        Ref.modify(stateRef, (s) => {
          const normalized = Object.fromEntries(
            Object.entries(cfg).map(([k, v]) => [k, Number(v)]),
          ) as Record<string, number>;
          return [
            { ok: true, appliedKeys: Object.keys(cfg), rejectedKeys: [] },
            { ...s, config: { ...s.config, ...normalized } },
          ] as const;
        }),
      updateRegimeFilter: (filter: Record<string, unknown>) =>
        Ref.update(stateRef, (s) => ({ ...s, regimeFilter: filter as any })),
      setEnabled: (enabled: boolean) => Ref.update(stateRef, (s) => ({ ...s, enabled })),
    };
  });
  return { makeArbStrategy };
});

vi.mock("../../src/strategies/efficiency.js", async () => {
  const { Effect, Ref } = await import("effect");
  const state = defaultStrategyState("efficiency");
  const makeEfficiencyStrategy = Effect.gen(function* () {
    const stateRef = yield* Ref.make(state as any);
    return {
      name: "efficiency",
      stateRef,
      evaluate: () =>
        Effect.sync(() => {
          if (!mockState.emitByStrategy.efficiency) return null;
          return {
            side: "UP",
            confidence: 0.8,
            size: 10,
            maxPrice: 0.55,
            strategy: "efficiency",
            reason: "test",
            timestamp: Date.now() - (mockState.signalAgeMsByStrategy.efficiency ?? 0),
          };
        }),
      getState: Ref.get(stateRef),
      onTrade: () => Effect.void,
      updateConfig: (cfg: Record<string, unknown>) =>
        Ref.modify(stateRef, (s) => {
          const normalized = Object.fromEntries(
            Object.entries(cfg).map(([k, v]) => [k, Number(v)]),
          ) as Record<string, number>;
          return [
            { ok: true, appliedKeys: Object.keys(cfg), rejectedKeys: [] },
            { ...s, config: { ...s.config, ...normalized } },
          ] as const;
        }),
      updateRegimeFilter: (filter: Record<string, unknown>) =>
        Ref.update(stateRef, (s) => ({ ...s, regimeFilter: filter as any })),
      setEnabled: (enabled: boolean) => Ref.update(stateRef, (s) => ({ ...s, enabled })),
    };
  });
  return { makeEfficiencyStrategy };
});

vi.mock("../../src/strategies/whale-hunt.js", async () => {
  const { Effect, Ref } = await import("effect");
  const state = defaultStrategyState("whale-hunt");
  const makeWhaleHuntStrategy = Effect.gen(function* () {
    const stateRef = yield* Ref.make(state as any);
    return {
      name: "whale-hunt",
      stateRef,
      evaluate: () =>
        Effect.sync(() => {
          if (!mockState.emitByStrategy["whale-hunt"]) return null;
          return {
            side: "UP",
            confidence: 0.75,
            size: 5,
            maxPrice: 0.55,
            strategy: "whale-hunt",
            reason: "test",
            timestamp: Date.now() - (mockState.signalAgeMsByStrategy["whale-hunt"] ?? 0),
          };
        }),
      getState: Ref.get(stateRef),
      onTrade: () => Effect.void,
      updateConfig: (cfg: Record<string, unknown>) =>
        Ref.modify(stateRef, (s) => {
          const normalized = Object.fromEntries(
            Object.entries(cfg).map(([k, v]) => [k, Number(v)]),
          ) as Record<string, number>;
          return [
            { ok: true, appliedKeys: Object.keys(cfg), rejectedKeys: [] },
            { ...s, config: { ...s.config, ...normalized } },
          ] as const;
        }),
      updateRegimeFilter: (filter: Record<string, unknown>) =>
        Ref.update(stateRef, (s) => ({ ...s, regimeFilter: filter as any })),
      setEnabled: (enabled: boolean) => Ref.update(stateRef, (s) => ({ ...s, enabled })),
    };
  });
  return { makeWhaleHuntStrategy };
});

vi.mock("../../src/strategies/momentum.js", async () => {
  const { Effect, Ref } = await import("effect");
  const state = defaultStrategyState("momentum");
  const makeMomentumStrategy = Effect.gen(function* () {
    const stateRef = yield* Ref.make(state as any);
    return {
      name: "momentum",
      stateRef,
      evaluate: () =>
        Effect.sync(() => {
          if (!mockState.emitByStrategy.momentum) return null;
          return {
            side: "UP",
            confidence: 0.78,
            size: 5,
            maxPrice: 0.55,
            strategy: "momentum",
            reason: "test",
            timestamp: Date.now() - (mockState.signalAgeMsByStrategy.momentum ?? 0),
          };
        }),
      addPrice: () => Effect.void,
      getState: Ref.get(stateRef),
      onTrade: () => Effect.void,
      updateConfig: (cfg: Record<string, unknown>) =>
        Ref.modify(stateRef, (s) => {
          const normalized = Object.fromEntries(
            Object.entries(cfg).map(([k, v]) => [k, Number(v)]),
          ) as Record<string, number>;
          return [
            { ok: true, appliedKeys: Object.keys(cfg), rejectedKeys: [] },
            { ...s, config: { ...s.config, ...normalized } },
          ] as const;
        }),
      updateRegimeFilter: (filter: Record<string, unknown>) =>
        Ref.update(stateRef, (s) => ({ ...s, regimeFilter: filter as any })),
      setEnabled: (enabled: boolean) => Ref.update(stateRef, (s) => ({ ...s, enabled })),
    };
  });
  return { makeMomentumStrategy };
});

interface EngineHarness {
  layer: Layer.Layer<TradingEngine, never, never>;
  executeSignalCalls: number;
  executeDualCalls: number;
  seenConditionIds: string[];
  capturedSignals: Signal[];
}

function makeHarness(opts: {
  window1: string;
  window2?: string;
  switchWindowAtMarketCall?: number;
  dualBuyIncident?: boolean;
  files?: Map<string, string>;
  /** Include this clobOrderId in submitted trades so reconcile can process them */
  orderClobId?: string;
  /** What getOrderStatusById returns when called (default: all nulls) */
  reconcileStatus?: {
    mappedStatus: string | null;
    rawStatus: string | null;
    avgPrice: number | null;
    filledShares: number | null;
    reason: string | null;
  };
  /** Override the best ask price in the order book (default: 0.55) */
  orderBookAsk?: number;
  /** Override window end offset from now (default: 240_000ms) */
  windowEndOffsetMs?: number;
  configOverrides?: Partial<AppConfigShape>;
}): EngineHarness {
  let marketCalls = 0;
  let executeSignalCalls = 0;
  let executeDualCalls = 0;
  const seenConditionIds: string[] = [];
  const capturedSignals: Signal[] = [];
  const files = opts.files ?? new Map<string, string>();
  const askPrice = opts.orderBookAsk ?? 0.55;

  const mkWindow = (conditionId: string): MarketWindow => {
    const now = Date.now();
    return {
      conditionId,
      slug: conditionId,
      title: `Window ${conditionId}`,
      polymarketUrl: "https://example.com",
      upTokenId: "up-token",
      downTokenId: "down-token",
      startTime: now - 60_000,
      endTime: now + (opts.windowEndOffsetMs ?? 240_000),
      priceToBeat: 100_000,
      resolved: false,
    };
  };

  const feedLayer = Layer.succeed(FeedService, {
    getLatestPrices: Effect.sync(() => ({
      binance: {
        exchange: "binance",
        price: 100_000,
        timestamp: Date.now(),
      },
    })),
    getOracleEstimate: Effect.succeed(100_000),
    getOracleTimestamp: Effect.sync(() => Date.now()),
    getCurrentAssetPrice: Effect.succeed(100_000),
    getFeedHealth: Effect.succeed({
      sources: [],
      healthyCount: 1,
      staleCount: 0,
      downCount: 0,
      oracleEstimate: 100_000,
      oracleSourceCount: 1,
      updatedAt: Date.now(),
    }),
    getRecentPrices: () => Effect.succeed([]),
    priceChanges: null,
  } as any);

  const marketLayer = Layer.succeed(MarketService, {
    fetchCurrentBtc5mWindow: Effect.sync(() => {
      marketCalls += 1;
      if (opts.window2 && opts.switchWindowAtMarketCall && marketCalls >= opts.switchWindowAtMarketCall) {
        return mkWindow(opts.window2);
      }
      return mkWindow(opts.window1);
    }),
  } as any);

  const orderLayer = Layer.succeed(OrderService, {
    executeSignal: (signal: Signal, _up: string, _down: string, windowEnd: number, conditionId: string, priceToBeatAtEntry: number) =>
      Effect.sync(() => {
        executeSignalCalls += 1;
        seenConditionIds.push(conditionId);
        capturedSignals.push(signal);
        const trade: TradeRecord = {
          id: `live-${executeSignalCalls}`,
          strategy: "arb",
          side: "UP",
          tokenId: "up-token",
          entryPrice: 0.55,
          size: 5,
          shares: 9,
          fee: 0,
          status: "submitted",
          outcome: null,
          pnl: 0,
          timestamp: Date.now(),
          windowEnd,
          shadow: false,
          conditionId,
          priceToBeatAtEntry,
          ...(opts.orderClobId ? { clobOrderId: opts.orderClobId } : {}),
        };
        return trade;
      }),
    executeDualBuy: (_up: string, _down: string, _upPx: number, _downPx: number, _size: number, windowEnd: number, conditionId: string, priceToBeatAtEntry: number) =>
      Effect.sync(() => {
        executeDualCalls += 1;
        seenConditionIds.push(conditionId);
        if (!opts.dualBuyIncident) return [];
        return [
          {
            id: `eff-${executeDualCalls}`,
            strategy: "efficiency-partial",
            side: "UP",
            tokenId: "up-token",
            entryPrice: 0.5,
            size: 10,
            shares: 20,
            fee: 0,
            status: "submitted",
            outcome: null,
            pnl: 0,
            timestamp: Date.now(),
            windowEnd,
            shadow: false,
            conditionId,
            priceToBeatAtEntry,
          } as TradeRecord,
        ];
      }),
    getOrderBook: () =>
      Effect.succeed({
        bids: [{ price: String(askPrice - 0.03), size: "100" }],
        asks: [{ price: String(askPrice), size: "100" }],
      }),
    getOrderStatusById: () =>
      Effect.succeed(
        opts.reconcileStatus ?? {
          mappedStatus: null,
          rawStatus: null,
          avgPrice: null,
          filledShares: null,
          reason: null,
        },
      ),
    listRecentOrders: () => Effect.succeed([]),
  } as any);

  const polyLayer = Layer.succeed(PolymarketClient, {
    isConnected: Effect.succeed(true),
    getWalletAddress: Effect.succeed("0xtest"),
  } as any);

  const riskLayer = Layer.succeed(RiskManager, {
    approve: () => Effect.succeed({ approved: true, reason: "OK" }),
    onTradeOpened: () => Effect.void,
    onTradeClosed: () => Effect.void,
    onNewWindow: () => Effect.void,
    resolveExpired: () => Effect.succeed([]),
    getSnapshot: Effect.succeed({
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
    getKillSwitchStatus: Effect.succeed([]),
    resetPause: Effect.void,
    rehydrate: () => Effect.void,
  } as any);

  const fillLayer = Layer.succeed(FillSimulator, {
    simulate: () => ({
      filled: false,
      reason: "no_liquidity",
      filledShares: 0,
      avgPrice: 0,
      fee: 0,
    }),
  } as any);

  const positionLayer = Layer.succeed(PositionSizer, {
    computeSize: (signal: Signal) => signal.size,
  } as any);

  const regimeLayer = Layer.succeed(RegimeDetector, {
    addPrice: () => Effect.void,
    update: () => Effect.void,
    getRegime: Effect.succeed({
      volatilityRegime: "normal",
      trendRegime: "chop",
      liquidityRegime: "normal",
      spreadRegime: "normal",
      volatilityValue: 0,
      trendStrength: 0,
      liquidityDepth: 0,
      spreadValue: 0,
    }),
  } as any);

  const configLayer = makeTestConfigLayer({
    trading: { mode: "live", whaleHunt: { ...DEFAULT_WHALE_HUNT_CONFIG } },
    ...(opts.configOverrides ?? {}),
  });

  const fsLayer = Layer.succeed(FileSystem.FileSystem, {
    exists: (path: string) => Effect.succeed(files.has(path)),
    readFileString: (path: string) =>
      files.has(path)
        ? Effect.succeed(files.get(path)!)
        : Effect.fail(new Error(`missing ${path}`)),
    writeFileString: (path: string, content: string, options?: { flag?: string }) =>
      Effect.sync(() => {
        if (options?.flag === "a") {
          files.set(path, (files.get(path) ?? "") + content);
          return;
        }
        files.set(path, content);
      }),
    makeDirectory: (_path: string, _options?: unknown) => Effect.void,
  } as any);

  const layer = TradingEngine.Default.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(feedLayer),
    Layer.provideMerge(marketLayer),
    Layer.provideMerge(orderLayer),
    Layer.provideMerge(polyLayer),
    Layer.provideMerge(riskLayer),
    Layer.provideMerge(fillLayer),
    Layer.provideMerge(positionLayer),
    Layer.provideMerge(regimeLayer),
    Layer.provideMerge(EventBus.Default),
    Layer.provideMerge(PnLTracker.Default),
    Layer.provideMerge(AccountActivityStore.Default),
    Layer.provideMerge(CriticalIncidentStore.Default),
    Layer.provideMerge(TradeStore.Default),
    Layer.provideMerge(ShadowTradeStore.Default),
    Layer.provideMerge(fsLayer),
    Layer.provideMerge(TestContext.TestContext),
  );

  return {
    layer,
    get executeSignalCalls() {
      return executeSignalCalls;
    },
    get executeDualCalls() {
      return executeDualCalls;
    },
    seenConditionIds,
    capturedSignals,
  };
}

describe("TradingEngine orchestration", () => {
  beforeEach(() => {
    mockState.emitByStrategy.arb = true;
    mockState.emitByStrategy.efficiency = false;
    mockState.emitByStrategy["whale-hunt"] = false;
    mockState.emitByStrategy.momentum = false;
    mockState.signalAgeMsByStrategy.arb = 0;
    mockState.signalAgeMsByStrategy.efficiency = 0;
    mockState.signalAgeMsByStrategy["whale-hunt"] = 0;
    mockState.signalAgeMsByStrategy.momentum = 0;
  });

  it("enforces per-window entry caps and resets on new window", async () => {
    const harness = makeHarness({
      window1: "cond-1",
      window2: "cond-2",
      switchWindowAtMarketCall: 4,
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* TradingEngine;
        yield* engine.setTradingActive(true);

        yield* TestClock.adjust("8 seconds");
        const callsInFirstWindow = harness.executeSignalCalls;
        expect(callsInFirstWindow).toBeGreaterThanOrEqual(1);
        expect(callsInFirstWindow).toBeLessThanOrEqual(3);

        yield* TestClock.adjust("5 seconds");
        const callsAfterSwitch = harness.executeSignalCalls;
        expect(callsAfterSwitch).toBeLessThanOrEqual(3);
        const currentWindow = yield* engine.getCurrentWindow;
        expect(currentWindow?.conditionId).toBe("cond-2");
      }).pipe(Effect.scoped, Effect.provide(harness.layer)),
    );
  });

  it("auto-pauses trading when efficiency dual-leg incident is detected", async () => {
    mockState.emitByStrategy.arb = false;
    mockState.emitByStrategy.efficiency = true;

    const harness = makeHarness({
      window1: "cond-eff",
      dualBuyIncident: true,
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* TradingEngine;
        yield* engine.setTradingActive(true);
        yield* TestClock.adjust("2 seconds");

        expect(harness.executeDualCalls).toBeGreaterThan(0);
        const active = yield* engine.isTradingActive;
        expect(active).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(harness.layer)),
    );
  });

  it("reconcile transitions submitted trade to filled when order is filled", async () => {
    const harness = makeHarness({
      window1: "cond-rec-fill",
      orderClobId: "clob-fill-1",
      reconcileStatus: {
        mappedStatus: "filled",
        rawStatus: "MATCHED",
        avgPrice: 0.55,
        filledShares: 9,
        reason: null,
      },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* TradingEngine;
        yield* engine.setTradingActive(true);
        // Allow enough ticks: first tick submits the trade, next ticks reconcile it
        yield* TestClock.adjust("2 seconds");

        const trades = yield* engine.tracker.getTrades(50);
        const filled = trades.filter((t: TradeRecord) => t.status === "filled");
        expect(filled.length).toBeGreaterThan(0);
        expect(filled[0]?.clobOrderId).toBe("clob-fill-1");
      }).pipe(Effect.scoped, Effect.provide(harness.layer)),
    );
  });

  it("reconcile marks submitted trade as cancelled when order is cancelled", async () => {
    const harness = makeHarness({
      window1: "cond-rec-cancel",
      orderClobId: "clob-cancel-1",
      reconcileStatus: {
        mappedStatus: "cancelled",
        rawStatus: "CANCELLED",
        avgPrice: null,
        filledShares: null,
        reason: "order cancelled",
      },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* TradingEngine;
        yield* engine.setTradingActive(true);
        yield* TestClock.adjust("2 seconds");

        const trades = yield* engine.tracker.getTrades(50);
        const cancelled = trades.filter((t: TradeRecord) => t.status === "cancelled");
        expect(cancelled.length).toBeGreaterThan(0);
      }).pipe(Effect.scoped, Effect.provide(harness.layer)),
    );
  });

  it("clamps order price to bestAsk when bestAsk is below strategy maxPrice", async () => {
    // Strategy emits maxPrice=0.55, but bestAsk=0.52 — order should be placed at 0.52
    const harness = makeHarness({ window1: "cond-clamp", orderBookAsk: 0.52 });

    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* TradingEngine;
        yield* engine.setTradingActive(true);
        yield* TestClock.adjust("1 second");

        expect(harness.capturedSignals.length).toBeGreaterThan(0);
        for (const sig of harness.capturedSignals) {
          expect(sig.maxPrice).toBe(0.52);
        }
      }).pipe(Effect.scoped, Effect.provide(harness.layer)),
    );
  });

  it("blocks whale-hunt execution near expiry when observed latency is high", async () => {
    mockState.emitByStrategy.arb = false;
    mockState.emitByStrategy["whale-hunt"] = true;
    mockState.signalAgeMsByStrategy["whale-hunt"] = 2000;

    const harness = makeHarness({
      window1: "cond-whale-latency",
      windowEndOffsetMs: 5000,
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* TradingEngine;
        yield* engine.setTradingActive(true);
        yield* TestClock.adjust("2 seconds");

        expect(harness.executeSignalCalls).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(harness.layer)),
    );
  });

  it("uses runtime whale-hunt guard config to allow execution when thresholds are relaxed", async () => {
    mockState.emitByStrategy.arb = false;
    mockState.emitByStrategy["whale-hunt"] = true;
    mockState.signalAgeMsByStrategy["whale-hunt"] = 2000;

    const harness = makeHarness({
      window1: "cond-whale-config-override",
      windowEndOffsetMs: 5000,
      configOverrides: {
        trading: {
          mode: "live",
          whaleHunt: {
            ...DEFAULT_WHALE_HUNT_CONFIG,
            latencyMultiplier: 1,
            latencyBufferMs: 0,
            minRequiredLeadMs: 1000,
          },
        },
      },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* TradingEngine;
        yield* engine.setTradingActive(true);
        yield* TestClock.adjust("2 seconds");

        expect(harness.executeSignalCalls).toBeGreaterThan(0);
      }).pipe(Effect.scoped, Effect.provide(harness.layer)),
    );
  });

  it("persists strategy config changes across engine restart", async () => {
    const files = new Map<string, string>();
    const first = makeHarness({ window1: "cond-persist-a", files });

    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* TradingEngine;
        const result = yield* engine.updateStrategyConfig("arb", { tradeSize: 42 });
        expect(result.status).toBe("ok");

        const states = yield* engine.getStrategyStates;
        const arb = states.find((s) => s.name === "arb");
        expect(arb?.config.tradeSize).toBe(42);
      }).pipe(Effect.scoped, Effect.provide(first.layer)),
    );

    const persistedRaw = files.get("data/strategy-state.json");
    expect(persistedRaw).toBeTruthy();
    const persisted = JSON.parse(persistedRaw!);
    expect(persisted.arb?.config?.tradeSize).toBe(42);

    const second = makeHarness({ window1: "cond-persist-b", files });
    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* TradingEngine;
        const states = yield* engine.getStrategyStates;
        const arb = states.find((s) => s.name === "arb");
        expect(arb?.config.tradeSize).toBe(42);
      }).pipe(Effect.scoped, Effect.provide(second.layer)),
    );
  });
});

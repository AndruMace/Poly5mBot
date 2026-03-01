import { Effect, Layer, TestContext, TestClock } from "effect";
import { NodeContext } from "@effect/platform-node";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { AppConfig } from "../src/config.js";
import { EventBus } from "../src/engine/event-bus.js";
import { RiskManager } from "../src/engine/risk.js";
import { FillSimulator } from "../src/engine/fill-simulator.js";
import { PositionSizer } from "../src/engine/position-sizer.js";
import { RegimeDetector } from "../src/engine/regime-detector.js";
import { TradeStore, ShadowTradeStore } from "../src/engine/trade-store.js";
import { PnLTracker } from "../src/engine/tracker.js";
import { AccountActivityStore } from "../src/activity/store.js";
import { CriticalIncidentStore } from "../src/incident/store.js";
import { ObservabilityStore } from "../src/observability/store.js";
import type { AppConfigShape } from "../src/config.js";

export const TestAppConfig = Layer.succeed(AppConfig, {
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
  server: { port: 3001, operatorToken: "" },
  storage: {
    backend: "file",
    databaseUrl: "",
  },
  test: {
    ciLiveIntegration: false,
    liveTestTimeoutMs: 5000,
    playwrightBaseUrl: "http://127.0.0.1:4173",
    testOperatorToken: "test-token",
  },
} as any);

export const CoreTestLayer = Layer.mergeAll(
  FillSimulator.Default,
  PositionSizer.Default,
  RegimeDetector.Default,
  EventBus.Default,
).pipe(
  Layer.provideMerge(RiskManager.Default),
  Layer.provideMerge(PnLTracker.Default),
  Layer.provideMerge(AccountActivityStore.Default),
  Layer.provideMerge(CriticalIncidentStore.Default),
  Layer.provideMerge(ObservabilityStore.Default),
  Layer.provideMerge(TradeStore.Default),
  Layer.provideMerge(ShadowTradeStore.Default),
  Layer.provideMerge(TestAppConfig),
  Layer.provideMerge(NodeContext.layer),
  Layer.provideMerge(NodeFileSystem.layer),
  Layer.provideMerge(TestContext.TestContext),
);

export const runTest = <E, A>(
  effect: Effect.Effect<A, E, any>,
  layer = CoreTestLayer,
) =>
  Effect.runPromise(
    effect.pipe(Effect.scoped, Effect.provide(layer)),
  );

export const makeTestConfigLayer = (
  overrides: Partial<AppConfigShape> = {},
) => {
  const merged = {
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
      ...(overrides.poly ?? {}),
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
      ...(overrides.risk ?? {}),
    },
    trading: {
      mode: "shadow" as const,
      ...(overrides.trading ?? {}),
    },
    redemption: {
      enabled: false,
      intervalMs: 45000,
      polygonRpcUrl: "https://polygon-rpc.com",
      ...(overrides.redemption ?? {}),
    },
    server: {
      port: 3001,
      operatorToken: "",
      ...(overrides.server ?? {}),
    },
    storage: {
      backend: "file" as const,
      databaseUrl: "",
      ...(overrides.storage ?? {}),
    },
    test: {
      ciLiveIntegration: false,
      liveTestTimeoutMs: 5000,
      playwrightBaseUrl: "http://127.0.0.1:4173",
      testOperatorToken: "test-token",
      ...(overrides.test ?? {}),
    },
  } satisfies AppConfigShape;

  return Layer.succeed(AppConfig, merged as any);
};

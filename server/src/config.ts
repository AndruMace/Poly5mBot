import { Config, Effect, Layer, Redacted } from "effect";
import {
  DEFAULT_WHALE_HUNT_CONFIG,
  normalizeWhaleHuntConfig,
  type WhaleHuntConfig,
} from "./strategies/whale-hunt-config.js";

export interface AppConfigShape {
  readonly poly: {
    readonly privateKey: string;
    readonly signatureType: number;
    readonly proxyAddress: string;
    readonly apiKey: string;
    readonly apiSecret: string;
    readonly apiPassphrase: string;
    readonly builderApiKey: string;
    readonly builderSecret: string;
    readonly builderPassphrase: string;
    readonly clobUrl: string;
    readonly chainId: number;
  };
  readonly risk: {
    readonly maxTradeSize: number;
    readonly maxTotalExposure: number;
    readonly maxDailyLoss: number;
    readonly maxConcurrentPositions: number;
    readonly maxHourlyLoss: number;
    readonly maxLossPerWindow: number;
    readonly maxConsecutiveLosses: number;
    readonly staleDataMs: number;
    readonly maxSpreadCents: number;
    readonly maxSignalAgeMs: number;
    readonly maxWindowSpend: number;
    readonly maxWindowTrades: number;
    readonly maxLegImbalanceMs: number;
    readonly maxHedgeRetries: number;
    readonly maxResidualExposureUsd: number;
    readonly maxUnwindSlippageBps: number;
  };
  readonly trading: {
    readonly mode: "live" | "shadow";
    readonly whaleHunt: WhaleHuntConfig;
  };
  readonly redemption: {
    readonly enabled: boolean;
    readonly intervalMs: number;
    readonly polygonRpcUrl: string;
  };
  readonly server: {
    readonly port: number;
    readonly operatorToken: string;
  };
  readonly storage: {
    readonly backend: "file" | "dual" | "postgres";
    readonly databaseUrl: string;
  };
  readonly markets: {
    readonly enabledIds: ReadonlyArray<string>;
  };
  readonly test: {
    readonly ciLiveIntegration: boolean;
    readonly liveTestTimeoutMs: number;
    readonly playwrightBaseUrl: string;
    readonly testOperatorToken: string;
  };
}

export class AppConfig extends Effect.Service<AppConfig>()("AppConfig", {
  effect: Effect.gen(function* () {
    const privateKey = yield* Config.string("POLY_PRIVATE_KEY").pipe(Config.withDefault(""));
    const signatureType = yield* Config.integer("POLY_SIGNATURE_TYPE").pipe(Config.withDefault(2));
    const proxyAddress = yield* Config.string("POLY_PROXY_ADDRESS").pipe(Config.withDefault(""));
    const apiKey = yield* Config.string("POLY_API_KEY").pipe(Config.withDefault(""));
    const apiSecret = yield* Config.string("POLY_API_SECRET").pipe(Config.withDefault(""));
    const apiPassphrase = yield* Config.string("POLY_API_PASSPHRASE").pipe(Config.withDefault(""));
    const builderApiKey = yield* Config.string("POLY_BUILDER_API_KEY").pipe(Config.withDefault(""));
    const builderSecret = yield* Config.string("POLY_BUILDER_SECRET").pipe(Config.withDefault(""));
    const builderPassphrase = yield* Config.string("POLY_BUILDER_PASSPHRASE").pipe(Config.withDefault(""));

    const maxTradeSize = yield* Config.number("MAX_TRADE_SIZE").pipe(Config.withDefault(10));
    const maxTotalExposure = yield* Config.number("MAX_TOTAL_EXPOSURE").pipe(Config.withDefault(100));
    const maxDailyLoss = yield* Config.number("MAX_DAILY_LOSS").pipe(Config.withDefault(50));
    const maxConcurrentPositions = yield* Config.integer("MAX_CONCURRENT_POSITIONS").pipe(Config.withDefault(5));
    const maxHourlyLoss = yield* Config.number("MAX_HOURLY_LOSS").pipe(Config.withDefault(25));
    const maxLossPerWindow = yield* Config.integer("MAX_LOSS_PER_WINDOW").pipe(Config.withDefault(2));
    const maxConsecutiveLosses = yield* Config.integer("MAX_CONSECUTIVE_LOSSES").pipe(Config.withDefault(5));
    const staleDataMs = yield* Config.integer("STALE_DATA_MS").pipe(Config.withDefault(5000));
    const maxSpreadCents = yield* Config.integer("MAX_SPREAD_CENTS").pipe(Config.withDefault(15));
    const maxSignalAgeMs = yield* Config.integer("MAX_SIGNAL_AGE_MS").pipe(Config.withDefault(2000));
    const maxWindowSpend = yield* Config.number("MAX_WINDOW_SPEND").pipe(Config.withDefault(15));
    const maxWindowTrades = yield* Config.integer("MAX_WINDOW_TRADES").pipe(Config.withDefault(6));
    const maxLegImbalanceMs = yield* Config.integer("MAX_LEG_IMBALANCE_MS").pipe(Config.withDefault(5000));
    const maxHedgeRetries = yield* Config.integer("MAX_HEDGE_RETRIES").pipe(Config.withDefault(2));
    const maxResidualExposureUsd = yield* Config.number("MAX_RESIDUAL_EXPOSURE_USD").pipe(Config.withDefault(1.5));
    const maxUnwindSlippageBps = yield* Config.integer("MAX_UNWIND_SLIPPAGE_BPS").pipe(Config.withDefault(35));

    const tradingMode = yield* Config.literal("live", "shadow")("TRADING_MODE").pipe(Config.withDefault("shadow" as const));
    const whaleHuntOrderBookBandPct = yield* Config.number("WHALE_HUNT_ORDERBOOK_BAND_PCT").pipe(
      Config.withDefault(DEFAULT_WHALE_HUNT_CONFIG.orderBookBandPct),
    );
    const whaleHuntMaxAdverseImbalance = yield* Config.number("WHALE_HUNT_MAX_ADVERSE_IMBALANCE").pipe(
      Config.withDefault(DEFAULT_WHALE_HUNT_CONFIG.maxAdverseImbalance),
    );
    const whaleHuntImbalanceWeight = yield* Config.number("WHALE_HUNT_IMBALANCE_WEIGHT").pipe(
      Config.withDefault(DEFAULT_WHALE_HUNT_CONFIG.imbalanceWeight),
    );
    const whaleHuntLatencyMultiplier = yield* Config.number("WHALE_HUNT_LATENCY_MULTIPLIER").pipe(
      Config.withDefault(DEFAULT_WHALE_HUNT_CONFIG.latencyMultiplier),
    );
    const whaleHuntLatencyBufferMs = yield* Config.integer("WHALE_HUNT_LATENCY_BUFFER_MS").pipe(
      Config.withDefault(DEFAULT_WHALE_HUNT_CONFIG.latencyBufferMs),
    );
    const whaleHuntMinRequiredLeadMs = yield* Config.integer("WHALE_HUNT_MIN_REQUIRED_LEAD_MS").pipe(
      Config.withDefault(DEFAULT_WHALE_HUNT_CONFIG.minRequiredLeadMs),
    );
    const whaleHuntMinLiveSubmittedForSizing = yield* Config.integer("WHALE_HUNT_MIN_LIVE_SUBMITTED_FOR_SIZING").pipe(
      Config.withDefault(DEFAULT_WHALE_HUNT_CONFIG.minLiveSubmittedForSizing),
    );

    const redeemEnabled = yield* Config.string("AUTO_REDEEM").pipe(
      Config.withDefault("true"),
      Config.map((v) => v !== "false"),
    );
    const redeemIntervalMs = yield* Config.integer("REDEEM_INTERVAL_MS").pipe(Config.withDefault(45000));
    const polygonRpcUrl = yield* Config.string("POLYGON_RPC_URL").pipe(Config.withDefault("https://polygon-rpc.com"));

    const serverPort = yield* Config.integer("SERVER_PORT").pipe(Config.withDefault(3001));
    const operatorToken = yield* Config.string("OPERATOR_TOKEN").pipe(Config.withDefault(""));
    const storageBackend = yield* Config.literal("file", "dual", "postgres")("STORAGE_BACKEND").pipe(
      Config.withDefault("file" as const),
    );
    const databaseUrl = yield* Config.string("DATABASE_URL").pipe(Config.withDefault(""));
    const ciLiveIntegration = yield* Config.string("CI_LIVE_INTEGRATION").pipe(
      Config.withDefault("false"),
      Config.map((v) => v === "true"),
    );
    const liveTestTimeoutMs = yield* Config.integer("LIVE_TEST_TIMEOUT_MS").pipe(
      Config.withDefault(15_000),
    );
    const playwrightBaseUrl = yield* Config.string("PLAYWRIGHT_BASE_URL").pipe(
      Config.withDefault("http://127.0.0.1:5173"),
    );
    const testOperatorToken = yield* Config.string("TEST_OPERATOR_TOKEN").pipe(
      Config.withDefault("test-operator-token"),
    );
    const enabledMarkets = yield* Config.string("ENABLED_MARKETS").pipe(
      Config.withDefault("btc"),
      Config.map((v) => v.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0)),
    );

    const cfg: AppConfigShape = {
      poly: {
        privateKey,
        signatureType,
        proxyAddress,
        apiKey,
        apiSecret,
        apiPassphrase,
        builderApiKey,
        builderSecret,
        builderPassphrase,
        clobUrl: "https://clob.polymarket.com",
        chainId: 137,
      },
      risk: {
        maxTradeSize,
        maxTotalExposure,
        maxDailyLoss,
        maxConcurrentPositions,
        maxHourlyLoss,
        maxLossPerWindow,
        maxConsecutiveLosses,
        staleDataMs,
        maxSpreadCents,
        maxSignalAgeMs,
        maxWindowSpend,
        maxWindowTrades,
        maxLegImbalanceMs,
        maxHedgeRetries,
        maxResidualExposureUsd,
        maxUnwindSlippageBps,
      },
      trading: {
        mode: tradingMode,
        whaleHunt: normalizeWhaleHuntConfig({
          orderBookBandPct: whaleHuntOrderBookBandPct,
          maxAdverseImbalance: whaleHuntMaxAdverseImbalance,
          imbalanceWeight: whaleHuntImbalanceWeight,
          latencyMultiplier: whaleHuntLatencyMultiplier,
          latencyBufferMs: whaleHuntLatencyBufferMs,
          minRequiredLeadMs: whaleHuntMinRequiredLeadMs,
          minLiveSubmittedForSizing: whaleHuntMinLiveSubmittedForSizing,
        }),
      },
      redemption: {
        enabled: redeemEnabled,
        intervalMs: redeemIntervalMs,
        polygonRpcUrl,
      },
      server: { port: serverPort, operatorToken },
      storage: { backend: storageBackend, databaseUrl },
      markets: { enabledIds: enabledMarkets },
      test: {
        ciLiveIntegration,
        liveTestTimeoutMs,
        playwrightBaseUrl,
        testOperatorToken,
      },
    };
    return cfg;
  }),
}) {}

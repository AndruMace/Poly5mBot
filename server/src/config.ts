import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(import.meta.dirname, "../../.env") });

export const config = {
  poly: {
    privateKey: process.env.POLY_PRIVATE_KEY ?? "",
    signatureType: parseInt(process.env.POLY_SIGNATURE_TYPE ?? "2", 10),
    proxyAddress: process.env.POLY_PROXY_ADDRESS ?? "",
    apiKey: process.env.POLY_API_KEY ?? "",
    apiSecret: process.env.POLY_API_SECRET ?? "",
    apiPassphrase: process.env.POLY_API_PASSPHRASE ?? "",
    builderApiKey: process.env.POLY_BUILDER_API_KEY ?? "",
    builderSecret: process.env.POLY_BUILDER_SECRET ?? "",
    builderPassphrase: process.env.POLY_BUILDER_PASSPHRASE ?? "",
    clobUrl: "https://clob.polymarket.com",
    chainId: 137,
  },
  risk: {
    maxTradeSize: parseFloat(process.env.MAX_TRADE_SIZE ?? "10"),
    maxTotalExposure: parseFloat(process.env.MAX_TOTAL_EXPOSURE ?? "100"),
    maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS ?? "50"),
    maxConcurrentPositions: parseInt(
      process.env.MAX_CONCURRENT_POSITIONS ?? "5",
      10,
    ),
    maxHourlyLoss: parseFloat(process.env.MAX_HOURLY_LOSS ?? "25"),
    maxLossPerWindow: parseInt(process.env.MAX_LOSS_PER_WINDOW ?? "2", 10),
    maxConsecutiveLosses: parseInt(process.env.MAX_CONSECUTIVE_LOSSES ?? "5", 10),
    staleDataMs: parseInt(process.env.STALE_DATA_MS ?? "5000", 10),
    maxSpreadCents: parseInt(process.env.MAX_SPREAD_CENTS ?? "15", 10),
    maxSignalAgeMs: parseInt(process.env.MAX_SIGNAL_AGE_MS ?? "2000", 10),
  },
  trading: {
    mode: (process.env.TRADING_MODE ?? "shadow") as "live" | "shadow",
  },
  redemption: {
    enabled: (process.env.AUTO_REDEEM ?? "true") !== "false",
    intervalMs: parseInt(process.env.REDEEM_INTERVAL_MS ?? "45000", 10),
    polygonRpcUrl:
      process.env.POLYGON_RPC_URL ?? "https://polygon-rpc.com",
  },
  server: {
    port: parseInt(process.env.SERVER_PORT ?? "3001", 10),
    operatorToken: process.env.OPERATOR_TOKEN ?? "",
  },
} as const;

import type { WhaleHuntConfigOverrides } from "../strategies/whale-hunt-config.js";

// ── Market asset configuration ──
// Each market (BTC, XRP, …) is described by one of these configs.
// Adding a new market is a matter of creating a MarketAssetConfig and
// adding it to ALL_MARKETS in definitions.ts.

export interface ExchangeSymbolConfig {
  // Binance
  readonly tradeStream?: string;
  readonly bookStream?: string;
  // Bybit
  readonly bybitTicker?: string;
  // Coinbase
  readonly productId?: string;
  // Kraken
  readonly krakenPair?: string;
  // Bitstamp
  readonly bitstampTradeChannel?: string;
  readonly bitstampBookChannel?: string;
  // OKX
  readonly okxInstId?: string;
}

export interface FeedAssetConfig {
  readonly exchange: string;
  readonly symbol: ExchangeSymbolConfig;
}

export interface MarketAssetConfig {
  /** Unique lowercase identifier, e.g. "btc", "xrp" */
  readonly id: string;
  /** Display name shown in UI, e.g. "BTC", "XRP" */
  readonly displayName: string;
  /** Polymarket slug prefix, e.g. "btc-updown-5m" */
  readonly slugPrefix: string;
  /** Market window duration in seconds (300 = 5m, 900 = 15m). */
  readonly windowDurationSec: number;
  /** Window title prefix, e.g. "BTC Up or Down" */
  readonly windowTitlePrefix: string;
  /** Exchange feed configurations for this asset */
  readonly feeds: ReadonlyArray<FeedAssetConfig>;
  /** Which strategy names to run for this market */
  readonly strategies: ReadonlyArray<string>;
  /** Optional per-market strategy config overrides applied before persisted state. */
  readonly strategyConfigOverrides?: Partial<Record<string, Record<string, number>>>;
  /** Optional per-market risk overrides (merged on top of global config) */
  readonly riskOverrides?: Partial<{
    maxTradeSize: number;
    maxTotalExposure: number;
    maxDailyLoss: number;
    maxConcurrentPositions: number;
    maxHourlyLoss: number;
    maxWindowSpend: number;
    maxWindowTrades: number;
    maxLegImbalanceMs: number;
    maxHedgeRetries: number;
    maxResidualExposureUsd: number;
    maxUnwindSlippageBps: number;
  }>;
  /** Optional per-market whale-hunt runtime overrides (merged over global defaults). */
  readonly whaleHuntOverrides?: WhaleHuntConfigOverrides;
}

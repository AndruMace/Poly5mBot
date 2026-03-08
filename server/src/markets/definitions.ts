import type { MarketAssetConfig } from "./registry.js";

export const BTC_MARKET: MarketAssetConfig = {
  id: "btc",
  displayName: "BTC",
  slugPrefix: "btc-updown-5m",
  windowTitlePrefix: "BTC Up or Down",
  feeds: [
    {
      exchange: "binance",
      symbol: {
        tradeStream: "btcusdt@trade",
        bookStream: "btcusdt@bookTicker",
      },
    },
    {
      exchange: "bybit",
      symbol: { bybitTicker: "tickers.BTCUSDT" },
    },
    {
      exchange: "coinbase",
      symbol: { productId: "BTC-USD" },
    },
    {
      exchange: "kraken",
      symbol: { krakenPair: "BTC/USD" },
    },
    {
      exchange: "bitstamp",
      symbol: {
        bitstampTradeChannel: "live_trades_btcusd",
        bitstampBookChannel: "order_book_btcusd",
      },
    },
    {
      exchange: "okx",
      symbol: { okxInstId: "BTC-USDT" },
    },
  ],
  strategies: ["arb", "efficiency", "whale-hunt", "momentum", "orderflow-imbalance"],
  strategyConfigOverrides: {
    arb: {
      // BTC arb was too permissive; require a cleaner dislocation and stronger PTB separation.
      minSpreadPct: 0.08,
      minConfirmingExchanges: 2,
    },
  },
  whaleHuntOverrides: {
    // BTC-specific production defaults: stricter microstructure and timing guards.
    maxAdverseImbalance: 0.1,
    imbalanceWeight: 0.25,
    // Conservative relaxation to reduce latency-guard overblocking.
    latencyMultiplier: 2.35,
    latencyBufferMs: 1100,
    minRequiredLeadMs: 3500,
    minLiveSubmittedForSizing: 50,
  },
};

export const XRP_MARKET: MarketAssetConfig = {
  id: "xrp",
  displayName: "XRP",
  slugPrefix: "xrp-updown-5m",
  windowTitlePrefix: "XRP Up or Down",
  feeds: [
    {
      exchange: "binance",
      symbol: {
        tradeStream: "xrpusdt@trade",
        bookStream: "xrpusdt@bookTicker",
      },
    },
    {
      exchange: "bybit",
      symbol: { bybitTicker: "tickers.XRPUSDT" },
    },
    {
      exchange: "coinbase",
      symbol: { productId: "XRP-USD" },
    },
    {
      exchange: "kraken",
      symbol: { krakenPair: "XRP/USD" },
    },
    {
      exchange: "bitstamp",
      symbol: {
        bitstampTradeChannel: "live_trades_xrpusd",
        bitstampBookChannel: "order_book_xrpusd",
      },
    },
    {
      exchange: "okx",
      symbol: { okxInstId: "XRP-USDT" },
    },
  ],
  strategies: ["arb", "momentum"],
  strategyConfigOverrides: {
    arb: {
      // XRP needs much stricter thresholds because small absolute price moves can look large in pct terms.
      minSpreadPct: 0.18,
      minConfirmingExchanges: 2,
    },
  },
  whaleHuntOverrides: {
    // Not currently enabled on XRP, but set for future activation.
    maxAdverseImbalance: 0.08,
    latencyMultiplier: 3.0,
    latencyBufferMs: 1800,
    minRequiredLeadMs: 5500,
    minLiveSubmittedForSizing: 80,
  },
};

export const ETH_MARKET: MarketAssetConfig = {
  id: "eth",
  displayName: "ETH",
  slugPrefix: "eth-updown-5m",
  windowTitlePrefix: "ETH Up or Down",
  feeds: [
    {
      exchange: "binance",
      symbol: {
        tradeStream: "ethusdt@trade",
        bookStream: "ethusdt@bookTicker",
      },
    },
    {
      exchange: "bybit",
      symbol: { bybitTicker: "tickers.ETHUSDT" },
    },
    {
      exchange: "coinbase",
      symbol: { productId: "ETH-USD" },
    },
    {
      exchange: "kraken",
      symbol: { krakenPair: "ETH/USD" },
    },
    {
      exchange: "bitstamp",
      symbol: {
        bitstampTradeChannel: "live_trades_ethusd",
        bitstampBookChannel: "order_book_ethusd",
      },
    },
    {
      exchange: "okx",
      symbol: { okxInstId: "ETH-USDT" },
    },
  ],
  strategies: ["arb", "momentum"],
  strategyConfigOverrides: {
    arb: {
      minSpreadPct: 0.12,
      minConfirmingExchanges: 2,
      minReferenceSources: 2,
      minPtbDistancePct: 0.05,
      persistenceMs: 3500,
      persistenceCount: 4,
      maxSharePrice: 0.54,
      maxExecutionPrice: 0.53,
      tradeSize: 4,
      maxEntriesPerWindow: 2,
    },
    momentum: {
      rsiPeriod: 14,
      rsiOverbought: 71,
      rsiOversold: 29,
      minPriceMovePct: 0.04,
      minPtbDistancePct: 0.05,
      chopConfidenceFloor: 0.62,
      chopSizeMultiplier: 0.65,
      maxSharePrice: 0.53,
      maxExecutionPrice: 0.52,
      tradeSize: 4,
      maxEntriesPerWindow: 2,
    },
  },
};

export const SOL_MARKET: MarketAssetConfig = {
  id: "sol",
  displayName: "SOL",
  slugPrefix: "sol-updown-5m",
  windowTitlePrefix: "SOL Up or Down",
  feeds: [
    {
      exchange: "binance",
      symbol: {
        tradeStream: "solusdt@trade",
        bookStream: "solusdt@bookTicker",
      },
    },
    {
      exchange: "bybit",
      symbol: { bybitTicker: "tickers.SOLUSDT" },
    },
    {
      exchange: "coinbase",
      symbol: { productId: "SOL-USD" },
    },
    {
      exchange: "kraken",
      symbol: { krakenPair: "SOL/USD" },
    },
    {
      exchange: "bitstamp",
      symbol: {
        bitstampTradeChannel: "live_trades_solusd",
        bitstampBookChannel: "order_book_solusd",
      },
    },
    {
      exchange: "okx",
      symbol: { okxInstId: "SOL-USDT" },
    },
  ],
  strategies: ["arb", "momentum"],
  strategyConfigOverrides: {
    arb: {
      minSpreadPct: 0.2,
      minConfirmingExchanges: 2,
      minReferenceSources: 3,
      minPtbDistancePct: 0.08,
      persistenceMs: 4000,
      persistenceCount: 5,
      maxSharePrice: 0.52,
      maxExecutionPrice: 0.51,
      tradeSize: 3,
      maxEntriesPerWindow: 1,
    },
    momentum: {
      rsiPeriod: 16,
      rsiOverbought: 73,
      rsiOversold: 27,
      minPriceMovePct: 0.06,
      minPtbDistancePct: 0.08,
      chopConfidenceFloor: 0.66,
      chopSizeMultiplier: 0.6,
      maxSharePrice: 0.52,
      maxExecutionPrice: 0.51,
      tradeSize: 3,
      maxEntriesPerWindow: 1,
    },
  },
};

export const ALL_MARKETS: ReadonlyArray<MarketAssetConfig> = [
  BTC_MARKET,
  XRP_MARKET,
  ETH_MARKET,
  SOL_MARKET,
];

export function getMarketConfig(marketId: string): MarketAssetConfig | undefined {
  return ALL_MARKETS.find((m) => m.id === marketId);
}

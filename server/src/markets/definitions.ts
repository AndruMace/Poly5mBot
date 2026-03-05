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
  whaleHuntOverrides: {
    // BTC-specific production defaults: stricter microstructure and timing guards.
    maxAdverseImbalance: 0.1,
    imbalanceWeight: 0.25,
    latencyMultiplier: 2.75,
    latencyBufferMs: 1500,
    minRequiredLeadMs: 4500,
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
  whaleHuntOverrides: {
    // Not currently enabled on XRP, but set for future activation.
    maxAdverseImbalance: 0.08,
    latencyMultiplier: 3.0,
    latencyBufferMs: 1800,
    minRequiredLeadMs: 5500,
    minLiveSubmittedForSizing: 80,
  },
};

export const ALL_MARKETS: ReadonlyArray<MarketAssetConfig> = [BTC_MARKET, XRP_MARKET];

export function getMarketConfig(marketId: string): MarketAssetConfig | undefined {
  return ALL_MARKETS.find((m) => m.id === marketId);
}

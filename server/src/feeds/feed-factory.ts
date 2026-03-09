import { Stream } from "effect";
import WebSocket from "ws";
import type { PricePoint } from "../types.js";
import type { ExchangeSymbolConfig, FeedAssetConfig } from "../markets/registry.js";
import { makeFeedStream } from "./common.js";

// ── Binance ──

const BINANCE_ENDPOINTS = [
  { label: "Binance.US", base: "wss://stream.binance.us:9443/stream?streams=" },
  { label: "Binance", base: "wss://stream.binance.com:9443/stream?streams=" },
] as const;

let binanceEndpointIdx = 0;

export function createBinanceFeed(symbol: ExchangeSymbolConfig): Stream.Stream<PricePoint, never, never> {
  const tradeStream = symbol.tradeStream ?? "btcusdt@trade";
  const bookStream = symbol.bookStream ?? "btcusdt@bookTicker";

  let bid = 0;
  let ask = 0;
  let lastBookEmit = 0;
  const BOOK_THROTTLE_MS = 50;

  return makeFeedStream({
    name: "binance",
    url: () => `${BINANCE_ENDPOINTS[binanceEndpointIdx % BINANCE_ENDPOINTS.length]!.base}${tradeStream}/${bookStream}`,
    onOpen: () => { binanceEndpointIdx = 0; },
    parseMessage: (text) => {
      const msg = JSON.parse(text);
      const stream = msg.stream as string;
      const data = msg.data;

      if (stream === bookStream) {
        bid = parseFloat(data.b);
        ask = parseFloat(data.a);
        const now = Date.now();
        if (bid > 0 && ask > 0 && now - lastBookEmit >= BOOK_THROTTLE_MS) {
          lastBookEmit = now;
          return { exchange: "binance", price: (bid + ask) / 2, timestamp: now, bid, ask };
        }
        return null;
      }

      if (stream === tradeStream) {
        return {
          exchange: "binance",
          price: parseFloat(data.p),
          timestamp: data.T,
          bid: bid || undefined,
          ask: ask || undefined,
        };
      }

      return null;
    },
  });
}

// ── Bybit ──

export function createBybitFeed(symbol: ExchangeSymbolConfig): Stream.Stream<PricePoint, never, never> {
  const ticker = symbol.bybitTicker ?? "tickers.BTCUSDT";

  return makeFeedStream({
    name: "bybit",
    url: "wss://stream.bybit.com/v5/public/spot",
    onOpen: (ws) => {
      ws.send(JSON.stringify({ op: "subscribe", args: [ticker] }));
    },
    pingIntervalMs: 20000,
    parseMessage: (text) => {
      const msg = JSON.parse(text);
      if (msg.topic !== ticker) return null;
      const d = msg.data;
      return {
        exchange: "bybit",
        price: parseFloat(d.lastPrice),
        timestamp: msg.ts,
        bid: d.bid1Price ? parseFloat(d.bid1Price) : undefined,
        ask: d.ask1Price ? parseFloat(d.ask1Price) : undefined,
      };
    },
  });
}

// ── Coinbase ──

export function createCoinbaseFeed(symbol: ExchangeSymbolConfig): Stream.Stream<PricePoint, never, never> {
  const productId = symbol.productId ?? "BTC-USD";

  return makeFeedStream({
    name: "coinbase",
    url: "wss://ws-feed.exchange.coinbase.com",
    onOpen: (ws) => {
      ws.send(JSON.stringify({ type: "subscribe", product_ids: [productId], channels: ["ticker"] }));
    },
    parseMessage: (text) => {
      const msg = JSON.parse(text);
      if (msg.type !== "ticker" || msg.product_id !== productId) return null;
      return {
        exchange: "coinbase",
        price: parseFloat(msg.price),
        timestamp: new Date(msg.time).getTime(),
        bid: msg.best_bid ? parseFloat(msg.best_bid) : undefined,
        ask: msg.best_ask ? parseFloat(msg.best_ask) : undefined,
      };
    },
  });
}

// ── Kraken ──

export function createKrakenFeed(symbol: ExchangeSymbolConfig): Stream.Stream<PricePoint, never, never> {
  const pair = symbol.krakenPair ?? "BTC/USD";

  return makeFeedStream({
    name: "kraken",
    url: "wss://ws.kraken.com/v2",
    onOpen: (ws) => {
      ws.send(JSON.stringify({ method: "subscribe", params: { channel: "ticker", symbol: [pair] } }));
    },
    parseMessage: (text) => {
      const msg = JSON.parse(text);
      if (msg.channel !== "ticker" || !msg.data) return null;
      const results: PricePoint[] = [];
      for (const d of msg.data) {
        if (d.symbol !== pair) continue;
        results.push({
          exchange: "kraken",
          price: Number(d.last),
          timestamp: Date.now(),
          bid: d.bid != null ? Number(d.bid) : undefined,
          ask: d.ask != null ? Number(d.ask) : undefined,
        });
      }
      return results.length > 0 ? results : null;
    },
  });
}

// ── Bitstamp ──

export function createBitstampFeed(symbol: ExchangeSymbolConfig): Stream.Stream<PricePoint, never, never> {
  const tradeChannel = symbol.bitstampTradeChannel ?? "live_trades_btcusd";
  const bookChannel = symbol.bitstampBookChannel ?? "order_book_btcusd";

  return makeFeedStream({
    name: "bitstamp",
    url: "wss://ws.bitstamp.net",
    onOpen: (ws) => {
      ws.send(JSON.stringify({ event: "bts:subscribe", data: { channel: tradeChannel } }));
      ws.send(JSON.stringify({ event: "bts:subscribe", data: { channel: bookChannel } }));
    },
    parseMessage: (text, latest) => {
      const msg = JSON.parse(text);

      if (msg.event === "data" && msg.channel === bookChannel) {
        const d = msg.data;
        if (d.bids?.length > 0 && d.asks?.length > 0) {
          const bid = parseFloat(d.bids[0][0]);
          const ask = parseFloat(d.asks[0][0]);
          if (bid > 0 && ask > 0) {
            return { exchange: "bitstamp", price: (bid + ask) / 2, timestamp: Date.now(), bid, ask };
          }
        }
        return null;
      }

      if (msg.event === "trade" && msg.channel === tradeChannel) {
        const d = msg.data;
        return {
          exchange: "bitstamp",
          price: d.price,
          timestamp: d.timestamp ? d.timestamp * 1000 : Date.now(),
          bid: latest?.bid,
          ask: latest?.ask,
        };
      }

      return null;
    },
  });
}

// ── OKX ──

export function createOkxFeed(symbol: ExchangeSymbolConfig): Stream.Stream<PricePoint, never, never> {
  const instId = symbol.okxInstId ?? "BTC-USDT";

  return makeFeedStream({
    name: "okx",
    url: "wss://ws.okx.com:8443/ws/v5/public",
    onOpen: (ws) => {
      ws.send(JSON.stringify({ op: "subscribe", args: [{ channel: "tickers", instId }] }));
    },
    pingIntervalMs: 25000,
    pingPayload: "ping",
    parseMessage: (text) => {
      if (text === "pong") return null;
      const msg = JSON.parse(text);
      if (!msg.data || msg.arg?.channel !== "tickers") return null;
      const results: PricePoint[] = [];
      for (const d of msg.data) {
        results.push({
          exchange: "okx",
          price: parseFloat(d.last),
          timestamp: parseInt(d.ts, 10),
          bid: d.bidPx ? parseFloat(d.bidPx) : undefined,
          ask: d.askPx ? parseFloat(d.askPx) : undefined,
        });
      }
      return results.length > 0 ? results : null;
    },
  });
}

// ── Factory dispatcher ──

const FEED_CREATORS: Record<string, (symbol: ExchangeSymbolConfig) => Stream.Stream<PricePoint, never, never>> = {
  binance: createBinanceFeed,
  bybit: createBybitFeed,
  coinbase: createCoinbaseFeed,
  kraken: createKrakenFeed,
  bitstamp: createBitstampFeed,
  okx: createOkxFeed,
};

export function createFeedForExchange(
  exchange: string,
  symbol: ExchangeSymbolConfig,
): Stream.Stream<PricePoint, never, never> | null {
  const creator = FEED_CREATORS[exchange];
  return creator ? creator(symbol) : null;
}

export function createFeedsForMarket(
  feedConfigs: ReadonlyArray<FeedAssetConfig>,
): { streams: Stream.Stream<PricePoint, never, never>[]; names: string[] } {
  const streams: Stream.Stream<PricePoint, never, never>[] = [];
  const names: string[] = [];
  for (const fc of feedConfigs) {
    const stream = createFeedForExchange(fc.exchange, fc.symbol);
    if (stream) {
      streams.push(stream);
      names.push(fc.exchange);
    }
  }
  return { streams, names };
}

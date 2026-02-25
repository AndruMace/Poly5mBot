import { Stream } from "effect";
import type { PricePoint } from "../types.js";
import { makeFeedStream, type FeedConfig } from "./common.js";

const ENDPOINTS = [
  {
    label: "Binance.US",
    url: "wss://stream.binance.us:9443/stream?streams=btcusd@trade/btcusd@bookTicker",
    tradeStream: "btcusd@trade",
    bookStream: "btcusd@bookTicker",
  },
  {
    label: "Binance",
    url: "wss://stream.binance.com:9443/stream?streams=btcusdt@trade/btcusdt@bookTicker",
    tradeStream: "btcusdt@trade",
    bookStream: "btcusdt@bookTicker",
  },
] as const;

let endpointIdx = 0;
let consecutiveFails = 0;
let lastBookEmit = 0;
const BOOK_THROTTLE_MS = 50;
let bid = 0;
let ask = 0;

function getEndpointUrl(): string {
  return ENDPOINTS[endpointIdx]!.url;
}

const config: FeedConfig = {
  name: "binance",
  url: getEndpointUrl,
  onOpen: () => {
    consecutiveFails = 0;
  },
  parseMessage: (text) => {
    const msg = JSON.parse(text);
    const ep = ENDPOINTS[endpointIdx]!;
    const stream = msg.stream as string;
    const data = msg.data;

    if (stream === ep.bookStream) {
      bid = parseFloat(data.b);
      ask = parseFloat(data.a);
      const now = Date.now();
      if (bid > 0 && ask > 0 && now - lastBookEmit >= BOOK_THROTTLE_MS) {
        lastBookEmit = now;
        return { exchange: "binance", price: (bid + ask) / 2, timestamp: now, bid, ask };
      }
      return null;
    }

    if (stream === ep.tradeStream) {
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
};

export const binanceFeed: Stream.Stream<PricePoint, never, never> = makeFeedStream(config);

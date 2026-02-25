import { Stream } from "effect";
import WebSocket from "ws";
import type { PricePoint } from "../types.js";
import { makeFeedStream } from "./common.js";

export const bybitFeed: Stream.Stream<PricePoint, never, never> = makeFeedStream({
  name: "bybit",
  url: "wss://stream.bybit.com/v5/public/linear",
  onOpen: (ws) => {
    ws.send(JSON.stringify({ op: "subscribe", args: ["tickers.BTCUSDT"] }));
  },
  pingIntervalMs: 20000,
  parseMessage: (text) => {
    const msg = JSON.parse(text);
    if (msg.topic !== "tickers.BTCUSDT") return null;
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

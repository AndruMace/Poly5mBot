import { Stream } from "effect";
import type { PricePoint } from "../types.js";
import { makeFeedStream } from "./common.js";

export const okxFeed: Stream.Stream<PricePoint, never, never> = makeFeedStream({
  name: "okx",
  url: "wss://ws.okx.com:8443/ws/v5/public",
  onOpen: (ws) => {
    ws.send(JSON.stringify({ op: "subscribe", args: [{ channel: "tickers", instId: "BTC-USDT" }] }));
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

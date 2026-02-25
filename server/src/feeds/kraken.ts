import { Stream } from "effect";
import type { PricePoint } from "../types.js";
import { makeFeedStream } from "./common.js";

export const krakenFeed: Stream.Stream<PricePoint, never, never> = makeFeedStream({
  name: "kraken",
  url: "wss://ws.kraken.com/v2",
  onOpen: (ws) => {
    ws.send(JSON.stringify({ method: "subscribe", params: { channel: "ticker", symbol: ["BTC/USD"] } }));
  },
  parseMessage: (text) => {
    const msg = JSON.parse(text);
    if (msg.channel !== "ticker" || !msg.data) return null;
    const results: PricePoint[] = [];
    for (const d of msg.data) {
      if (d.symbol !== "BTC/USD") continue;
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

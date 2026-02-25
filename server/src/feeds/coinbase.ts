import { Stream } from "effect";
import type { PricePoint } from "../types.js";
import { makeFeedStream } from "./common.js";

export const coinbaseFeed: Stream.Stream<PricePoint, never, never> = makeFeedStream({
  name: "coinbase",
  url: "wss://ws-feed.exchange.coinbase.com",
  onOpen: (ws) => {
    ws.send(JSON.stringify({ type: "subscribe", product_ids: ["BTC-USD"], channels: ["ticker"] }));
  },
  parseMessage: (text) => {
    const msg = JSON.parse(text);
    if (msg.type !== "ticker" || msg.product_id !== "BTC-USD") return null;
    return {
      exchange: "coinbase",
      price: parseFloat(msg.price),
      timestamp: new Date(msg.time).getTime(),
      bid: msg.best_bid ? parseFloat(msg.best_bid) : undefined,
      ask: msg.best_ask ? parseFloat(msg.best_ask) : undefined,
    };
  },
});

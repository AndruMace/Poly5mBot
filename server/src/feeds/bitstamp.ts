import { Stream } from "effect";
import type { PricePoint } from "../types.js";
import { makeFeedStream } from "./common.js";

export const bitstampFeed: Stream.Stream<PricePoint, never, never> = makeFeedStream({
  name: "bitstamp",
  url: "wss://ws.bitstamp.net",
  onOpen: (ws) => {
    ws.send(JSON.stringify({ event: "bts:subscribe", data: { channel: "live_trades_btcusd" } }));
    ws.send(JSON.stringify({ event: "bts:subscribe", data: { channel: "order_book_btcusd" } }));
  },
  parseMessage: (text, latest) => {
    const msg = JSON.parse(text);

    if (msg.event === "data" && msg.channel === "order_book_btcusd") {
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

    if (msg.event === "trade" && msg.channel === "live_trades_btcusd") {
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

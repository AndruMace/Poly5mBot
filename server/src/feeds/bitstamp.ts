import { EventEmitter } from "events";
import WebSocket from "ws";
import type { PricePoint } from "../types.js";

export class BitstampFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private latest: PricePoint | null = null;

  start(): void {
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  getLatest(): PricePoint | null {
    return this.latest;
  }

  private connect(): void {
    if (!this.running) return;

    this.ws = new WebSocket("wss://ws.bitstamp.net");

    this.ws.on("open", () => {
      console.log("[Bitstamp] Connected");
      this.ws!.send(
        JSON.stringify({
          event: "bts:subscribe",
          data: { channel: "live_trades_btcusd" },
        }),
      );
      this.ws!.send(
        JSON.stringify({
          event: "bts:subscribe",
          data: { channel: "order_book_btcusd" },
        }),
      );
      this.emit("connected");
    });

    this.ws.on("message", (raw: WebSocket.Data) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.event === "data" && msg.channel === "order_book_btcusd") {
          const d = msg.data;
          if (d.bids?.length > 0 && d.asks?.length > 0) {
            const bid = parseFloat(d.bids[0][0]);
            const ask = parseFloat(d.asks[0][0]);
            if (bid > 0 && ask > 0) {
              const point: PricePoint = {
                exchange: "bitstamp",
                price: (bid + ask) / 2,
                timestamp: Date.now(),
                bid,
                ask,
              };
              this.latest = point;
              this.emit("price", point);
            }
          }
          return;
        }

        if (
          msg.event === "trade" &&
          msg.channel === "live_trades_btcusd"
        ) {
          const d = msg.data;
          const point: PricePoint = {
            exchange: "bitstamp",
            price: d.price,
            timestamp: d.timestamp ? d.timestamp * 1000 : Date.now(),
            bid: this.latest?.bid,
            ask: this.latest?.ask,
          };
          this.latest = point;
          this.emit("price", point);
        }
      } catch {
        /* ignore */
      }
    });

    this.ws.on("close", () => {
      console.log("[Bitstamp] Disconnected");
      this.emit("disconnected");
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      console.error("[Bitstamp] Error:", err.message);
      this.ws?.close();
    });
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    this.reconnectTimer = setTimeout(() => this.connect(), 3000);
  }
}

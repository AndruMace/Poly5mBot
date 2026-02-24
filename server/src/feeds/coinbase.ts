import { EventEmitter } from "events";
import WebSocket from "ws";
import type { PricePoint } from "../types.js";

export class CoinbaseFeed extends EventEmitter {
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

    this.ws = new WebSocket("wss://ws-feed.exchange.coinbase.com");

    this.ws.on("open", () => {
      console.log("[Coinbase] Connected");
      this.ws!.send(
        JSON.stringify({
          type: "subscribe",
          product_ids: ["BTC-USD"],
          channels: ["ticker"],
        }),
      );
      this.emit("connected");
    });

    this.ws.on("message", (raw: WebSocket.Data) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== "ticker" || msg.product_id !== "BTC-USD") return;

        const point: PricePoint = {
          exchange: "coinbase",
          price: parseFloat(msg.price),
          timestamp: new Date(msg.time).getTime(),
          bid: msg.best_bid ? parseFloat(msg.best_bid) : undefined,
          ask: msg.best_ask ? parseFloat(msg.best_ask) : undefined,
        };
        this.latest = point;
        this.emit("price", point);
      } catch {
        /* ignore */
      }
    });

    this.ws.on("close", () => {
      console.log("[Coinbase] Disconnected");
      this.emit("disconnected");
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      console.error("[Coinbase] Error:", err.message);
      this.ws?.close();
    });
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    this.reconnectTimer = setTimeout(() => this.connect(), 3000);
  }
}

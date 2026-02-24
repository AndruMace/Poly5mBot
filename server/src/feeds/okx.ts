import { EventEmitter } from "events";
import WebSocket from "ws";
import type { PricePoint } from "../types.js";

export class OkxFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private latest: PricePoint | null = null;

  start(): void {
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }

  getLatest(): PricePoint | null {
    return this.latest;
  }

  private connect(): void {
    if (!this.running) return;

    this.ws = new WebSocket("wss://ws.okx.com:8443/ws/v5/public");

    this.ws.on("open", () => {
      console.log("[OKX] Connected");
      this.ws!.send(
        JSON.stringify({
          op: "subscribe",
          args: [{ channel: "tickers", instId: "BTC-USDT" }],
        }),
      );
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send("ping");
        }
      }, 25000);
      this.emit("connected");
    });

    this.ws.on("message", (raw: WebSocket.Data) => {
      try {
        const text = raw.toString();
        if (text === "pong") return;

        const msg = JSON.parse(text);
        if (!msg.data || msg.arg?.channel !== "tickers") return;

        for (const d of msg.data) {
          const point: PricePoint = {
            exchange: "okx",
            price: parseFloat(d.last),
            timestamp: parseInt(d.ts, 10),
            bid: d.bidPx ? parseFloat(d.bidPx) : undefined,
            ask: d.askPx ? parseFloat(d.askPx) : undefined,
          };
          this.latest = point;
          this.emit("price", point);
        }
      } catch {
        /* ignore */
      }
    });

    this.ws.on("close", () => {
      console.log("[OKX] Disconnected");
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.emit("disconnected");
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      console.error("[OKX] Error:", err.message);
      this.ws?.close();
    });
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    this.reconnectTimer = setTimeout(() => this.connect(), 3000);
  }
}

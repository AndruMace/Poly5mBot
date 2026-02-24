import { EventEmitter } from "events";
import WebSocket from "ws";
import type { PricePoint } from "../types.js";

export class KrakenFeed extends EventEmitter {
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

    this.ws = new WebSocket("wss://ws.kraken.com/v2");

    this.ws.on("open", () => {
      console.log("[Kraken] Connected");
      this.ws!.send(
        JSON.stringify({
          method: "subscribe",
          params: {
            channel: "ticker",
            symbol: ["BTC/USD"],
          },
        }),
      );
      this.emit("connected");
    });

    this.ws.on("message", (raw: WebSocket.Data) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.channel !== "ticker" || !msg.data) return;

        for (const d of msg.data) {
          if (d.symbol !== "BTC/USD") continue;
          const point: PricePoint = {
            exchange: "kraken",
            price: Number(d.last),
            timestamp: Date.now(),
            bid: d.bid != null ? Number(d.bid) : undefined,
            ask: d.ask != null ? Number(d.ask) : undefined,
          };
          this.latest = point;
          this.emit("price", point);
        }
      } catch {
        /* ignore */
      }
    });

    this.ws.on("close", () => {
      console.log("[Kraken] Disconnected");
      this.emit("disconnected");
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      console.error("[Kraken] Error:", err.message);
      this.ws?.close();
    });
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    this.reconnectTimer = setTimeout(() => this.connect(), 3000);
  }
}

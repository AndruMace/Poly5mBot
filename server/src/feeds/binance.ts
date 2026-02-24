import { EventEmitter } from "events";
import WebSocket from "ws";
import type { PricePoint } from "../types.js";

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

export class BinanceFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private latest: PricePoint | null = null;
  private lastBookEmit = 0;
  private endpointIdx = 0;
  private consecutiveFails = 0;
  private static readonly BOOK_THROTTLE_MS = 50;

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

    const ep = ENDPOINTS[this.endpointIdx]!;
    this.ws = new WebSocket(ep.url);

    let bid = 0;
    let ask = 0;

    this.ws.on("open", () => {
      console.log(`[Binance] Connected via ${ep.label}`);
      this.consecutiveFails = 0;
      this.emit("connected");
    });

    this.ws.on("message", (raw: WebSocket.Data) => {
      try {
        const msg = JSON.parse(raw.toString());
        const stream = msg.stream as string;
        const data = msg.data;

        if (stream === ep.bookStream) {
          bid = parseFloat(data.b);
          ask = parseFloat(data.a);

          const now = Date.now();
          if (
            bid > 0 &&
            ask > 0 &&
            now - this.lastBookEmit >= BinanceFeed.BOOK_THROTTLE_MS
          ) {
            this.lastBookEmit = now;
            const point: PricePoint = {
              exchange: "binance",
              price: (bid + ask) / 2,
              timestamp: now,
              bid,
              ask,
            };
            this.latest = point;
            this.emit("price", point);
          }
        } else if (stream === ep.tradeStream) {
          const point: PricePoint = {
            exchange: "binance",
            price: parseFloat(data.p),
            timestamp: data.T,
            bid: bid || undefined,
            ask: ask || undefined,
          };
          this.latest = point;
          this.emit("price", point);
        }
      } catch {
        /* ignore parse errors */
      }
    });

    this.ws.on("close", () => {
      console.log(`[Binance] Disconnected (${ep.label})`);
      this.emit("disconnected");
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      console.error(`[Binance] Error (${ep.label}):`, err.message);
      this.consecutiveFails++;
      if (this.consecutiveFails >= 2) {
        this.endpointIdx = (this.endpointIdx + 1) % ENDPOINTS.length;
        this.consecutiveFails = 0;
        console.log(
          `[Binance] Switching to ${ENDPOINTS[this.endpointIdx]!.label}`,
        );
      }
      this.ws?.close();
    });
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    this.reconnectTimer = setTimeout(() => this.connect(), 3000);
  }
}

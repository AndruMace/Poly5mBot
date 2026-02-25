import { EventEmitter } from "events";
import { BinanceFeed } from "./binance.js";
import { BybitFeed } from "./bybit.js";
import { CoinbaseFeed } from "./coinbase.js";
import { KrakenFeed } from "./kraken.js";
import { BitstampFeed } from "./bitstamp.js";
import { OkxFeed } from "./okx.js";
import { OracleApproximator } from "./oracle.js";
import type { FeedHealthSnapshot, PricePoint } from "../types.js";

interface FeedAdapter extends EventEmitter {
  start(): void;
  stop(): void;
  getLatest(): PricePoint | null;
}

interface FeedSource {
  name: string;
  feed: FeedAdapter;
}

export class FeedManager extends EventEmitter {
  readonly binance = new BinanceFeed();
  readonly bybit = new BybitFeed();
  readonly coinbase = new CoinbaseFeed();
  readonly kraken = new KrakenFeed();
  readonly bitstamp = new BitstampFeed();
  readonly okx = new OkxFeed();
  readonly oracle = new OracleApproximator();

  private allFeeds: FeedSource[] = [
    { name: "binance", feed: this.binance },
    { name: "bybit", feed: this.bybit },
    { name: "coinbase", feed: this.coinbase },
    { name: "kraken", feed: this.kraken },
    { name: "bitstamp", feed: this.bitstamp },
    { name: "okx", feed: this.okx },
  ];
  private connectionBySource: Record<string, boolean> = {
    binance: false,
    bybit: false,
    coinbase: false,
    kraken: false,
    bitstamp: false,
    okx: false,
  };

  private priceHistory: PricePoint[] = [];
  private readonly maxHistory = 3000;
  private static readonly STALE_MS = 5000;
  private static readonly DOWN_MS = 15000;

  start(): void {
    for (const { name, feed } of this.allFeeds) {
      feed.on("price", (p: PricePoint) => {
        this.oracle.update(p);
        this.priceHistory.push(p);
        if (this.priceHistory.length > this.maxHistory) {
          this.priceHistory = this.priceHistory.slice(-this.maxHistory);
        }
        this.emit("price", p);
      });
      feed.on("connected", () => {
        this.connectionBySource[name] = true;
      });
      feed.on("disconnected", () => {
        this.connectionBySource[name] = false;
      });
      feed.start();
    }

    this.oracle.on("estimate", (est: { price: number; timestamp: number }) => {
      this.emit("oracleEstimate", est);
    });
    this.oracle.start();

    console.log(`[FeedManager] ${this.allFeeds.length} feeds started`);
  }

  stop(): void {
    for (const { name, feed } of this.allFeeds) {
      this.connectionBySource[name] = false;
      feed.stop();
    }
    this.oracle.stop();
    console.log("[FeedManager] All feeds stopped");
  }

  getLatestPrices(): Record<string, PricePoint> {
    const result: Record<string, PricePoint> = {};
    const sources: Array<[string, { getLatest(): PricePoint | null }]> = [
      ["binance", this.binance],
      ["bybit", this.bybit],
      ["coinbase", this.coinbase],
      ["kraken", this.kraken],
      ["bitstamp", this.bitstamp],
      ["okx", this.okx],
    ];
    for (const [name, feed] of sources) {
      const p = feed.getLatest();
      if (p) result[name] = p;
    }
    return result;
  }

  getOracleEstimate(): number {
    return this.oracle.getEstimate();
  }

  getOracleTimestamp(): number {
    return this.oracle.getLastEstimateTs();
  }

  getCurrentBtcPrice(): number {
    const est = this.oracle.getEstimate();
    if (est > 0) return est;
    for (const { feed } of this.allFeeds) {
      const p = feed.getLatest();
      if (p) return p.price;
    }
    return 0;
  }

  getFeedHealth(): FeedHealthSnapshot {
    const now = Date.now();
    const sources = this.allFeeds.map(({ name, feed }) => {
      const latest = feed.getLatest();
      const lastUpdateTs = latest?.timestamp ?? null;
      const ageMs =
        typeof lastUpdateTs === "number" && lastUpdateTs > 0
          ? Math.max(0, now - lastUpdateTs)
          : null;

      let status: "healthy" | "stale" | "down" = "down";
      if (this.connectionBySource[name] && ageMs !== null) {
        if (ageMs <= FeedManager.STALE_MS) status = "healthy";
        else if (ageMs <= FeedManager.DOWN_MS) status = "stale";
        else status = "down";
      }

      return {
        name,
        connected: this.connectionBySource[name],
        status,
        lastUpdateTs,
        ageMs,
        price: latest?.price ?? null,
        bid: latest?.bid ?? null,
        ask: latest?.ask ?? null,
      };
    });

    const healthyCount = sources.filter((s) => s.status === "healthy").length;
    const staleCount = sources.filter((s) => s.status === "stale").length;
    const downCount = sources.length - healthyCount - staleCount;

    return {
      sources,
      healthyCount,
      staleCount,
      downCount,
      oracleEstimate: this.getOracleEstimate(),
      oracleSourceCount: this.oracle.getSourceCount(),
      updatedAt: now,
    };
  }

  getRecentPrices(exchange: string, lookbackMs: number): PricePoint[];
  getRecentPrices(lookbackMs: number): PricePoint[];
  getRecentPrices(
    exchangeOrLookback: string | number,
    lookbackMs?: number,
  ): PricePoint[] {
    const cutoff = Date.now() -
      (typeof exchangeOrLookback === "number"
        ? exchangeOrLookback
        : lookbackMs!);
    if (typeof exchangeOrLookback === "string") {
      return this.priceHistory.filter(
        (p) => p.exchange === exchangeOrLookback && p.timestamp >= cutoff,
      );
    }
    return this.priceHistory.filter((p) => p.timestamp >= cutoff);
  }
}

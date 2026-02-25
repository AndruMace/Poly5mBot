import { Effect, Ref, Stream, SubscriptionRef, Schedule } from "effect";
import { binanceFeed } from "./binance.js";
import { bybitFeed } from "./bybit.js";
import { coinbaseFeed } from "./coinbase.js";
import { krakenFeed } from "./kraken.js";
import { bitstampFeed } from "./bitstamp.js";
import { okxFeed } from "./okx.js";
import { computeOracleEstimate } from "./oracle.js";
import type { PricePoint, FeedHealthSnapshot, FeedSourceHealth } from "../types.js";

const STALE_MS = 5000;
const DOWN_MS = 15000;
const MAX_HISTORY = 3000;

interface FeedState {
  readonly latestByExchange: Map<string, PricePoint>;
  readonly connectionByExchange: Map<string, boolean>;
  readonly oracleEstimate: number;
  readonly oracleTimestamp: number;
  readonly oracleSourceCount: number;
}

const initialFeedState: FeedState = {
  latestByExchange: new Map(),
  connectionByExchange: new Map([
    ["binance", false], ["bybit", false], ["coinbase", false],
    ["kraken", false], ["bitstamp", false], ["okx", false],
  ]),
  oracleEstimate: 0,
  oracleTimestamp: 0,
  oracleSourceCount: 0,
};

export class FeedService extends Effect.Service<FeedService>()("FeedService", {
  scoped: Effect.gen(function* () {
    const stateRef = yield* SubscriptionRef.make<FeedState>(initialFeedState);
    const historyRef = yield* Ref.make<PricePoint[]>([]);

    const updatePrice = (point: PricePoint) =>
      Effect.gen(function* () {
        yield* SubscriptionRef.update(stateRef, (s) => {
          const newLatest = new Map(s.latestByExchange);
          newLatest.set(point.exchange, point);
          const newConn = new Map(s.connectionByExchange);
          newConn.set(point.exchange, true);
          const oracle = computeOracleEstimate(newLatest);
          return {
            ...s,
            latestByExchange: newLatest,
            connectionByExchange: newConn,
            oracleEstimate: oracle.price > 0 ? oracle.price : s.oracleEstimate,
            oracleTimestamp: oracle.price > 0 ? Date.now() : s.oracleTimestamp,
            oracleSourceCount: oracle.sourceCount,
          };
        });
        yield* Ref.update(historyRef, (h) => {
          const next = [...h, point];
          return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
        });
      });

    const allFeeds = Stream.mergeAll(
      [binanceFeed, bybitFeed, coinbaseFeed, krakenFeed, bitstampFeed, okxFeed],
      { concurrency: "unbounded" },
    );

    yield* allFeeds.pipe(
      Stream.tap(updatePrice),
      Stream.runDrain,
      Effect.forkScoped,
    );

    yield* Effect.log(`[FeedService] 6 feeds started`);

    const getLatestPrices = SubscriptionRef.get(stateRef).pipe(
      Effect.map((s) => {
        const result: Record<string, PricePoint> = {};
        for (const [name, p] of s.latestByExchange) result[name] = p;
        return result;
      }),
    );

    const getOracleEstimate = SubscriptionRef.get(stateRef).pipe(
      Effect.map((s) => s.oracleEstimate),
    );

    const getOracleTimestamp = SubscriptionRef.get(stateRef).pipe(
      Effect.map((s) => s.oracleTimestamp),
    );

    const getCurrentBtcPrice = SubscriptionRef.get(stateRef).pipe(
      Effect.map((s) => {
        if (s.oracleEstimate > 0) return s.oracleEstimate;
        for (const p of s.latestByExchange.values()) {
          if (p.price > 0) return p.price;
        }
        return 0;
      }),
    );

    const getFeedHealth: Effect.Effect<FeedHealthSnapshot> = SubscriptionRef.get(stateRef).pipe(
      Effect.map((s) => {
        const now = Date.now();
        const feedNames = ["binance", "bybit", "coinbase", "kraken", "bitstamp", "okx"];
        const sources: FeedSourceHealth[] = feedNames.map((name) => {
          const latest = s.latestByExchange.get(name) ?? null;
          const lastUpdateTs = latest?.timestamp ?? null;
          const ageMs = typeof lastUpdateTs === "number" && lastUpdateTs > 0
            ? Math.max(0, now - lastUpdateTs)
            : null;
          const connected = s.connectionByExchange.get(name) ?? false;

          let status: "healthy" | "stale" | "down" = "down";
          if (connected && ageMs !== null) {
            if (ageMs <= STALE_MS) status = "healthy";
            else if (ageMs <= DOWN_MS) status = "stale";
          }

          return {
            name,
            connected,
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
          oracleEstimate: s.oracleEstimate,
          oracleSourceCount: s.oracleSourceCount,
          updatedAt: now,
        };
      }),
    );

    const getRecentPrices = (lookbackMs: number, exchange?: string) =>
      Ref.get(historyRef).pipe(
        Effect.map((h) => {
          const cutoff = Date.now() - lookbackMs;
          return h.filter((p) => p.timestamp >= cutoff && (!exchange || p.exchange === exchange));
        }),
      );

    const priceChanges = stateRef.changes;

    return {
      getLatestPrices,
      getOracleEstimate,
      getOracleTimestamp,
      getCurrentBtcPrice,
      getFeedHealth,
      getRecentPrices,
      priceChanges,
    } as const;
  }),
}) {}

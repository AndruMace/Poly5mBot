import { Duration, Effect, Ref, Stream, SubscriptionRef } from "effect";
import { binanceFeed } from "./binance.js";
import { bybitFeed } from "./bybit.js";
import { coinbaseFeed } from "./coinbase.js";
import { krakenFeed } from "./kraken.js";
import { bitstampFeed } from "./bitstamp.js";
import { okxFeed } from "./okx.js";
import { computeOracleEstimate } from "./oracle.js";
import { isDisconnectSentinel } from "./common.js";
import { fetchExchangeWeights, DEFAULT_EXCHANGE_WEIGHTS } from "./volume-weights.js";
import type { PricePoint, FeedHealthSnapshot, FeedSourceHealth } from "../types.js";

const STALE_MS = 5000;
const DOWN_MS = 15000;
const MAX_HISTORY = 3000;
const ORACLE_EMA_ALPHA = 0.2;
const GRACE_PERIOD_MS = 5_000;

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
    const weightsRef = yield* Ref.make<Record<string, number>>(DEFAULT_EXCHANGE_WEIGHTS);

    // Initial fetch with 8s timeout, fall back to defaults
    yield* fetchExchangeWeights.pipe(
      Effect.timeout(Duration.seconds(8)),
      Effect.orElse(() => Effect.succeed(DEFAULT_EXCHANGE_WEIGHTS)),
      Effect.tap((w) => Ref.set(weightsRef, w)),
      Effect.tap(() => Effect.log("[FeedService] Exchange weights updated")),
      Effect.catchAll(() => Effect.void),
    );

    // Hourly refresh fiber
    yield* fetchExchangeWeights.pipe(
      Effect.tap((w) => Ref.set(weightsRef, w)),
      Effect.tap(() => Effect.log("[FeedService] Exchange weights updated")),
      Effect.catchAll(() => Effect.void),
      Effect.delay(Duration.hours(1)),
      Effect.forever,
      Effect.forkScoped,
    );

    const pendingReconnect = new Set<string>();
    const reconnectedAt = new Map<string, number>();

    const isInGracePeriod = (exchange: string, now: number): boolean => {
      const reconAt = reconnectedAt.get(exchange);
      if (!reconAt) return false;
      if (now - reconAt < GRACE_PERIOD_MS) return true;
      reconnectedAt.delete(exchange);
      return false;
    };

    const updatePrice = (point: PricePoint) =>
      Effect.gen(function* () {
        if (isDisconnectSentinel(point)) {
          pendingReconnect.add(point.exchange);
          yield* SubscriptionRef.update(stateRef, (s) => {
            const newConn = new Map(s.connectionByExchange);
            newConn.set(point.exchange, false);
            return { ...s, connectionByExchange: newConn };
          });
          return;
        }

        const now = Date.now();
        if (pendingReconnect.has(point.exchange)) {
          pendingReconnect.delete(point.exchange);
          reconnectedAt.set(point.exchange, now);
          yield* Effect.log(
            `[FeedService] ${point.exchange} reconnected — grace period ${GRACE_PERIOD_MS}ms`,
          );
        }

        const weights = yield* Ref.get(weightsRef);

        const effectiveWeights = { ...weights };
        for (const [exchange] of reconnectedAt) {
          if (isInGracePeriod(exchange, now)) {
            effectiveWeights[exchange] = 0;
          }
        }

        yield* SubscriptionRef.update(stateRef, (s) => {
          const newLatest = new Map(s.latestByExchange);
          newLatest.set(point.exchange, point);
          const newConn = new Map(s.connectionByExchange);
          newConn.set(point.exchange, true);
          const oracle = computeOracleEstimate(newLatest, effectiveWeights);
          const rawOracle = oracle.price;
          const smoothedOracle = rawOracle > 0
            ? (s.oracleEstimate > 0
                ? ORACLE_EMA_ALPHA * rawOracle + (1 - ORACLE_EMA_ALPHA) * s.oracleEstimate
                : rawOracle)
            : s.oracleEstimate;
          return {
            ...s,
            latestByExchange: newLatest,
            connectionByExchange: newConn,
            oracleEstimate: smoothedOracle,
            oracleTimestamp: rawOracle > 0 ? Date.now() : s.oracleTimestamp,
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
        const now = Date.now();
        const result: Record<string, PricePoint> = {};
        for (const [name, p] of s.latestByExchange) {
          if (isInGracePeriod(name, now)) continue;
          result[name] = p;
        }
        return result;
      }),
    );

    const getOracleEstimate = SubscriptionRef.get(stateRef).pipe(
      Effect.map((s) => s.oracleEstimate),
    );

    const getOracleTimestamp = SubscriptionRef.get(stateRef).pipe(
      Effect.map((s) => s.oracleTimestamp),
    );

    const getCurrentAssetPrice = SubscriptionRef.get(stateRef).pipe(
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

          let status: "healthy" | "stale" | "down" | "warming_up" = "down";
          if (connected && ageMs !== null) {
            if (isInGracePeriod(name, now)) status = "warming_up";
            else if (ageMs <= STALE_MS) status = "healthy";
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
      getCurrentAssetPrice,
      getFeedHealth,
      getRecentPrices,
      priceChanges,
    } as const;
  }),
}) {}

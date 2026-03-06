import { Effect, Ref, Scope, Stream, SubscriptionRef } from "effect";
import { computeOracleEstimate } from "./oracle.js";
import { DEFAULT_EXCHANGE_WEIGHTS } from "./volume-weights.js";
import type { PricePoint, FeedHealthSnapshot, FeedSourceHealth } from "../types.js";

const STALE_MS = 5000;
const DOWN_MS = 15000;
const MAX_HISTORY = 3000;
const ORACLE_EMA_ALPHA = 0.2;

interface FeedState {
  readonly latestByExchange: Map<string, PricePoint>;
  readonly connectionByExchange: Map<string, boolean>;
  readonly oracleEstimate: number;
  readonly oracleTimestamp: number;
  readonly oracleSourceCount: number;
}

export interface MarketFeedInstance {
  readonly marketId: string;
  readonly getLatestPrices: Effect.Effect<Record<string, PricePoint>>;
  readonly getOracleEstimate: Effect.Effect<number>;
  readonly getOracleTimestamp: Effect.Effect<number>;
  readonly getCurrentAssetPrice: Effect.Effect<number>;
  readonly getFeedHealth: Effect.Effect<FeedHealthSnapshot>;
  readonly getRecentPrices: (lookbackMs: number, exchange?: string) => Effect.Effect<PricePoint[]>;
  readonly priceChanges: SubscriptionRef.SubscriptionRef<FeedState>["changes"];
}

export function createMarketFeedManager(
  marketId: string,
  feedStreams: Stream.Stream<PricePoint, never, never>[],
  feedNames: string[],
  weights?: Record<string, number>,
): Effect.Effect<MarketFeedInstance, never, Scope.Scope> {
  return Effect.gen(function* () {
    const initialConnections = new Map<string, boolean>(feedNames.map((n) => [n, false]));
    const stateRef = yield* SubscriptionRef.make<FeedState>({
      latestByExchange: new Map(),
      connectionByExchange: initialConnections,
      oracleEstimate: 0,
      oracleTimestamp: 0,
      oracleSourceCount: 0,
    });
    const historyRef = yield* Ref.make<PricePoint[]>([]);
    const weightsRef = yield* Ref.make<Record<string, number>>(weights ?? DEFAULT_EXCHANGE_WEIGHTS);

    const updatePrice = (point: PricePoint) =>
      Effect.gen(function* () {
        const w = yield* Ref.get(weightsRef);
        yield* SubscriptionRef.update(stateRef, (s) => {
          const newLatest = new Map(s.latestByExchange);
          newLatest.set(point.exchange, point);
          const newConn = new Map(s.connectionByExchange);
          newConn.set(point.exchange, true);
          const oracle = computeOracleEstimate(newLatest, w);
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

    const allFeeds = Stream.mergeAll(feedStreams, { concurrency: "unbounded" });

    yield* allFeeds.pipe(
      Stream.tap(updatePrice),
      Stream.runDrain,
      Effect.forkScoped,
    );

    yield* Effect.log(`[FeedManager:${marketId}] ${feedStreams.length} feeds started`);

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
      marketId,
      getLatestPrices,
      getOracleEstimate,
      getOracleTimestamp,
      getCurrentAssetPrice,
      getFeedHealth,
      getRecentPrices,
      priceChanges,
    } as const;
  });
}

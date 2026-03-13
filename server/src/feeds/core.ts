import { Duration, Effect, Ref, Scope, Stream, SubscriptionRef } from "effect";
import { computeOracleEstimate } from "./oracle.js";
import { isDisconnectSentinel } from "./common.js";
import { fetchExchangeWeights, DEFAULT_EXCHANGE_WEIGHTS } from "./volume-weights.js";
import type { FeedHealthSnapshot, FeedSourceHealth, PricePoint } from "../types.js";

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

export interface FeedCoreInstance {
  readonly getLatestPrices: Effect.Effect<Record<string, PricePoint>>;
  readonly getOracleEstimate: Effect.Effect<number>;
  readonly getOracleTimestamp: Effect.Effect<number>;
  readonly getCurrentAssetPrice: Effect.Effect<number>;
  readonly getFeedHealth: Effect.Effect<FeedHealthSnapshot>;
  readonly getRecentPrices: (lookbackMs: number, exchange?: string) => Effect.Effect<PricePoint[]>;
  readonly priceChanges: SubscriptionRef.SubscriptionRef<FeedState>["changes"];
}

interface CreateFeedCoreInput {
  readonly logPrefix: string;
  readonly feedStreams: ReadonlyArray<Stream.Stream<PricePoint, never, never>>;
  readonly feedNames: ReadonlyArray<string>;
  readonly initialWeights?: Record<string, number>;
}

export function createFeedCore(
  input: CreateFeedCoreInput,
): Effect.Effect<FeedCoreInstance, never, Scope.Scope> {
  return Effect.gen(function* () {
    const stateRef = yield* SubscriptionRef.make<FeedState>({
      latestByExchange: new Map(),
      connectionByExchange: new Map(input.feedNames.map((name) => [name, false])),
      oracleEstimate: 0,
      oracleTimestamp: 0,
      oracleSourceCount: 0,
    });
    const historyRef = yield* Ref.make<PricePoint[]>([]);
    const weightsRef = yield* Ref.make<Record<string, number>>(input.initialWeights ?? DEFAULT_EXCHANGE_WEIGHTS);

    yield* fetchExchangeWeights.pipe(
      Effect.timeout(Duration.seconds(8)),
      Effect.orElse(() => Effect.succeed(input.initialWeights ?? DEFAULT_EXCHANGE_WEIGHTS)),
      Effect.tap((weights) => Ref.set(weightsRef, weights)),
      Effect.tap(() => Effect.log(`${input.logPrefix} Exchange weights updated`)),
      Effect.catchAll(() => Effect.void),
    );

    yield* fetchExchangeWeights.pipe(
      Effect.tap((weights) => Ref.set(weightsRef, weights)),
      Effect.tap(() => Effect.log(`${input.logPrefix} Exchange weights refreshed`)),
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
          yield* SubscriptionRef.update(stateRef, (state) => {
            const newConn = new Map(state.connectionByExchange);
            newConn.set(point.exchange, false);
            return { ...state, connectionByExchange: newConn };
          });
          return;
        }

        const now = Date.now();
        if (pendingReconnect.has(point.exchange)) {
          pendingReconnect.delete(point.exchange);
          reconnectedAt.set(point.exchange, now);
          yield* Effect.log(
            `${input.logPrefix} ${point.exchange} reconnected - grace period ${GRACE_PERIOD_MS}ms`,
          );
        }

        const weights = yield* Ref.get(weightsRef);
        const effectiveWeights = { ...weights };
        for (const [exchange] of reconnectedAt) {
          if (isInGracePeriod(exchange, now)) {
            effectiveWeights[exchange] = 0;
          }
        }

        yield* SubscriptionRef.update(stateRef, (state) => {
          const latestByExchange = new Map(state.latestByExchange);
          latestByExchange.set(point.exchange, point);
          const connectionByExchange = new Map(state.connectionByExchange);
          connectionByExchange.set(point.exchange, true);
          const oracle = computeOracleEstimate(latestByExchange, effectiveWeights);
          const rawOracle = oracle.price;
          const oracleEstimate = rawOracle > 0
            ? (state.oracleEstimate > 0
                ? ORACLE_EMA_ALPHA * rawOracle + (1 - ORACLE_EMA_ALPHA) * state.oracleEstimate
                : rawOracle)
            : state.oracleEstimate;
          return {
            ...state,
            latestByExchange,
            connectionByExchange,
            oracleEstimate,
            oracleTimestamp: rawOracle > 0 ? now : state.oracleTimestamp,
            oracleSourceCount: oracle.sourceCount,
          };
        });

        yield* Ref.update(historyRef, (history) => {
          const next = [...history, point];
          return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
        });
      });

    yield* Stream.mergeAll(input.feedStreams, { concurrency: "unbounded" }).pipe(
      Stream.tap(updatePrice),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* Effect.log(`${input.logPrefix} ${input.feedStreams.length} feeds started`);

    const getLatestPrices = SubscriptionRef.get(stateRef).pipe(
      Effect.map((state) => {
        const now = Date.now();
        const result: Record<string, PricePoint> = {};
        for (const [name, point] of state.latestByExchange) {
          if (isInGracePeriod(name, now)) continue;
          result[name] = point;
        }
        return result;
      }),
    );

    const getOracleEstimate = SubscriptionRef.get(stateRef).pipe(
      Effect.map((state) => state.oracleEstimate),
    );

    const getOracleTimestamp = SubscriptionRef.get(stateRef).pipe(
      Effect.map((state) => state.oracleTimestamp),
    );

    const getCurrentAssetPrice = SubscriptionRef.get(stateRef).pipe(
      Effect.map((state) => {
        if (state.oracleEstimate > 0) return state.oracleEstimate;
        for (const point of state.latestByExchange.values()) {
          if (point.price > 0) return point.price;
        }
        return 0;
      }),
    );

    const getFeedHealth: Effect.Effect<FeedHealthSnapshot> = SubscriptionRef.get(stateRef).pipe(
      Effect.map((state) => {
        const now = Date.now();
        const sources: FeedSourceHealth[] = input.feedNames.map((name) => {
          const latest = state.latestByExchange.get(name) ?? null;
          const lastUpdateTs = latest?.timestamp ?? null;
          const ageMs = typeof lastUpdateTs === "number" && lastUpdateTs > 0
            ? Math.max(0, now - lastUpdateTs)
            : null;
          const connected = state.connectionByExchange.get(name) ?? false;

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

        const healthyCount = sources.filter((source) => source.status === "healthy").length;
        const staleCount = sources.filter((source) => source.status === "stale").length;
        const downCount = sources.length - healthyCount - staleCount;

        return {
          sources,
          healthyCount,
          staleCount,
          downCount,
          oracleEstimate: state.oracleEstimate,
          oracleSourceCount: state.oracleSourceCount,
          updatedAt: now,
        };
      }),
    );

    const getRecentPrices = (lookbackMs: number, exchange?: string) =>
      Ref.get(historyRef).pipe(
        Effect.map((history) => {
          const cutoff = Date.now() - lookbackMs;
          return history.filter((point) => point.timestamp >= cutoff && (!exchange || point.exchange === exchange));
        }),
      );

    return {
      getLatestPrices,
      getOracleEstimate,
      getOracleTimestamp,
      getCurrentAssetPrice,
      getFeedHealth,
      getRecentPrices,
      priceChanges: stateRef.changes,
    } as const;
  });
}

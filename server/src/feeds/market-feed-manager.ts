import { Effect, Scope, Stream } from "effect";
import { DEFAULT_EXCHANGE_WEIGHTS } from "./volume-weights.js";
import { createFeedCore, type FeedCoreInstance } from "./core.js";
import type { PricePoint, FeedHealthSnapshot } from "../types.js";

export interface MarketFeedInstance {
  readonly marketId: string;
  readonly getLatestPrices: Effect.Effect<Record<string, PricePoint>>;
  readonly getOracleEstimate: Effect.Effect<number>;
  readonly getOracleTimestamp: Effect.Effect<number>;
  readonly getCurrentAssetPrice: Effect.Effect<number>;
  readonly getFeedHealth: Effect.Effect<FeedHealthSnapshot>;
  readonly getRecentPrices: (lookbackMs: number, exchange?: string) => Effect.Effect<PricePoint[]>;
  readonly priceChanges: FeedCoreInstance["priceChanges"];
}

export function createMarketFeedManager(
  marketId: string,
  feedStreams: Stream.Stream<PricePoint, never, never>[],
  feedNames: string[],
  weights?: Record<string, number>,
): Effect.Effect<MarketFeedInstance, never, Scope.Scope> {
  return Effect.gen(function* () {
    const runtime = yield* createFeedCore({
      logPrefix: `[FeedManager:${marketId}]`,
      feedStreams,
      feedNames,
      initialWeights: weights ?? DEFAULT_EXCHANGE_WEIGHTS,
    });

    return {
      marketId,
      ...runtime,
    } as const;
  });
}

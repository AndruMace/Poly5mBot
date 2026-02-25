import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer, Stream } from "effect";
import { computeOracleEstimate } from "../../src/feeds/oracle.js";
import type { PricePoint } from "../../src/types.js";

type FeedPoints = Record<string, PricePoint[]>;

const feedPoints = vi.hoisted<FeedPoints>(() => ({
  binance: [],
  bybit: [],
  coinbase: [],
  kraken: [],
  bitstamp: [],
  okx: [],
}));

vi.mock("../../src/feeds/binance.js", () => ({
  binanceFeed: Stream.suspend(() => Stream.fromIterable(feedPoints.binance)),
}));
vi.mock("../../src/feeds/bybit.js", () => ({
  bybitFeed: Stream.suspend(() => Stream.fromIterable(feedPoints.bybit)),
}));
vi.mock("../../src/feeds/coinbase.js", () => ({
  coinbaseFeed: Stream.suspend(() => Stream.fromIterable(feedPoints.coinbase)),
}));
vi.mock("../../src/feeds/kraken.js", () => ({
  krakenFeed: Stream.suspend(() => Stream.fromIterable(feedPoints.kraken)),
}));
vi.mock("../../src/feeds/bitstamp.js", () => ({
  bitstampFeed: Stream.suspend(() => Stream.fromIterable(feedPoints.bitstamp)),
}));
vi.mock("../../src/feeds/okx.js", () => ({
  okxFeed: Stream.suspend(() => Stream.fromIterable(feedPoints.okx)),
}));

describe("oracle + feed aggregation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T12:00:00.000Z"));
    for (const key of Object.keys(feedPoints)) feedPoints[key].splice(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("filters stale + outlier prices in oracle estimate", () => {
    const now = Date.now();
    const prices = new Map<string, PricePoint>([
      ["binance", { exchange: "binance", price: 100.0, timestamp: now - 500 }],
      ["bybit", { exchange: "bybit", price: 100.1, timestamp: now - 800 }],
      ["coinbase", { exchange: "coinbase", price: 99.9, timestamp: now - 700 }],
      ["kraken", { exchange: "kraken", price: 100.05, timestamp: now - 900 }],
      ["okx", { exchange: "okx", price: 130.0, timestamp: now - 600 }],
      ["stale", { exchange: "stale", price: 100.0, timestamp: now - 20_000 }],
    ]);

    const result = computeOracleEstimate(prices);

    expect(result.sourceCount).toBe(4);
    expect(result.price).toBeCloseTo(100.03, 2);
  });

  it("reports all feeds down before any feed data is observed", async () => {
    const { FeedService } = await import("../../src/feeds/manager.js");
    const health = await Effect.runPromise(
      Effect.gen(function* () {
        const feed = yield* FeedService;
        yield* Effect.yieldNow();
        yield* Effect.yieldNow();
        return yield* feed.getFeedHealth;
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(FeedService.Default)),
      ),
    );

    const byName = new Map(health.sources.map((s) => [s.name, s]));
    expect(byName.get("binance")?.status).toBe("down");
    expect(byName.get("bybit")?.status).toBe("down");
    expect(byName.get("coinbase")?.status).toBe("down");
    expect(health.healthyCount).toBe(0);
    expect(health.staleCount).toBe(0);
    expect(health.downCount).toBe(6);
    expect(health.oracleSourceCount).toBe(0);
    expect(health.oracleEstimate).toBe(0);
  });
});

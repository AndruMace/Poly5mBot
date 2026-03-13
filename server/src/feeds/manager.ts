import { Effect } from "effect";
import { binanceFeed } from "./binance.js";
import { bybitFeed } from "./bybit.js";
import { coinbaseFeed } from "./coinbase.js";
import { krakenFeed } from "./kraken.js";
import { bitstampFeed } from "./bitstamp.js";
import { okxFeed } from "./okx.js";
import { createFeedCore } from "./core.js";

export class FeedService extends Effect.Service<FeedService>()("FeedService", {
  scoped: Effect.gen(function* () {
    const feedNames = ["binance", "bybit", "coinbase", "kraken", "bitstamp", "okx"] as const;
    const runtime = yield* createFeedCore({
      logPrefix: "[FeedService]",
      feedNames,
      feedStreams: [binanceFeed, bybitFeed, coinbaseFeed, krakenFeed, bitstampFeed, okxFeed],
    });
    return runtime;
  }),
}) {}

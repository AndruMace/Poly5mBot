import { Effect } from "effect";

export const DEFAULT_EXCHANGE_WEIGHTS: Record<string, number> = {
  binance:  4.0,
  bybit:    2.0,
  coinbase: 2.0,
  okx:      1.0,
  kraken:   1.0,
  bitstamp: 0.5,
};

async function fetchWithTimeout(url: string, parse: (d: any) => number): Promise<number> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return parse(data);
  } finally {
    clearTimeout(timer);
  }
}

const fetchers: { exchange: string; url: string; parse: (d: any) => number }[] = [
  {
    exchange: "binance",
    url: "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT",
    parse: (d) => Number(d.quoteVolume),
  },
  {
    exchange: "bybit",
    url: "https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT",
    parse: (d) => Number(d.result.list[0].turnover24h),
  },
  {
    exchange: "coinbase",
    url: "https://api.exchange.coinbase.com/products/BTC-USD/stats",
    parse: (d) => Number(d.volume) * Number(d.last),
  },
  {
    exchange: "okx",
    url: "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT",
    parse: (d) => Number(d.data[0].volCcy24h),
  },
  {
    exchange: "kraken",
    url: "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
    parse: (d) => Number(d.result.XXBTZUSD.v[1]) * Number(d.result.XXBTZUSD.c[0]),
  },
  {
    exchange: "bitstamp",
    url: "https://www.bitstamp.net/api/v2/ticker/btcusd/",
    parse: (d) => Number(d.volume) * Number(d.last),
  },
];

export const fetchExchangeWeights: Effect.Effect<Record<string, number>> = Effect.gen(
  function* () {
    const results = yield* Effect.all(
      fetchers.map(({ exchange, url, parse }) =>
        Effect.tryPromise(() => fetchWithTimeout(url, parse)).pipe(
          Effect.map((vol) => ({ exchange, vol })),
          Effect.catchAll(() => Effect.succeed({ exchange, vol: -1 })),
        ),
      ),
      { concurrency: "unbounded" },
    );

    const succeeded = results.filter((r) => r.vol > 0);
    if (succeeded.length < 3) {
      yield* Effect.log("[FeedService] Volume fetch: too few exchanges succeeded, using defaults");
      return DEFAULT_EXCHANGE_WEIGHTS;
    }

    const weights: Record<string, number> = { ...DEFAULT_EXCHANGE_WEIGHTS };
    for (const { exchange, vol } of succeeded) {
      weights[exchange] = vol;
    }
    return weights;
  },
);

import { Effect, Ref } from "effect";
import { makeStrategyBase, makeInitialState, type Strategy, type StrategyInternalState } from "./base.js";
import type { MarketContext, Signal } from "../types.js";
import { DEFAULT_EXCHANGE_WEIGHTS } from "../feeds/volume-weights.js";

const DEFAULT_CONFIG: Record<string, number> = {
  minSpreadPct: 0.04,
  minPtbDistancePct: 0.03,
  persistenceMs: 3000,
  persistenceCount: 4,
  minConfirmingExchanges: 3,
  minReferenceSources: 2,
  minWindowElapsedSec: 180,
  maxWindowElapsedSec: 270,
  maxSharePrice: 0.55,
  maxExecutionPrice: 0.54,
  maxOracleAgeSec: 5,
  tradeSize: 5,
  maxEntriesPerWindow: 2,
  maxSameSideEntriesPerWindow: 1,
  allowSameSideStacking: 0,
  qualityMinMultiplier: 0.5,
  qualityMaxMultiplier: 1.15,
  spreadPenaltyK: 8,
};

const DEFAULT_REGIME_FILTER = {
  allowedVolatility: ["low" as const, "normal" as const, "high" as const],
  allowedSpread: ["tight" as const, "normal" as const],
};

export const makeArbStrategy = Effect.gen(function* () {
  const ref = yield* Ref.make<StrategyInternalState>(makeInitialState(DEFAULT_CONFIG, DEFAULT_REGIME_FILTER));
  const spreadHistoryRef = yield* Ref.make<Array<{ side: "UP" | "DOWN"; ts: number }>>([]);
  const base = makeStrategyBase("arb", DEFAULT_CONFIG, DEFAULT_REGIME_FILTER, ref);

  const evaluate = (ctx: MarketContext): Effect.Effect<Signal | null> =>
    Effect.gen(function* () {
      const s = yield* Ref.get(ref);
      if (!ctx.currentWindow || !ctx.priceToBeat) return null;

      const elapsedSec = ctx.windowElapsedMs / 1000;
      if (elapsedSec < s.config["minWindowElapsedSec"]!) return null;
      if (elapsedSec > s.config["maxWindowElapsedSec"]!) return null;

      const binance = ctx.prices["binance"];
      if (!binance) return null;

      yield* Ref.update(ref, (st) => ({ ...st, status: "watching" as const }));

      const maxOracleAgeMs = (s.config["maxOracleAgeSec"] ?? 5) * 1000;
      const reference = buildCrossExchangeReference(
        ctx,
        Math.max(1, Math.floor(s.config["minReferenceSources"] ?? 2)),
        maxOracleAgeMs,
      );
      if (!reference) {
        yield* Ref.update(ref, (st) => ({
          ...st,
          statusReason: "Waiting for fresh cross-exchange reference",
        }));
        return null;
      }

      const spreadPct = ((priceOf(binance) - reference.price) / reference.price) * 100;
      const absSpread = Math.abs(spreadPct);

      if (absSpread < s.config["minSpreadPct"]!) {
        yield* Ref.set(spreadHistoryRef, []);
        return null;
      }

      const side: "UP" | "DOWN" = spreadPct > 0 ? "UP" : "DOWN";

      if (ctx.trendRegime) {
        if (side === "DOWN" && (ctx.trendRegime === "up" || ctx.trendRegime === "strong_up")) return null;
        if (side === "UP" && (ctx.trendRegime === "down" || ctx.trendRegime === "strong_down")) return null;
      }

      const btcDelta = ((priceOf(binance) - ctx.priceToBeat) / ctx.priceToBeat) * 100;
      const minPtbDistancePct = Math.max(0, s.config["minPtbDistancePct"]!);
      if (Math.abs(btcDelta) < minPtbDistancePct) return null;
      if (side === "UP" && btcDelta <= 0) return null;
      if (side === "DOWN" && btcDelta >= 0) return null;

      const now = Date.now();
      yield* Ref.update(spreadHistoryRef, (h) => {
        const cutoff = now - s.config["persistenceMs"]!;
        return [...h.filter((x) => x.ts > cutoff), { side, ts: now }];
      });

      const history = yield* Ref.get(spreadHistoryRef);
      const sameSideCount = history.filter((x) => x.side === side).length;
      if (sameSideCount < s.config["persistenceCount"]!) {
        yield* Ref.update(ref, (st) => ({
          ...st,
          statusReason: `Waiting for spread persistence (${sameSideCount}/${s.config["persistenceCount"]!})`,
        }));
        return null;
      }

      const confirmers = countConfirmingExchanges(ctx, side, minPtbDistancePct);
      if (confirmers < s.config["minConfirmingExchanges"]!) {
        yield* Ref.update(ref, (st) => ({
          ...st,
          statusReason: `Insufficient exchange confirmation (${confirmers}/${s.config["minConfirmingExchanges"]!})`,
        }));
        return null;
      }

      const confidence = Math.min(1, (absSpread / s.config["minSpreadPct"]!) * 0.6 + (confirmers / 4) * 0.4);
      const maxPrice = s.config["maxSharePrice"] ?? 0.55;

      yield* Ref.set(spreadHistoryRef, []);
      const signal: Signal = {
        side,
        confidence,
        size: s.config["tradeSize"]!,
        maxPrice,
        strategy: "arb",
        reason: `Binance ${spreadPct > 0 ? "leads" : "lags"} cross-exchange reference by ${absSpread.toFixed(3)}% (${confirmers} confirmers, persisted ${sameSideCount} ticks)`,
        timestamp: Date.now(),
        telemetry: {
          arbBinancePrice: priceOf(binance),
          arbReferencePrice: reference.price,
          arbReferenceSources: reference.sourceCount,
          arbSpreadPct: spreadPct,
          arbAbsSpreadPct: absSpread,
          arbPtbDeltaPct: btcDelta,
          arbConfirmers: confirmers,
        },
      };
      yield* Ref.update(ref, (st) => ({ ...st, status: "trading" as const, lastSignal: signal }));
      return signal;
    });

  return { name: "arb", evaluate, stateRef: ref, ...base } satisfies Strategy;
});

const REFERENCE_EXCHANGES = ["bybit", "coinbase", "kraken", "okx", "bitstamp"] as const;
const REFERENCE_OUTLIER_PCT = 0.0015;

function priceOf(point: { price: number; bid?: number; ask?: number }): number {
  const bid = Number(point.bid);
  const ask = Number(point.ask);
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
    return (bid + ask) / 2;
  }
  return Number(point.price);
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function buildCrossExchangeReference(
  ctx: MarketContext,
  minReferenceSources: number,
  maxAgeMs: number,
): { price: number; sourceCount: number } | null {
  const now = Date.now();
  const candidates = REFERENCE_EXCHANGES.flatMap((name) => {
    const feed = ctx.prices[name];
    if (!feed) return [];
    const ageMs = now - feed.timestamp;
    const price = priceOf(feed);
    if (!Number.isFinite(price) || price <= 0 || ageMs > maxAgeMs) return [];
    return [{ exchange: name, price }];
  });
  if (candidates.length < minReferenceSources) return null;

  const sortedPrices = candidates.map((c) => c.price).sort((a, b) => a - b);
  const center = median(sortedPrices);
  const filtered = candidates.filter((candidate) => Math.abs(candidate.price - center) / center < REFERENCE_OUTLIER_PCT);
  const usable = filtered.length >= minReferenceSources ? filtered : candidates;

  let weightSum = 0;
  let weightedPriceSum = 0;
  for (const candidate of usable) {
    const weight = DEFAULT_EXCHANGE_WEIGHTS[candidate.exchange] ?? 1;
    weightedPriceSum += candidate.price * weight;
    weightSum += weight;
  }
  if (weightSum <= 0) return null;

  return {
    price: weightedPriceSum / weightSum,
    sourceCount: usable.length,
  };
}

function countConfirmingExchanges(ctx: MarketContext, side: "UP" | "DOWN", minPtbDistancePct: number): number {
  if (ctx.priceToBeat === null || ctx.priceToBeat <= 0) return 0;
  let count = 0;
  const thresholdPct = Math.max(0.01, minPtbDistancePct / 2);
  for (const name of REFERENCE_EXCHANGES) {
    const feed = ctx.prices[name];
    if (!feed) continue;
    const feedPrice = priceOf(feed);
    const feedDeltaPct = ((feedPrice - ctx.priceToBeat) / ctx.priceToBeat) * 100;
    if (side === "UP" && feedDeltaPct >= thresholdPct) count++;
    if (side === "DOWN" && feedDeltaPct <= -thresholdPct) count++;
  }
  return count;
}

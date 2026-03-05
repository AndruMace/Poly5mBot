import { Effect, Ref } from "effect";
import { makeStrategyBase, makeInitialState, type Strategy, type StrategyInternalState } from "./base.js";
import type { MarketContext, Signal } from "../types.js";

const DEFAULT_CONFIG: Record<string, number> = {
  minSpreadPct: 0.04,
  persistenceMs: 3000,
  persistenceCount: 4,
  minConfirmingExchanges: 1,
  minWindowElapsedSec: 180,
  maxWindowElapsedSec: 270,
  maxSharePrice: 0.55,
  maxOracleAgeSec: 5,
  tradeSize: 5,
  maxEntriesPerWindow: 2,
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

      const oraclePrice = ctx.oracleEstimate;
      if (oraclePrice <= 0) return null;

      const maxOracleAgeMs = (s.config["maxOracleAgeSec"] ?? 5) * 1000;
      if (ctx.oracleTimestamp > 0 && Date.now() - ctx.oracleTimestamp > maxOracleAgeMs) {
        yield* Ref.update(ref, (st) => ({
          ...st,
          statusReason: `Oracle stale (${((Date.now() - ctx.oracleTimestamp) / 1000).toFixed(1)}s > ${s.config["maxOracleAgeSec"]}s)`,
        }));
        return null;
      }

      const spreadPct = ((binance.price - oraclePrice) / oraclePrice) * 100;
      const absSpread = Math.abs(spreadPct);

      if (absSpread < s.config["minSpreadPct"]!) {
        yield* Ref.set(spreadHistoryRef, []);
        return null;
      }

      const side: "UP" | "DOWN" = spreadPct > 0 ? "UP" : "DOWN";
      const btcDelta = ((binance.price - ctx.priceToBeat) / ctx.priceToBeat) * 100;
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

      const confirmers = countConfirmingExchanges(ctx, side);
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
        reason: `Binance ${spreadPct > 0 ? "leads" : "lags"} oracle by ${absSpread.toFixed(3)}% (${confirmers + 1} exchanges agree, persisted ${sameSideCount} ticks)`,
        timestamp: Date.now(),
      };
      yield* Ref.update(ref, (st) => ({ ...st, status: "trading" as const, lastSignal: signal }));
      return signal;
    });

  return { name: "arb", evaluate, stateRef: ref, ...base } satisfies Strategy;
});

function countConfirmingExchanges(ctx: MarketContext, side: "UP" | "DOWN"): number {
  const others = ["bybit", "coinbase", "kraken", "okx"];
  let count = 0;
  const oracle = ctx.oracleEstimate;
  if (oracle <= 0) return 0;
  for (const name of others) {
    const feed = ctx.prices[name];
    if (!feed) continue;
    const feedSpread = ((feed.price - oracle) / oracle) * 100;
    if (side === "UP" && feedSpread > 0.01) count++;
    if (side === "DOWN" && feedSpread < -0.01) count++;
  }
  return count;
}

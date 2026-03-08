import { Effect, Ref } from "effect";
import { computeRSI, buildCandles } from "../indicators/technical.js";
import { makeStrategyBase, makeInitialState, type Strategy, type StrategyInternalState } from "./base.js";
import type { MarketContext, Signal, PricePoint } from "../types.js";

const DEFAULT_CONFIG: Record<string, number> = {
  rsiPeriod: 14,
  rsiOverbought: 66,
  rsiOversold: 34,
  minWindowElapsedSec: 180,
  maxWindowElapsedSec: 270,
  minPriceMovePct: 0.05,
  minPtbDistancePct: 0.03,
  maxSharePrice: 0.67,
  maxExecutionPrice: 0.66,
  tradeSize: 8,
  maxEntriesPerWindow: 2,
  maxSameSideEntriesPerWindow: 2,
  allowSameSideStacking: 0,
  chopConfidenceFloor: 0.58,
  chopSizeMultiplier: 0.75,
  qualityMinMultiplier: 0.5,
  qualityMaxMultiplier: 1.15,
  spreadPenaltyK: 8,
  thinLiquidityDiscount: 0.02,
  blowoutSpreadDiscount: 0.03,
};

const DEFAULT_REGIME_FILTER = {
  allowedVolatility: ["low" as const, "normal" as const, "high" as const],
  allowedTrend: ["strong_up" as const, "up" as const, "chop" as const, "down" as const, "strong_down" as const],
};

export const makeMomentumStrategy = Effect.gen(function* () {
  const ref = yield* Ref.make<StrategyInternalState>(makeInitialState(DEFAULT_CONFIG, DEFAULT_REGIME_FILTER));
  const priceBufferRef = yield* Ref.make<PricePoint[]>([]);
  const base = makeStrategyBase("momentum", DEFAULT_CONFIG, DEFAULT_REGIME_FILTER, ref);

  const addPrice = (point: PricePoint) =>
    Ref.update(priceBufferRef, (buf) => {
      const cutoff = Date.now() - 15 * 60_000;
      return [...buf.filter((p) => p.timestamp > cutoff), point];
    });

  const evaluate = (ctx: MarketContext): Effect.Effect<Signal | null> =>
    Effect.gen(function* () {
      const s = yield* Ref.get(ref);
      if (!ctx.currentWindow || !ctx.priceToBeat) return null;

      const elapsedSec = ctx.windowElapsedMs / 1000;
      if (elapsedSec < s.config["minWindowElapsedSec"]!) return null;
      if (elapsedSec > s.config["maxWindowElapsedSec"]!) return null;

      yield* Ref.update(ref, (st) => ({ ...st, status: "watching" as const }));

      const buffer = yield* Ref.get(priceBufferRef);
      const candles = buildCandles(buffer, 30_000);
      if (candles.length < s.config["rsiPeriod"]! + 1) return null;

      const rsi = computeRSI(candles, s.config["rsiPeriod"]!);
      if (rsi === null) return null;

      const priceMove = ((ctx.currentAssetPrice - ctx.priceToBeat) / ctx.priceToBeat) * 100;
      const absMove = Math.abs(priceMove);
      if (absMove < s.config["minPriceMovePct"]!) return null;
      if (absMove < Math.max(0, s.config["minPtbDistancePct"]!)) return null;

      let side: "UP" | "DOWN" | null = null;
      let reason = "";

      if (rsi > s.config["rsiOverbought"]! && priceMove > 0) {
        side = "UP";
        reason = `RSI=${rsi.toFixed(1)} confirms upward momentum, price +${absMove.toFixed(3)}%`;
      } else if (rsi < s.config["rsiOversold"]! && priceMove < 0) {
        side = "DOWN";
        reason = `RSI=${rsi.toFixed(1)} confirms downward momentum, price -${absMove.toFixed(3)}%`;
      }

      if (!side) return null;

      const confidence = Math.min(1, Math.abs(rsi - 50) / 30);

      const signal: Signal = {
        side,
        confidence,
        size: s.config["tradeSize"]!,
        maxPrice: s.config["maxSharePrice"] ?? 0.65,
        strategy: "momentum",
        reason,
        timestamp: Date.now(),
      };
      yield* Ref.update(ref, (st) => ({ ...st, status: "trading" as const, lastSignal: signal }));
      return signal;
    });

  return { name: "momentum", evaluate, addPrice, stateRef: ref, ...base } satisfies Strategy & { addPrice: typeof addPrice };
});

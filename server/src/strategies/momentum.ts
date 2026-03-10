import { Effect, Ref } from "effect";
import { computeRSI, buildCandles } from "../indicators/technical.js";
import { makeStrategyBase, makeInitialState, type Strategy, type StrategyInternalState } from "./base.js";
import type { MarketContext, Signal, PricePoint } from "../types.js";

const DEFAULT_CONFIG: Record<string, number> = {
  rsiPeriod: 14,
  rsiOverbought: 66,
  rsiOversold: 28,
  minWindowElapsedSec: 180,
  maxWindowElapsedSec: 270,
  minPriceMovePct: 0.05,
  minPtbDistancePct: 0.03,
  maxSharePrice: 0.58,
  maxExecutionPrice: 0.55,
  tradeSize: 8,
  maxEntriesPerWindow: 2,
  maxSameSideEntriesPerWindow: 1,
  allowSameSideStacking: 0,
  chopConfidenceFloor: 0.58,
  chopSizeMultiplier: 0.75,
  chopDownSizeMultiplier: 0.50,
  qualityMinMultiplier: 0.5,
  qualityMaxMultiplier: 1.15,
  spreadPenaltyK: 8,
  thinLiquidityDiscount: 0.02,
  blowoutSpreadDiscount: 0.03,
  downChopConfidenceFloor: 0.70,
  downMinTrendStrength: 0.05,
  downMaxSpreadRegime: 2,
  lossCooldownAfter: 2,
  lossCooldownMinutes: 10,
  candleIntervalMs: 30_000,
  priceBufferMs: 900_000,
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
    Effect.gen(function* () {
      const s = yield* Ref.get(ref);
      const priceBufferMs = Math.max(60_000, Math.floor(s.config["priceBufferMs"] ?? 900_000));
      const cutoff = Date.now() - priceBufferMs;
      yield* Ref.update(priceBufferRef, (buf) => [...buf.filter((p) => p.timestamp > cutoff), point]);
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
      const candleIntervalMs = Math.max(5_000, Math.floor(s.config["candleIntervalMs"] ?? 30_000));
      const candles = buildCandles(buffer, candleIntervalMs);
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

      let confidence = Math.min(1, Math.abs(rsi - 50) / 30);
      if (side === "DOWN") {
        confidence = Math.min(0.65, 0.3 + (s.config["rsiOversold"]! - rsi) * 0.01);
        confidence = Math.max(0.3, confidence);
      }

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

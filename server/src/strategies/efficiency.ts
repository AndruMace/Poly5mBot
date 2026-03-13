import { Effect, Ref } from "effect";
import { effectiveFeeRateStatic } from "../polymarket/orders.js";
import { makeStrategyBase, makeInitialState, type Strategy, type StrategyInternalState } from "./base.js";
import type { MarketContext, Signal } from "../types.js";

const DEFAULT_CONFIG: Record<string, number> = {
  minWindowElapsedSec: 180,
  minProfitBps: 8,
  slippageBufferBps: 4,
  tradeSize: 20,
  maxEntriesPerWindow: 2,
  maxVolatilityValue: 0.0003,
};

const DEFAULT_REGIME_FILTER = {
  allowedLiquidity: ["thin" as const, "normal" as const, "deep" as const],
  allowedSpread: ["tight" as const, "normal" as const, "wide" as const, "blowout" as const],
};

export const makeEfficiencyStrategy = Effect.gen(function* () {
  const ref = yield* Ref.make<StrategyInternalState>(makeInitialState(DEFAULT_CONFIG, DEFAULT_REGIME_FILTER));
  const base = makeStrategyBase("efficiency", DEFAULT_CONFIG, DEFAULT_REGIME_FILTER, ref);

  const evaluate = (ctx: MarketContext): Effect.Effect<Signal | null> =>
    Effect.gen(function* () {
      const s = yield* Ref.get(ref);
      if (!ctx.currentWindow) return null;
      const elapsedSec = ctx.windowElapsedMs / 1000;
      if (elapsedSec < s.config["minWindowElapsedSec"]!) return null;

      const maxVol = s.config["maxVolatilityValue"] ?? 0.0003;
      if (ctx.volatilityValue !== undefined && ctx.volatilityValue > maxVol) return null;

      const { bestAskUp, bestAskDown } = ctx.orderBook;
      if (bestAskUp === null || bestAskDown === null) return null;

      yield* Ref.update(ref, (st) => ({ ...st, status: "watching" as const }));

      const totalCost = bestAskUp + bestAskDown;
      if (totalCost >= 1.0) return null;

      const feeUp = effectiveFeeRateStatic(bestAskUp);
      const feeDown = effectiveFeeRateStatic(bestAskDown);
      const totalFees = feeUp + feeDown;
      const slippageBufferBps = s.config["slippageBufferBps"] ?? 0;
      const slippageBuffer = slippageBufferBps / 10_000;

      const netProfit = 1.0 - totalCost - totalFees - slippageBuffer;
      const profitBps = netProfit * 10000;

      if (profitBps < s.config["minProfitBps"]!) return null;

      const signal: Signal = {
        side: "UP",
        confidence: Math.min(1, profitBps / 200),
        size: s.config["tradeSize"]!,
        maxPrice: bestAskUp,
        strategy: "efficiency",
        reason: `Sum=${totalCost.toFixed(4)}, fees=${(totalFees * 10_000).toFixed(1)}bps, buffer=${slippageBufferBps.toFixed(1)}bps, net=${profitBps.toFixed(0)}bps`,
        timestamp: Date.now(),
      };
      yield* Ref.update(ref, (st) => ({ ...st, status: "trading" as const, lastSignal: signal }));
      return signal;
    });

  return { name: "efficiency", evaluate, stateRef: ref, ...base } satisfies Strategy;
});

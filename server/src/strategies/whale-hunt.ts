import { Effect, Ref } from "effect";
import { makeStrategyBase, makeInitialState, type Strategy, type StrategyInternalState } from "./base.js";
import type { MarketContext, Signal } from "../types.js";

const DEFAULT_CONFIG: Record<string, number> = {
  entryWindowSec: 60,
  maxDynamicEntryWindowSec: 120,
  minPriceMovePct: 0.03,
  minEarlyGapPct: 0.12,
  probabilityFloor: 0.78,
  regimeWeight: 0.2,
  liquidityWeight: 0.2,
  spreadPenaltyWeight: 0.3,
  maxSharePrice: 0.995,
  minSharePrice: 0.75,
  tradeSize: 15,
  maxEntriesPerWindow: 2,
};

const DEFAULT_REGIME_FILTER = {
  allowedVolatility: ["low" as const, "normal" as const, "high" as const, "extreme" as const],
  allowedTrend: ["strong_up" as const, "up" as const, "chop" as const, "down" as const, "strong_down" as const],
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export const makeWhaleHuntStrategy = Effect.gen(function* () {
  const ref = yield* Ref.make<StrategyInternalState>(makeInitialState(DEFAULT_CONFIG, DEFAULT_REGIME_FILTER));
  const base = makeStrategyBase("whale-hunt", DEFAULT_CONFIG, DEFAULT_REGIME_FILTER, ref);

  const evaluate = (ctx: MarketContext): Effect.Effect<Signal | null> =>
    Effect.gen(function* () {
      const s = yield* Ref.get(ref);
      if (!ctx.currentWindow || !ctx.priceToBeat) return null;

      const remainingSec = ctx.windowRemainingMs / 1000;
      if (remainingSec < 3) return null;

      yield* Ref.update(ref, (st) => ({ ...st, status: "watching" as const }));

      const priceMove = ((ctx.currentBtcPrice - ctx.priceToBeat) / ctx.priceToBeat) * 100;
      const absMove = Math.abs(priceMove);
      const baseEntryWindowSec = s.config["entryWindowSec"]!;
      const maxDynamicEntryWindowSec = Math.max(baseEntryWindowSec, s.config["maxDynamicEntryWindowSec"]!);
      const minEarlyGapPct = s.config["minEarlyGapPct"]!;
      const probabilityFloor = clamp(s.config["probabilityFloor"]!, 0, 1);
      const regimeWeight = clamp(s.config["regimeWeight"]!, 0, 1);
      const liquidityWeight = clamp(s.config["liquidityWeight"]!, 0, 1);
      const spreadPenaltyWeight = clamp(s.config["spreadPenaltyWeight"]!, 0, 1);

      if (absMove < s.config["minPriceMovePct"]!) return null;

      const side: "UP" | "DOWN" = priceMove > 0 ? "UP" : "DOWN";

      const bestAsk = side === "UP" ? ctx.orderBook.bestAskUp : ctx.orderBook.bestAskDown;
      if (bestAsk === null) return null;
      if (bestAsk > s.config["maxSharePrice"]!) return null;
      if (bestAsk < s.config["minSharePrice"]!) return null;

      const bestBid = side === "UP" ? ctx.orderBook.bestBidUp : ctx.orderBook.bestBidDown;
      const spread = bestBid !== null ? bestAsk - bestBid : 0.05;

      const entryWindowSec = remainingSec <= baseEntryWindowSec
        ? baseEntryWindowSec
        : Math.min(maxDynamicEntryWindowSec, baseEntryWindowSec + (absMove - minEarlyGapPct) * 400);

      const isEarlyEntry = remainingSec > baseEntryWindowSec;
      const usedDynamicWindow = isEarlyEntry;

      if (remainingSec > entryWindowSec && !(isEarlyEntry && absMove >= minEarlyGapPct)) {
        return null;
      }

      const impliedProb = 1 - bestAsk;
      const dynamicFloor = probabilityFloor - regimeWeight * 0.05 - liquidityWeight * 0.05 + spreadPenaltyWeight * spread;
      if (impliedProb < dynamicFloor) return null;

      const confidence = clamp(
        impliedProb * 0.5 + (absMove / 0.1) * 0.3 + (1 - spread / 0.1) * 0.2,
        0,
        1,
      );

      const signal: Signal = {
        side,
        confidence,
        size: s.config["tradeSize"]!,
        maxPrice: bestAsk,
        strategy: "whale-hunt",
        reason: `BTC ${side === "UP" ? "+" : "-"}${absMove.toFixed(3)}%, ask=$${bestAsk.toFixed(3)}, implied=${(impliedProb * 100).toFixed(1)}%, ${remainingSec.toFixed(0)}s left`,
        timestamp: Date.now(),
        telemetry: {
          dynamicWindowSec: entryWindowSec,
          usedDynamicWindow,
          earlyEntry: isEarlyEntry,
          reversalImprobability: impliedProb,
        },
      };
      yield* Ref.update(ref, (st) => ({ ...st, status: "trading" as const, lastSignal: signal }));
      return signal;
    });

  return { name: "whale-hunt", evaluate, stateRef: ref, ...base } satisfies Strategy;
});

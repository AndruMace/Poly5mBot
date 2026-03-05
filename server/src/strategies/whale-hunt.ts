import { Effect, Ref } from "effect";
import { makeStrategyBase, makeInitialState, type Strategy, type StrategyInternalState } from "./base.js";
import type { MarketContext, Signal } from "../types.js";
import { DEFAULT_WHALE_HUNT_CONFIG } from "./whale-hunt-config.js";

const DEFAULT_CONFIG: Record<string, number> = {
  minWindowElapsedSec: 180,
  entryWindowSec: 60,
  maxDynamicEntryWindowSec: 120,
  minPriceMovePct: 0.03,
  minEarlyGapPct: 0.12,
  probabilityFloor: 0.78,
  regimeWeight: 0.2,
  liquidityWeight: 0.2,
  spreadPenaltyWeight: 0.3,
  orderBookBandPct: DEFAULT_WHALE_HUNT_CONFIG.orderBookBandPct,
  maxAdverseImbalance: DEFAULT_WHALE_HUNT_CONFIG.maxAdverseImbalance,
  imbalanceWeight: DEFAULT_WHALE_HUNT_CONFIG.imbalanceWeight,
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

function computeOrderBookImbalance(
  sideBook: { bids: Array<{ price: number; size: number }>; asks: Array<{ price: number; size: number }> },
  bestBid: number | null,
  bestAsk: number | null,
  bandPct: number,
): number | null {
  if (bestBid === null || bestAsk === null) return null;
  const mid = (bestBid + bestAsk) / 2;
  if (!Number.isFinite(mid) || mid <= 0) return null;
  const band = mid * Math.max(0, bandPct);
  const minBidPrice = mid - band;
  const maxAskPrice = mid + band;
  const bidVol = sideBook.bids.reduce(
    (sum, level) => sum + (level.price >= minBidPrice ? Math.max(0, level.size) : 0),
    0,
  );
  const askVol = sideBook.asks.reduce(
    (sum, level) => sum + (level.price <= maxAskPrice ? Math.max(0, level.size) : 0),
    0,
  );
  const total = bidVol + askVol;
  if (total <= 0) return null;
  return (bidVol - askVol) / total;
}

export const makeWhaleHuntStrategy = Effect.gen(function* () {
  const ref = yield* Ref.make<StrategyInternalState>(makeInitialState(DEFAULT_CONFIG, DEFAULT_REGIME_FILTER));
  const base = makeStrategyBase("whale-hunt", DEFAULT_CONFIG, DEFAULT_REGIME_FILTER, ref);

  const evaluate = (ctx: MarketContext): Effect.Effect<Signal | null> =>
    Effect.gen(function* () {
      const s = yield* Ref.get(ref);
      if (!ctx.currentWindow || !ctx.priceToBeat) return null;
      const elapsedSec = ctx.windowElapsedMs / 1000;
      if (elapsedSec < s.config["minWindowElapsedSec"]!) return null;

      const remainingSec = ctx.windowRemainingMs / 1000;
      if (remainingSec < 3) return null;

      yield* Ref.update(ref, (st) => ({ ...st, status: "watching" as const }));

      const priceMove = ((ctx.currentAssetPrice - ctx.priceToBeat) / ctx.priceToBeat) * 100;
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
      const sideBook = side === "UP" ? ctx.orderBook.up : ctx.orderBook.down;
      const orderBookBandPct = clamp(s.config["orderBookBandPct"]!, 0.001, 0.25);
      const maxAdverseImbalance = clamp(s.config["maxAdverseImbalance"]!, 0, 1);
      const imbalanceWeight = clamp(s.config["imbalanceWeight"]!, 0, 1);
      const imbalance = computeOrderBookImbalance(sideBook, bestBid, bestAsk, orderBookBandPct);
      if (imbalance === null) return null;
      if (imbalance < -maxAdverseImbalance) return null;

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
        impliedProb * 0.5 + (absMove / 0.1) * 0.3 + (1 - spread / 0.1) * 0.2 + imbalance * imbalanceWeight,
        0,
        1,
      );

      const signal: Signal = {
        side,
        confidence,
        size: s.config["tradeSize"]!,
        maxPrice: bestAsk,
        strategy: "whale-hunt",
        reason: `BTC ${side === "UP" ? "+" : "-"}${absMove.toFixed(3)}%, ask=$${bestAsk.toFixed(3)}, imbalance=${imbalance.toFixed(2)}, implied=${(impliedProb * 100).toFixed(1)}%, ${remainingSec.toFixed(0)}s left`,
        timestamp: Date.now(),
        telemetry: {
          dynamicWindowSec: entryWindowSec,
          usedDynamicWindow,
          earlyEntry: isEarlyEntry,
          reversalImprobability: impliedProb,
          orderBookImbalance: imbalance,
        },
      };
      yield* Ref.update(ref, (st) => ({ ...st, status: "trading" as const, lastSignal: signal }));
      return signal;
    });

  return { name: "whale-hunt", evaluate, stateRef: ref, ...base } satisfies Strategy;
});

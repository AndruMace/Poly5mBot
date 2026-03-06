import { Effect, Ref } from "effect";
import { makeStrategyBase, makeInitialState, type Strategy, type StrategyInternalState } from "./base.js";
import type { MarketContext, OrderBookSide, Side, Signal } from "../types.js";

export const DEFAULT_CONFIG: Record<string, number> = {
  orderBookBandPct: 0.05,
  minImbalanceRatio: 3.5,
  maxImbalanceRatioForConfidence: 10,
  maxSpreadPct: 0.03,
  minWindowElapsedSec: 180,
  minWindowRemainingSec: 30,
  minPtbDistancePct: 0.03,
  lookbackSec: 10,
  minRatioDelta10s: 0,
  maxRatioDelta10sForConfidence: 3,
  minBookNotional: 200,
  maxSharePrice: 0.9,
  maxExecutionPrice: 0.88,
  tradeSize: 10,
  maxEntriesPerWindow: 1,
  maxSameSideEntriesPerWindow: 1,
  allowSameSideStacking: 0,
  chopConfidenceFloor: 0.6,
  chopSizeMultiplier: 0.75,
  qualityMinMultiplier: 0.5,
  qualityMaxMultiplier: 1.15,
  spreadPenaltyK: 8,
};

export const DEFAULT_REGIME_FILTER = {
  allowedLiquidity: ["deep" as const],
  allowedSpread: ["tight" as const, "normal" as const],
};

interface SidePressure {
  ratio: number;
  spreadPct: number;
  bestAsk: number;
  totalNotional: number;
  signedImbalance: number;
}

interface PressureSnapshot {
  ts: number;
  upRatio: number;
  downRatio: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function computeSidePressure(
  sideBook: OrderBookSide,
  bestBid: number | null,
  bestAsk: number | null,
  bandPct: number,
): SidePressure | null {
  if (bestBid === null || bestAsk === null) return null;
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) return null;
  if (bestAsk < bestBid) return null;

  const mid = (bestBid + bestAsk) / 2;
  if (!Number.isFinite(mid) || mid <= 0) return null;

  const spread = bestAsk - bestBid;
  const spreadPct = spread / mid;

  const band = mid * Math.max(0, bandPct);
  const minBidPrice = mid - band;
  const maxAskPrice = mid + band;

  const bidNotional = sideBook.bids.reduce((sum, level) => {
    if (level.price < minBidPrice) return sum;
    return sum + Math.max(0, level.size) * Math.max(0, level.price);
  }, 0);

  const askNotional = sideBook.asks.reduce((sum, level) => {
    if (level.price > maxAskPrice) return sum;
    return sum + Math.max(0, level.size) * Math.max(0, level.price);
  }, 0);

  const totalNotional = bidNotional + askNotional;
  if (totalNotional <= 0) return null;

  const ratio = bidNotional / Math.max(askNotional, 1e-9);
  const signedImbalance = (bidNotional - askNotional) / totalNotional;
  return { ratio, spreadPct, bestAsk, totalNotional, signedImbalance };
}

export const makeOrderFlowImbalanceStrategy = Effect.gen(function* () {
  const ref = yield* Ref.make<StrategyInternalState>(makeInitialState(DEFAULT_CONFIG, DEFAULT_REGIME_FILTER));
  const pressureHistoryRef = yield* Ref.make<PressureSnapshot[]>([]);
  const base = makeStrategyBase("orderflow-imbalance", DEFAULT_CONFIG, DEFAULT_REGIME_FILTER, ref);

  const evaluate = (ctx: MarketContext): Effect.Effect<Signal | null> =>
    Effect.gen(function* () {
      const s = yield* Ref.get(ref);
      if (!ctx.currentWindow || !ctx.priceToBeat || ctx.priceToBeat <= 0) return null;

      const elapsedSec = ctx.windowElapsedMs / 1000;
      if (elapsedSec < s.config["minWindowElapsedSec"]!) return null;

      const remainingSec = ctx.windowRemainingMs / 1000;
      if (remainingSec <= s.config["minWindowRemainingSec"]!) return null;

      yield* Ref.update(ref, (st) => ({ ...st, status: "watching" as const }));

      const bandPct = clamp(s.config["orderBookBandPct"]!, 0.001, 0.2);
      const minImbalanceRatio = Math.max(1, s.config["minImbalanceRatio"]!);
      const maxImbalanceRatioForConfidence = Math.max(minImbalanceRatio + 0.1, s.config["maxImbalanceRatioForConfidence"]!);
      const maxSpreadPct = clamp(s.config["maxSpreadPct"]!, 0.001, 0.2);
      const lookbackMs = Math.max(1000, s.config["lookbackSec"]! * 1000);
      const minRatioDelta10s = Math.max(0, s.config["minRatioDelta10s"]!);
      const maxRatioDelta10sForConfidence = Math.max(0.1, s.config["maxRatioDelta10sForConfidence"]!);
      const minBookNotional = Math.max(0, s.config["minBookNotional"]!);
      const maxSharePrice = clamp(s.config["maxSharePrice"]!, 0.01, 0.999);
      const minPtbDistancePct = Math.max(0, s.config["minPtbDistancePct"]!);
      const ptbDistancePct = Math.abs((ctx.currentAssetPrice - ctx.priceToBeat) / ctx.priceToBeat) * 100;
      if (ptbDistancePct < minPtbDistancePct) return null;

      const upPressure = computeSidePressure(
        ctx.orderBook.up,
        ctx.orderBook.bestBidUp,
        ctx.orderBook.bestAskUp,
        bandPct,
      );
      const downPressure = computeSidePressure(
        ctx.orderBook.down,
        ctx.orderBook.bestBidDown,
        ctx.orderBook.bestAskDown,
        bandPct,
      );
      if (!upPressure || !downPressure) return null;

      const now = Date.now();
      const nextHistory = yield* Ref.modify(pressureHistoryRef, (history) => {
        const pruned = history.filter((h) => now - h.ts <= lookbackMs);
        const appended = [...pruned, { ts: now, upRatio: upPressure.ratio, downRatio: downPressure.ratio }];
        return [appended, appended] as const;
      });

      const baseline = nextHistory[0]!;
      const upRatioDelta = upPressure.ratio - baseline.upRatio;
      const downRatioDelta = downPressure.ratio - baseline.downRatio;

      const candidates: Array<{ side: Side; pressure: SidePressure; ratioDelta: number }> = [];
      if (
        upPressure.ratio >= minImbalanceRatio
        && upPressure.spreadPct <= maxSpreadPct
        && upPressure.totalNotional >= minBookNotional
        && upPressure.bestAsk <= maxSharePrice
        && upRatioDelta >= minRatioDelta10s
        && ctx.currentAssetPrice > ctx.priceToBeat
      ) {
        candidates.push({ side: "UP", pressure: upPressure, ratioDelta: upRatioDelta });
      }
      if (
        downPressure.ratio >= minImbalanceRatio
        && downPressure.spreadPct <= maxSpreadPct
        && downPressure.totalNotional >= minBookNotional
        && downPressure.bestAsk <= maxSharePrice
        && downRatioDelta >= minRatioDelta10s
        && ctx.currentAssetPrice < ctx.priceToBeat
      ) {
        candidates.push({ side: "DOWN", pressure: downPressure, ratioDelta: downRatioDelta });
      }
      if (candidates.length === 0) return null;

      const selected = candidates.reduce((best, current) => {
        if (current.pressure.ratio > best.pressure.ratio) return current;
        if (current.pressure.ratio < best.pressure.ratio) return best;
        return current.ratioDelta > best.ratioDelta ? current : best;
      });

      const ratioConfidence = clamp(
        (selected.pressure.ratio - minImbalanceRatio) / (maxImbalanceRatioForConfidence - minImbalanceRatio),
        0,
        1,
      );
      const velocityConfidence = clamp(selected.ratioDelta / maxRatioDelta10sForConfidence, 0, 1);
      const confidence = clamp(ratioConfidence * 0.8 + velocityConfidence * 0.2, 0, 1);

      const signal: Signal = {
        side: selected.side,
        confidence,
        size: s.config["tradeSize"]!,
        maxPrice: selected.pressure.bestAsk,
        strategy: "orderflow-imbalance",
        reason: `${selected.side} flow pressure ${selected.pressure.ratio.toFixed(2)}x (spread ${(selected.pressure.spreadPct * 100).toFixed(2)}%, delta10s ${selected.ratioDelta.toFixed(2)}x, PTB dist ${ptbDistancePct.toFixed(3)}%, book $${selected.pressure.totalNotional.toFixed(0)})`,
        timestamp: now,
        telemetry: {
          orderBookImbalance: selected.pressure.signedImbalance,
        },
      };
      yield* Ref.update(ref, (st) => ({ ...st, status: "trading" as const, lastSignal: signal }));
      return signal;
    });

  return { name: "orderflow-imbalance", evaluate, stateRef: ref, ...base } satisfies Strategy;
});

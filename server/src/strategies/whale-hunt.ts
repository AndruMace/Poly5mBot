import { BaseStrategy } from "./base.js";
import type { MarketContext, Signal } from "../types.js";

/**
 * Strategy 3: Whale Hunt (Late Entry Yield)
 *
 * In the final seconds of a 5-min window, if BTC has moved decisively,
 * buy the near-certain winning side at 0.94-0.97 for a 3-6% return.
 */
export class WhaleHuntStrategy extends BaseStrategy {
  readonly name = "whale-hunt";

  constructor() {
    super();
    this.config = {
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
    this.regimeFilter = {
      allowedVolatility: ["low", "normal", "high", "extreme"],
      allowedTrend: ["strong_up", "up", "chop", "down", "strong_down"],
    };
  }

  private clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
  }

  evaluate(ctx: MarketContext): Signal | null {
    if (!ctx.currentWindow || !ctx.priceToBeat) return null;

    const remainingSec = ctx.windowRemainingMs / 1000;
    if (remainingSec < 3) return null;

    this.status = "watching";

    const priceMove =
      ((ctx.currentBtcPrice - ctx.priceToBeat) / ctx.priceToBeat) * 100;
    const absMove = Math.abs(priceMove);
    const baseEntryWindowSec = this.config["entryWindowSec"]!;
    const maxDynamicEntryWindowSec = Math.max(
      baseEntryWindowSec,
      this.config["maxDynamicEntryWindowSec"]!,
    );
    const minEarlyGapPct = this.config["minEarlyGapPct"]!;
    const probabilityFloor = this.clamp(this.config["probabilityFloor"]!, 0, 1);
    const regimeWeight = this.clamp(this.config["regimeWeight"]!, 0, 1);
    const liquidityWeight = this.clamp(this.config["liquidityWeight"]!, 0, 1);
    const spreadPenaltyWeight = this.clamp(
      this.config["spreadPenaltyWeight"]!,
      0,
      1,
    );

    if (absMove < this.config["minPriceMovePct"]!) return null;

    const side: "UP" | "DOWN" = priceMove > 0 ? "UP" : "DOWN";

    const bestAsk =
      side === "UP"
        ? ctx.orderBook.bestAskUp
        : ctx.orderBook.bestAskDown;

    if (bestAsk === null) return null;
    if (bestAsk > this.config["maxSharePrice"]!) return null;
    if (bestAsk < this.config["minSharePrice"]!) return null;

    const bestBid =
      side === "UP"
        ? ctx.orderBook.bestBidUp
        : ctx.orderBook.bestBidDown;
    const spreadCents =
      bestBid !== null && bestAsk > 0
        ? Math.max(0, (bestAsk - bestBid) * 100)
        : 10;
    const spreadScore = this.clamp(1 - spreadCents / 20, 0, 1);

    const askLevels = (side === "UP" ? ctx.orderBook.up.asks : ctx.orderBook.down.asks)
      .slice()
      .sort((a, b) => a.price - b.price)
      .filter((l) => l.price <= bestAsk)
      .slice(0, 3);
    const topDepth = askLevels.reduce((sum, l) => sum + Math.max(0, l.size), 0);
    const liquidityScore = this.clamp(topDepth / 200, 0, 1);

    const priceValues = Object.values(ctx.prices)
      .map((p) => p.price)
      .filter((p) => Number.isFinite(p) && p > 0);
    const consensusTotal = priceValues.length;
    const consensusAgree =
      consensusTotal > 0
        ? priceValues.filter((p) =>
            side === "UP" ? p >= ctx.priceToBeat! : p <= ctx.priceToBeat!,
          ).length
        : 0;
    const consensusRatio =
      consensusTotal > 0 ? consensusAgree / consensusTotal : 0.5;

    const moveScore = this.clamp((absMove - minEarlyGapPct) / 0.25, 0, 1);
    const combinedScore = this.clamp(
      0.45 * moveScore +
        regimeWeight * consensusRatio +
        liquidityWeight * liquidityScore +
        0.2 * spreadScore -
        spreadPenaltyWeight * (1 - spreadScore),
      0,
      1,
    );
    const dynamicEntryWindowSec =
      baseEntryWindowSec +
      (maxDynamicEntryWindowSec - baseEntryWindowSec) * combinedScore;

    if (remainingSec > dynamicEntryWindowSec) {
      this.status = "idle";
      this.statusReason = "whale:early_entry_rejected outside_dynamic_window";
      return null;
    }

    const usingEarlyWindow = remainingSec > baseEntryWindowSec;
    if (usingEarlyWindow && absMove < minEarlyGapPct) {
      this.status = "idle";
      this.statusReason = "whale:early_entry_rejected gap_below_threshold";
      return null;
    }

    const mean =
      priceValues.length > 0
        ? priceValues.reduce((s, v) => s + v, 0) / priceValues.length
        : ctx.currentBtcPrice;
    const variance =
      priceValues.length > 1
        ? priceValues.reduce((s, v) => s + (v - mean) ** 2, 0) / priceValues.length
        : 0;
    const dispersionPct = mean > 0 ? Math.sqrt(variance) / mean : 0;
    const sigmaPct = Math.max(0.02, dispersionPct * 100);
    const horizonScale = Math.sqrt(Math.max(remainingSec, 1) / 60);
    const z = absMove / Math.max(0.0001, sigmaPct * horizonScale);
    const reversalProbability = Math.exp(-0.5 * z * z);
    const reversalImprobability = this.clamp(1 - reversalProbability, 0, 1);

    if (reversalImprobability < probabilityFloor) {
      this.status = "idle";
      this.statusReason = `whale:probability_rejected ${reversalImprobability.toFixed(3)}<${probabilityFloor.toFixed(3)}`;
      return null;
    }

    const expectedReturn = ((1.0 - bestAsk) / bestAsk) * 100;

    this.status = "trading";
    this.statusReason = null;
    const signal: Signal = {
      side,
      confidence: this.clamp(
        0.5 * this.clamp(absMove / 0.3, 0, 1) +
          0.3 * reversalImprobability +
          0.2 * consensusRatio,
        0,
        1,
      ),
      size: this.config["tradeSize"]!,
      maxPrice: bestAsk,
      strategy: this.name,
      reason: `BTC ${priceMove > 0 ? "up" : "down"} ${absMove.toFixed(3)}%, ${remainingSec.toFixed(0)}s left, dynWin=${dynamicEntryWindowSec.toFixed(0)}s, revImprob=${reversalImprobability.toFixed(2)}, ${expectedReturn.toFixed(1)}% return`,
      timestamp: Date.now(),
      telemetry: {
        dynamicWindowSec: dynamicEntryWindowSec,
        usedDynamicWindow: dynamicEntryWindowSec > baseEntryWindowSec + 1,
        earlyEntry: usingEarlyWindow,
        reversalImprobability,
      },
    };
    this.lastSignal = signal;
    return signal;
  }
}

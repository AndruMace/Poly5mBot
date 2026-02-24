import { calculateFee } from "../polymarket/orders.js";
import type { OrderBookSide } from "../types.js";

export interface SimulatedFill {
  filled: boolean;
  filledShares: number;
  avgPrice: number;
  fee: number;
  levels: Array<{ price: number; shares: number }>;
  reason?: string;
}

export interface SimulatorOpts {
  slippageBps?: number;
  fillProbability?: number;
  minLiquidityPct?: number;
}

const DEFAULT_OPTS: Required<SimulatorOpts> = {
  slippageBps: 5,
  fillProbability: 0.7,
  minLiquidityPct: 0.1,
};

export class FillSimulator {
  simulate(
    _side: "BUY" | "SELL",
    _tokenId: string,
    requestedShares: number,
    limitPrice: number,
    orderBook: OrderBookSide,
    opts?: SimulatorOpts,
  ): SimulatedFill {
    const o = { ...DEFAULT_OPTS, ...opts };

    const levels = _side === "BUY"
      ? [...orderBook.asks].sort((a, b) => a.price - b.price)
      : [...orderBook.bids].sort((a, b) => b.price - a.price);

    if (levels.length === 0) {
      return {
        filled: false,
        filledShares: 0,
        avgPrice: 0,
        fee: 0,
        levels: [],
        reason: "no_liquidity",
      };
    }

    const totalAvailable = levels
      .filter((l) =>
        _side === "BUY" ? l.price <= limitPrice : l.price >= limitPrice,
      )
      .reduce((s, l) => s + l.size, 0);

    if (totalAvailable < requestedShares * o.minLiquidityPct) {
      return {
        filled: false,
        filledShares: 0,
        avgPrice: 0,
        fee: 0,
        levels: [],
        reason: "insufficient_liquidity",
      };
    }

    if (Math.random() > o.fillProbability) {
      return {
        filled: false,
        filledShares: 0,
        avgPrice: 0,
        fee: 0,
        levels: [],
        reason: "queue_position_miss",
      };
    }

    let remaining = requestedShares;
    let totalCost = 0;
    let totalFee = 0;
    const filledLevels: Array<{ price: number; shares: number }> = [];

    for (const level of levels) {
      if (remaining <= 0) break;

      const priceOk =
        _side === "BUY"
          ? level.price <= limitPrice
          : level.price >= limitPrice;
      if (!priceOk) break;

      const slippageAdj = level.price * (1 + o.slippageBps / 10_000);
      const effectivePrice = _side === "BUY"
        ? Math.min(slippageAdj, limitPrice)
        : Math.max(level.price * (1 - o.slippageBps / 10_000), limitPrice);

      const fillAtLevel = Math.min(remaining, level.size);
      totalCost += effectivePrice * fillAtLevel;
      totalFee += calculateFee(fillAtLevel, effectivePrice);
      filledLevels.push({ price: effectivePrice, shares: fillAtLevel });
      remaining -= fillAtLevel;
    }

    const filledShares = requestedShares - remaining;
    if (filledShares <= 0) {
      return {
        filled: false,
        filledShares: 0,
        avgPrice: 0,
        fee: 0,
        levels: [],
        reason: "price_exceeded",
      };
    }

    return {
      filled: true,
      filledShares,
      avgPrice: totalCost / filledShares,
      fee: totalFee,
      levels: filledLevels,
      reason:
        filledShares < requestedShares ? "partial_fill" : undefined,
    };
  }
}

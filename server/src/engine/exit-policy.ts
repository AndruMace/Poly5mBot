import type { MarketContext, OrderBookSide, Side, TradeRecord } from "../types.js";
import { effectiveFeeRateStatic } from "../polymarket/orders.js";

// ── Types ──

export interface ExitPolicy {
  enabled: boolean;
  maxHoldMs: number;
  maxAdverseMovePct: number;
  minExitEdgeBps: number;
  spreadDecayExitFactor?: number;
  minMaintainImbalanceRatio?: number;
}

export type ExitTrigger = "time_stop" | "adverse_move" | "thesis_invalidation";

export interface ExitSignal {
  tradeId: string;
  tokenId: string;
  side: Side;
  strategy: string;
  shares: number;
  bestBid: number;
  trigger: ExitTrigger;
  reason: string;
}

export interface OpenPosition {
  tradeId: string;
  strategy: string;
  side: Side;
  tokenId: string;
  entryPrice: number;
  entryAssetPrice: number;
  shares: number;
  timestamp: number;
  entryArbAbsSpreadPct?: number;
}

// ── Default Configs ──

export const DEFAULT_EXIT_POLICIES: Record<string, ExitPolicy> = {
  arb: {
    enabled: true,
    maxHoldMs: 30_000,
    maxAdverseMovePct: 0.6,
    minExitEdgeBps: 5,
    spreadDecayExitFactor: 0.4,
  },
  "orderflow-imbalance": {
    enabled: true,
    maxHoldMs: 20_000,
    maxAdverseMovePct: 0.5,
    minExitEdgeBps: 5,
    minMaintainImbalanceRatio: 1.3,
  },
  momentum: {
    enabled: true,
    maxHoldMs: 45_000,
    maxAdverseMovePct: 0.7,
    minExitEdgeBps: 5,
  },
};

const SKIP_EXIT_STRATEGIES = new Set(["whale-hunt", "efficiency", "efficiency-flatten"]);

// ── Exit Evaluation ──

function computeSidePressure(
  sideBook: OrderBookSide,
  bestBid: number | null,
  bestAsk: number | null,
  bandPct: number,
): { ratio: number } | null {
  if (bestBid === null || bestAsk === null) return null;
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) return null;
  if (bestAsk < bestBid) return null;
  const mid = (bestBid + bestAsk) / 2;
  if (!Number.isFinite(mid) || mid <= 0) return null;
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
  if (bidNotional + askNotional <= 0) return null;
  return { ratio: bidNotional / Math.max(askNotional, 1e-9) };
}

function getBestBid(ctx: MarketContext, side: Side): number | null {
  const raw = side === "UP" ? ctx.orderBook.bestBidUp : ctx.orderBook.bestBidDown;
  return raw !== null && Number.isFinite(raw) && raw > 0 ? raw : null;
}

function crossExchangeAbsSpread(ctx: MarketContext): number | null {
  const binance = ctx.prices["binance"];
  if (!binance) return null;
  const refExchanges = ["bybit", "coinbase", "kraken", "okx", "bitstamp"] as const;
  const refPrices: number[] = [];
  const now = Date.now();
  for (const name of refExchanges) {
    const feed = ctx.prices[name];
    if (!feed || now - feed.timestamp > 5000) continue;
    const p = priceOf(feed);
    if (Number.isFinite(p) && p > 0) refPrices.push(p);
  }
  if (refPrices.length < 2) return null;
  refPrices.sort((a, b) => a - b);
  const mid = refPrices.length % 2 === 0
    ? (refPrices[refPrices.length / 2 - 1]! + refPrices[refPrices.length / 2]!) / 2
    : refPrices[Math.floor(refPrices.length / 2)]!;
  return Math.abs((priceOf(binance) - mid) / mid) * 100;
}

function priceOf(point: { price: number; bid?: number; ask?: number }): number {
  const bid = Number(point.bid);
  const ask = Number(point.ask);
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
    return (bid + ask) / 2;
  }
  return Number(point.price);
}

function passesExitCostGuard(
  entryPrice: number,
  bestBid: number,
  minExitEdgeBps: number,
): boolean {
  const exitFee = effectiveFeeRateStatic(bestBid);
  const exitCost = (entryPrice - bestBid) + exitFee;
  const holdRisk = entryPrice;
  const edgeBps = ((holdRisk - exitCost) / entryPrice) * 10_000;
  return edgeBps >= minExitEdgeBps;
}

export function evaluateExits(
  positions: OpenPosition[],
  ctx: MarketContext,
  policies: Record<string, ExitPolicy>,
  now: number,
): ExitSignal[] {
  const exits: ExitSignal[] = [];

  for (const pos of positions) {
    if (SKIP_EXIT_STRATEGIES.has(pos.strategy)) continue;
    const policy = policies[pos.strategy];
    if (!policy?.enabled) continue;

    const bestBid = getBestBid(ctx, pos.side);
    if (bestBid === null) continue;

    // Time stop
    if (policy.maxHoldMs > 0 && now - pos.timestamp >= policy.maxHoldMs) {
      if (passesExitCostGuard(pos.entryPrice, bestBid, policy.minExitEdgeBps)) {
        exits.push({
          tradeId: pos.tradeId,
          tokenId: pos.tokenId,
          side: pos.side,
          strategy: pos.strategy,
          shares: pos.shares,
          bestBid,
          trigger: "time_stop",
          reason: `Held ${Math.round((now - pos.timestamp) / 1000)}s > max ${Math.round(policy.maxHoldMs / 1000)}s`,
        });
        continue;
      }
    }

    // Adverse move (measured against underlying BTC price)
    if (policy.maxAdverseMovePct > 0 && ctx.currentAssetPrice > 0 && pos.entryAssetPrice > 0) {
      const movePct = ((ctx.currentAssetPrice - pos.entryAssetPrice) / pos.entryAssetPrice) * 100;
      const adverse = pos.side === "UP" ? -movePct : movePct;
      if (adverse >= policy.maxAdverseMovePct) {
        if (passesExitCostGuard(pos.entryPrice, bestBid, policy.minExitEdgeBps)) {
          exits.push({
            tradeId: pos.tradeId,
            tokenId: pos.tokenId,
            side: pos.side,
            strategy: pos.strategy,
            shares: pos.shares,
            bestBid,
            trigger: "adverse_move",
            reason: `BTC moved ${adverse.toFixed(3)}% against ${pos.side} (limit ${policy.maxAdverseMovePct}%)`,
          });
          continue;
        }
      }
    }

    // Thesis invalidation — arb: cross-exchange spread decayed
    if (
      pos.strategy === "arb"
      && policy.spreadDecayExitFactor !== undefined
      && pos.entryArbAbsSpreadPct !== undefined
      && pos.entryArbAbsSpreadPct > 0
    ) {
      const currentSpread = crossExchangeAbsSpread(ctx);
      if (currentSpread !== null) {
        const threshold = pos.entryArbAbsSpreadPct * policy.spreadDecayExitFactor;
        if (currentSpread < threshold) {
          if (passesExitCostGuard(pos.entryPrice, bestBid, policy.minExitEdgeBps)) {
            exits.push({
              tradeId: pos.tradeId,
              tokenId: pos.tokenId,
              side: pos.side,
              strategy: pos.strategy,
              shares: pos.shares,
              bestBid,
              trigger: "thesis_invalidation",
              reason: `Arb spread decayed to ${currentSpread.toFixed(3)}% < ${threshold.toFixed(3)}% (${(policy.spreadDecayExitFactor * 100).toFixed(0)}% of entry ${pos.entryArbAbsSpreadPct.toFixed(3)}%)`,
            });
            continue;
          }
        }
      }
    }

    // Thesis invalidation — OFI: imbalance ratio collapsed
    if (
      pos.strategy === "orderflow-imbalance"
      && policy.minMaintainImbalanceRatio !== undefined
    ) {
      const sideBook = pos.side === "UP" ? ctx.orderBook.up : ctx.orderBook.down;
      const sideBestBid = pos.side === "UP" ? ctx.orderBook.bestBidUp : ctx.orderBook.bestBidDown;
      const sideBestAsk = pos.side === "UP" ? ctx.orderBook.bestAskUp : ctx.orderBook.bestAskDown;
      const pressure = computeSidePressure(sideBook, sideBestBid, sideBestAsk, 0.05);
      if (pressure !== null && pressure.ratio < policy.minMaintainImbalanceRatio) {
        if (passesExitCostGuard(pos.entryPrice, bestBid, policy.minExitEdgeBps)) {
          exits.push({
            tradeId: pos.tradeId,
            tokenId: pos.tokenId,
            side: pos.side,
            strategy: pos.strategy,
            shares: pos.shares,
            bestBid,
            trigger: "thesis_invalidation",
            reason: `OFI pressure collapsed to ${pressure.ratio.toFixed(2)}x < maintenance ${policy.minMaintainImbalanceRatio}x`,
          });
          continue;
        }
      }
    }
  }

  return exits;
}

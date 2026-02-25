import type { OrderBookSide } from "../types.js";

export const MIN_CLOB_NOTIONAL = 1.0;

export type ShadowPreflightResult =
  | { allowed: true; requestedShares: number; visibleShares: number }
  | {
      allowed: false;
      reason:
        | "below_min_notional"
        | "invalid_limit_price"
        | "no_visible_liquidity_at_limit";
      requestedShares: number;
      visibleShares: number;
    };

export function preflightShadowBuy(
  notional: number,
  limitPrice: number,
  orderBook: OrderBookSide,
): ShadowPreflightResult {
  if (notional < MIN_CLOB_NOTIONAL) {
    return {
      allowed: false,
      reason: "below_min_notional",
      requestedShares: 0,
      visibleShares: 0,
    };
  }

  if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
    return {
      allowed: false,
      reason: "invalid_limit_price",
      requestedShares: 0,
      visibleShares: 0,
    };
  }

  const requestedShares = notional / limitPrice;
  const visibleShares = orderBook.asks
    .filter((lvl) => lvl.price <= limitPrice && lvl.size > 0)
    .reduce((sum, lvl) => sum + lvl.size, 0);

  if (visibleShares <= 0) {
    return {
      allowed: false,
      reason: "no_visible_liquidity_at_limit",
      requestedShares,
      visibleShares: 0,
    };
  }

  return { allowed: true, requestedShares, visibleShares };
}

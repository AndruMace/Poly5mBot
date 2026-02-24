import { getPolymarketClient } from "./client.js";
import type { Signal, TradeRecord } from "../types.js";

const FEE_RATE = 0.25;
const FEE_EXPONENT = 2;
const FOK_SIZE_SCALES = [1, 0.8, 0.6, 0.45];

function floorTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.floor(value * factor + Number.EPSILON) / factor;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x === 0 ? 1 : x;
}

/**
 * CLOB BUY precision requirements:
 * - maker amount (quote) max 2 decimals
 * - taker amount (size/shares) max 4 decimals
 *
 * This helper computes a price/size pair that satisfies both constraints.
 */
function quantizeBuyOrder(notional: number, rawPrice: number): {
  price: number;
  shares: number;
  quote: number;
} {
  const price = floorTo(rawPrice, 2);
  const maxQuote = floorTo(notional, 2);
  if (price <= 0 || maxQuote <= 0) {
    return { price: 0, shares: 0, quote: 0 };
  }

  const priceCents = Math.round(price * 100);
  if (priceCents <= 0) {
    return { price: 0, shares: 0, quote: 0 };
  }

  // shares are represented with up to 4 decimals
  // shareUnits = shares * 10_000 (integer)
  // quoteCents = (shareUnits * priceCents) / 10_000 must be integer
  const d = gcd(10_000, priceCents);
  const minShareUnitStep = Math.floor(10_000 / d);
  const quoteCentsPerStep = Math.floor(priceCents / d);
  const maxQuoteCents = Math.floor(maxQuote * 100);
  const stepCount = Math.floor(maxQuoteCents / quoteCentsPerStep);
  const shareUnits = stepCount * minShareUnitStep;
  const shares = floorTo(shareUnits / 10_000, 4);
  const quote = floorTo((shareUnits * priceCents) / 1_000_000, 2);
  return { price, shares, quote };
}

function extractOrderError(err: unknown): string {
  if (!err || typeof err !== "object") return "unknown error";
  const e = err as any;
  const data = e?.response?.data;
  if (typeof data?.error === "string" && data.error.trim().length > 0) {
    return data.error;
  }
  if (typeof e?.message === "string" && e.message.trim().length > 0) {
    return e.message;
  }
  return "unknown error";
}

function isFokLiquidityReject(reason: string | null | undefined): boolean {
  if (!reason) return false;
  const r = reason.toLowerCase();
  return (
    r.includes("couldn't be fully filled") ||
    r.includes("fully filled or killed")
  );
}

export function calculateFee(shares: number, price: number): number {
  return shares * FEE_RATE * Math.pow(price * (1 - price), FEE_EXPONENT);
}

export function effectiveFeeRate(price: number): number {
  return FEE_RATE * Math.pow(price * (1 - price), FEE_EXPONENT);
}

let tradeCounter = 0;

function inspectPostedOrder(order: unknown): {
  accepted: boolean;
  orderId: string | null;
  status: string | null;
  reason: string | null;
} {
  if (!order || typeof order !== "object") {
    return {
      accepted: false,
      orderId: null,
      status: null,
      reason: "Empty order response",
    };
  }

  const data = order as Record<string, unknown>;
  const orderIdRaw = data["orderID"] ?? data["orderId"] ?? data["id"];
  const orderId =
    typeof orderIdRaw === "string" && orderIdRaw.trim().length > 0
      ? orderIdRaw
      : null;

  const statusRaw = data["status"] ?? data["state"];
  const status =
    typeof statusRaw === "string" ? statusRaw.toLowerCase() : undefined;
  const errorRaw = data["error"] ?? data["errorMsg"] ?? data["message"] ?? data["reason"];
  const errorMsg =
    typeof errorRaw === "string" && errorRaw.trim().length > 0
      ? errorRaw
      : null;
  const success = data["success"] === true || data["ok"] === true;

  const rejectedByStatus =
    status === "rejected" ||
    status === "cancelled" ||
    status === "canceled" ||
    status === "failed";

  if (errorMsg || rejectedByStatus) {
    return {
      accepted: false,
      orderId,
      status: status ?? null,
      reason: errorMsg ?? `Order status: ${status}`,
    };
  }

  const acceptedByStatus =
    status === "filled" ||
    status === "matched" ||
    status === "live" ||
    status === "accepted";

  const accepted = success || acceptedByStatus || orderId !== null;
  return {
    accepted,
    orderId,
    status: status ?? null,
    reason: accepted ? null : "Order was not accepted by CLOB",
  };
}

export async function executeSignal(
  signal: Signal,
  upTokenId: string,
  downTokenId: string,
  windowEnd: number,
  conditionId: string,
  priceToBeatAtEntry: number,
): Promise<TradeRecord | null> {
  try {
    const client = await getPolymarketClient();
    const tokenId = signal.side === "UP" ? upTokenId : downTokenId;
    let lastReason: string | null = null;

    for (const scale of FOK_SIZE_SCALES) {
      const q = quantizeBuyOrder(signal.size * scale, signal.maxPrice);
      const notional = q.quote;
      const price = q.price;
      const shares = q.shares;
      if (price <= 0 || shares <= 0 || notional <= 0) continue;

      try {
        const rawOrder = await (client as any).createAndPostOrder(
          {
            tokenID: tokenId,
            price,
            side: "BUY",
            size: shares,
          },
          { tickSize: "0.01", negRisk: false },
          "FOK",
        );
        const parsed = inspectPostedOrder(rawOrder);
        if (!parsed.accepted) {
          lastReason = parsed.reason ?? "Order was not accepted by CLOB";
          if (isFokLiquidityReject(lastReason)) {
            continue;
          }
          console.warn(
            `[Orders] Live order rejected/unconfirmed for ${signal.strategy} ${signal.side}: ${lastReason}`,
          );
          return null;
        }

        const fee = calculateFee(shares, price);
        const record: TradeRecord = {
          id: `trade-${++tradeCounter}-${Date.now()}`,
          strategy: signal.strategy,
          side: signal.side,
          tokenId,
          entryPrice: price,
          size: notional,
          shares,
          fee,
          status: "filled",
          outcome: null,
          pnl: -fee,
          timestamp: Date.now(),
          windowEnd,
          conditionId,
          priceToBeatAtEntry,
          clobOrderId: parsed.orderId ?? undefined,
          clobResult: parsed.status ?? "accepted",
          clobReason: parsed.reason ?? undefined,
        };

        console.log(
          `[Orders] Executed ${signal.strategy} ${signal.side} @ $${price} for $${notional} (${shares} shares, fee: $${fee.toFixed(4)}) [scale=${scale}]`,
        );
        return record;
      } catch (err) {
        const reason = extractOrderError(err);
        lastReason = reason;
        if (isFokLiquidityReject(reason)) {
          continue;
        }
        console.warn(
          `[Orders] Live order rejected/unconfirmed for ${signal.strategy} ${signal.side}: ${reason}`,
        );
        return null;
      }
    }

    console.warn(
      `[Orders] Live order rejected/unconfirmed for ${signal.strategy} ${signal.side}: ${lastReason ?? "order couldn't be fully filled. FOK orders are fully filled or killed."}`,
    );
    return null;
  } catch (err) {
    console.error("[Orders] Failed to execute signal:", err);
    return null;
  }
}

export async function executeDualBuy(
  upTokenId: string,
  downTokenId: string,
  upPrice: number,
  downPrice: number,
  size: number,
  windowEnd: number,
  conditionId: string,
  priceToBeatAtEntry: number,
): Promise<TradeRecord[]> {
  const trades: TradeRecord[] = [];

  const legs: Array<["UP" | "DOWN", string, number]> = [
    ["UP", upTokenId, upPrice],
    ["DOWN", downTokenId, downPrice],
  ];

  for (const [side, tokenId, price] of legs) {
    try {
      const client = await getPolymarketClient();
      const q = quantizeBuyOrder(size / 2, price);
      const halfNotional = q.quote;
      const shares = q.shares;
      const px = q.price;
      if (px <= 0 || shares <= 0 || halfNotional <= 0) {
        throw new Error(
          `Invalid quantized ${side} leg: size=${size / 2}, price=${price}`,
        );
      }

      const rawOrder = await (client as any).createAndPostOrder(
        {
          tokenID: tokenId,
          price: px,
          side: "BUY",
          size: shares,
        },
        { tickSize: "0.01", negRisk: false },
        "FOK",
      );
      const parsed = inspectPostedOrder(rawOrder);
      if (!parsed.accepted) {
        throw new Error(
          parsed.reason ?? `Unconfirmed ${side} efficiency leg order`,
        );
      }

      const fee = calculateFee(shares, px);

      trades.push({
        id: `trade-${++tradeCounter}-${Date.now()}`,
        strategy: "efficiency",
        side,
        tokenId,
        entryPrice: px,
        size: halfNotional,
        shares,
        fee,
        status: "filled",
        outcome: null,
        pnl: -fee,
        timestamp: Date.now(),
        windowEnd,
        conditionId,
        priceToBeatAtEntry,
        clobOrderId: parsed.orderId ?? undefined,
        clobResult: parsed.status ?? "accepted",
        clobReason: parsed.reason ?? undefined,
      });
    } catch (err) {
      console.error(`[Orders] Failed dual buy ${side}:`, err);
      if (trades.length === 1) {
        console.error(
          `[Orders] CRITICAL: Efficiency leg 2 failed — single-leg directional exposure on ${trades[0]!.side}`,
        );
        trades[0]!.strategy = "efficiency-partial";
      }
      break;
    }
  }

  return trades;
}

export async function getOrderBook(tokenId: string) {
  try {
    const client = await getPolymarketClient();
    const book = await (client as any).getOrderBook(tokenId);
    return book;
  } catch (err: any) {
    console.error(`[Orders] getOrderBook failed for ${tokenId.slice(0, 12)}...: ${err.message ?? err}`);
    return null;
  }
}

export async function getMidpoint(tokenId: string): Promise<number | null> {
  try {
    const client = await getPolymarketClient();
    const mid = await (client as any).getMidpoint(tokenId);
    return typeof mid === "number" ? mid : parseFloat(mid);
  } catch {
    return null;
  }
}

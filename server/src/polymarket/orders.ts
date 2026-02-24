import { getPolymarketClient } from "./client.js";
import type { Signal, TradeRecord } from "../types.js";

const FEE_RATE = 0.25;
const FEE_EXPONENT = 2;

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
    const notional = signal.size;
    const price = signal.maxPrice;
    const shares = Math.floor((notional / price) * 100) / 100;

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
      console.warn(
        `[Orders] Live order rejected/unconfirmed for ${signal.strategy} ${signal.side}: ${parsed.reason ?? "unknown reason"}`,
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
      `[Orders] Executed ${signal.strategy} ${signal.side} @ $${price} for $${notional} (${shares} shares, fee: $${fee.toFixed(4)})`,
    );
    return record;
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
      const halfNotional = size / 2;
      const shares = Math.floor((halfNotional / price) * 100) / 100;

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
        throw new Error(
          parsed.reason ?? `Unconfirmed ${side} efficiency leg order`,
        );
      }

      const fee = calculateFee(shares, price);

      trades.push({
        id: `trade-${++tradeCounter}-${Date.now()}`,
        strategy: "efficiency",
        side,
        tokenId,
        entryPrice: price,
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

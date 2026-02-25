import { Effect } from "effect";
import { PolymarketClient } from "./client.js";
import { OrderError } from "../errors.js";
import type { Signal, TradeRecord, TradeStatus } from "../types.js";

const FEE_RATE = 0.25;
const FEE_EXPONENT = 2;
const FOK_SIZE_SCALES = [1, 0.8, 0.6, 0.45];
const MIN_CLOB_NOTIONAL = 1.0;

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

function quantizeBuyOrder(notional: number, rawPrice: number) {
  const price = floorTo(rawPrice, 2);
  const maxQuote = floorTo(notional, 2);
  if (price <= 0 || maxQuote <= 0) return { price: 0, shares: 0, quote: 0 };

  const priceCents = Math.round(price * 100);
  if (priceCents <= 0) return { price: 0, shares: 0, quote: 0 };

  const d = gcd(10_000, priceCents);
  const minShareUnitStep = Math.floor(10_000 / d);
  const quoteCentsPerStep = Math.floor(priceCents / d);
  const maxQuoteCents = Math.floor(maxQuote * 100);
  const stepCount = Math.floor(maxQuoteCents / quoteCentsPerStep);
  const shareUnits = stepCount * minShareUnitStep;
  let shares = floorTo(shareUnits / 10_000, 4);
  let quote = floorTo((shareUnits * priceCents) / 1_000_000, 2);

  const shares2d = floorTo(shares, 2);
  const rawQuote2d = shares2d * price;
  const quoteCents2d = Math.round(rawQuote2d * 100);
  if (Math.abs(rawQuote2d - quoteCents2d / 100) > 1e-9) {
    const d2 = gcd(100, priceCents);
    const step2 = Math.floor(100 / d2);
    const qps2 = Math.floor(priceCents / d2);
    const sc2 = Math.floor(maxQuoteCents / qps2);
    const su2 = sc2 * step2;
    shares = floorTo(su2 / 100, 2);
    quote = floorTo((su2 * priceCents) / 10_000, 2);
  }

  return { price, shares, quote };
}

function extractOrderError(err: unknown): string {
  if (!err || typeof err !== "object") return "unknown error";
  const e = err as any;
  const data = e?.response?.data;
  if (typeof data?.error === "string" && data.error.trim().length > 0) return data.error;
  if (typeof e?.message === "string" && e.message.trim().length > 0) return e.message;
  return "unknown error";
}

function isFokLiquidityReject(reason: string | null | undefined): boolean {
  if (!reason) return false;
  const r = reason.toLowerCase();
  return r.includes("couldn't be fully filled") || r.includes("fully filled or killed");
}

export function calculateFee(shares: number, price: number): number {
  return shares * FEE_RATE * Math.pow(price * (1 - price), FEE_EXPONENT);
}

export function effectiveFeeRate(price: number): number {
  return FEE_RATE * Math.pow(price * (1 - price), FEE_EXPONENT);
}

function mapClobStatusToTradeStatus(status: string | null | undefined): TradeStatus {
  const normalized = (status ?? "").toLowerCase();
  if (normalized === "filled" || normalized === "matched") return "filled";
  if (normalized === "partial" || normalized === "partially_filled") return "partial";
  if (normalized === "rejected" || normalized === "failed") return "rejected";
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  if (normalized === "accepted" || normalized === "live" || normalized === "open") return "submitted";
  return "submitted";
}

function inspectPostedOrder(order: unknown) {
  if (!order || typeof order !== "object") {
    return {
      accepted: false,
      orderId: null as string | null,
      status: null as string | null,
      mappedStatus: "rejected" as TradeStatus,
      reason: "Empty order response" as string | null,
    };
  }
  const data = order as Record<string, unknown>;
  const orderIdRaw = data["orderID"] ?? data["orderId"] ?? data["id"];
  const orderId = typeof orderIdRaw === "string" && orderIdRaw.trim().length > 0 ? orderIdRaw : null;
  const statusRaw = data["status"] ?? data["state"];
  const status = typeof statusRaw === "string" ? statusRaw.toLowerCase() : undefined;
  const errorRaw = data["error"] ?? data["errorMsg"] ?? data["message"] ?? data["reason"];
  const errorMsg = typeof errorRaw === "string" && errorRaw.trim().length > 0 ? errorRaw : null;
  const success = data["success"] === true || data["ok"] === true;
  const rejectedByStatus = status === "rejected" || status === "cancelled" || status === "canceled" || status === "failed";

  const mappedStatus = mapClobStatusToTradeStatus(status ?? null);

  if (errorMsg || rejectedByStatus) {
    return {
      accepted: false,
      orderId,
      status: status ?? null,
      mappedStatus,
      reason: errorMsg ?? `Order status: ${status}`,
    };
  }

  const acceptedByStatus = status === "filled" || status === "matched" || status === "live" || status === "accepted";
  const accepted = success || acceptedByStatus || orderId !== null;
  return {
    accepted,
    orderId,
    status: status ?? null,
    mappedStatus,
    reason: accepted ? null : "Order was not accepted by CLOB",
  };
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizeOrderStatus(order: unknown): {
  mappedStatus: TradeStatus | null;
  rawStatus: string | null;
  avgPrice: number | null;
  filledShares: number | null;
  reason: string | null;
} {
  if (!order || typeof order !== "object") {
    return { mappedStatus: null, rawStatus: null, avgPrice: null, filledShares: null, reason: null };
  }
  const data = order as Record<string, unknown>;
  const statusRaw = data["status"] ?? data["state"];
  const rawStatus = typeof statusRaw === "string" ? statusRaw.toLowerCase() : null;
  const mappedStatus = rawStatus ? mapClobStatusToTradeStatus(rawStatus) : null;
  const avgPrice =
    toNumber(data["avgPrice"]) ??
    toNumber(data["averagePrice"]) ??
    toNumber(data["price"]);
  const filledShares =
    toNumber(data["sizeMatched"]) ??
    toNumber(data["filledSize"]) ??
    toNumber(data["sizeFilled"]) ??
    toNumber(data["matchedSize"]);
  const reasonRaw = data["reason"] ?? data["error"] ?? data["message"];
  const reason = typeof reasonRaw === "string" && reasonRaw.trim().length > 0 ? reasonRaw : null;
  return { mappedStatus, rawStatus, avgPrice, filledShares, reason };
}

let tradeCounter = 0;

export class OrderService extends Effect.Service<OrderService>()("OrderService", {
  effect: Effect.gen(function* () {
    const polyClient = yield* PolymarketClient;

    const executeSignal = (
      signal: Signal,
      upTokenId: string,
      downTokenId: string,
      windowEnd: number,
      conditionId: string,
      priceToBeatAtEntry: number,
    ) =>
      Effect.gen(function* () {
        const client = yield* polyClient.getClient;
        const tokenId = signal.side === "UP" ? upTokenId : downTokenId;
        let lastReason: string | null = null;

        for (const scale of FOK_SIZE_SCALES) {
          const q = quantizeBuyOrder(signal.size * scale, signal.maxPrice);
          const notional = q.quote;
          const price = q.price;
          const shares = q.shares;
          if (price <= 0 || shares <= 0 || notional <= 0) continue;
          if (notional < MIN_CLOB_NOTIONAL) continue;

          const result = yield* Effect.tryPromise({
            try: () =>
              (client as any).createAndPostOrder(
                { tokenID: tokenId, price, side: "BUY", size: shares },
                { tickSize: "0.01", negRisk: false },
                "FOK",
              ) as Promise<unknown>,
            catch: (err) => extractOrderError(err),
          }).pipe(Effect.either);

          if (result._tag === "Left") {
            const reason = result.left;
            lastReason = reason;
            if (isFokLiquidityReject(reason)) continue;
            const record: TradeRecord = {
              id: `trade-${++tradeCounter}-${Date.now()}`,
              strategy: signal.strategy,
              side: signal.side,
              tokenId,
              entryPrice: price,
              size: notional,
              shares,
              fee: 0,
              status: "rejected",
              outcome: null,
              pnl: 0,
              timestamp: Date.now(),
              windowEnd,
              conditionId,
              priceToBeatAtEntry,
              clobResult: "rejected",
              clobReason: reason,
            };
            yield* Effect.logWarning(`[Orders] Live order rejected for ${signal.strategy} ${signal.side}: ${reason}`);
            return record;
          }

          const parsed = inspectPostedOrder(result.right);
          if (!parsed.accepted) {
            lastReason = parsed.reason ?? "Order was not accepted by CLOB";
            if (isFokLiquidityReject(lastReason)) continue;
            const record: TradeRecord = {
              id: `trade-${++tradeCounter}-${Date.now()}`,
              strategy: signal.strategy,
              side: signal.side,
              tokenId,
              entryPrice: price,
              size: notional,
              shares,
              fee: 0,
              status: parsed.mappedStatus === "rejected" ? "rejected" : "cancelled",
              outcome: null,
              pnl: 0,
              timestamp: Date.now(),
              windowEnd,
              conditionId,
              priceToBeatAtEntry,
              clobOrderId: parsed.orderId ?? undefined,
              clobResult: parsed.status ?? "rejected",
              clobReason: parsed.reason ?? undefined,
            };
            yield* Effect.logWarning(`[Orders] Live order rejected for ${signal.strategy} ${signal.side}: ${lastReason}`);
            return record;
          }

          const mappedStatus = parsed.mappedStatus;
          const fee = mappedStatus === "filled" || mappedStatus === "partial" ? calculateFee(shares, price) : 0;
          const record: TradeRecord = {
            id: `trade-${++tradeCounter}-${Date.now()}`,
            strategy: signal.strategy,
            side: signal.side,
            tokenId,
            entryPrice: price,
            size: notional,
            shares,
            fee,
            status: mappedStatus,
            outcome: null,
            pnl: fee > 0 ? -fee : 0,
            timestamp: Date.now(),
            windowEnd,
            conditionId,
            priceToBeatAtEntry,
            clobOrderId: parsed.orderId ?? undefined,
            clobResult: parsed.status ?? "accepted",
            clobReason: parsed.reason ?? undefined,
          };

          yield* Effect.log(
            `[Orders] Submitted ${signal.strategy} ${signal.side} @ $${price} for $${notional} (${shares} shares, status=${mappedStatus}, fee: $${fee.toFixed(4)}) [scale=${scale}]`,
          );
          return record as TradeRecord | null;
        }

        yield* Effect.logWarning(
          `[Orders] All FOK sizes exhausted for ${signal.strategy} ${signal.side}: ${lastReason ?? "order couldn't be fully filled"}`,
        );
        return null as TradeRecord | null;
      }).pipe(
        Effect.withSpan("Orders.executeSignal", {
          attributes: { strategy: signal.strategy, side: signal.side },
        }),
        Effect.catchAll((err) => {
          return Effect.logError(`[Orders] Failed to execute signal: ${err}`).pipe(
            Effect.map(() => null as TradeRecord | null),
          );
        }),
      );

    const executeDualBuy = (
      upTokenId: string,
      downTokenId: string,
      upPrice: number,
      downPrice: number,
      size: number,
      windowEnd: number,
      conditionId: string,
      priceToBeatAtEntry: number,
    ) =>
      Effect.gen(function* () {
        const trades: TradeRecord[] = [];
        const client = yield* polyClient.getClient;

        const pxUp = floorTo(upPrice, 2);
        const pxDown = floorTo(downPrice, 2);
        if (pxUp <= 0 || pxDown <= 0) return trades;

        const rawShares = size / (pxUp + pxDown);
        const shares = floorTo(rawShares, 2);
        if (shares <= 0) return trades;

        const legs: Array<["UP" | "DOWN", string, number]> = [
          ["UP", upTokenId, pxUp],
          ["DOWN", downTokenId, pxDown],
        ];

        for (const [side, tokenId, px] of legs) {
          const legNotional = floorTo(shares * px, 2);
          if (legNotional < MIN_CLOB_NOTIONAL) {
            yield* Effect.logWarning(
              `[Orders] Efficiency ${side} leg notional $${legNotional.toFixed(2)} < min $${MIN_CLOB_NOTIONAL}, aborting dual buy`,
            );
            if (trades.length === 1) {
              trades[0]!.strategy = "efficiency-partial";
              yield* Effect.logError(
                `[Orders] CRITICAL: Efficiency leg 2 skipped — single-leg directional exposure on ${trades[0]!.side}`,
              );
            }
            break;
          }

          const result = yield* Effect.tryPromise({
            try: () =>
              (client as any).createAndPostOrder(
                { tokenID: tokenId, price: px, side: "BUY", size: shares },
                { tickSize: "0.01", negRisk: false },
                "FOK",
              ) as Promise<unknown>,
            catch: (err) => new OrderError({ message: extractOrderError(err) }),
          }).pipe(Effect.either);

          if (result._tag === "Left") {
            yield* Effect.logError(`[Orders] Failed dual buy ${side}: ${result.left.message}`);
            if (trades.length === 1) {
              yield* Effect.logError(
                `[Orders] CRITICAL: Efficiency leg 2 failed — single-leg directional exposure on ${trades[0]!.side}`,
              );
              trades[0]!.strategy = "efficiency-partial";
            }
            break;
          }

          const parsed = inspectPostedOrder(result.right);
          if (!parsed.accepted) {
            yield* Effect.logError(`[Orders] Failed dual buy ${side}: ${parsed.reason}`);
            if (trades.length === 1) {
              trades[0]!.strategy = "efficiency-partial";
            }
            break;
          }

          const mappedStatus = parsed.mappedStatus;
          const fee = mappedStatus === "filled" || mappedStatus === "partial" ? calculateFee(shares, px) : 0;
          trades.push({
            id: `trade-${++tradeCounter}-${Date.now()}`,
            strategy: "efficiency",
            side,
            tokenId,
            entryPrice: px,
            size: legNotional,
            shares,
            fee,
            status: mappedStatus,
            outcome: null,
            pnl: fee > 0 ? -fee : 0,
            timestamp: Date.now(),
            windowEnd,
            conditionId,
            priceToBeatAtEntry,
            clobOrderId: parsed.orderId ?? undefined,
            clobResult: parsed.status ?? "accepted",
            clobReason: parsed.reason ?? undefined,
          });
        }

        return trades;
      });

    const getOrderBook = (tokenId: string) =>
      Effect.gen(function* () {
        const client = yield* polyClient.getClient;
        return yield* Effect.tryPromise({
          try: () => (client as any).getOrderBook(tokenId),
          catch: (err) => new OrderError({ message: `getOrderBook failed for ${tokenId.slice(0, 12)}...: ${err}` }),
        });
      }).pipe(Effect.catchAll((err) => Effect.logError(String(err)).pipe(Effect.map(() => null))));

    const getMidpoint = (tokenId: string) =>
      Effect.gen(function* () {
        const client = yield* polyClient.getClient;
        const mid = yield* Effect.tryPromise({
          try: () => (client as any).getMidpoint(tokenId) as Promise<unknown>,
          catch: () => null,
        });
        return typeof mid === "number" ? mid : typeof mid === "string" ? parseFloat(mid) : null;
      }).pipe(Effect.catchAll(() => Effect.succeed(null as number | null)));

    const getOrderStatusById = (orderId: string) =>
      Effect.gen(function* () {
        const client = yield* polyClient.getClient;
        const c = client as any;
        const candidates = [
          () => c.getOrder?.(orderId),
          () => c.getOrderById?.(orderId),
          () => c.getOrderStatus?.(orderId),
          () => c.getOrder?.({ id: orderId }),
        ].filter((fn) => typeof fn === "function");

        for (const call of candidates) {
          const result = yield* Effect.tryPromise({
            try: () => Promise.resolve(call()),
            catch: () => null,
          });
          if (result) return normalizeOrderStatus(result);
        }
        return { mappedStatus: null, rawStatus: null, avgPrice: null, filledShares: null, reason: null };
      }).pipe(Effect.catchAll(() => Effect.succeed({ mappedStatus: null, rawStatus: null, avgPrice: null, filledShares: null, reason: null })));

    return { executeSignal, executeDualBuy, getOrderBook, getMidpoint, getOrderStatusById, calculateFee, effectiveFeeRate } as const;
  }),
}) {}

export { calculateFee as calculateFeeStatic, effectiveFeeRate as effectiveFeeRateStatic };

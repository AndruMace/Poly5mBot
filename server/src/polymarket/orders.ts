import { Effect } from "effect";
import { PolymarketClient } from "./client.js";
import { OrderError } from "../errors.js";
import type { Signal, TradeRecord, TradeStatus } from "../types.js";

const FEE_RATE = 0.25;
const FEE_EXPONENT = 2;
const FOK_SIZE_SCALES = [1, 0.8, 0.6, 0.45];
const IOC_SIZE_SCALES = [1, 0.8, 0.6, 0.45, 0.35, 0.25, 0.15];
const FOK_BACKOFF_SIZE_SCALES = [0.45, 0.35, 0.25, 0.15];
const MIN_CLOB_NOTIONAL = 1.0;
const FOK_LIQUIDITY_BACKOFF_BASE_MS = 8_000;
const FOK_LIQUIDITY_BACKOFF_MAX_MS = 120_000;
interface FokBackoffState {
  consecutiveFailures: number;
  blockedUntil: number;
}

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

function lcm(a: number, b: number): number {
  return Math.abs(a * b) / gcd(a, b);
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

  // Fallback to simpler quantization if step-based is too granular or fails 2 decimal maker check
  const shares2d = floorTo(shares, 2);
  const rawQuote2d = shares2d * price;
  const quoteCents2d = Math.round(rawQuote2d * 100);
  
  if (Math.abs(rawQuote2d - quoteCents2d / 100) > 1e-9 || (shares * price * 100) % 1 !== 0) {
    const d2 = gcd(100, priceCents);
    const step2 = Math.floor(100 / d2);
    const qps2 = Math.floor(priceCents / d2);
    const sc2 = Math.floor(maxQuoteCents / qps2);
    const su2 = sc2 * step2;
    shares = floorTo(su2 / 100, 2);
    quote = floorTo((su2 * priceCents) / 10_000, 2);
  }

  // Final safety check: Polymarket throws if shares * price has > 2 decimals.
  // So we explicitly floor it to exactly 2 decimal precision.
  shares = floorTo(shares, 4);
  quote = floorTo(shares * price, 2);
  
  // Back-calculate shares if flooring the quote disrupted the exact price ratio.
  // If we spend exactly `quote` at `price`, we get `quote / price` shares.
  // Polymarket requires shares to have max 4 decimals, and quote max 2 decimals.
  const correctedShares = floorTo(quote / price, 4);
  if (Math.abs(correctedShares * price - quote) < 1e-6) {
    shares = correctedShares;
  } else {
    // If it doesn't map perfectly, we just fallback to truncating shares to 2 decimals,
    // which guarantees that shares(2 decimals) * price(2 decimals) = max 4 decimals, 
    // but often still violates the 2 decimal quote rule. So we have to find a share count
    // that produces exactly a 2-decimal quote.
    shares = floorTo(shares, 2);
    quote = floorTo(shares * price, 2);
  }

  return { price, shares, quote };
}

function quantizeDualBuyOrder(totalNotional: number, upPriceRaw: number, downPriceRaw: number) {
  const upPrice = floorTo(upPriceRaw, 2);
  const downPrice = floorTo(downPriceRaw, 2);
  if (upPrice <= 0 || downPrice <= 0 || totalNotional <= 0) {
    return { shares: 0, upNotional: 0, downNotional: 0, upPrice: 0, downPrice: 0 };
  }

  const rawShares = totalNotional / (upPrice + downPrice);
  if (rawShares <= 0) {
    return { shares: 0, upNotional: 0, downNotional: 0, upPrice: 0, downPrice: 0 };
  }

  const upPriceCents = Math.round(upPrice * 100);
  const downPriceCents = Math.round(downPrice * 100);
  if (upPriceCents <= 0 || downPriceCents <= 0) {
    return { shares: 0, upNotional: 0, downNotional: 0, upPrice: 0, downPrice: 0 };
  }

  // Ensure both legs satisfy: quote = shares * price has at most 2 decimal places.
  // shares are represented as 1e-4 units, so we need (shareUnits * priceCents) divisible by 10_000.
  const upStep = Math.floor(10_000 / gcd(10_000, upPriceCents));
  const downStep = Math.floor(10_000 / gcd(10_000, downPriceCents));
  const shareStepUnits = lcm(upStep, downStep);

  const rawShareUnits = Math.floor(rawShares * 10_000);
  const shareUnits = Math.floor(rawShareUnits / shareStepUnits) * shareStepUnits;
  if (shareUnits <= 0) {
    return { shares: 0, upNotional: 0, downNotional: 0, upPrice: 0, downPrice: 0 };
  }

  const shares = floorTo(shareUnits / 10_000, 4);
  const upNotional = floorTo((shareUnits * upPriceCents) / 1_000_000, 2);
  const downNotional = floorTo((shareUnits * downPriceCents) / 1_000_000, 2);

  return { shares, upNotional, downNotional, upPrice, downPrice };
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

function isSizeBelowMinimum(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return reason.toLowerCase().includes("lower than the minimum");
}

function toFokBackoffMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  return Math.min(FOK_LIQUIDITY_BACKOFF_MAX_MS, FOK_LIQUIDITY_BACKOFF_BASE_MS * 2 ** exponent);
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

export interface VenueOrderSnapshot {
  orderId: string;
  tokenId: string | null;
  side: "BUY" | "SELL" | null;
  mappedStatus: TradeStatus | null;
  rawStatus: string | null;
  avgPrice: number | null;
  filledShares: number | null;
  updatedAtMs: number | null;
}

let tradeCounter = 0;

export class OrderService extends Effect.Service<OrderService>()("OrderService", {
  effect: Effect.gen(function* () {
    const polyClient = yield* PolymarketClient;
    const fokBackoffByKey = new Map<string, FokBackoffState>();

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
        const backoffKey = `${signal.strategy}:${signal.side}:${tokenId}`;
        const now = Date.now();
        const backoff = fokBackoffByKey.get(backoffKey);
        const backoffActive = !!backoff && now < backoff.blockedUntil;
        const scales = backoffActive ? FOK_BACKOFF_SIZE_SCALES : FOK_SIZE_SCALES;
        let lastReason: string | null = null;

        for (const scale of scales) {
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
            if (isFokLiquidityReject(reason)) {
              const consecutiveFailures = (backoffActive ? backoff?.consecutiveFailures ?? 0 : 0) + 1;
              const backoffMs = toFokBackoffMs(consecutiveFailures);
              fokBackoffByKey.set(backoffKey, {
                consecutiveFailures,
                blockedUntil: Date.now() + backoffMs,
              });
              continue;
            }
            fokBackoffByKey.delete(backoffKey);
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
              shadow: false,
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
            if (isFokLiquidityReject(lastReason)) {
              const consecutiveFailures = (backoffActive ? backoff?.consecutiveFailures ?? 0 : 0) + 1;
              const backoffMs = toFokBackoffMs(consecutiveFailures);
              fokBackoffByKey.set(backoffKey, {
                consecutiveFailures,
                blockedUntil: Date.now() + backoffMs,
              });
              continue;
            }
            fokBackoffByKey.delete(backoffKey);
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
              shadow: false,
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
            shadow: false,
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
          fokBackoffByKey.delete(backoffKey);
          return record as TradeRecord | null;
        }

        // FOK can fail in thin/fast books even when a partial instant fill
        // would still be strategically valuable. Try IOC as a controlled fallback.
        for (const scale of IOC_SIZE_SCALES) {
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
                "IOC",
              ) as Promise<unknown>,
            catch: (err) => extractOrderError(err),
          }).pipe(Effect.either);

          if (result._tag === "Left") {
            const reason = result.left;
            lastReason = reason;
            if (isFokLiquidityReject(reason)) continue;
            fokBackoffByKey.delete(backoffKey);
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
              shadow: false,
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
          let observed = normalizeOrderStatus(result.right);
          if ((observed.filledShares ?? 0) <= 0 && parsed.orderId) {
            const refreshed = yield* getOrderStatusById(parsed.orderId);
            if (refreshed.mappedStatus) {
              observed = refreshed;
            }
          }

          const observedStatus = observed.mappedStatus ?? parsed.mappedStatus;
          const observedShares =
            observed.filledShares ??
            (observedStatus === "filled" ? shares : null);

          if (
            (observedStatus === "filled" || observedStatus === "partial") &&
            observedShares !== null &&
            observedShares > 0
          ) {
            const fillRatio = shares > 0 ? observedShares / shares : 0;
            const avgPrice = observed.avgPrice ?? price;
            const filledNotional = floorTo(observedShares * avgPrice, 2);
            const fee = calculateFee(observedShares, avgPrice);
            const status =
              observedStatus === "filled" || fillRatio >= 0.995
                ? "filled"
                : "partial";
            const record: TradeRecord = {
              id: `trade-${++tradeCounter}-${Date.now()}`,
              strategy: signal.strategy,
              side: signal.side,
              tokenId,
              entryPrice: avgPrice,
              size: filledNotional,
              shares: observedShares,
              fee,
              status,
              shadow: false,
              outcome: null,
              pnl: fee > 0 ? -fee : 0,
              timestamp: Date.now(),
              windowEnd,
              conditionId,
              priceToBeatAtEntry,
              clobOrderId: parsed.orderId ?? undefined,
              clobResult: observed.rawStatus ?? parsed.status ?? "ioc",
              clobReason: parsed.reason ?? undefined,
            };
            yield* Effect.log(
              `[Orders] IOC fallback filled ${signal.strategy} ${signal.side} @ $${avgPrice.toFixed(4)} for $${filledNotional.toFixed(2)} (${observedShares.toFixed(4)} shares, fillRatio=${(fillRatio * 100).toFixed(1)}%) [scale=${scale}]`,
            );
            fokBackoffByKey.delete(backoffKey);
            return record;
          }

          const reason = parsed.reason ?? observed.reason;
          if (isFokLiquidityReject(reason)) {
            lastReason = reason;
            continue;
          }
          if (isSizeBelowMinimum(reason)) {
            // Smaller scales will also fail minimum — stop now
            lastReason = reason;
            break;
          }
          // For balance errors and other non-fill responses: let the loop
          // try smaller scales (a smaller amount may fit within available balance).
          lastReason = reason;
        }

        yield* Effect.logWarning(
          `[Orders] All FOK sizes exhausted for ${signal.strategy} ${signal.side}: ${lastReason ?? "order couldn't be fully filled"} (IOC fallback also did not reach minimum fill threshold)`,
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

        const q = quantizeDualBuyOrder(size, upPrice, downPrice);
        const pxUp = q.upPrice;
        const pxDown = q.downPrice;
        const shares = q.shares;
        if (shares <= 0) return trades;

        const legs: Array<["UP" | "DOWN", string, number, number]> = [
          ["UP", upTokenId, pxUp, q.upNotional],
          ["DOWN", downTokenId, pxDown, q.downNotional],
        ];

        for (const [side, tokenId, px, legNotional] of legs) {
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
            shadow: false,
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

    const listRecentOrders = (sinceMs: number, limit = 300) =>
      Effect.gen(function* () {
        const client = yield* polyClient.getClient;
        const c = client as any;
        const calls = [
          () => c.getOrders?.(),
          () => c.getActiveOrders?.(),
          () => c.listOrders?.(),
          () => c.getTrades?.(),
        ].filter((fn) => typeof fn === "function");

        for (const call of calls) {
          const result = yield* Effect.tryPromise({
            try: () => Promise.resolve(call()),
            catch: () => null,
          });
          if (!result) continue;
          const rows: unknown[] = Array.isArray(result)
            ? result
            : Array.isArray((result as any)?.orders)
              ? (result as any).orders
              : Array.isArray((result as any)?.data)
                ? (result as any).data
                : [];
          if (rows.length === 0) continue;

          const snapshots: VenueOrderSnapshot[] = [];
          for (const row of rows.slice(0, Math.max(1, limit * 2))) {
            const status = normalizeOrderStatus(row);
            const obj = row as Record<string, unknown>;
            const orderIdRaw = obj["orderID"] ?? obj["orderId"] ?? obj["id"];
            const orderId = typeof orderIdRaw === "string" ? orderIdRaw : null;
            if (!orderId) continue;
            const tokenIdRaw = obj["tokenID"] ?? obj["tokenId"] ?? obj["asset_id"];
            const tokenId = typeof tokenIdRaw === "string" ? tokenIdRaw : null;
            const sideRaw = obj["side"];
            const side = sideRaw === "BUY" || sideRaw === "SELL" ? sideRaw : null;
            const updatedRaw = toNumber(obj["updatedAt"]) ?? toNumber(obj["createdAt"]) ?? toNumber(obj["timestamp"]);
            if (typeof updatedRaw === "number" && Number.isFinite(updatedRaw) && updatedRaw > 0 && updatedRaw < 10_000_000_000) {
              // best-effort normalization for second-based timestamps
              const updatedAtMs = Math.floor(updatedRaw * 1000);
              if (updatedAtMs < sinceMs) continue;
              snapshots.push({
                orderId,
                tokenId,
                side,
                mappedStatus: status.mappedStatus,
                rawStatus: status.rawStatus,
                avgPrice: status.avgPrice,
                filledShares: status.filledShares,
                updatedAtMs,
              });
              continue;
            }
            const updatedAtMs = typeof updatedRaw === "number" && Number.isFinite(updatedRaw) ? Math.floor(updatedRaw) : null;
            if (updatedAtMs !== null && updatedAtMs < sinceMs) continue;
            snapshots.push({
              orderId,
              tokenId,
              side,
              mappedStatus: status.mappedStatus,
              rawStatus: status.rawStatus,
              avgPrice: status.avgPrice,
              filledShares: status.filledShares,
              updatedAtMs,
            });
          }
          snapshots.sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0));
          return snapshots.slice(0, limit);
        }
        return [] as VenueOrderSnapshot[];
      }).pipe(
        Effect.catchAll(() => Effect.succeed([] as VenueOrderSnapshot[])),
      );

    return {
      executeSignal,
      executeDualBuy,
      getOrderBook,
      getMidpoint,
      getOrderStatusById,
      listRecentOrders,
      calculateFee,
      effectiveFeeRate,
    } as const;
  }),
}) {}

export { calculateFee as calculateFeeStatic, effectiveFeeRate as effectiveFeeRateStatic };

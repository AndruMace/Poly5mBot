import { Effect } from "effect";
import { TradeStore, ShadowTradeStore, toTradeRecord } from "./trade-store.js";
import type { Trade, TradeRecord, PnLSummary } from "../types.js";

export type TradeQueryMode = "all" | "live" | "shadow";

export interface TradeListQuery {
  limit?: number;
  cursor?: string;
  mode?: TradeQueryMode;
  sinceMs?: number;
}

export interface TradeListResult {
  items: TradeRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}

function encodeCursor(t: TradeRecord): string {
  return Buffer.from(
    JSON.stringify({ ts: t.timestamp, id: t.id }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(
  cursor: string,
): { ts: number; id: string } | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { ts: unknown; id: unknown };
    if (
      typeof parsed.ts === "number" &&
      Number.isFinite(parsed.ts) &&
      typeof parsed.id === "string" &&
      parsed.id.length > 0
    ) {
      return { ts: parsed.ts, id: parsed.id };
    }
  } catch {
    /* ignore bad cursor */
  }
  return null;
}

function sortTradesDesc(a: TradeRecord, b: TradeRecord): number {
  if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
  return b.id.localeCompare(a.id);
}

export class PnLTracker extends Effect.Service<PnLTracker>()("PnLTracker", {
  effect: Effect.gen(function* () {
    const liveStore = yield* TradeStore;
    const shadowStore = yield* ShadowTradeStore;

    const getStore = (shadow: boolean) => (shadow ? shadowStore : liveStore);

    const addTrade = (trade: TradeRecord) =>
      Effect.gen(function* () {
        const shadow = (trade as any).shadow === true;
        const s = getStore(shadow);
        const existing = yield* s.getTrade(trade.id);
        if (existing) return;

        yield* s.createTrade({
          id: trade.id,
          conditionId: trade.conditionId,
          strategy: trade.strategy,
          side: trade.side,
          tokenId: trade.tokenId,
          priceToBeatAtEntry: trade.priceToBeatAtEntry,
          windowEnd: trade.windowEnd,
          shadow,
          size: trade.size,
          requestedShares: trade.shares,
          clobOrderId: trade.clobOrderId,
          clobResult: trade.clobResult,
          clobReason: trade.clobReason,
          entryContext: trade.entryContext,
        });

        yield* s.appendEvent(trade.id, "signal_generated", {
          conditionId: trade.conditionId,
          strategy: trade.strategy,
          side: trade.side,
          tokenId: trade.tokenId,
          priceToBeatAtEntry: trade.priceToBeatAtEntry,
          windowEnd: trade.windowEnd,
          shadow,
          size: trade.size,
          requestedShares: trade.shares,
          entryContext: trade.entryContext,
        });

        if (trade.status === "filled") {
          yield* s.appendEvent(trade.id, "fill", {
            shares: trade.shares,
            price: trade.entryPrice,
            fee: trade.fee,
            orderId: trade.clobOrderId,
            result: trade.clobResult,
            reason: trade.clobReason,
          });
        } else if (trade.status === "partial") {
          yield* s.appendEvent(trade.id, "partial_fill", {
            shares: trade.shares,
            price: trade.entryPrice,
            fee: trade.fee,
            orderId: trade.clobOrderId,
            result: trade.clobResult ?? "partial",
            reason: trade.clobReason,
          });
        } else if (trade.status === "rejected") {
          yield* s.appendEvent(trade.id, "order_rejected", {
            shares: trade.shares,
            price: trade.entryPrice,
            orderId: trade.clobOrderId,
            result: trade.clobResult ?? "rejected",
            reason: trade.clobReason ?? "Order rejected by venue",
          });
        } else if (trade.status === "cancelled") {
          yield* s.appendEvent(trade.id, "cancel", {
            reason: trade.clobReason ?? "Order cancelled",
          });
        } else {
          yield* s.appendEvent(trade.id, "order_submitted", {
            shares: trade.shares,
            price: trade.entryPrice,
            orderId: trade.clobOrderId,
            result: trade.clobResult,
            reason: trade.clobReason,
          });
        }
      });

    const resolveTrade = (
      id: string,
      won: boolean,
      shadow = false,
      details?: {
        outcomeSource?: "venue" | "estimated";
        settlementWinnerSide?: "UP" | "DOWN" | null;
      },
    ) =>
      getStore(shadow).appendEvent(id, "resolved", {
        won,
        outcomeSource: details?.outcomeSource ?? "estimated",
        settlementWinnerSide: details?.settlementWinnerSide ?? null,
      });

    const expireTrade = (id: string, closingAssetPrice: number, shadow = false) =>
      getStore(shadow).appendEvent(id, "expired", { closingAssetPrice });

    const cancelTrade = (id: string, reason: string, shadow = false) =>
      Effect.gen(function* () {
        const s = getStore(shadow);
        const trade = yield* s.getTrade(id);
        if (!trade) return;
        if (trade.status === "cancelled" || trade.status === "resolved") return;
        yield* s.appendEvent(id, "cancel", { reason });
      });

    const listTrades = (query: TradeListQuery = {}) =>
      Effect.gen(function* () {
        const limit = Math.max(1, Math.min(query.limit ?? 100, 1000));
        const mode = query.mode ?? "all";
        const liveAll = yield* liveStore.getAllTrades;
        const shadowAll = yield* shadowStore.getAllTrades;

        let combined: TradeRecord[] = [];
        if (mode === "all" || mode === "live") {
          combined.push(...liveAll.map((t) => ({ ...toTradeRecord(t), marketId: "btc" })));
        }
        if (mode === "all" || mode === "shadow") {
          combined.push(...shadowAll.map((t) => ({ ...toTradeRecord(t), marketId: "btc" })));
        }

        if (typeof query.sinceMs === "number" && Number.isFinite(query.sinceMs)) {
          combined = combined.filter((t) => t.timestamp >= query.sinceMs!);
        }

        combined.sort(sortTradesDesc);

        const decodedCursor = query.cursor ? decodeCursor(query.cursor) : null;
        if (decodedCursor) {
          combined = combined.filter(
            (t) =>
              t.timestamp < decodedCursor.ts ||
              (t.timestamp === decodedCursor.ts &&
                t.id.localeCompare(decodedCursor.id) < 0),
          );
        }

        const items = combined.slice(0, limit);
        const hasMore = combined.length > limit;
        const nextCursor =
          hasMore && items.length > 0 ? encodeCursor(items[items.length - 1]!) : null;

        return { items, hasMore, nextCursor } satisfies TradeListResult;
      });

    const getTrades = (limit = 100) =>
      listTrades({ limit, mode: "all" }).pipe(
        Effect.map((r) => r.items),
      );

    const getSummary = (shadow = false) => getStore(shadow).getSummary;

    const getTradeById = (id: string, shadow = false) => getStore(shadow).getTrade(id);

    const getTradeRecordById = (id: string, shadow = false) =>
      Effect.gen(function* () {
        const trade = yield* getStore(shadow).getTrade(id);
        return trade ? toTradeRecord(trade) : undefined;
      });

    const getOpenTrades = (shadow = false) => getStore(shadow).getOpenTrades;

    const getAllTradeRecords = (shadow = false) =>
      Effect.gen(function* () {
        const all = yield* getStore(shadow).getAllTrades;
        return all.map(toTradeRecord);
      });

    return {
      liveStore,
      shadowStore,
      addTrade,
      resolveTrade,
      expireTrade,
      cancelTrade,
      listTrades,
      getTrades,
      getSummary,
      getTradeById,
      getTradeRecordById,
      getOpenTrades,
      getAllTradeRecords,
    } as const;
  }),
}) {}

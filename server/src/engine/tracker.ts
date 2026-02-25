import { Effect } from "effect";
import { TradeStore, ShadowTradeStore, toTradeRecord } from "./trade-store.js";
import type { Trade, TradeRecord, PnLSummary } from "../types.js";

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

    const resolveTrade = (id: string, won: boolean, shadow = false) =>
      getStore(shadow).appendEvent(id, "resolved", { won });

    const expireTrade = (id: string, closingBtcPrice: number, shadow = false) =>
      getStore(shadow).appendEvent(id, "expired", { closingBtcPrice });

    const cancelTrade = (id: string, reason: string, shadow = false) =>
      Effect.gen(function* () {
        const s = getStore(shadow);
        const trade = yield* s.getTrade(id);
        if (!trade) return;
        if (trade.status === "cancelled" || trade.status === "resolved") return;
        yield* s.appendEvent(id, "cancel", { reason });
      });

    const getTrades = (limit = 100) =>
      Effect.gen(function* () {
        const live = yield* liveStore.getTrades(limit);
        const shadow = yield* shadowStore.getTrades(limit);
        return [...live, ...shadow]
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, limit);
      });

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
      getTrades,
      getSummary,
      getTradeById,
      getTradeRecordById,
      getOpenTrades,
      getAllTradeRecords,
    } as const;
  }),
}) {}

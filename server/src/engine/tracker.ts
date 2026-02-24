import { TradeStore } from "./trade-store.js";
import type { TradeRecord, PnLSummary, Trade } from "../types.js";

/**
 * Thin wrapper around TradeStore that preserves the legacy API
 * used by the engine and WebSocket server.
 */
export class PnLTracker {
  readonly store: TradeStore;
  private shadowStore: TradeStore;

  constructor() {
    this.store = new TradeStore(false);
    this.shadowStore = new TradeStore(true);
  }

  getStore(shadow: boolean): TradeStore {
    return shadow ? this.shadowStore : this.store;
  }

  addTrade(trade: TradeRecord): void {
    const shadow = (trade as any).shadow === true;
    const s = this.getStore(shadow);
    const existing = s.getTrade(trade.id);
    if (existing) return;

    s.createTrade({
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
    });

    s.appendEvent(trade.id, "signal_generated", {
      conditionId: trade.conditionId,
      strategy: trade.strategy,
      side: trade.side,
      tokenId: trade.tokenId,
      priceToBeatAtEntry: trade.priceToBeatAtEntry,
      windowEnd: trade.windowEnd,
      shadow,
      size: trade.size,
      requestedShares: trade.shares,
    });

    if (trade.status === "filled") {
      s.appendEvent(trade.id, "fill", {
        shares: trade.shares,
        price: trade.entryPrice,
        fee: trade.fee,
        orderId: trade.clobOrderId,
        result: trade.clobResult,
        reason: trade.clobReason,
      });
    } else {
      s.appendEvent(trade.id, "order_submitted", {
        shares: trade.shares,
        price: trade.entryPrice,
        orderId: trade.clobOrderId,
        result: trade.clobResult,
        reason: trade.clobReason,
      });
    }
  }

  resolveTrade(id: string, won: boolean, shadow = false): void {
    const s = this.getStore(shadow);
    const trade = s.getTrade(id);
    if (!trade) return;
    s.appendEvent(id, "resolved", { won });
  }

  expireTrade(id: string, closingBtcPrice: number, shadow = false): void {
    const s = this.getStore(shadow);
    s.appendEvent(id, "expired", { closingBtcPrice });
  }

  cancelTrade(id: string, reason: string, shadow = false): void {
    const s = this.getStore(shadow);
    const trade = s.getTrade(id);
    if (!trade) return;
    if (trade.status === "cancelled" || trade.status === "resolved") return;
    s.appendEvent(id, "cancel", { reason });
  }

  getTrades(limit = 100): TradeRecord[] {
    const live = this.store.getTrades(limit);
    const shadow = this.shadowStore.getTrades(limit);
    return [...live, ...shadow]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  getSummary(shadow = false): PnLSummary {
    return this.getStore(shadow).getSummary();
  }

  getTradeById(id: string, shadow = false): Trade | undefined {
    return this.getStore(shadow).getTrade(id);
  }

  getTradeRecordById(id: string, shadow = false): TradeRecord | undefined {
    const s = this.getStore(shadow);
    const trade = s.getTrade(id);
    return trade ? s.toTradeRecord(trade) : undefined;
  }

  getOpenTrades(shadow = false): Trade[] {
    return this.getStore(shadow).getOpenTrades();
  }
}

import fs from "fs";
import path from "path";
import crypto from "crypto";
import type {
  Trade,
  TradeEvent,
  TradeEventType,
  TradeRecord,
  PnLSummary,
} from "../types.js";

const DATA_DIR = path.resolve(import.meta.dirname, "../../data");
const LIVE_FILE = path.join(DATA_DIR, "events.jsonl");
const SHADOW_FILE = path.join(DATA_DIR, "shadow-events.jsonl");

function uid(): string {
  return crypto.randomBytes(8).toString("hex");
}

export class TradeStore {
  private trades = new Map<string, Trade>();
  private filePath: string;

  constructor(shadow = false) {
    this.filePath = shadow ? SHADOW_FILE : LIVE_FILE;
    this.replay();
  }

  appendEvent(
    tradeId: string,
    type: TradeEventType,
    data: Record<string, unknown>,
  ): TradeEvent {
    const event: TradeEvent = {
      id: uid(),
      tradeId,
      type,
      timestamp: Date.now(),
      data,
    };
    this.applyEvent(event);
    this.persist(event);
    return event;
  }

  createTrade(init: {
    id: string;
    conditionId: string;
    strategy: string;
    side: "UP" | "DOWN";
    tokenId: string;
    priceToBeatAtEntry: number;
    windowEnd: number;
    shadow: boolean;
    size: number;
    requestedShares: number;
    clobOrderId?: string;
    clobResult?: string;
    clobReason?: string;
  }): Trade {
    const trade: Trade = {
      ...init,
      events: [],
      status: "pending",
      filledShares: 0,
      avgFillPrice: 0,
      totalFees: 0,
      pnl: 0,
      outcome: null,
      clobOrderId: init.clobOrderId,
      clobResult: init.clobResult,
      clobReason: init.clobReason,
    };
    this.trades.set(trade.id, trade);
    return trade;
  }

  getTrade(id: string): Trade | undefined {
    return this.trades.get(id);
  }

  getOpenTrades(): Trade[] {
    return [...this.trades.values()].filter(
      (t) =>
        t.status !== "resolved" &&
        t.status !== "cancelled",
    );
  }

  getAllTrades(): Trade[] {
    return [...this.trades.values()];
  }

  toTradeRecord(t: Trade): TradeRecord {
    const legacyStatus: TradeRecord["status"] =
      t.status === "resolved"
        ? "resolved"
        : t.status === "filled"
          ? "filled"
          : t.status === "partial"
            ? "partial"
            : t.status === "submitted"
              ? "submitted"
              : t.status === "cancelled"
                ? "cancelled"
                : t.status === "expired"
                  ? "expired"
                  : "pending";
    return {
      id: t.id,
      strategy: t.strategy,
      side: t.side,
      tokenId: t.tokenId,
      entryPrice: t.avgFillPrice,
      size: t.size,
      shares: t.filledShares,
      fee: t.totalFees,
      status: legacyStatus,
      outcome: t.outcome,
      pnl: t.pnl,
      timestamp: t.events[0]?.timestamp ?? Date.now(),
      windowEnd: t.windowEnd,
      shadow: t.shadow,
      conditionId: t.conditionId,
      priceToBeatAtEntry: t.priceToBeatAtEntry,
      closingBtcPrice: t.closingBtcPrice,
      lastEventType: t.events[t.events.length - 1]?.type,
      clobOrderId: t.clobOrderId,
      clobResult: t.clobResult,
      clobReason: t.clobReason,
    };
  }

  getTrades(limit = 100): TradeRecord[] {
    const all = [...this.trades.values()];
    return all
      .slice(-limit)
      .reverse()
      .map((t) => this.toTradeRecord(t));
  }

  getSummary(): PnLSummary {
    const resolved = [...this.trades.values()].filter(
      (t) => t.status === "resolved",
    );
    const totalPnl = resolved.reduce((s, t) => s + t.pnl, 0);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTrades = resolved.filter(
      (t) => (t.events[0]?.timestamp ?? 0) >= todayStart.getTime(),
    );
    const todayPnl = todayTrades.reduce((s, t) => s + t.pnl, 0);

    const wins = resolved.filter((t) => t.outcome === "win").length;
    const winRate =
      resolved.length > 0 ? (wins / resolved.length) * 100 : 0;

    const byStrategy: PnLSummary["byStrategy"] = {};
    for (const t of resolved) {
      if (!byStrategy[t.strategy]) {
        byStrategy[t.strategy] = { pnl: 0, trades: 0, winRate: 0 };
      }
      const s = byStrategy[t.strategy]!;
      s.pnl += t.pnl;
      s.trades++;
    }
    for (const [strat, s] of Object.entries(byStrategy)) {
      const stratWins = resolved.filter(
        (t) => t.strategy === strat && t.outcome === "win",
      ).length;
      s.winRate = s.trades > 0 ? (stratWins / s.trades) * 100 : 0;
    }

    let cumPnl = 0;
    const history = resolved.map((t) => {
      cumPnl += t.pnl;
      return {
        timestamp: t.events[0]?.timestamp ?? 0,
        cumulativePnl: cumPnl,
      };
    });

    return { totalPnl, todayPnl, totalTrades: resolved.length, winRate, byStrategy, history };
  }

  private applyEvent(event: TradeEvent): void {
    const trade = this.trades.get(event.tradeId);
    if (!trade) return;

    trade.events.push(event);

    switch (event.type) {
      case "signal_generated":
        trade.status = "pending";
        break;
      case "order_submitted":
        trade.status = "submitted";
        if (typeof event.data.orderId === "string") {
          trade.clobOrderId = event.data.orderId;
        }
        if (typeof event.data.result === "string") {
          trade.clobResult = event.data.result;
        }
        if (typeof event.data.reason === "string") {
          trade.clobReason = event.data.reason;
        }
        break;
      case "order_rejected":
      case "cancel":
        trade.status = "cancelled";
        break;
      case "partial_fill": {
        trade.status = "partial";
        const shares = Number(event.data.shares ?? 0);
        const price = Number(event.data.price ?? 0);
        const fee = Number(event.data.fee ?? 0);
        const totalCost =
          trade.avgFillPrice * trade.filledShares + price * shares;
        trade.filledShares += shares;
        trade.avgFillPrice =
          trade.filledShares > 0 ? totalCost / trade.filledShares : 0;
        trade.totalFees += fee;
        trade.pnl = -trade.totalFees;
        break;
      }
      case "fill": {
        trade.status = "filled";
        const shares = Number(event.data.shares ?? 0);
        const price = Number(event.data.price ?? 0);
        const fee = Number(event.data.fee ?? 0);
        const totalCost =
          trade.avgFillPrice * trade.filledShares + price * shares;
        trade.filledShares += shares;
        trade.avgFillPrice =
          trade.filledShares > 0 ? totalCost / trade.filledShares : 0;
        trade.totalFees += fee;
        trade.pnl = -trade.totalFees;
        if (typeof event.data.orderId === "string") {
          trade.clobOrderId = event.data.orderId;
        }
        if (typeof event.data.result === "string") {
          trade.clobResult = event.data.result;
        }
        if (typeof event.data.reason === "string") {
          trade.clobReason = event.data.reason;
        }
        break;
      }
      case "expired":
        trade.status = "expired";
        trade.closingBtcPrice = Number(event.data.closingBtcPrice ?? 0);
        break;
      case "resolved": {
        trade.status = "resolved";
        const won = Boolean(event.data.won);
        trade.outcome = won ? "win" : "loss";
        const realizedCost = trade.avgFillPrice * trade.filledShares;
        trade.pnl = won
          ? trade.filledShares * 1.0 - realizedCost - trade.totalFees
          : -realizedCost - trade.totalFees;
        break;
      }
    }
  }

  private writeBuffer: string[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  private persist(event: TradeEvent): void {
    this.writeBuffer.push(JSON.stringify(event) + "\n");
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => this.flushBuffer(), 200);
    }
  }

  private flushBuffer(): void {
    if (this.flushing || this.writeBuffer.length === 0) return;
    this.flushing = true;
    const batch = this.writeBuffer.splice(0);
    const data = batch.join("");
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch { /* directory likely exists */ }
    fs.promises
      .appendFile(this.filePath, data)
      .catch((err) => console.error("[TradeStore] Failed to persist events:", err))
      .finally(() => {
        this.flushing = false;
      });
  }

  flushSync(): void {
    if (this.writeBuffer.length === 0) return;
    const batch = this.writeBuffer.splice(0);
    const data = batch.join("");
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.appendFileSync(this.filePath, data);
    } catch (err) {
      console.error("[TradeStore] Failed to flush events:", err);
    }
  }

  private replay(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const lines = fs
        .readFileSync(this.filePath, "utf-8")
        .split("\n")
        .filter(Boolean);
      const initEvents: TradeEvent[] = [];
      for (const line of lines) {
        try {
          initEvents.push(JSON.parse(line));
        } catch {
          /* skip corrupt lines */
        }
      }
      const tradeIds = new Set(initEvents.map((e) => e.tradeId));
      for (const id of tradeIds) {
        const first = initEvents.find(
          (e) => e.tradeId === id && e.type === "signal_generated",
        );
        if (first?.data) {
          this.createTrade({
            id,
            conditionId: String(first.data.conditionId ?? ""),
            strategy: String(first.data.strategy ?? ""),
            side: first.data.side as "UP" | "DOWN",
            tokenId: String(first.data.tokenId ?? ""),
            priceToBeatAtEntry: Number(first.data.priceToBeatAtEntry ?? 0),
            windowEnd: Number(first.data.windowEnd ?? 0),
            shadow: Boolean(first.data.shadow),
            size: Number(first.data.size ?? 0),
            requestedShares: Number(first.data.requestedShares ?? 0),
          });
        }
      }
      for (const event of initEvents) {
        this.applyEvent(event);
      }
      console.log(
        `[TradeStore] Replayed ${initEvents.length} events for ${tradeIds.size} trades`,
      );
    } catch {
      console.log("[TradeStore] No existing events to replay");
    }
  }
}

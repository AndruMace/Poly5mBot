import { Effect, Ref, Chunk, Schedule, Queue } from "effect";
import { FileSystem } from "@effect/platform";
import crypto from "crypto";
import type {
  Trade,
  TradeEvent,
  TradeEventType,
  TradeRecord,
  PnLSummary,
} from "../types.js";

const DATA_DIR = "data";
const LIVE_FILE = "data/events.jsonl";
const SHADOW_FILE = "data/shadow-events.jsonl";

function uid(): string {
  return crypto.randomBytes(8).toString("hex");
}

function applyEventToTrade(trade: Trade, event: TradeEvent): void {
  trade.events.push(event);

  switch (event.type) {
    case "signal_generated":
      trade.status = "pending";
      break;
    case "order_submitted":
      trade.status = "submitted";
      if (typeof event.data.orderId === "string") trade.clobOrderId = event.data.orderId;
      if (typeof event.data.result === "string") trade.clobResult = event.data.result;
      if (typeof event.data.reason === "string") trade.clobReason = event.data.reason;
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
      const totalCost = trade.avgFillPrice * trade.filledShares + price * shares;
      trade.filledShares += shares;
      trade.avgFillPrice = trade.filledShares > 0 ? totalCost / trade.filledShares : 0;
      trade.totalFees += fee;
      trade.pnl = -trade.totalFees;
      break;
    }
    case "fill": {
      trade.status = "filled";
      const shares = Number(event.data.shares ?? 0);
      const price = Number(event.data.price ?? 0);
      const fee = Number(event.data.fee ?? 0);
      const totalCost = trade.avgFillPrice * trade.filledShares + price * shares;
      trade.filledShares += shares;
      trade.avgFillPrice = trade.filledShares > 0 ? totalCost / trade.filledShares : 0;
      trade.totalFees += fee;
      trade.pnl = -trade.totalFees;
      if (typeof event.data.orderId === "string") trade.clobOrderId = event.data.orderId;
      if (typeof event.data.result === "string") trade.clobResult = event.data.result;
      if (typeof event.data.reason === "string") trade.clobReason = event.data.reason;
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

function makeTrade(init: {
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
  return {
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
  } as Trade;
}

export function toTradeRecord(t: Trade): TradeRecord {
  return {
    id: t.id,
    strategy: t.strategy,
    side: t.side,
    tokenId: t.tokenId,
    entryPrice: t.avgFillPrice,
    size: t.size,
    shares: t.filledShares,
    fee: t.totalFees,
    status: t.status,
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
  } as TradeRecord;
}

function computeSummary(trades: Map<string, Trade>): PnLSummary {
  const resolved = [...trades.values()].filter((t) => t.status === "resolved");
  const totalPnl = resolved.reduce((s, t) => s + t.pnl, 0);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTrades = resolved.filter(
    (t) => (t.events[0]?.timestamp ?? 0) >= todayStart.getTime(),
  );
  const todayPnl = todayTrades.reduce((s, t) => s + t.pnl, 0);

  const wins = resolved.filter((t) => t.outcome === "win").length;
  const winRate = resolved.length > 0 ? (wins / resolved.length) * 100 : 0;

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
    const stratWins = resolved.filter((t) => t.strategy === strat && t.outcome === "win").length;
    s.winRate = s.trades > 0 ? (stratWins / s.trades) * 100 : 0;
  }

  let cumPnl = 0;
  const history = resolved.map((t) => {
    cumPnl += t.pnl;
    return { timestamp: t.events[0]?.timestamp ?? 0, cumulativePnl: cumPnl };
  });

  return { totalPnl, todayPnl, totalTrades: resolved.length, winRate, byStrategy, history } as PnLSummary;
}

export interface TradeStoreService {
  readonly appendEvent: (
    tradeId: string,
    type: TradeEventType,
    data: Record<string, unknown>,
  ) => Effect.Effect<TradeEvent>;
  readonly createTrade: (init: {
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
  }) => Effect.Effect<Trade>;
  readonly getTrade: (id: string) => Effect.Effect<Trade | undefined>;
  readonly getOpenTrades: Effect.Effect<ReadonlyArray<Trade>>;
  readonly getAllTrades: Effect.Effect<ReadonlyArray<Trade>>;
  readonly getTrades: (limit?: number) => Effect.Effect<ReadonlyArray<TradeRecord>>;
  readonly getSummary: Effect.Effect<PnLSummary>;
}

export const makeTradeStore = (shadow: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const filePath = shadow ? SHADOW_FILE : LIVE_FILE;
    const tradesRef = yield* Ref.make(new Map<string, Trade>());
    const writeQueue = yield* Queue.unbounded<string>();

    const flushLoop = Effect.gen(function* () {
      const items = yield* Queue.takeAll(writeQueue);
      if (Chunk.size(items) === 0) return;
      const data = Chunk.toReadonlyArray(items).join("");
      yield* fs.makeDirectory(DATA_DIR, { recursive: true }).pipe(Effect.catchAll(() => Effect.void));
      yield* fs.writeFileString(filePath, data, { flag: "a" }).pipe(
        Effect.catchAll((err) => Effect.logError(`[TradeStore] Failed to persist events: ${err}`)),
      );
    }).pipe(
      Effect.repeat(Schedule.fixed("200 millis")),
      Effect.catchAll(() => Effect.void),
      Effect.forkScoped,
    );
    yield* flushLoop;

    const replay = Effect.gen(function* () {
      const exists = yield* fs.exists(filePath);
      if (!exists) return;
      const content = yield* fs.readFileString(filePath);
      const lines = content.split("\n").filter(Boolean);
      const initEvents: TradeEvent[] = [];
      for (const line of lines) {
        try {
          initEvents.push(JSON.parse(line));
        } catch {
          /* skip corrupt lines */
        }
      }
      const tradeIds = new Set(initEvents.map((e) => e.tradeId));
      yield* Ref.update(tradesRef, (trades) => {
        for (const id of tradeIds) {
          const first = initEvents.find((e) => e.tradeId === id && e.type === "signal_generated");
          if (first?.data) {
            const t = makeTrade({
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
            trades.set(id, t);
          }
        }
        for (const event of initEvents) {
          const trade = trades.get(event.tradeId);
          if (trade) applyEventToTrade(trade, event);
        }
        return trades;
      });
      yield* Effect.log(`[TradeStore] Replayed ${initEvents.length} events for ${tradeIds.size} trades`);
    }).pipe(Effect.catchAll(() => Effect.log("[TradeStore] No existing events to replay")));

    yield* replay;

    const appendEvent = (tradeId: string, type: TradeEventType, data: Record<string, unknown>) =>
      Effect.gen(function* () {
        const event: TradeEvent = {
          id: uid(),
          tradeId,
          type,
          timestamp: Date.now(),
          data,
        };
        yield* Ref.update(tradesRef, (trades) => {
          const trade = trades.get(event.tradeId);
          if (trade) applyEventToTrade(trade, event);
          return trades;
        });
        yield* Queue.offer(writeQueue, JSON.stringify(event) + "\n");
        return event;
      });

    const createTrade = (init: Parameters<TradeStoreService["createTrade"]>[0]) =>
      Ref.modify(tradesRef, (trades) => {
        const trade = makeTrade(init);
        trades.set(trade.id, trade);
        return [trade, trades] as const;
      });

    const getTrade = (id: string) =>
      Ref.get(tradesRef).pipe(Effect.map((trades) => trades.get(id)));

    const getOpenTrades = Ref.get(tradesRef).pipe(
      Effect.map((trades) =>
        [...trades.values()].filter((t) => t.status !== "resolved" && t.status !== "cancelled"),
      ),
    );

    const getAllTrades = Ref.get(tradesRef).pipe(
      Effect.map((trades) => [...trades.values()]),
    );

    const getTrades = (limit = 100) =>
      Ref.get(tradesRef).pipe(
        Effect.map((trades) =>
          [...trades.values()].slice(-limit).reverse().map(toTradeRecord),
        ),
      );

    const getSummary = Ref.get(tradesRef).pipe(Effect.map(computeSummary));

    return {
      appendEvent,
      createTrade,
      getTrade,
      getOpenTrades,
      getAllTrades,
      getTrades,
      getSummary,
    } satisfies TradeStoreService;
  });

export class TradeStore extends Effect.Service<TradeStore>()("TradeStore", {
  scoped: makeTradeStore(false),
}) {}

export class ShadowTradeStore extends Effect.Service<ShadowTradeStore>()("ShadowTradeStore", {
  scoped: makeTradeStore(true),
}) {}

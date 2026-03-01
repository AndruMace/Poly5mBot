import { Effect, Ref, Chunk, Schedule, Queue, Option } from "effect";
import { FileSystem } from "@effect/platform";
import crypto from "crypto";
import { AppConfig } from "../config.js";
import { PostgresStorage } from "../storage/postgres.js";
import { ObservabilityStore } from "../observability/store.js";
import type {
  Trade,
  TradeEvent,
  TradeEventType,
  TradeRecord,
  PnLSummary,
  EntryContext,
} from "../types.js";

const DATA_DIR = "data";
const LIVE_FILE = "data/events.jsonl";
const SHADOW_FILE = "data/shadow-events.jsonl";
const PNL_HISTORY_MAX_POINTS = 300;

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
      trade.status = "rejected";
      if (typeof event.data.reason === "string") trade.clobReason = event.data.reason;
      if (typeof event.data.result === "string") trade.clobResult = event.data.result;
      break;
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
      trade.resolutionSource = event.data.outcomeSource === "venue" ? "venue" : "estimated";
      trade.settlementWinnerSide =
        event.data.settlementWinnerSide === "UP" || event.data.settlementWinnerSide === "DOWN"
          ? event.data.settlementWinnerSide
          : null;
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
  entryContext?: EntryContext;
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
    resolutionSource: undefined,
    settlementWinnerSide: null,
    clobOrderId: init.clobOrderId,
    clobResult: init.clobResult,
    clobReason: init.clobReason,
    entryContext: init.entryContext,
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
    resolutionSource: t.resolutionSource,
    settlementWinnerSide: t.settlementWinnerSide ?? null,
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
    entryContext: t.entryContext,
  } as TradeRecord;
}

function computeSummary(trades: Map<string, Trade>): PnLSummary {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();

  let totalPnl = 0;
  let todayPnl = 0;
  let totalTrades = 0;
  let totalWins = 0;
  let cumulativePnl = 0;

  const history: Array<{ timestamp: number; cumulativePnl: number }> = [];
  const strategyAgg: Record<string, { pnl: number; trades: number; wins: number }> = {};

  for (const trade of trades.values()) {
    if (trade.status !== "resolved") continue;

    totalTrades += 1;
    totalPnl += trade.pnl;

    const ts = trade.events[0]?.timestamp ?? 0;
    if (ts >= todayStartMs) {
      todayPnl += trade.pnl;
    }

    const won = trade.outcome === "win";
    if (won) totalWins += 1;

    if (!strategyAgg[trade.strategy]) {
      strategyAgg[trade.strategy] = { pnl: 0, trades: 0, wins: 0 };
    }
    const strat = strategyAgg[trade.strategy]!;
    strat.pnl += trade.pnl;
    strat.trades += 1;
    if (won) strat.wins += 1;

    cumulativePnl += trade.pnl;
    history.push({ timestamp: ts, cumulativePnl });
    if (history.length > PNL_HISTORY_MAX_POINTS) {
      history.shift();
    }
  }

  const byStrategy: PnLSummary["byStrategy"] = {};
  for (const [strategy, agg] of Object.entries(strategyAgg)) {
    byStrategy[strategy] = {
      pnl: agg.pnl,
      trades: agg.trades,
      winRate: agg.trades > 0 ? (agg.wins / agg.trades) * 100 : 0,
    };
  }

  const winRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;

  return {
    totalPnl,
    todayPnl,
    totalTrades,
    winRate,
    byStrategy,
    history,
  } satisfies PnLSummary;
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
    entryContext?: EntryContext;
  }) => Effect.Effect<Trade>;
  readonly getTrade: (id: string) => Effect.Effect<Trade | undefined>;
  readonly getOpenTrades: Effect.Effect<ReadonlyArray<Trade>>;
  readonly getAllTrades: Effect.Effect<ReadonlyArray<Trade>>;
  readonly getTrades: (limit?: number) => Effect.Effect<ReadonlyArray<TradeRecord>>;
  readonly getSummary: Effect.Effect<PnLSummary>;
}

export const makeTradeStore = (shadow: boolean) =>
  Effect.gen(function* () {
    const configOpt = yield* Effect.serviceOption(AppConfig);
    const postgresOpt = yield* Effect.serviceOption(PostgresStorage);
    const observabilityOpt = yield* Effect.serviceOption(ObservabilityStore);
    const backend = Option.match(configOpt, {
      onNone: () => "file" as const,
      onSome: (cfg) => cfg.storage.backend,
    });
    const postgres = Option.getOrUndefined(postgresOpt);
    const observability = Option.getOrUndefined(observabilityOpt);
    const fs = yield* FileSystem.FileSystem;
    const filePath = shadow ? SHADOW_FILE : LIVE_FILE;
    const stream = shadow ? "shadow" : "live";
    const useFile = backend === "file" || backend === "dual";
    const usePostgres = !!postgres && (backend === "postgres" || backend === "dual");
    const tradesRef = yield* Ref.make(new Map<string, Trade>());
    const logTradeObservability = (trade: Trade, type: TradeEventType, data: Record<string, unknown>) =>
      observability
        ? observability.append({
            category: "trade_lifecycle",
            source: "trade_store",
            action: `trade_event:${type}`,
            entityType: "trade",
            entityId: trade.id,
            status: trade.status,
            strategy: trade.strategy,
            mode: trade.shadow ? "shadow" : "live",
            payload: {
              tradeId: trade.id,
              eventType: type,
              status: trade.status,
              strategy: trade.strategy,
              side: trade.side,
              conditionId: trade.conditionId,
              clobOrderId: trade.clobOrderId ?? null,
              data,
            },
          }).pipe(Effect.catchAll(() => Effect.void))
        : Effect.void;

    const writeQueue = yield* Queue.unbounded<string>();

    const flushLoop = Effect.gen(function* () {
      const items = yield* Queue.takeAll(writeQueue);
      if (Chunk.size(items) === 0) return;
      if (useFile) {
        const data = Chunk.toReadonlyArray(items).join("");
        yield* fs.makeDirectory(DATA_DIR, { recursive: true }).pipe(Effect.catchAll(() => Effect.void));
        yield* fs.writeFileString(filePath, data, { flag: "a" }).pipe(
          Effect.catchAll((err) => Effect.logError(`[TradeStore] Failed to persist events: ${err}`)),
        );
      }
    }).pipe(
      Effect.repeat(Schedule.fixed("200 millis")),
      Effect.catchAll(() => Effect.void),
      Effect.forkScoped,
    );
    yield* flushLoop;

    const replay = Effect.gen(function* () {
      const initEvents: TradeEvent[] = [];
      if (useFile) {
        const exists = yield* fs.exists(filePath);
        if (exists) {
          const content = yield* fs.readFileString(filePath);
          const lines = content.split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              initEvents.push(JSON.parse(line));
            } catch {
              /* skip corrupt lines */
            }
          }
        }
      }
      if (usePostgres) {
        const rows = yield* postgres!.query<{
          id: string;
          trade_id: string;
          event_type: string;
          event_ts: number;
          data: Record<string, unknown>;
        }>(
          "select id, trade_id, event_type, event_ts, data from trade_events where stream = $1 order by event_ts asc",
          [stream],
        ).pipe(Effect.catchAll(() => Effect.succeed([])));
        for (const row of rows) {
          initEvents.push({
            id: String(row.id),
            tradeId: String(row.trade_id),
            type: row.event_type as TradeEventType,
            timestamp: Number(row.event_ts ?? 0),
            data: row.data ?? {},
          });
        }
      }
      const deduped = new Map<string, TradeEvent>();
      for (const e of initEvents) {
        deduped.set(e.id, e);
      }
      const replayEvents = [...deduped.values()].sort((a, b) => a.timestamp - b.timestamp);
      const tradeIds = new Set(replayEvents.map((e) => e.tradeId));
      yield* Ref.update(tradesRef, (trades) => {
        for (const id of tradeIds) {
          const first = replayEvents.find((e) => e.tradeId === id && e.type === "signal_generated");
          if (first?.data) {
            const ec = first.data.entryContext as EntryContext | undefined;
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
              entryContext: ec,
            });
            trades.set(id, t);
          }
        }
        for (const event of replayEvents) {
          const trade = trades.get(event.tradeId);
          if (trade) applyEventToTrade(trade, event);
        }
        return trades;
      });
      yield* Effect.log(`[TradeStore] Replayed ${replayEvents.length} events for ${tradeIds.size} trades`);
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
        if (useFile) {
          yield* Queue.offer(writeQueue, JSON.stringify(event) + "\n");
        }
        const updatedTrade = yield* Ref.get(tradesRef).pipe(Effect.map((m) => m.get(event.tradeId)));
        if (updatedTrade) {
          yield* logTradeObservability(updatedTrade, type, data);
        }
        if (usePostgres) {
          yield* postgres!.execute(
            "insert into trade_events (id, trade_id, stream, event_type, event_ts, data) values ($1, $2, $3, $4, $5, $6::jsonb) on conflict (id) do nothing",
            [event.id, event.tradeId, stream, event.type, event.timestamp, JSON.stringify(event.data ?? {})],
          ).pipe(Effect.catchAll(() => Effect.void));
          if (updatedTrade) {
            const record = toTradeRecord(updatedTrade);
            yield* postgres!.execute(
              `insert into trades_projection
                (id, stream, strategy, side, token_id, status, outcome, size, shares, fee, pnl, timestamp_ms, window_end_ms, condition_id, clob_order_id, clob_result, clob_reason, payload)
               values
                ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
               on conflict (id) do update set
                stream=excluded.stream,
                strategy=excluded.strategy,
                side=excluded.side,
                token_id=excluded.token_id,
                status=excluded.status,
                outcome=excluded.outcome,
                size=excluded.size,
                shares=excluded.shares,
                fee=excluded.fee,
                pnl=excluded.pnl,
                timestamp_ms=excluded.timestamp_ms,
                window_end_ms=excluded.window_end_ms,
                condition_id=excluded.condition_id,
                clob_order_id=excluded.clob_order_id,
                clob_result=excluded.clob_result,
                clob_reason=excluded.clob_reason,
                payload=excluded.payload`,
              [
                record.id,
                stream,
                record.strategy,
                record.side,
                record.tokenId,
                record.status,
                record.outcome,
                record.size,
                record.shares,
                record.fee,
                record.pnl,
                record.timestamp,
                record.windowEnd,
                record.conditionId,
                record.clobOrderId ?? null,
                record.clobResult ?? null,
                record.clobReason ?? null,
                JSON.stringify(record),
              ],
            ).pipe(Effect.catchAll(() => Effect.void));
          }
        }
        return event;
      });

    const createTrade = (init: Parameters<TradeStoreService["createTrade"]>[0]) =>
      Effect.gen(function* () {
        const trade = yield* Ref.modify(tradesRef, (trades) => {
          const t = makeTrade(init);
          trades.set(t.id, t);
          return [t, trades] as const;
        });
        if (observability) {
          yield* observability.append({
            category: "trade_lifecycle",
            source: "trade_store",
            action: "trade_created",
            entityType: "trade",
            entityId: trade.id,
            status: trade.status,
            strategy: trade.strategy,
            mode: trade.shadow ? "shadow" : "live",
            payload: {
              tradeId: trade.id,
              conditionId: trade.conditionId,
              strategy: trade.strategy,
              side: trade.side,
              size: trade.size,
              requestedShares: trade.requestedShares,
            },
          }).pipe(Effect.catchAll(() => Effect.void));
        }
        return trade;
      });

    const getTrade = (id: string) =>
      Ref.get(tradesRef).pipe(Effect.map((trades) => trades.get(id)));

    const getOpenTrades = Ref.get(tradesRef).pipe(
      Effect.map((trades) =>
        [...trades.values()].filter(
          (t) => t.status !== "resolved" && t.status !== "cancelled" && t.status !== "rejected",
        ),
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

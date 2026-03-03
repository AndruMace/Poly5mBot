import { Effect, Ref } from "effect";
import type { EntryContext, EngineEvent, MarketContext, Signal, StrategyDiagnostics } from "../types.js";
import type { EngineState } from "./state.js";
import { preflightShadowBuy } from "./shadow-preflight.js";
import type { SimulatorOpts } from "./fill-simulator.js";

interface ExecutionDeps {
  stateRef: Ref.Ref<EngineState>;
  minFillRatioByStrategy: Record<string, number>;
  shadowSimOptsByStrategy: Record<string, SimulatorOpts>;
  fillSimulator: {
    simulate: (
      side: "BUY" | "SELL",
      tokenId: string,
      shares: number,
      maxPrice: number,
      book: { bids: Array<{ price: number; size: number }>; asks: Array<{ price: number; size: number }> },
      opts?: SimulatorOpts,
    ) => {
      filled: boolean;
      filledShares: number;
      avgPrice: number;
      fee: number;
      reason?: string;
    };
  };
  tracker: {
    shadowStore: {
      createTrade: (input: any) => Effect.Effect<void, any, never>;
      appendEvent: (
        tradeId: string,
        type: "signal_generated" | "order_submitted" | "cancel" | "partial_fill" | "fill",
        data: Record<string, unknown>,
      ) => Effect.Effect<void, any, never>;
    };
    getTradeRecordById: (id: string, shadow: boolean) => Effect.Effect<any, any, never>;
    addTrade: (trade: any) => Effect.Effect<void, any, never>;
  };
  orderService: {
    executeDualBuy: (...args: any[]) => Effect.Effect<any[], any, never>;
    executeSignal: (...args: any[]) => Effect.Effect<any | null, any, never>;
  };
  riskManager: {
    onTradeOpened: (trade: any, shadow?: boolean) => Effect.Effect<void, any, never>;
  };
  emit: (event: EngineEvent) => Effect.Effect<void, any, never>;
  bumpDiag: (
    st: EngineState,
    strategy: string,
    key: keyof StrategyDiagnostics,
    delta: number,
    isShadowMode?: boolean,
  ) => void;
  recordSignalLatency: (st: EngineState, ms: number) => void;
  haltTradingWithIncident: (incident: {
    kind: "unmatched_account_fill" | "oversize_account_fill" | "efficiency_partial_incident" | "reconciler_error";
    message: string;
    fingerprint: string;
    details: Record<string, unknown>;
  }) => Effect.Effect<void, any, never>;
}

export function makeExecutionHandlers(deps: ExecutionDeps) {
  let tradeCounter = 0;

  const executeShadow = (signal: Signal, conditionId: string, ptb: number, ctx: MarketContext, entryCtx: EntryContext) =>
    Effect.gen(function* () {
      const st = yield* Ref.get(deps.stateRef);
      if (!st.currentWindow) return false;

      const tokenId = signal.side === "UP" ? st.currentWindow.upTokenId : st.currentWindow.downTokenId;
      const notional = signal.size;
      const book = signal.side === "UP" ? st.orderBook.up : st.orderBook.down;
      const preflight = preflightShadowBuy(notional, signal.maxPrice, book);
      if (!preflight.allowed) {
        yield* Ref.update(deps.stateRef, (s) => {
          deps.bumpDiag(s, signal.strategy, "liquidityFail", 1, true);
          return s;
        });
        yield* Effect.log(
          `[Shadow] ${signal.strategy} ${signal.side} skipped: ${preflight.reason}`,
        );
        return false;
      }

      const shares = Math.floor(preflight.requestedShares * 100) / 100;

      const simOpts = deps.shadowSimOptsByStrategy[signal.strategy];
      const result = deps.fillSimulator.simulate("BUY", tokenId, shares, signal.maxPrice, book, simOpts);

      const tradeId = `shadow-${++tradeCounter}-${Date.now()}`;
      const signalToSubmitMs = Math.max(0, Date.now() - signal.timestamp);

      yield* deps.tracker.shadowStore.createTrade({
        id: tradeId, conditionId, strategy: signal.strategy, side: signal.side,
        tokenId, priceToBeatAtEntry: ptb, windowEnd: st.currentWindow.endTime,
        shadow: true, size: notional, requestedShares: shares,
        entryContext: entryCtx,
      });
      yield* deps.tracker.shadowStore.appendEvent(tradeId, "signal_generated", {
        conditionId, strategy: signal.strategy, side: signal.side, tokenId,
        priceToBeatAtEntry: ptb, windowEnd: st.currentWindow.endTime,
        shadow: true, size: notional, requestedShares: shares,
        entryContext: entryCtx,
      });
      yield* deps.tracker.shadowStore.appendEvent(tradeId, "order_submitted", { shares, price: signal.maxPrice });
      const submittedRecord = yield* deps.tracker.getTradeRecordById(tradeId, true);
      if (submittedRecord) {
        (submittedRecord as any).shadow = true;
        yield* deps.emit({ _tag: "Trade", data: submittedRecord });
      }

      yield* Ref.update(deps.stateRef, (s) => {
        deps.bumpDiag(s, signal.strategy, "submitted", 1, true);
        deps.recordSignalLatency(s, signalToSubmitMs);
        return s;
      });

      if (!result.filled) {
        yield* deps.tracker.shadowStore.appendEvent(tradeId, "cancel", { reason: result.reason });
        yield* Ref.update(deps.stateRef, (s) => {
          if (result.reason === "queue_position_miss") {
            deps.bumpDiag(s, signal.strategy, "queueMiss", 1, true);
          } else if (result.reason === "insufficient_liquidity" || result.reason === "no_liquidity") {
            deps.bumpDiag(s, signal.strategy, "liquidityFail", 1, true);
          }
          return s;
        });
        const cancelledRecord = yield* deps.tracker.getTradeRecordById(tradeId, true);
        if (cancelledRecord) {
          (cancelledRecord as any).shadow = true;
          yield* deps.emit({ _tag: "Trade", data: cancelledRecord });
        }
        yield* Effect.log(`[Shadow] ${signal.strategy} ${signal.side} cancelled: ${result.reason}`);
        return false;
      }

      const fillRatio = shares > 0 ? result.filledShares / shares : 0;
      const minFill = deps.minFillRatioByStrategy[signal.strategy] ?? 0.5;
      if (fillRatio < minFill) {
        yield* deps.tracker.shadowStore.appendEvent(tradeId, "cancel", { reason: "low_fill_ratio", fillRatio, minFillRatio: minFill });
        yield* Ref.update(deps.stateRef, (s) => {
          deps.bumpDiag(s, signal.strategy, "lowFillCancel", 1, true);
          return s;
        });
        const cancelledRecord = yield* deps.tracker.getTradeRecordById(tradeId, true);
        if (cancelledRecord) {
          (cancelledRecord as any).shadow = true;
          yield* deps.emit({ _tag: "Trade", data: cancelledRecord });
        }
        return false;
      }

      if (result.filledShares < shares) {
        yield* deps.tracker.shadowStore.appendEvent(tradeId, "partial_fill", { shares: result.filledShares, price: result.avgPrice, fee: result.fee });
        yield* Ref.update(deps.stateRef, (s) => { deps.bumpDiag(s, signal.strategy, "partialFill", 1, true); return s; });
      } else {
        yield* deps.tracker.shadowStore.appendEvent(tradeId, "fill", { shares: result.filledShares, price: result.avgPrice, fee: result.fee });
        yield* Ref.update(deps.stateRef, (s) => { deps.bumpDiag(s, signal.strategy, "fullFill", 1, true); return s; });
      }

      const record = yield* deps.tracker.getTradeRecordById(tradeId, true);
      if (record) {
        (record as any).shadow = true;
        yield* deps.riskManager.onTradeOpened(record, true);
        yield* deps.emit({ _tag: "Trade", data: record });
      }

      yield* Effect.log(`[Shadow] ${signal.strategy} ${signal.side} filled ${result.filledShares} @ $${result.avgPrice.toFixed(4)}`);
      return true;
    });

  const executeLive = (signal: Signal, conditionId: string, ptb: number, entryCtx: EntryContext) =>
    Effect.gen(function* () {
      const st = yield* Ref.get(deps.stateRef);
      if (!st.currentWindow) return false;

      const signalToSubmitMs = Math.max(0, Date.now() - signal.timestamp);
      yield* Ref.update(deps.stateRef, (s) => { deps.recordSignalLatency(s, signalToSubmitMs); return s; });

      if (signal.strategy === "efficiency") {
        const trades = yield* deps.orderService.executeDualBuy(
          st.currentWindow.upTokenId, st.currentWindow.downTokenId,
          st.orderBook.bestAskUp!, st.orderBook.bestAskDown!,
          signal.size, st.currentWindow.endTime, conditionId, ptb,
        );
        let incident = false;
        for (const trade of trades) {
          trade.entryContext = entryCtx;
          if (trade.strategy === "efficiency-partial") {
            incident = true;
          }
          yield* Ref.update(deps.stateRef, (s) => { deps.bumpDiag(s, signal.strategy, "submitted", 1, false); return s; });
          yield* deps.tracker.addTrade(trade);
          if (trade.status === "filled" || trade.status === "partial" || trade.status === "submitted") {
            yield* deps.riskManager.onTradeOpened(trade);
            yield* Ref.update(deps.stateRef, (s) => {
              const diagKey = trade.status === "partial" ? "partialFill" : trade.status === "submitted" ? "submitted" : "fullFill";
              deps.bumpDiag(s, signal.strategy, diagKey, 1, false);
              return s;
            });
          } else if (trade.status === "cancelled" || trade.status === "rejected") {
            yield* Ref.update(deps.stateRef, (s) => {
              deps.bumpDiag(s, signal.strategy, "liveRejected", 1, false);
              return s;
            });
          }
          // Emit the stored record so the WS message timestamp matches what the
          // API and cursor pagination return (both use the event-sourced timestamp).
          const stored = yield* deps.tracker.getTradeRecordById(trade.id, false);
          yield* deps.emit({ _tag: "Trade", data: stored ?? trade });
        }
        if (incident) {
          yield* Ref.update(deps.stateRef, (s) => ({
            ...s,
            efficiencyIncidentBlocked: true,
            tradingActive: false,
          }));
          yield* deps.emit({ _tag: "TradingActive", data: { tradingActive: false } });
          yield* deps.haltTradingWithIncident({
            kind: "efficiency_partial_incident",
            message: "Efficiency dual-leg incident detected. Trading paused until manual intervention.",
            fingerprint: `efficiency-partial:${conditionId}:${Date.now()}`,
            details: {
              conditionId,
              strategy: signal.strategy,
              side: signal.side,
              size: signal.size,
            },
          });
          yield* Effect.logError(
            "[Engine] Efficiency dual-leg incident detected. Trading paused and efficiency strategy blocked until manual restart.",
          );
          return false;
        }
        return trades.some(
          (t) => t.status === "submitted" || t.status === "partial" || t.status === "filled",
        );
      }

      const trade = yield* deps.orderService.executeSignal(
        signal, st.currentWindow.upTokenId, st.currentWindow.downTokenId,
        st.currentWindow.endTime, conditionId, ptb,
      );
      if (trade) {
        trade.entryContext = entryCtx;
        yield* Ref.update(deps.stateRef, (s) => { deps.bumpDiag(s, signal.strategy, "submitted", 1, false); return s; });
        yield* deps.tracker.addTrade(trade);
        if (trade.status === "filled" || trade.status === "partial" || trade.status === "submitted") {
          yield* deps.riskManager.onTradeOpened(trade);
          yield* Ref.update(deps.stateRef, (s) => {
            const diagKey = trade.status === "partial" ? "partialFill" : trade.status === "submitted" ? "submitted" : "fullFill";
            deps.bumpDiag(s, signal.strategy, diagKey, 1, false);
            return s;
          });
        } else if (trade.status === "cancelled" || trade.status === "rejected") {
          yield* Ref.update(deps.stateRef, (s) => { deps.bumpDiag(s, signal.strategy, "liveRejected", 1, false); return s; });
        }
        // Emit the stored record so the WS message timestamp matches what the
        // API and cursor pagination return (both use the event-sourced timestamp).
        const stored = yield* deps.tracker.getTradeRecordById(trade.id, false);
        yield* deps.emit({ _tag: "Trade", data: stored ?? trade });
        return trade.status === "submitted" || trade.status === "partial" || trade.status === "filled";
      }
      yield* Ref.update(deps.stateRef, (s) => { deps.bumpDiag(s, signal.strategy, "liveRejected", 1, false); return s; });
      return false;
    });

  const executeStrategy = (signal: Signal, shadow: boolean, ctx: MarketContext, entryCtx: EntryContext) =>
    Effect.gen(function* () {
      const st = yield* Ref.get(deps.stateRef);
      if (!st.currentWindow) return false;
      const conditionId = st.currentWindow.conditionId;
      const ptb = st.currentWindow.priceToBeat ?? 0;

      if (shadow) {
        return yield* executeShadow(signal, conditionId, ptb, ctx, entryCtx);
      }
      return yield* executeLive(signal, conditionId, ptb, entryCtx);
    });

  return {
    executeStrategy,
  } as const;
}

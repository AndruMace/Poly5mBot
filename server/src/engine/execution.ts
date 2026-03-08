import { Effect, Ref } from "effect";
import type { EntryContext, EngineEvent, MarketContext, Signal, StrategyDiagnostics } from "../types.js";
import type { EngineState } from "./state.js";
import { preflightShadowBuy } from "./shadow-preflight.js";
import type { SimulatorOpts } from "./fill-simulator.js";
import type { WhaleHuntConfig } from "../strategies/whale-hunt-config.js";
import { effectiveFeeRateStatic } from "../polymarket/orders.js";

function computeLatencyGuardLeadMs(observedLatencyMs: number, cfg: WhaleHuntConfig): number {
  return Math.max(
    cfg.minRequiredLeadMs,
    observedLatencyMs * cfg.latencyMultiplier + cfg.latencyBufferMs,
  );
}

type ExecutionResult = {
  executed: boolean;
  rejectClass?: "precision_invalid_local" | "precision_rejected_by_venue" | "silent_null_execution";
  rejectReason?: string;
};

function classifyReject(reason: string | undefined): ExecutionResult["rejectClass"] | undefined {
  if (!reason) return undefined;
  const normalized = reason.toLowerCase();
  if (normalized.includes("precision_invalid_local")) return "precision_invalid_local";
  if (
    normalized.includes("invalid amounts")
    || normalized.includes("max accuracy of 2 decimals")
    || normalized.includes("taker amount a max of 4 decimals")
  ) {
    return "precision_rejected_by_venue";
  }
  return undefined;
}

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
    executeSell: (...args: any[]) => Effect.Effect<any, any, never>;
    getOrderBook: (tokenId: string) => Effect.Effect<any, any, never>;
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
  whaleHuntConfig: WhaleHuntConfig;
  efficiencyRecovery: {
    maxLegImbalanceMs: number;
    maxHedgeRetries: number;
    maxResidualExposureUsd: number;
    maxUnwindSlippageBps: number;
  };
  logPrefix: string;
}

function isLiveExecutedStatus(status: string | null | undefined): boolean {
  return status === "submitted" || status === "partial" || status === "filled";
}

function getBestAskFromBook(book: unknown): number | null {
  if (!book || typeof book !== "object") return null;
  const asks = (book as any).asks;
  if (!Array.isArray(asks) || asks.length === 0) return null;
  const first = asks[0];
  const raw = first?.price;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function getBestBidFromBook(book: unknown): number | null {
  if (!book || typeof book !== "object") return null;
  const bids = (book as any).bids;
  if (!Array.isArray(bids) || bids.length === 0) return null;
  const first = bids[0];
  const raw = first?.price;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function floorTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.floor((value + Number.EPSILON) * factor) / factor;
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
          `${deps.logPrefix} [Shadow] ${signal.strategy} ${signal.side} skipped: ${preflight.reason}`,
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
        yield* Effect.log(`${deps.logPrefix} [Shadow] ${signal.strategy} ${signal.side} cancelled: ${result.reason}`);
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

      yield* Effect.log(`${deps.logPrefix} [Shadow] ${signal.strategy} ${signal.side} filled ${result.filledShares} @ $${result.avgPrice.toFixed(4)}`);
      return true;
    });

  const executeLive = (signal: Signal, conditionId: string, ptb: number, entryCtx: EntryContext) =>
    Effect.gen(function* () {
      const st = yield* Ref.get(deps.stateRef);
      if (!st.currentWindow) return { executed: false } as ExecutionResult;

      const signalToSubmitMs = Math.max(0, Date.now() - signal.timestamp);
      yield* Ref.update(deps.stateRef, (s) => { deps.recordSignalLatency(s, signalToSubmitMs); return s; });

      if (signal.strategy === "whale-hunt") {
        const remainingMs = st.currentWindow.endTime - Date.now();
        const observedLatencyMs = Math.max(
          signalToSubmitMs,
          st.metrics.latency.lastSignalToSubmitMs,
          st.metrics.latency.avgRecentSignalToSubmitMs,
        );
        const requiredLeadMs = computeLatencyGuardLeadMs(observedLatencyMs, deps.whaleHuntConfig);
        if (remainingMs <= requiredLeadMs) {
          yield* Ref.update(deps.stateRef, (s) => {
            deps.bumpDiag(s, signal.strategy, "riskRejected", 1, false);
            return s;
          });
          yield* Effect.log(
            `${deps.logPrefix} whale-hunt ${signal.side} blocked by latency guard: latency ${Math.round(observedLatencyMs)}ms, remaining ${Math.round(remainingMs)}ms, required lead ${Math.round(requiredLeadMs)}ms`,
          );
          return { executed: false } as ExecutionResult;
        }
      }

      if (signal.strategy === "efficiency") {
        const persistLiveTrade = (trade: any) =>
          Effect.gen(function* () {
            trade.entryContext = entryCtx;
            yield* Ref.update(deps.stateRef, (s) => {
              deps.bumpDiag(s, signal.strategy, "submitted", 1, false);
              return s;
            });
            yield* deps.tracker.addTrade(trade);
            if (isLiveExecutedStatus(trade.status)) {
              yield* deps.riskManager.onTradeOpened(trade);
              yield* Ref.update(deps.stateRef, (s) => {
                const diagKey = trade.status === "partial" ? "partialFill" : trade.status === "submitted" ? "submitted" : "fullFill";
                deps.bumpDiag(s, signal.strategy, diagKey, 1, false);
                return s;
              });
            } else if (trade.status === "cancelled" || trade.status === "rejected") {
              const rejectClass = classifyReject(trade.clobReason);
              yield* Ref.update(deps.stateRef, (s) => {
                deps.bumpDiag(s, signal.strategy, "liveRejected", 1, false);
                if (rejectClass === "precision_invalid_local" || rejectClass === "precision_rejected_by_venue") {
                  deps.bumpDiag(s, signal.strategy, "precisionRejected", 1, false);
                }
                return s;
              });
            }
            const stored = yield* deps.tracker.getTradeRecordById(trade.id, false);
            yield* deps.emit({ _tag: "Trade", data: stored ?? trade });
          });

        const trades = yield* deps.orderService.executeDualBuy(
          st.currentWindow.upTokenId, st.currentWindow.downTokenId,
          st.orderBook.bestAskUp!, st.orderBook.bestAskDown!,
          signal.size, st.currentWindow.endTime, conditionId, ptb,
        );
        for (const trade of trades) {
          yield* persistLiveTrade(trade);
        }

        const partialIncidentTrade = trades.find((t) => t.strategy === "efficiency-partial");
        if (partialIncidentTrade && isLiveExecutedStatus(partialIncidentTrade.status)) {
          const elapsedMs = Date.now() - partialIncidentTrade.timestamp;
          const withinLegImbalanceLimit = elapsedMs <= deps.efficiencyRecovery.maxLegImbalanceMs;
          let recovered = false;
          let terminalState: "hedged" | "flattened" | "paused_with_residual" = "paused_with_residual";
          let residualExposureUsd = partialIncidentTrade.size;

          if (withinLegImbalanceLimit) {
            const oppositeSide: "UP" | "DOWN" = partialIncidentTrade.side === "UP" ? "DOWN" : "UP";
            const oppositeTokenId = oppositeSide === "UP" ? st.currentWindow.upTokenId : st.currentWindow.downTokenId;
            for (let attempt = 1; attempt <= deps.efficiencyRecovery.maxHedgeRetries; attempt += 1) {
              const oppositeBook = yield* deps.orderService.getOrderBook(oppositeTokenId);
              const oppositeBestAsk = getBestAskFromBook(oppositeBook);
              if (oppositeBestAsk === null) break;
              const sumCost = partialIncidentTrade.entryPrice + oppositeBestAsk;
              const expectedNetBps = (1 - sumCost - effectiveFeeRateStatic(partialIncidentTrade.entryPrice) - effectiveFeeRateStatic(oppositeBestAsk)) * 10_000;
              if (expectedNetBps <= 0) {
                break;
              }
              const hedgeMaxPrice = floorTo(oppositeBestAsk * (1 + deps.efficiencyRecovery.maxUnwindSlippageBps / 10_000), 2);
              const hedgeSignal: Signal = {
                side: oppositeSide,
                confidence: Math.max(0.5, signal.confidence),
                size: partialIncidentTrade.size,
                maxPrice: hedgeMaxPrice,
                strategy: "efficiency",
                reason: `efficiency_recovery_hedge_attempt_${attempt}`,
                timestamp: Date.now(),
              };
              const hedgeTrade = yield* deps.orderService.executeSignal(
                hedgeSignal,
                st.currentWindow.upTokenId,
                st.currentWindow.downTokenId,
                st.currentWindow.endTime,
                conditionId,
                ptb,
              );
              if (!hedgeTrade) continue;
              yield* persistLiveTrade(hedgeTrade);
              if (isLiveExecutedStatus(hedgeTrade.status)) {
                residualExposureUsd = Math.max(0, partialIncidentTrade.size - hedgeTrade.size);
                if (residualExposureUsd <= deps.efficiencyRecovery.maxResidualExposureUsd) {
                  recovered = true;
                  terminalState = "hedged";
                  break;
                }
              }
            }
          }

          if (!recovered) {
            const sameLegBook = yield* deps.orderService.getOrderBook(partialIncidentTrade.tokenId);
            const sameLegBestBid = getBestBidFromBook(sameLegBook);
            if (sameLegBestBid !== null) {
              const minPrice = floorTo(Math.max(0.01, sameLegBestBid * (1 - deps.efficiencyRecovery.maxUnwindSlippageBps / 10_000)), 2);
              const closeTrade = yield* deps.orderService.executeSell(
                partialIncidentTrade.tokenId,
                partialIncidentTrade.side,
                "efficiency-flatten",
                partialIncidentTrade.shares,
                minPrice,
                st.currentWindow.endTime,
                conditionId,
                ptb,
              );
              if (closeTrade) {
                yield* persistLiveTrade(closeTrade);
                if (isLiveExecutedStatus(closeTrade.status)) {
                  const residualShares = Math.max(0, partialIncidentTrade.shares - closeTrade.shares);
                  residualExposureUsd = residualShares * partialIncidentTrade.entryPrice;
                  if (residualExposureUsd <= deps.efficiencyRecovery.maxResidualExposureUsd) {
                    recovered = true;
                    terminalState = "flattened";
                  }
                }
              }
            }
          }

          if (!recovered) {
            terminalState = "paused_with_residual";
          }

          if (terminalState === "paused_with_residual") {
            const incidentReason = withinLegImbalanceLimit
              ? "hedge_or_flatten_failed"
              : "max_leg_imbalance_exceeded";
            yield* Ref.update(deps.stateRef, (s) => ({
              ...s,
              efficiencyIncidentBlocked: true,
              tradingActive: false,
            }));
            yield* deps.emit({ _tag: "TradingActive", data: { tradingActive: false } });
            yield* deps.haltTradingWithIncident({
              kind: "efficiency_partial_incident",
              message: "Efficiency dual-leg recovery failed. Trading paused until manual intervention.",
              fingerprint: `efficiency-partial:${conditionId}:${Date.now()}`,
              details: {
                conditionId,
                strategy: signal.strategy,
                side: signal.side,
                size: signal.size,
                reason: incidentReason,
                terminalState,
                residualExposureUsd: Number(residualExposureUsd.toFixed(2)),
              },
            });
            yield* Effect.logError(
              `${deps.logPrefix} Efficiency recovery failed (${incidentReason}); paused with residual $${residualExposureUsd.toFixed(2)}.`,
            );
            return { executed: false } as ExecutionResult;
          }

          yield* Effect.log(
            `${deps.logPrefix} Efficiency recovery completed (${terminalState}) residual=$${residualExposureUsd.toFixed(2)}.`,
          );
          return { executed: true } as ExecutionResult;
        }

        if (partialIncidentTrade) {
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
            `${deps.logPrefix} Efficiency dual-leg incident detected. Trading paused and efficiency strategy blocked until manual restart.`,
          );
          return { executed: false } as ExecutionResult;
        }
        const executed = trades.some(
          (t) => isLiveExecutedStatus(t.status),
        );
        if (executed) return { executed } as ExecutionResult;
        const firstReject = trades.find((t) => t.status === "rejected" || t.status === "cancelled");
        const rejectReason = firstReject?.clobReason;
        return {
          executed: false,
          rejectClass: classifyReject(rejectReason),
          rejectReason,
        } as ExecutionResult;
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
          const rejectClass = classifyReject(trade.clobReason);
          yield* Ref.update(deps.stateRef, (s) => {
            deps.bumpDiag(s, signal.strategy, "liveRejected", 1, false);
            if (rejectClass === "precision_invalid_local" || rejectClass === "precision_rejected_by_venue") {
              deps.bumpDiag(s, signal.strategy, "precisionRejected", 1, false);
            }
            return s;
          });
        }
        // Emit the stored record so the WS message timestamp matches what the
        // API and cursor pagination return (both use the event-sourced timestamp).
        const stored = yield* deps.tracker.getTradeRecordById(trade.id, false);
        yield* deps.emit({ _tag: "Trade", data: stored ?? trade });
        const executed = trade.status === "submitted" || trade.status === "partial" || trade.status === "filled";
        if (executed) {
          return { executed: true } as ExecutionResult;
        }
        const rejectReason = trade.clobReason;
        return {
          executed: false,
          rejectClass: classifyReject(rejectReason),
          rejectReason,
        } as ExecutionResult;
      }
      yield* Ref.update(deps.stateRef, (s) => {
        deps.bumpDiag(s, signal.strategy, "liveRejected", 1, false);
        deps.bumpDiag(s, signal.strategy, "silentNullExecution", 1, false);
        return s;
      });
      return {
        executed: false,
        rejectClass: "silent_null_execution",
        rejectReason: "order_service_returned_null",
      } as ExecutionResult;
    });

  const executeStrategy = (signal: Signal, shadow: boolean, ctx: MarketContext, entryCtx: EntryContext) =>
    Effect.gen(function* () {
      const st = yield* Ref.get(deps.stateRef);
      if (!st.currentWindow) return { executed: false } as ExecutionResult;
      const conditionId = st.currentWindow.conditionId;
      const ptb = st.currentWindow.priceToBeat ?? 0;

      if (shadow) {
        const executed = yield* executeShadow(signal, conditionId, ptb, ctx, entryCtx);
        return { executed } as ExecutionResult;
      }
      return yield* executeLive(signal, conditionId, ptb, entryCtx);
    });

  return {
    executeStrategy,
  } as const;
}

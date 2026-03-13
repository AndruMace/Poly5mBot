import { Effect, Ref } from "effect";
import type { Strategy } from "../strategies/base.js";
import type { EngineEvent, MarketWindow } from "../types.js";
import type { EngineState } from "./state.js";
import { zeroDiagnostics } from "./state.js";

interface WindowManagerDeps {
  stateRef: Ref.Ref<EngineState>;
  strategies: ReadonlyArray<Strategy>;
  fetchCurrentWindow: Effect.Effect<MarketWindow | null, never, never>;
  isConnected: Effect.Effect<boolean, never, never>;
  onNewWindow: (conditionId: string) => Effect.Effect<void, never, never>;
  emit: (event: EngineEvent) => Effect.Effect<void, never, never>;
  obs: (input: any) => Effect.Effect<void, never, never>;
  refreshOrderBook: (window: MarketWindow) => Effect.Effect<void, never, never>;
  formatWindowTitle: (window: MarketWindow) => string;
  logPrefix: string;
}

export function makeMarketPoller(deps: WindowManagerDeps) {
  const ptbPendingSinceByCondition = new Map<string, number>();

  return Effect.gen(function* () {
    yield* Ref.update(deps.stateRef, (st) => ({ ...st, lastPoll: Date.now() }));
    const current = yield* deps.fetchCurrentWindow;
    const st = yield* Ref.get(deps.stateRef);

    if (current && current.conditionId !== st.currentWindow?.conditionId) {
      const updatedWindow: MarketWindow = { ...current };
      const title = current.title ?? deps.formatWindowTitle(current);
      const observedAt = Date.now();
      yield* Effect.log(
        `${deps.logPrefix} New window: ${title} | Price to beat: ${
          updatedWindow.priceToBeat !== null
            ? `$${updatedWindow.priceToBeat.toFixed(2)}`
            : `unavailable (${updatedWindow.priceToBeatReason ?? "unresolved"})`
        }`,
      );
      yield* deps.obs({
        category: "engine",
        source: "engine",
        action: "window_changed",
        entityType: "window",
        entityId: current.conditionId,
        status: "active",
        mode: st.mode,
        payload: {
          title,
          conditionId: current.conditionId,
          startTime: current.startTime,
          endTime: current.endTime,
          priceToBeat: updatedWindow.priceToBeat,
          priceToBeatStatus: updatedWindow.priceToBeatStatus ?? "pending",
          priceToBeatSource: updatedWindow.priceToBeatSource ?? "unavailable",
          priceToBeatReason: updatedWindow.priceToBeatReason ?? null,
        },
      });

      yield* Ref.update(deps.stateRef, (s) => ({
        ...s,
        currentWindow: updatedWindow,
        windowTitle: title,
        entriesThisWindow: new Map(),
        openPositions: new Map(),
        windowEndPriceSnapshot: null,
        windowEndSnapshotTs: 0,
        metrics: { ...s.metrics, windowConditionId: current.conditionId },
        windowDiagnostics: Object.fromEntries(deps.strategies.map((strategy) => [strategy.name, zeroDiagnostics()])),
      }));
      if (updatedWindow.priceToBeat === null) {
        ptbPendingSinceByCondition.set(updatedWindow.conditionId, observedAt);
      } else {
        ptbPendingSinceByCondition.delete(updatedWindow.conditionId);
      }
      yield* deps.onNewWindow(current.conditionId);
      yield* deps.emit({ _tag: "Market", data: updatedWindow });
    } else if (
      current &&
      st.currentWindow &&
      current.conditionId === st.currentWindow.conditionId &&
      current.priceToBeat !== null &&
      st.currentWindow.priceToBeat === null
    ) {
      // Same window — PTB just resolved. Update state and push to frontend.
      const now = Date.now();
      const pendingSince = ptbPendingSinceByCondition.get(current.conditionId) ?? st.currentWindow.startTime;
      const resolutionMs = Math.max(0, now - pendingSince);
      ptbPendingSinceByCondition.delete(current.conditionId);
      yield* Ref.update(deps.stateRef, (s) => ({
        ...s,
        currentWindow: { ...current },
        metrics: {
          ...s.metrics,
          latency: {
            ...s.metrics.latency,
            ptbWindowToExactLastMs: resolutionMs,
            ptbWindowToExactSamples: (s.metrics.latency.ptbWindowToExactSamples ?? 0) + 1,
            ptbWindowToExactAvgMs: (() => {
              const prevSamples = s.metrics.latency.ptbWindowToExactSamples ?? 0;
              const prevAvg = s.metrics.latency.ptbWindowToExactAvgMs ?? 0;
              return (prevAvg * prevSamples + resolutionMs) / (prevSamples + 1);
            })(),
          },
        },
      }));
      yield* deps.obs({
        category: "engine",
        source: "engine",
        action: "ptb_resolved",
        entityType: "window",
        entityId: current.conditionId,
        status: "resolved",
        mode: st.mode,
        payload: {
          resolutionMs,
          priceToBeat: current.priceToBeat,
          priceToBeatSource: current.priceToBeatSource ?? "unavailable",
        },
      });
      yield* deps.emit({ _tag: "Market", data: current });
      yield* Effect.log(
        `${deps.logPrefix} PTB resolved for existing window in ${resolutionMs}ms: $${current.priceToBeat.toFixed(2)} (${current.priceToBeatSource})`,
      );
    }

    const afterSt = yield* Ref.get(deps.stateRef);
    const connected = yield* deps.isConnected;
    if (afterSt.currentWindow && (connected || afterSt.mode === "shadow")) {
      yield* deps.refreshOrderBook(afterSt.currentWindow).pipe(
        Effect.catchAll(() => Effect.void),
        Effect.forkDaemon,
      );
    }
  }).pipe(
    Effect.catchAll((err) => Effect.logError(`${deps.logPrefix} Market poll error: ${err}`)),
  );
}

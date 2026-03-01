import { Effect, Ref } from "effect";
import type { Strategy } from "../strategies/base.js";
import type { EngineEvent, MarketWindow } from "../types.js";
import type { EngineState } from "./state.js";
import { zeroDiagnostics } from "./state.js";

interface WindowManagerDeps {
  stateRef: Ref.Ref<EngineState>;
  strategies: ReadonlyArray<Strategy>;
  fetchCurrentWindow: Effect.Effect<MarketWindow | null, never, never>;
  fetchCurrentBtcPrice: Effect.Effect<number, never, never>;
  isConnected: Effect.Effect<boolean, never, never>;
  onNewWindow: (conditionId: string) => Effect.Effect<void, never, never>;
  emit: (event: EngineEvent) => Effect.Effect<void, never, never>;
  obs: (input: any) => Effect.Effect<void, never, never>;
  refreshOrderBook: (window: MarketWindow) => Effect.Effect<void, never, never>;
  formatWindowTitle: (window: MarketWindow) => string;
}

export function makeMarketPoller(deps: WindowManagerDeps) {
  return Effect.gen(function* () {
    yield* Ref.update(deps.stateRef, (st) => ({ ...st, lastPoll: Date.now() }));
    const current = yield* deps.fetchCurrentWindow;
    const st = yield* Ref.get(deps.stateRef);

    if (current && current.conditionId !== st.currentWindow?.conditionId) {
      let ptb = current.priceToBeat;
      if (ptb === null) {
        const openPrice = yield* deps.fetchCurrentBtcPrice;
        if (openPrice > 0) {
          ptb = openPrice;
          yield* Effect.logWarning(
            `[Engine] priceToBeat not in market metadata — using local feed $${openPrice.toFixed(2)}`,
          );
        }
      }
      const updatedWindow: MarketWindow = { ...current, priceToBeat: ptb };
      const title = current.title ?? deps.formatWindowTitle(current);
      yield* Effect.log(
        `[Engine] New window: ${title} | Price to beat: $${ptb?.toFixed(2) ?? "unknown"}`,
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
          priceToBeat: ptb,
        },
      });

      yield* Ref.update(deps.stateRef, (s) => ({
        ...s,
        currentWindow: updatedWindow,
        windowTitle: title,
        entriesThisWindow: new Map(),
        windowEndPriceSnapshot: null,
        windowEndSnapshotTs: 0,
        metrics: { ...s.metrics, windowConditionId: current.conditionId },
        windowDiagnostics: Object.fromEntries(deps.strategies.map((strategy) => [strategy.name, zeroDiagnostics()])),
      }));
      yield* deps.onNewWindow(current.conditionId);
      yield* deps.emit({ _tag: "Market", data: updatedWindow });
    }

    const afterSt = yield* Ref.get(deps.stateRef);
    const connected = yield* deps.isConnected;
    if (afterSt.currentWindow && (connected || afterSt.mode === "shadow")) {
      yield* deps.refreshOrderBook(afterSt.currentWindow);
    }
  }).pipe(
    Effect.catchAll((err) => Effect.logError(`[Engine] Market poll error: ${err}`)),
  );
}

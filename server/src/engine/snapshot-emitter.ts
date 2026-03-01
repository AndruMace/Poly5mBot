import { Effect, Ref } from "effect";
import type { Strategy } from "../strategies/base.js";
import type { EngineEvent, KillSwitchStatus, PnLSummary, RiskSnapshot } from "../types.js";
import type { EngineState } from "./state.js";

interface SnapshotEmitterDeps {
  stateRef: Ref.Ref<EngineState>;
  strategies: ReadonlyArray<Strategy>;
  emit: (event: EngineEvent) => Effect.Effect<void, never, never>;
  recomputeReconciliation: Effect.Effect<void, never, never>;
  getLiveSummary: Effect.Effect<PnLSummary, never, never>;
  getShadowSummary: Effect.Effect<PnLSummary, never, never>;
  getKillSwitchStatus: Effect.Effect<ReadonlyArray<KillSwitchStatus>, never, never>;
  getRiskSnapshot: Effect.Effect<RiskSnapshot, never, never>;
}

export function makeSnapshotEmitter(deps: SnapshotEmitterDeps) {
  return (isShadow: boolean) =>
    Effect.gen(function* () {
      const now = Date.now();
      const stBefore = yield* Ref.get(deps.stateRef);
      if (now - stBefore.metrics.reconciliation.updatedAt > 5_000) {
        yield* deps.recomputeReconciliation;
      }

      const stratStates = yield* Effect.all(deps.strategies.map((s) => s.getState));
      yield* deps.emit({ _tag: "Strategies", data: stratStates });

      const livePnl = yield* deps.getLiveSummary;
      yield* deps.emit({ _tag: "Pnl", data: livePnl });

      const shadowPnl = yield* deps.getShadowSummary;
      yield* deps.emit({ _tag: "ShadowPnl", data: shadowPnl });

      const regime = (yield* Ref.get(deps.stateRef)).regime;
      yield* deps.emit({ _tag: "Regime", data: regime });

      const killSwitch = yield* deps.getKillSwitchStatus;
      yield* deps.emit({ _tag: "KillSwitch", data: killSwitch });

      const risk = yield* deps.getRiskSnapshot;
      yield* deps.emit({ _tag: "Risk", data: risk });

      const st = yield* Ref.get(deps.stateRef);
      yield* deps.emit({
        _tag: "Metrics",
        data: { ...st.metrics, rolling: st.rollingDiagnostics, window: st.windowDiagnostics },
      });
    });
}

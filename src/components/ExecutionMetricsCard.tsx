import { useRxValue } from "@effect-rx/rx-react";
import { metricsRx } from "../store/index.js";
import { Gauge } from "lucide-react";
import {
  STRATEGY_UI_ORDER,
  getStrategyDisplayName,
} from "../utils/strategy.js";

const STRATEGY_ORDER = STRATEGY_UI_ORDER;

export function ExecutionMetricsCard() {
  const metrics = useRxValue(metricsRx);
  const recon = metrics.reconciliation;

  return (
    <div className="bg-[var(--bg-card)] rounded-xl p-4 border border-[var(--border)]">
      <div className="flex items-center gap-2 mb-3">
        <Gauge size={16} className="text-[var(--accent-blue)]" />
        <h3 className="text-sm font-semibold">Execution Metrics</h3>
      </div>
      <div className="grid grid-cols-3 gap-3 mb-3 text-xs">
        <div className="bg-[var(--bg-secondary)] rounded px-3 py-2">
          <div className="text-[var(--text-secondary)]">Last Signal→Submit</div>
          <div className="font-mono">{metrics.latency.lastSignalToSubmitMs.toFixed(0)} ms</div>
        </div>
        <div className="bg-[var(--bg-secondary)] rounded px-3 py-2">
          <div className="text-[var(--text-secondary)]">Avg Signal→Submit</div>
          <div className="font-mono">{metrics.latency.avgSignalToSubmitMs.toFixed(1)} ms</div>
        </div>
        <div className="bg-[var(--bg-secondary)] rounded px-3 py-2">
          <div className="text-[var(--text-secondary)]">Recent Avg (20)</div>
          <div className="font-mono">{metrics.latency.avgRecentSignalToSubmitMs.toFixed(1)} ms</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3 mb-3 text-xs">
        <div className="bg-[var(--bg-secondary)] rounded px-3 py-2">
          <div className="text-[var(--text-secondary)]">Latency Samples</div>
          <div className="font-mono">{metrics.latency.samples}</div>
        </div>
        <div className="bg-[var(--bg-secondary)] rounded px-3 py-2">
          <div className="text-[var(--text-secondary)]">Price Data Age</div>
          <div className="font-mono">
            {metrics.latency.priceDataAgeMs >= 0
              ? `${metrics.latency.priceDataAgeMs.toFixed(0)} ms`
              : "n/a"}
          </div>
        </div>
        <div className="bg-[var(--bg-secondary)] rounded px-3 py-2">
          <div className="text-[var(--text-secondary)]">Orderbook Age</div>
          <div className="font-mono">
            {metrics.latency.orderbookAgeMs >= 0
              ? `${metrics.latency.orderbookAgeMs.toFixed(0)} ms`
              : "n/a"}
          </div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[var(--text-secondary)] border-b border-[var(--border)]">
              <th className="text-left py-1">Strategy</th>
              <th className="text-right py-1">Signals</th>
              <th className="text-right py-1">Risk Rej</th>
              <th className="text-right py-1">Live Rej</th>
              <th className="text-right py-1">Dyn Win</th>
              <th className="text-right py-1">Early OK</th>
              <th className="text-right py-1">Early Rej</th>
              <th className="text-right py-1">Prob Rej</th>
              <th className="text-right py-1">Queue Miss</th>
              <th className="text-right py-1">Liq Fail</th>
              <th className="text-right py-1">Low Fill</th>
              <th className="text-right py-1">Partial</th>
              <th className="text-right py-1">Full</th>
            </tr>
          </thead>
          <tbody>
            {STRATEGY_ORDER.map((name) => {
              const row = metrics.window[name];
              return (
                <tr key={name} className="border-t border-[var(--border)]/50">
                  <td className="py-1">{getStrategyDisplayName(name)}</td>
                  <td className="py-1 text-right font-mono">{row?.signals ?? 0}</td>
                  <td className="py-1 text-right font-mono">{row?.riskRejected ?? 0}</td>
                  <td className="py-1 text-right font-mono">{row?.liveRejected ?? 0}</td>
                  <td className="py-1 text-right font-mono">{row?.dynamicWindowUsed ?? 0}</td>
                  <td className="py-1 text-right font-mono">{row?.earlyEntryAccepted ?? 0}</td>
                  <td className="py-1 text-right font-mono">{row?.earlyEntryRejected ?? 0}</td>
                  <td className="py-1 text-right font-mono">{row?.probabilityRejected ?? 0}</td>
                  <td className="py-1 text-right font-mono">{row?.queueMiss ?? 0}</td>
                  <td className="py-1 text-right font-mono">{row?.liquidityFail ?? 0}</td>
                  <td className="py-1 text-right font-mono">{row?.lowFillCancel ?? 0}</td>
                  <td className="py-1 text-right font-mono">{row?.partialFill ?? 0}</td>
                  <td className="py-1 text-right font-mono">{row?.fullFill ?? 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-4 pt-3 border-t border-[var(--border)]">
        <div className="text-xs font-semibold mb-2">Live vs Shadow Reconciliation</div>
        <div className="grid grid-cols-3 gap-3 mb-3 text-xs">
          <div className="bg-[var(--bg-secondary)] rounded px-3 py-2">
            <div className="text-[var(--text-secondary)]">Trades (L/S)</div>
            <div className="font-mono">
              {recon.liveTotalTrades} / {recon.shadowTotalTrades}
            </div>
          </div>
          <div className="bg-[var(--bg-secondary)] rounded px-3 py-2">
            <div className="text-[var(--text-secondary)]">Win Rate (L/S)</div>
            <div className="font-mono">
              {recon.liveWinRate.toFixed(1)}% / {recon.shadowWinRate.toFixed(1)}%
            </div>
          </div>
          <div className="bg-[var(--bg-secondary)] rounded px-3 py-2">
            <div className="text-[var(--text-secondary)]">Total PnL (L/S)</div>
            <div className="font-mono">
              ${recon.liveTotalPnl.toFixed(2)} / ${recon.shadowTotalPnl.toFixed(2)}
            </div>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[var(--text-secondary)] border-b border-[var(--border)]">
                <th className="text-left py-1">Strategy</th>
                <th className="text-right py-1">Signals L/S</th>
                <th className="text-right py-1">Submit L/S</th>
                <th className="text-right py-1">Fill% L/S</th>
                <th className="text-right py-1">Rej% L/S</th>
                <th className="text-right py-1">PnL L/S</th>
                <th className="text-right py-1">Delta PnL</th>
              </tr>
            </thead>
            <tbody>
              {STRATEGY_ORDER.map((name) => {
                const row = recon.strategies.find((s) => s.strategy === name);
                return (
                  <tr key={`recon-${name}`} className="border-t border-[var(--border)]/50">
                    <td className="py-1">{getStrategyDisplayName(name)}</td>
                    <td className="py-1 text-right font-mono">
                      {row?.liveSignals ?? 0} / {row?.shadowSignals ?? 0}
                    </td>
                    <td className="py-1 text-right font-mono">
                      {row?.liveSubmitted ?? 0} / {row?.shadowSubmitted ?? 0}
                    </td>
                    <td className="py-1 text-right font-mono">
                      {((row?.liveFillRate ?? 0) * 100).toFixed(0)}% / {((row?.shadowFillRate ?? 0) * 100).toFixed(0)}%
                    </td>
                    <td className="py-1 text-right font-mono">
                      {((row?.liveRejectRate ?? 0) * 100).toFixed(0)}% / {((row?.shadowRejectRate ?? 0) * 100).toFixed(0)}%
                    </td>
                    <td className="py-1 text-right font-mono">
                      ${(row?.livePnl ?? 0).toFixed(2)} / ${(row?.shadowPnl ?? 0).toFixed(2)}
                    </td>
                    <td className="py-1 text-right font-mono">
                      ${(row?.pnlDelta ?? 0).toFixed(2)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

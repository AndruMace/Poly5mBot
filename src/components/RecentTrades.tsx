import { useMemo } from "react";
import { useRxValue } from "@effect-rx/rx-react";
import { tradesRx, modeRx } from "../store/index.js";
import { History } from "lucide-react";
import { getStrategyDisplayName } from "../utils/strategy.js";

export function RecentTrades() {
  const trades = useRxValue(tradesRx);
  const mode = useRxValue(modeRx);

  const { recent, recentLosses } = useMemo(() => {
    const modeTrades = trades
      .filter((t) => (mode === "shadow" ? t.shadow : !t.shadow))
      .sort((a, b) => b.timestamp - a.timestamp);

    return {
      recent: modeTrades.slice(0, 10),
      recentLosses: modeTrades
        .filter((t) => t.status === "resolved" && t.outcome === "loss")
        .slice(0, 3),
    };
  }, [trades, mode]);

  return (
    <div className="bg-[var(--bg-card)] rounded-xl p-4 border border-[var(--border)]">
      <div className="flex items-center gap-2 mb-3 text-sm text-[var(--text-secondary)]">
        <History size={14} />
        <span>
          Recent {mode === "shadow" ? "Shadow" : "Live"} Trades
        </span>
      </div>
      {recentLosses.length > 0 && (
        <div className="mb-3 rounded-md border border-[var(--accent-red)]/35 bg-[var(--accent-red)]/10 px-3 py-2 text-xs">
          <div className="mb-1 font-medium text-[var(--accent-red)]">
            Recent Losses
          </div>
          <div className="space-y-1 text-[var(--text-secondary)]">
            {recentLosses.map((t) => (
              <div key={`loss-${t.id}`} className="flex items-center justify-between">
                <span>
                  {getStrategyDisplayName(t.strategy)} ({new Date(t.timestamp).toLocaleTimeString()})
                </span>
                <span className="font-mono text-[var(--accent-red)]">
                  ${t.pnl.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {recent.length === 0 ? (
        <div className="text-sm text-[var(--text-secondary)] text-center py-6">
          No trades yet
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[var(--text-secondary)]">
                <th className="text-left py-1.5 px-2 font-medium">Time</th>
                <th className="text-left py-1.5 px-2 font-medium">Strategy</th>
                <th className="text-left py-1.5 px-2 font-medium">Side</th>
                <th className="text-right py-1.5 px-2 font-medium">Price</th>
                <th className="text-right py-1.5 px-2 font-medium">Size</th>
                <th className="text-center py-1.5 px-2 font-medium">Status</th>
                <th className="text-left py-1.5 px-2 font-medium">Event</th>
                <th className="text-left py-1.5 px-2 font-medium">CLOB</th>
                <th className="text-right py-1.5 px-2 font-medium">P&L</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((t) => (
                <tr
                  key={t.id}
                  className={`border-t border-[var(--border)] hover:bg-[var(--bg-secondary)]/50 ${
                    t.status === "resolved" && t.outcome === "loss"
                      ? "bg-[var(--accent-red)]/8"
                      : ""
                  }`}
                >
                  <td className="py-1.5 px-2 font-mono text-[var(--text-secondary)]">
                    {new Date(t.timestamp).toLocaleTimeString()}
                  </td>
                  <td className="py-1.5 px-2">
                    {getStrategyDisplayName(t.strategy)}
                    {t.status === "resolved" && t.outcome === "loss" && (
                      <span className="ml-1 rounded bg-[var(--accent-red)]/15 px-1 py-0.5 text-[10px] text-[var(--accent-red)]">
                        LOSS
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 px-2">
                    <span
                      className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                        t.side === "UP"
                          ? "bg-[var(--accent-green)]/15 text-[var(--accent-green)]"
                          : "bg-[var(--accent-red)]/15 text-[var(--accent-red)]"
                      }`}
                    >
                      {t.side}
                    </span>
                  </td>
                  <td className="py-1.5 px-2 text-right font-mono">
                    ${t.entryPrice.toFixed(2)}
                  </td>
                  <td className="py-1.5 px-2 text-right font-mono">
                    ${t.size.toFixed(2)}
                  </td>
                  <td className="py-1.5 px-2 text-center">
                    <StatusBadge status={t.status} outcome={t.outcome} />
                  </td>
                  <td className="py-1.5 px-2 font-mono text-[var(--text-secondary)]">
                    {t.lastEventType ?? "—"}
                  </td>
                  <td className="py-1.5 px-2 text-[11px] font-mono text-[var(--text-secondary)]">
                    {t.shadow ? "shadow" : (t.clobResult ?? "—")}
                  </td>
                  <td
                    className={`py-1.5 px-2 text-right font-mono ${
                      t.pnl >= 0
                        ? "text-[var(--accent-green)]"
                        : "text-[var(--accent-red)]"
                    }`}
                  >
                    {t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusBadge({
  status,
  outcome,
}: {
  status: string;
  outcome: string | null;
}) {
  if (status === "resolved") {
    return (
      <span
        className={`px-1.5 py-0.5 rounded text-xs ${
          outcome === "win"
            ? "bg-[var(--accent-green)]/15 text-[var(--accent-green)]"
            : "bg-[var(--accent-red)]/15 text-[var(--accent-red)]"
        }`}
      >
        {outcome === "win" ? "Won" : "Lost"}
      </span>
    );
  }
  if (status === "filled") {
    return (
      <span className="px-1.5 py-0.5 rounded text-xs bg-[var(--accent-blue)]/15 text-[var(--accent-blue)]">
        Active
      </span>
    );
  }
  if (status === "partial") {
    return (
      <span className="px-1.5 py-0.5 rounded text-xs bg-[var(--accent-yellow)]/15 text-[var(--accent-yellow)]">
        Partial
      </span>
    );
  }
  if (status === "cancelled") {
    return (
      <span className="px-1.5 py-0.5 rounded text-xs bg-[var(--text-secondary)]/15 text-[var(--text-secondary)]">
        Cancelled
      </span>
    );
  }
  return (
    <span className="px-1.5 py-0.5 rounded text-xs bg-[var(--accent-yellow)]/15 text-[var(--accent-yellow)]">
      {status}
    </span>
  );
}

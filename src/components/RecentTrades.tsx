import { useStore } from "../store/index.js";
import { History } from "lucide-react";

export function RecentTrades() {
  const trades = useStore((s) => s.trades);
  const mode = useStore((s) => s.mode);
  const recent = trades
    .filter((t) => (mode === "shadow" ? t.shadow : !t.shadow))
    .slice(0, 10);

  return (
    <div className="bg-[var(--bg-card)] rounded-xl p-4 border border-[var(--border)]">
      <div className="flex items-center gap-2 mb-3 text-sm text-[var(--text-secondary)]">
        <History size={14} />
        <span>
          Recent {mode === "shadow" ? "Shadow" : "Live"} Trades
        </span>
      </div>

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
                  className="border-t border-[var(--border)] hover:bg-[var(--bg-secondary)]/50"
                >
                  <td className="py-1.5 px-2 font-mono text-[var(--text-secondary)]">
                    {new Date(t.timestamp).toLocaleTimeString()}
                  </td>
                  <td className="py-1.5 px-2 capitalize">{t.strategy}</td>
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

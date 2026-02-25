import { useState, useMemo } from "react";
import { useRxValue } from "@effect-rx/rx-react";
import { tradesRx } from "../store/index.js";
import { PnLCard } from "./PnLCard.js";
import { History, Download } from "lucide-react";

type TradeFilter = "all" | "live" | "shadow";

export function TradeLog() {
  const trades = useRxValue(tradesRx);
  const [filter, setFilter] = useState<TradeFilter>("all");

  const filtered = useMemo(() => {
    if (filter === "all") return trades;
    if (filter === "shadow") return trades.filter((t) => t.shadow);
    return trades.filter((t) => !t.shadow);
  }, [trades, filter]);

  const lossByStrategy = useMemo(() => {
    const map = new Map<string, { count: number; pnl: number }>();
    for (const t of filtered) {
      if (t.status !== "resolved" || t.outcome !== "loss") continue;
      const prev = map.get(t.strategy) ?? { count: 0, pnl: 0 };
      map.set(t.strategy, { count: prev.count + 1, pnl: prev.pnl + t.pnl });
    }
    return [...map.entries()]
      .map(([strategy, data]) => ({ strategy, ...data }))
      .sort((a, b) => a.pnl - b.pnl);
  }, [filtered]);

  function csvCell(value: unknown): string {
    const s = String(value ?? "");
    const needsQuote =
      s.includes(",") ||
      s.includes('"') ||
      s.includes("\n") ||
      /^[=+\-@\t\r]/.test(s);
    if (!needsQuote) return s;
    const escaped = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return `"${escaped.replace(/"/g, '""')}"`;
  }

  function exportCsv() {
    const headers = [
      "ID",
      "Time",
      "Strategy",
      "Side",
      "Entry Price",
      "Size",
      "Shares",
      "Fee",
      "Status",
      "Outcome",
      "Last Event",
      "CLOB Result",
      "CLOB Order ID",
      "CLOB Reason",
      "P&L",
      "Shadow",
    ];
    const rows = filtered.map((t) => [
      t.id,
      new Date(t.timestamp).toISOString(),
      t.strategy,
      t.side,
      t.entryPrice,
      t.size,
      t.shares.toFixed(4),
      t.fee.toFixed(4),
      t.status,
      t.outcome ?? "",
      t.lastEventType ?? "",
      t.clobResult ?? "",
      t.clobOrderId ?? "",
      t.clobReason ?? "",
      t.pnl.toFixed(4),
      t.shadow ? "yes" : "no",
    ]);
    const csv = [
      headers.map(csvCell).join(","),
      ...rows.map((r) => r.map(csvCell).join(",")),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trades-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const filterBtns: { label: string; value: TradeFilter }[] = [
    { label: "All", value: "all" },
    { label: "Live", value: "live" },
    { label: "Shadow", value: "shadow" },
  ];

  return (
    <div>
      <div className="mb-4">
        <PnLCard />
      </div>

      <div className="bg-[var(--bg-card)] rounded-xl p-4 border border-[var(--border)]">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <History size={16} className="text-[var(--accent-blue)]" />
            <h2 className="text-lg font-semibold">Trade History</h2>
            <span className="text-xs text-[var(--text-secondary)] ml-2">
              {filtered.length} trades
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-[var(--border)] overflow-hidden">
              {filterBtns.map((btn) => (
                <button
                  key={btn.value}
                  onClick={() => setFilter(btn.value)}
                  className={`px-3 py-1 text-xs transition-colors ${
                    filter === btn.value
                      ? "bg-[var(--accent-blue)] text-white"
                      : "bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  {btn.label}
                </button>
              ))}
            </div>
            {filtered.length > 0 && (
              <button
                onClick={exportCsv}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[var(--bg-secondary)] text-[var(--text-secondary)] rounded hover:text-[var(--text-primary)] transition-colors border border-[var(--border)]"
              >
                <Download size={12} />
                Export CSV
              </button>
            )}
          </div>
        </div>

        {lossByStrategy.length > 0 && (
          <div className="mb-3 rounded-lg border border-[var(--accent-red)]/35 bg-[var(--accent-red)]/8 p-3">
            <div className="mb-2 text-xs font-medium text-[var(--accent-red)]">
              Losses By Strategy (Resolved)
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {lossByStrategy.map((row) => (
                <div
                  key={`loss-${row.strategy}`}
                  className="flex items-center justify-between rounded bg-[var(--bg-card)]/70 px-2 py-1.5 text-xs"
                >
                  <span className="capitalize">{row.strategy}</span>
                  <span className="font-mono text-[var(--accent-red)]">
                    {row.count} loss{row.count === 1 ? "" : "es"} · ${row.pnl.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {filtered.length === 0 ? (
          <div className="text-sm text-[var(--text-secondary)] text-center py-12">
            No trades recorded yet. Enable strategies and wait for signals.
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[var(--bg-card)]">
                <tr className="text-[var(--text-secondary)] border-b border-[var(--border)]">
                  <th className="text-left py-2 px-2 font-medium">Time</th>
                  <th className="text-left py-2 px-2 font-medium">Strategy</th>
                  <th className="text-left py-2 px-2 font-medium">Side</th>
                  <th className="text-right py-2 px-2 font-medium">
                    Entry Price
                  </th>
                  <th className="text-right py-2 px-2 font-medium">Size</th>
                  <th className="text-right py-2 px-2 font-medium">Shares</th>
                  <th className="text-right py-2 px-2 font-medium">Fee</th>
                  <th className="text-center py-2 px-2 font-medium">Status</th>
                  <th className="text-left py-2 px-2 font-medium">Last Event</th>
                  <th className="text-left py-2 px-2 font-medium">CLOB</th>
                  <th className="text-right py-2 px-2 font-medium">P&L</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => (
                  <tr
                    key={t.id}
                    className={`border-t border-[var(--border)]/50 hover:bg-[var(--bg-secondary)]/30 ${
                      t.status === "resolved" && t.outcome === "loss"
                        ? "bg-[var(--accent-red)]/8"
                        : ""
                    }`}
                  >
                    <td className="py-2 px-2 font-mono text-[var(--text-secondary)]">
                      {new Date(t.timestamp).toLocaleTimeString()}
                    </td>
                    <td className="py-2 px-2 capitalize">
                      {t.strategy}
                      {t.status === "resolved" && t.outcome === "loss" && (
                        <span className="ml-1 rounded bg-[var(--accent-red)]/15 px-1 py-0.5 text-[10px] text-[var(--accent-red)]">
                          LOSS
                        </span>
                      )}
                      {t.shadow && (
                        <span className="ml-1 text-[10px] text-[var(--accent-yellow)]">S</span>
                      )}
                    </td>
                    <td className="py-2 px-2">
                      <span
                        className={`px-1.5 py-0.5 rounded font-medium ${
                          t.side === "UP"
                            ? "bg-[var(--accent-green)]/15 text-[var(--accent-green)]"
                            : "bg-[var(--accent-red)]/15 text-[var(--accent-red)]"
                        }`}
                      >
                        {t.side}
                      </span>
                    </td>
                    <td className="py-2 px-2 text-right font-mono">
                      ${t.entryPrice.toFixed(2)}
                    </td>
                    <td className="py-2 px-2 text-right font-mono">
                      ${t.size.toFixed(2)}
                    </td>
                    <td className="py-2 px-2 text-right font-mono text-[var(--text-secondary)]">
                      {t.shares.toFixed(2)}
                    </td>
                    <td className="py-2 px-2 text-right font-mono text-[var(--text-secondary)]">
                      ${t.fee.toFixed(4)}
                    </td>
                    <td className="py-2 px-2 text-center">
                      <StatusBadge status={t.status} outcome={t.outcome} />
                    </td>
                    <td className="py-2 px-2 font-mono text-[var(--text-secondary)]">
                      {t.lastEventType ?? "—"}
                    </td>
                    <td className="py-2 px-2 text-[11px]">
                      {t.shadow ? (
                        <span className="text-[var(--text-secondary)]">shadow</span>
                      ) : (
                        <div className="flex flex-col leading-tight">
                          <span className="font-mono text-[var(--text-primary)]">
                            {t.clobResult ?? "—"}
                          </span>
                          <span className="font-mono text-[var(--text-secondary)]">
                            {t.clobOrderId ?? "no-order-id"}
                          </span>
                          {t.clobReason && (
                            <span className="text-[var(--accent-red)]">
                              {t.clobReason}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td
                      className={`py-2 px-2 text-right font-mono font-medium ${
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
        className={`px-1.5 py-0.5 rounded ${
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
      <span className="px-1.5 py-0.5 rounded bg-[var(--accent-blue)]/15 text-[var(--accent-blue)]">
        Active
      </span>
    );
  }
  if (status === "partial") {
    return (
      <span className="px-1.5 py-0.5 rounded bg-[var(--accent-yellow)]/15 text-[var(--accent-yellow)]">
        Partial
      </span>
    );
  }
  if (status === "submitted" || status === "pending") {
    return (
      <span className="px-1.5 py-0.5 rounded bg-[var(--accent-blue)]/10 text-[var(--text-secondary)]">
        {status}
      </span>
    );
  }
  if (status === "cancelled") {
    return (
      <span className="px-1.5 py-0.5 rounded bg-[var(--text-secondary)]/15 text-[var(--text-secondary)]">
        Cancelled
      </span>
    );
  }
  if (status === "expired") {
    return (
      <span className="px-1.5 py-0.5 rounded bg-[var(--accent-yellow)]/10 text-[var(--text-secondary)]">
        Expired
      </span>
    );
  }
  return (
    <span className="px-1.5 py-0.5 rounded bg-[var(--accent-yellow)]/15 text-[var(--accent-yellow)]">
      {status}
    </span>
  );
}

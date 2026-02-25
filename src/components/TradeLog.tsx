import { useCallback, useEffect, useMemo, useState } from "react";
import { useRxValue } from "@effect-rx/rx-react";
import { tradesRx } from "../store/index.js";
import { PnLCard } from "./PnLCard.js";
import { History, Download } from "lucide-react";
import type {
  TradeFilterMode,
  TradeRecord,
  TradesPageResponse,
  TradeTimeframe,
} from "../types/index.js";

const PAGE_SIZE = 100;
const DISPLAY_TIMEFRAME: TradeTimeframe = "30d";
const CSV_TIMEFRAME_OPTIONS: Array<{
  value: TradeTimeframe;
  label: string;
}> = [
  { value: "1h", label: "Past hour" },
  { value: "12h", label: "Past 12 hours" },
  { value: "1d", label: "Past day" },
  { value: "7d", label: "Past week" },
  { value: "all", label: "All" },
];

export function TradeLog() {
  const wsTrades = useRxValue(tradesRx);
  const [filter, setFilter] = useState<TradeFilterMode>("all");
  const [rows, setRows] = useState<TradeRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([null]);
  const [csvTimeframe, setCsvTimeframe] = useState<TradeTimeframe>("1d");
  const [exporting, setExporting] = useState(false);

  const mergeTrades = useCallback((a: TradeRecord[], b: TradeRecord[]) => {
    const merged = new Map<string, TradeRecord>();
    for (const t of a) merged.set(t.id, t);
    for (const t of b) merged.set(t.id, t);
    return Array.from(merged.values()).sort((x, y) => y.timestamp - x.timestamp);
  }, []);

  const loadPage = useCallback(
    async (mode: TradeFilterMode, cursor: string | null, targetPage: number) => {
      setLoading(true);
      setLoadError(null);
      try {
        const qs = new URLSearchParams({
          mode,
          timeframe: DISPLAY_TIMEFRAME,
          limit: String(PAGE_SIZE),
        });
        if (cursor) qs.set("cursor", cursor);
        const res = await fetch(`/api/trades?${qs.toString()}`);
        if (!res.ok) throw new Error(`Trade history request failed (${res.status})`);
        const payload = (await res.json()) as TradesPageResponse;
        setRows([...payload.items]);
        setNextCursor(payload.nextCursor);
        setPageIndex(targetPage);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Could not load trade history";
        setLoadError(msg);
        setRows([]);
        setNextCursor(null);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    setCursorHistory([null]);
    void loadPage(filter, null, 0);
  }, [filter, loadPage]);

  useEffect(() => {
    if (pageIndex !== 0 || wsTrades.length === 0) return;
    setRows((prev) => mergeTrades(prev, wsTrades).slice(0, PAGE_SIZE));
  }, [mergeTrades, pageIndex, wsTrades]);

  const filtered = useMemo(() => {
    if (filter === "all") return rows;
    if (filter === "shadow") return rows.filter((t) => t.shadow);
    return rows.filter((t) => !t.shadow);
  }, [rows, filter]);

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

  async function exportCsv() {
    setExporting(true);
    try {
      const qs = new URLSearchParams({
        mode: filter,
        timeframe: csvTimeframe,
      });
      const res = await fetch(`/api/trades/export.csv?${qs.toString()}`);
      if (!res.ok) throw new Error(`CSV export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `trades-${csvTimeframe}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  async function goToNextPage() {
    if (!nextCursor || loading) return;
    const nextPage = pageIndex + 1;
    setCursorHistory((prev) => {
      const copy = prev.slice(0, nextPage);
      copy[nextPage] = nextCursor;
      return copy;
    });
    await loadPage(filter, nextCursor, nextPage);
  }

  async function goToPrevPage() {
    if (pageIndex === 0 || loading) return;
    const prevPage = pageIndex - 1;
    const prevCursor = cursorHistory[prevPage] ?? null;
    await loadPage(filter, prevCursor, prevPage);
  }

  const filterBtns: { label: string; value: TradeFilterMode }[] = [
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
              {loading ? "Loading..." : `${filtered.length} trades`}
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
            <select
              value={csvTimeframe}
              onChange={(e) => setCsvTimeframe(e.target.value as TradeTimeframe)}
              className="px-2 py-1 text-xs rounded border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
            >
              {CSV_TIMEFRAME_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => void exportCsv()}
              disabled={exporting}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[var(--bg-secondary)] text-[var(--text-secondary)] rounded hover:text-[var(--text-primary)] transition-colors border border-[var(--border)] disabled:opacity-50"
            >
              <Download size={12} />
              {exporting ? "Exporting..." : "Export CSV"}
            </button>
          </div>
        </div>

        <div className="mb-3 flex items-center justify-between text-xs text-[var(--text-secondary)]">
          <span>Showing {DISPLAY_TIMEFRAME === "30d" ? "past 30 days" : DISPLAY_TIMEFRAME}</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void goToPrevPage()}
              disabled={pageIndex === 0 || loading}
              className="px-2 py-1 rounded border border-[var(--border)] disabled:opacity-50"
            >
              Previous
            </button>
            <span>Page {pageIndex + 1}</span>
            <button
              onClick={() => void goToNextPage()}
              disabled={!nextCursor || loading}
              className="px-2 py-1 rounded border border-[var(--border)] disabled:opacity-50"
            >
              Next
            </button>
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

        {loadError ? (
          <div className="text-sm text-[var(--accent-red)] text-center py-8">
            {loadError}
          </div>
        ) : filtered.length === 0 ? (
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

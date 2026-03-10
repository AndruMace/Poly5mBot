import { useMemo, useState } from "react";
import { useRxSet, useRxValue } from "@effect-rx/rx-react";
import {
  activeMarketIdRx,
  marketComparisonRx,
  pinnedMarketsRx,
  workspaceLayoutPrefsRx,
  type MarketListViewRow,
} from "../../store/index.js";
import { ArrowDownAZ, ArrowUpAZ, Search, Star, Target, Play, Square } from "lucide-react";

interface MarketsOverviewPanelProps {
  onSelectMarket: (marketId: string) => void;
  onFocusMarket: (marketId: string) => void;
}

function formatCurrency(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}$${value.toFixed(2)}`;
}

export function MarketsOverviewPanel({
  onSelectMarket,
  onFocusMarket,
}: MarketsOverviewPanelProps) {
  const rows = useRxValue(marketComparisonRx);
  const activeMarketId = useRxValue(activeMarketIdRx);
  const pinnedMarkets = useRxValue(pinnedMarketsRx);
  const prefs = useRxValue(workspaceLayoutPrefsRx);
  const setPinnedMarkets = useRxSet(pinnedMarketsRx);
  const setWorkspacePrefs = useRxSet(workspaceLayoutPrefsRx);
  const [togglePending, setTogglePending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cardClass = useMemo(
    () => (prefs.density === "compact" ? "p-2" : "p-3"),
    [prefs.density],
  );

  const gridClass = useMemo(() => {
    if (prefs.density === "compact") {
      return "grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3";
    }
    return "grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3";
  }, [prefs.density]);

  const updatePrefs = (patch: Partial<typeof prefs>) => {
    setWorkspacePrefs({ ...prefs, ...patch });
  };

  const togglePin = (marketId: string) => {
    const next = pinnedMarkets.includes(marketId)
      ? pinnedMarkets.filter((v) => v !== marketId)
      : [...pinnedMarkets, marketId];
    setPinnedMarkets(next);
  };

  const toggleTrading = async (row: MarketListViewRow) => {
    setError(null);
    setTogglePending(row.marketId);
    try {
      const res = await fetch(`/api/trading/${row.marketId}/toggle`, { method: "POST" });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error ?? "Failed to toggle trading");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to toggle trading");
    } finally {
      setTogglePending(null);
    }
  };

  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search
            size={13}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-secondary)]"
          />
          <input
            value={prefs.query}
            onChange={(e) => updatePrefs({ query: e.target.value })}
            placeholder="Search by symbol or market id"
            className="w-full rounded border border-[var(--border)] bg-[var(--bg-secondary)] py-1.5 pl-7 pr-2 text-xs"
          />
        </div>
        <select
          value={prefs.sortBy}
          onChange={(e) => updatePrefs({ sortBy: e.target.value as typeof prefs.sortBy })}
          className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs"
        >
          <option value="pnl">Sort: Total PnL</option>
          <option value="todayPnl">Sort: Today PnL</option>
          <option value="winRate">Sort: Win Rate</option>
          <option value="risk">Sort: Risk</option>
          <option value="latency">Sort: Latency</option>
          <option value="symbol">Sort: Symbol</option>
        </select>
        <button
          onClick={() => updatePrefs({ sortDir: prefs.sortDir === "asc" ? "desc" : "asc" })}
          className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs"
          title="Toggle sort direction"
        >
          {prefs.sortDir === "asc" ? <ArrowUpAZ size={13} /> : <ArrowDownAZ size={13} />}
        </button>
        <button
          onClick={() =>
            updatePrefs({
              density: prefs.density === "compact" ? "comfortable" : "compact",
            })
          }
          className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs"
        >
          {prefs.density === "compact" ? "Comfortable" : "Compact"}
        </button>
        <label className="ml-1 flex items-center gap-1 text-xs text-[var(--text-secondary)]">
          <input
            type="checkbox"
            checked={prefs.riskOnly}
            onChange={(e) => updatePrefs({ riskOnly: e.target.checked })}
          />
          Risk only
        </label>
      </div>

      {error && (
        <div className="mb-2 rounded border border-[var(--accent-red)]/30 bg-[var(--accent-red)]/10 p-2 text-xs text-[var(--accent-red)]">
          {error}
        </div>
      )}

      <div className={gridClass}>
        {rows.map((row) => {
          const isActive = activeMarketId === row.marketId;
          return (
            <article
              key={row.marketId}
              data-testid={`market-card-${row.marketId}`}
              className={`rounded-lg border ${cardClass} ${
                isActive
                  ? "border-[var(--accent-blue)]/60 bg-[var(--accent-blue)]/10"
                  : "border-[var(--border)] bg-[var(--bg-secondary)]"
              }`}
            >
              <div className="mb-2 flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-1.5">
                    <h3 className="text-sm font-semibold">{row.displayName}</h3>
                    {row.stale && (
                      <span className="rounded bg-[var(--accent-yellow)]/20 px-1 py-0.5 text-[10px] text-[var(--accent-yellow)]">
                        STALE
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-[var(--text-secondary)]">
                    {row.marketId.toUpperCase()} · {row.mode.toUpperCase()} · {row.tradingActive ? "ACTIVE" : "PAUSED"}
                  </p>
                </div>
                <button
                  onClick={() => togglePin(row.marketId)}
                  className={`rounded p-1 ${row.pinned ? "text-[var(--accent-yellow)]" : "text-[var(--text-secondary)]"}`}
                  title={row.pinned ? "Unpin market" : "Pin market"}
                >
                  <Star size={14} fill={row.pinned ? "currentColor" : "none"} />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <span className="text-[var(--text-secondary)]">Spot</span>
                <span className="text-right font-mono">
                  {row.latestPrice !== null ? `$${row.latestPrice.toFixed(2)}` : "—"}
                </span>
                <span className="text-[var(--text-secondary)]">UP / DOWN</span>
                <span className="text-right font-mono">
                  {row.upMid !== null && row.downMid !== null
                    ? `${Math.round(row.upMid * 100)}c / ${Math.round(row.downMid * 100)}c`
                    : "—"}
                </span>
                <span className="text-[var(--text-secondary)]">Total PnL</span>
                <span className={`text-right font-mono ${row.totalPnl >= 0 ? "text-[var(--accent-green)]" : "text-[var(--accent-red)]"}`}>
                  {formatCurrency(row.totalPnl)}
                </span>
                <span className="text-[var(--text-secondary)]">Win Rate</span>
                <span className="text-right font-mono">{row.winRate.toFixed(1)}%</span>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <button
                  onClick={() => onSelectMarket(row.marketId)}
                  className="rounded border border-[var(--border)] px-2 py-1 text-[11px]"
                >
                  Select
                </button>
                <button
                  onClick={() => onFocusMarket(row.marketId)}
                  className="rounded border border-[var(--border)] px-2 py-1 text-[11px]"
                >
                  <Target size={11} className="mr-1 inline" />
                  Focus
                </button>
                <button
                  onClick={() => void toggleTrading(row)}
                  disabled={togglePending === row.marketId}
                  className="rounded border border-[var(--border)] px-2 py-1 text-[11px] disabled:opacity-50"
                >
                  {togglePending === row.marketId ? "..." : row.tradingActive ? <Square size={11} className="inline" /> : <Play size={11} className="inline" />}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

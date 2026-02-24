import { useMemo } from "react";
import { useStore } from "../store/index.js";
import { Activity } from "lucide-react";

function formatAge(ageMs: number | null): string {
  if (ageMs === null || ageMs < 0) return "n/a";
  if (ageMs < 1000) return `${ageMs.toFixed(0)} ms`;
  return `${(ageMs / 1000).toFixed(1)} s`;
}

function statusClass(status: "healthy" | "stale" | "down"): string {
  if (status === "healthy") return "text-[var(--accent-green)]";
  if (status === "stale") return "text-[var(--accent-yellow)]";
  return "text-[var(--accent-red)]";
}

export function FeedHealthCard() {
  const feedHealth = useStore((s) => s.feedHealth);

  const qualityLabel = useMemo(() => {
    const active = feedHealth.healthyCount + feedHealth.staleCount;
    if (active >= 5) return "High confidence";
    if (active >= 4) return "Moderate confidence";
    return "Degraded confidence";
  }, [feedHealth.healthyCount, feedHealth.staleCount]);

  return (
    <div className="bg-[var(--bg-card)] rounded-xl p-4 border border-[var(--border)]">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-[var(--accent-blue)]" />
          <h3 className="text-sm font-semibold">Feed Health</h3>
        </div>
        <div className="text-xs font-mono text-[var(--text-secondary)]">
          used {feedHealth.oracleSourceCount}/6
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3 mb-3 text-xs">
        <div className="bg-[var(--bg-secondary)] rounded px-3 py-2">
          <div className="text-[var(--text-secondary)]">Healthy</div>
          <div className="font-mono text-[var(--accent-green)]">
            {feedHealth.healthyCount}
          </div>
        </div>
        <div className="bg-[var(--bg-secondary)] rounded px-3 py-2">
          <div className="text-[var(--text-secondary)]">Stale</div>
          <div className="font-mono text-[var(--accent-yellow)]">
            {feedHealth.staleCount}
          </div>
        </div>
        <div className="bg-[var(--bg-secondary)] rounded px-3 py-2">
          <div className="text-[var(--text-secondary)]">Down</div>
          <div className="font-mono text-[var(--accent-red)]">
            {feedHealth.downCount}
          </div>
        </div>
        <div className="bg-[var(--bg-secondary)] rounded px-3 py-2">
          <div className="text-[var(--text-secondary)]">Oracle</div>
          <div className="font-mono">
            ${feedHealth.oracleEstimate.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>
      </div>

      <div className="text-xs mb-2">
        <span className="text-[var(--text-secondary)]">Quality: </span>
        <span
          className={
            qualityLabel === "High confidence"
              ? "text-[var(--accent-green)]"
              : qualityLabel === "Moderate confidence"
                ? "text-[var(--accent-yellow)]"
                : "text-[var(--accent-red)]"
          }
        >
          {qualityLabel}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[var(--text-secondary)] border-b border-[var(--border)]">
              <th className="text-left py-1">Source</th>
              <th className="text-left py-1">Status</th>
              <th className="text-right py-1">Age</th>
              <th className="text-right py-1">Price</th>
              <th className="text-right py-1">Bid</th>
              <th className="text-right py-1">Ask</th>
            </tr>
          </thead>
          <tbody>
            {feedHealth.sources.map((s) => (
              <tr key={s.name} className="border-t border-[var(--border)]/50">
                <td className="py-1 capitalize">{s.name}</td>
                <td className={`py-1 capitalize ${statusClass(s.status)}`}>
                  {s.status}
                </td>
                <td className="py-1 text-right font-mono text-[var(--text-secondary)]">
                  {formatAge(s.ageMs)}
                </td>
                <td className="py-1 text-right font-mono">
                  {s.price !== null ? s.price.toFixed(2) : "—"}
                </td>
                <td className="py-1 text-right font-mono text-[var(--text-secondary)]">
                  {s.bid !== null ? s.bid.toFixed(2) : "—"}
                </td>
                <td className="py-1 text-right font-mono text-[var(--text-secondary)]">
                  {s.ask !== null ? s.ask.toFixed(2) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

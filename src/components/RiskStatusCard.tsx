import { ShieldAlert } from "lucide-react";
import { useStore } from "../store/index.js";

function fmtMoney(v: number): string {
  return `${v >= 0 ? "+" : ""}$${v.toFixed(2)}`;
}

function ratioColor(current: number, limit: number): string {
  if (limit <= 0) return "text-[var(--text-secondary)]";
  const pct = current / limit;
  if (pct >= 0.9) return "text-[var(--accent-red)]";
  if (pct >= 0.7) return "text-[var(--accent-yellow)]";
  return "text-[var(--accent-green)]";
}

export function RiskStatusCard() {
  const risk = useStore((s) => s.risk);
  const killSwitches = useStore((s) => s.killSwitches);
  const activeCount = killSwitches.filter((k) => k.active).length;

  const rows = [
    {
      label: "Concurrent Positions",
      current: risk.openPositions,
      limit: risk.maxConcurrentPositions,
      value: `${risk.openPositions} / ${risk.maxConcurrentPositions}`,
      color: ratioColor(risk.openPositions, risk.maxConcurrentPositions),
    },
    {
      label: "Total Exposure",
      current: risk.openExposure,
      limit: risk.maxTotalExposure,
      value: `$${risk.openExposure.toFixed(2)} / $${risk.maxTotalExposure.toFixed(2)}`,
      color: ratioColor(risk.openExposure, risk.maxTotalExposure),
    },
    {
      label: "Daily P&L",
      current: Math.max(0, -risk.dailyPnl),
      limit: risk.maxDailyLoss,
      value: `${fmtMoney(risk.dailyPnl)} / -$${risk.maxDailyLoss.toFixed(2)}`,
      color: ratioColor(Math.max(0, -risk.dailyPnl), risk.maxDailyLoss),
    },
    {
      label: "Hourly P&L",
      current: Math.max(0, -risk.hourlyPnl),
      limit: risk.maxHourlyLoss,
      value: `${fmtMoney(risk.hourlyPnl)} / -$${risk.maxHourlyLoss.toFixed(2)}`,
      color: ratioColor(Math.max(0, -risk.hourlyPnl), risk.maxHourlyLoss),
    },
    {
      label: "Consecutive Losses",
      current: risk.consecutiveLosses,
      limit: risk.maxConsecutiveLosses,
      value: `${risk.consecutiveLosses} / ${risk.maxConsecutiveLosses}`,
      color: ratioColor(risk.consecutiveLosses, risk.maxConsecutiveLosses),
    },
    {
      label: "Window Losses",
      current: risk.windowLosses,
      limit: risk.maxLossPerWindow,
      value: `${risk.windowLosses} / ${risk.maxLossPerWindow}`,
      color: ratioColor(risk.windowLosses, risk.maxLossPerWindow),
    },
  ];

  return (
    <div className="bg-[var(--bg-card)] rounded-xl p-4 border border-[var(--border)]">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
          <ShieldAlert size={14} />
          <span>Risk & Kill Switches</span>
        </div>
        <div
          className={`text-xs px-2 py-1 rounded border ${
            activeCount > 0
              ? "text-[var(--accent-red)] border-[var(--accent-red)]/40 bg-[var(--accent-red)]/10"
              : "text-[var(--accent-green)] border-[var(--accent-green)]/40 bg-[var(--accent-green)]/10"
          }`}
        >
          {activeCount > 0 ? `${activeCount} active` : "All clear"}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {rows.map((r) => (
          <div
            key={r.label}
            className="rounded-md border border-[var(--border)]/70 bg-[var(--bg-secondary)]/40 px-3 py-2"
          >
            <div className="text-[11px] text-[var(--text-secondary)]">{r.label}</div>
            <div className={`text-sm font-mono ${r.color}`}>{r.value}</div>
          </div>
        ))}
      </div>

      <div className="mt-3 text-xs text-[var(--text-secondary)]">
        Auto-pause:{" "}
        {risk.pauseRemainingSec > 0 ? (
          <span className="text-[var(--accent-red)] font-medium">
            {risk.pauseRemainingSec}s remaining
          </span>
        ) : (
          <span className="text-[var(--accent-green)] font-medium">inactive</span>
        )}
      </div>
    </div>
  );
}


import { useStore } from "../store/index.js";
import {
  LineChart,
  Line,
  ResponsiveContainer,
} from "recharts";
import {
  DollarSign,
  TrendingUp,
  BarChart3,
  Target,
  Eye,
} from "lucide-react";

export function PnLCard() {
  const pnl = useStore((s) => s.pnl);
  const shadowPnl = useStore((s) => s.shadowPnl);
  const mode = useStore((s) => s.mode);

  const activePnl = mode === "shadow" ? shadowPnl : pnl;

  const cards = [
    {
      label: "Total P&L",
      value: activePnl.totalPnl,
      icon: DollarSign,
      format: (v: number) => `${v >= 0 ? "+" : ""}$${v.toFixed(2)}`,
      color: activePnl.totalPnl >= 0 ? "var(--accent-green)" : "var(--accent-red)",
    },
    {
      label: "Today",
      value: activePnl.todayPnl,
      icon: TrendingUp,
      format: (v: number) => `${v >= 0 ? "+" : ""}$${v.toFixed(2)}`,
      color: activePnl.todayPnl >= 0 ? "var(--accent-green)" : "var(--accent-red)",
    },
    {
      label: "Total Trades",
      value: activePnl.totalTrades,
      icon: BarChart3,
      format: (v: number) => v.toString(),
      color: "var(--accent-blue)",
    },
    {
      label: "Win Rate",
      value: activePnl.winRate,
      icon: Target,
      format: (v: number) => `${v.toFixed(1)}%`,
      color:
        activePnl.winRate >= 50 ? "var(--accent-green)" : "var(--accent-yellow)",
    },
  ];

  return (
    <div className="bg-[var(--bg-card)] rounded-xl p-4 border border-[var(--border)]">
      {mode === "shadow" && (
        <div className="flex items-center gap-1.5 mb-3 text-xs text-[var(--accent-yellow)]">
          <Eye size={12} />
          Shadow Mode P&L
        </div>
      )}
      <div className="grid grid-cols-4 gap-3 mb-3">
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <div key={c.label} className="flex flex-col">
              <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] mb-1">
                <Icon size={12} />
                {c.label}
              </div>
              <span
                className="font-mono text-lg font-semibold"
                style={{ color: c.color }}
              >
                {c.format(c.value)}
              </span>
            </div>
          );
        })}
      </div>

      {activePnl.history.length > 1 && (
        <div className="h-16">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={activePnl.history}>
              <Line
                type="monotone"
                dataKey="cumulativePnl"
                stroke={
                  activePnl.totalPnl >= 0
                    ? "var(--accent-green)"
                    : "var(--accent-red)"
                }
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {Object.keys(activePnl.byStrategy).length > 0 && (
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <div className="text-xs text-[var(--text-secondary)] mb-2">
            By Strategy
          </div>
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(activePnl.byStrategy).map(([name, s]) => (
              <div
                key={name}
                className="flex items-center justify-between text-xs bg-[var(--bg-secondary)] px-2 py-1.5 rounded"
              >
                <span className="capitalize">{name}</span>
                <span
                  className="font-mono"
                  style={{
                    color:
                      s.pnl >= 0
                        ? "var(--accent-green)"
                        : "var(--accent-red)",
                  }}
                >
                  {s.pnl >= 0 ? "+" : ""}${s.pnl.toFixed(2)} ({s.winRate.toFixed(0)}%)
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

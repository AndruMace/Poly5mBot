import { useStore } from "../store/index.js";
import { useState } from "react";
import { Brain, Zap, Eye, Pause, ShieldOff } from "lucide-react";

const STATUS_ICONS: Record<string, typeof Pause> = {
  idle: Pause,
  watching: Eye,
  trading: Zap,
  regime_blocked: ShieldOff,
};

const STATUS_COLORS: Record<string, string> = {
  idle: "text-[var(--text-secondary)]",
  watching: "text-[var(--accent-yellow)]",
  trading: "text-[var(--accent-green)]",
  regime_blocked: "text-[var(--accent-red)]",
};

export function StrategyMini() {
  const strategies = useStore((s) => s.strategies);
  const [selectedReason, setSelectedReason] = useState<{
    name: string;
    reason: string;
  } | null>(null);

  function handleStrategyClick(name: string, status: string, reason?: string | null) {
    if (status === "idle") {
      const resolvedReason =
        reason ?? "No signal conditions met for the current market state.";
      setSelectedReason((prev) =>
        prev?.name === name ? null : { name, reason: resolvedReason },
      );
      return;
    }
    setSelectedReason(null);
  }

  return (
    <div className="bg-[var(--bg-card)] rounded-xl p-4 border border-[var(--border)]">
      <div className="flex items-center gap-2 mb-3 text-sm text-[var(--text-secondary)]">
        <Brain size={14} />
        <span>Active Strategies</span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {strategies.map((s) => {
          const StatusIcon = STATUS_ICONS[s.status] ?? Pause;
          return (
            <button
              key={s.name}
              onClick={() => handleStrategyClick(s.name, s.status, s.statusReason)}
              className={`flex items-center justify-between px-3 py-2 rounded-lg border ${
                s.enabled
                  ? "border-[var(--accent-blue)]/30 bg-[var(--accent-blue)]/5"
                  : "border-[var(--border)] bg-[var(--bg-secondary)]"
              } ${s.enabled && s.status === "idle" ? "cursor-pointer hover:border-[var(--accent-yellow)]/40" : "cursor-default"}`}
            >
              <div className="flex items-center gap-2">
                <StatusIcon
                  size={12}
                  className={STATUS_COLORS[s.status] ?? STATUS_COLORS.idle}
                />
                <span className="text-sm capitalize">{s.name}</span>
              </div>
              <div className="flex items-center gap-2 text-xs font-mono">
                <span className="text-[var(--accent-green)]">{s.wins}W</span>
                <span className="text-[var(--accent-red)]">{s.losses}L</span>
              </div>
            </button>
          );
        })}
        {strategies.length === 0 && (
          <div className="col-span-2 text-sm text-[var(--text-secondary)] text-center py-4">
            No strategies loaded
          </div>
        )}
      </div>
      {selectedReason && (
        <div className="mt-3 text-xs bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-secondary)]">
          <span className="font-medium capitalize text-[var(--text-primary)]">
            {selectedReason.name}
          </span>
          <span>: {selectedReason.reason}</span>
        </div>
      )}
    </div>
  );
}

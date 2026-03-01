import type { TradeOutcome, TradeStatus } from "../types/index.js";

export function TradeStatusBadge({
  status,
  outcome,
  compact = false,
}: {
  status: TradeStatus | string;
  outcome: TradeOutcome | string | null;
  compact?: boolean;
}) {
  const base = compact
    ? "px-1.5 py-0.5 rounded text-xs"
    : "px-1.5 py-0.5 rounded";

  if (status === "resolved") {
    return (
      <span
        className={`${base} ${
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
      <span className={`${base} bg-[var(--accent-blue)]/15 text-[var(--accent-blue)]`}>
        Active
      </span>
    );
  }
  if (status === "partial") {
    return (
      <span className={`${base} bg-[var(--accent-yellow)]/15 text-[var(--accent-yellow)]`}>
        Partial
      </span>
    );
  }
  if (status === "submitted" || status === "pending") {
    return (
      <span className={`${base} bg-[var(--accent-blue)]/10 text-[var(--text-secondary)]`}>
        {status}
      </span>
    );
  }
  if (status === "cancelled") {
    return (
      <span className={`${base} bg-[var(--text-secondary)]/15 text-[var(--text-secondary)]`}>
        Cancelled
      </span>
    );
  }
  if (status === "rejected") {
    return (
      <span className={`${base} bg-[var(--accent-red)]/15 text-[var(--accent-red)]`}>
        Rejected
      </span>
    );
  }
  if (status === "expired") {
    return (
      <span className={`${base} bg-[var(--accent-yellow)]/10 text-[var(--text-secondary)]`}>
        Expired
      </span>
    );
  }
  return (
    <span className={`${base} bg-[var(--accent-yellow)]/15 text-[var(--accent-yellow)]`}>
      {status}
    </span>
  );
}

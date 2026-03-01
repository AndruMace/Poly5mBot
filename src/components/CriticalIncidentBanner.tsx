import { useMemo } from "react";
import { useRxValue } from "@effect-rx/rx-react";
import { AlertTriangle } from "lucide-react";
import { incidentsRx } from "../store/index.js";

export function CriticalIncidentBanner() {
  const incidents = useRxValue(incidentsRx);

  const active = useMemo(
    () => incidents.filter((i) => i.resolvedAt === null).sort((a, b) => b.createdAt - a.createdAt),
    [incidents],
  );

  if (active.length === 0) return null;
  const newest = active[0]!;

  return (
    <div className="mx-4 mt-3 rounded-lg border border-[var(--accent-red)]/50 bg-[var(--accent-red)]/15 p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className="mt-0.5 text-[var(--accent-red)]" />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-[var(--accent-red)]">
            Critical Incident Active ({active.length})
          </div>
          <div className="text-sm text-[var(--text-primary)]">
            {newest.message}
          </div>
          <div className="mt-1 text-xs text-[var(--text-secondary)]">
            {new Date(newest.createdAt).toLocaleString()} · Kind: {newest.kind}
          </div>
        </div>
      </div>
    </div>
  );
}

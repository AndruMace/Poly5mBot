import { useEffect, useMemo, useState } from "react";
import { useRxValue } from "@effect-rx/rx-react";
import { AlertTriangle, X } from "lucide-react";
import { incidentsRx } from "../store/index.js";

export function CriticalIncidentBanner() {
  const incidents = useRxValue(incidentsRx);
  const [dismissedIncidentId, setDismissedIncidentId] = useState<string | null>(null);

  const active = useMemo(
    () => incidents.filter((i) => i.resolvedAt === null).sort((a, b) => b.createdAt - a.createdAt),
    [incidents],
  );

  const newest = active[0] ?? null;
  const newestId = newest?.id ?? null;
  const isDismissed = newestId !== null && dismissedIncidentId === newestId;

  useEffect(() => {
    // Re-open banner automatically when a new incident becomes newest.
    if (dismissedIncidentId !== null && newestId !== null && dismissedIncidentId !== newestId) {
      setDismissedIncidentId(null);
    }
  }, [dismissedIncidentId, newestId]);

  if (!newest) return null;

  if (isDismissed) return null;

  return (
    <div className="mx-4 mt-3 rounded-lg border border-[var(--accent-red)]/50 bg-[var(--accent-red)]/15 p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className="mt-0.5 text-[var(--accent-red)]" />
        <div className="min-w-0 flex-1">
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
        <button
          type="button"
          aria-label="Dismiss critical incident banner"
          title="Dismiss"
          onClick={() => setDismissedIncidentId(newest.id)}
          className="rounded p-1 text-[var(--text-secondary)] hover:bg-black/10 hover:text-[var(--text-primary)]"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

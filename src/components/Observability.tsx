import { useCallback, useEffect, useMemo, useState } from "react";
import { useRxValue } from "@effect-rx/rx-react";
import { Activity, Search, Save, Clock3, Table2, AlertTriangle, ShieldAlert, RefreshCw, Play } from "lucide-react";
import {
  observabilityEventsRx,
  killSwitchesRx,
  riskRx,
  tradingActiveRx,
  activeMarketIdRx,
  exchangeConnectedRx,
} from "../store/index.js";
import {
  OBSERVABILITY_CATEGORIES,
  OBSERVABILITY_ENTITY_TYPES,
  OBSERVABILITY_SOURCES,
} from "../../server/src/shared/observability.js";
import type {
  ObservabilityCategory,
  CriticalIncident,
  ObservabilityEntityType,
  ObservabilityEvent,
  ObservabilityMetricsResponse,
  ObservabilitySource,
  ObservabilityEventsPageResponse,
  TradeTimeframe,
  TradingMode,
} from "../types/index.js";
import { resetMarketKillSwitches, toggleMarketTrading } from "../utils/market-actions.js";

type ViewMode = "timeline" | "table";

interface FiltersState {
  timeframe: TradeTimeframe;
  category: ObservabilityCategory | "";
  source: ObservabilitySource | "";
  strategy: string;
  mode: TradingMode | "";
  status: string;
  entityType: ObservabilityEntityType | "";
  entityId: string;
  q: string;
}

interface SavedFilter {
  id: string;
  name: string;
  filters: FiltersState;
}

const DEFAULT_FILTERS: FiltersState = {
  timeframe: "30d",
  category: "",
  source: "",
  strategy: "",
  mode: "",
  status: "",
  entityType: "",
  entityId: "",
  q: "",
};

const STORAGE_KEY = "observabilitySavedFilters";
const PAGE_SIZE = 200;

const CATEGORY_OPTIONS: Array<ObservabilityCategory> = [...OBSERVABILITY_CATEGORIES];
const SOURCE_OPTIONS: Array<ObservabilitySource> = [...OBSERVABILITY_SOURCES];
const ENTITY_OPTIONS: Array<ObservabilityEntityType> = [...OBSERVABILITY_ENTITY_TYPES];

const TIMEFRAME_OPTIONS: Array<{ value: TradeTimeframe; label: string }> = [
  { value: "1h", label: "1h" },
  { value: "12h", label: "12h" },
  { value: "1d", label: "1d" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "all" },
];

function normalizeRows(rows: ObservabilityEvent[]): ObservabilityEvent[] {
  return [...rows].sort((a, b) => b.timestamp - a.timestamp);
}

export function Observability() {
  const liveEvents = useRxValue(observabilityEventsRx);
  const [filters, setFilters] = useState<FiltersState>({ ...DEFAULT_FILTERS });
  const [viewMode, setViewMode] = useState<ViewMode>("timeline");
  const [rows, setRows] = useState<ObservabilityEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<ObservabilityMetricsResponse | null>(null);
  const [selected, setSelected] = useState<ObservabilityEvent | null>(null);
  const [incidents, setIncidents] = useState<CriticalIncident[]>([]);
  const [incidentLoading, setIncidentLoading] = useState(false);
  const [incidentError, setIncidentError] = useState<string | null>(null);
  const [selectedIncident, setSelectedIncident] = useState<CriticalIncident | null>(null);
  const [resolvingIncidentId, setResolvingIncidentId] = useState<string | null>(null);
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([]);
  const [gateActionError, setGateActionError] = useState<string | null>(null);
  const [gateActionLoading, setGateActionLoading] = useState<"reset" | "start" | null>(null);
  const killSwitches = useRxValue(killSwitchesRx);
  const risk = useRxValue(riskRx);
  const tradingActive = useRxValue(tradingActiveRx);
  const activeMarketId = useRxValue(activeMarketIdRx);
  const exchangeConnected = useRxValue(exchangeConnectedRx);

  useEffect(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as SavedFilter[];
      if (Array.isArray(parsed)) setSavedFilters(parsed.slice(0, 10));
    } catch {
      /* ignore invalid local cache */
    }
  }, []);

  const persistSavedFilters = useCallback((next: SavedFilter[]) => {
    setSavedFilters(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore localStorage failures */
    }
  }, []);

  const buildQuery = useCallback(
    (cursor: string | null, limit = PAGE_SIZE) => {
      const qs = new URLSearchParams({
        limit: String(limit),
        timeframe: filters.timeframe,
      });
      if (cursor) qs.set("cursor", cursor);
      if (filters.category) qs.set("category", filters.category);
      if (filters.source) qs.set("source", filters.source);
      if (filters.strategy.trim()) qs.set("strategy", filters.strategy.trim());
      if (filters.mode) qs.set("mode", filters.mode);
      if (filters.status.trim()) qs.set("status", filters.status.trim());
      if (filters.entityType) qs.set("entityType", filters.entityType);
      if (filters.entityId.trim()) qs.set("entityId", filters.entityId.trim());
      if (filters.q.trim()) qs.set("q", filters.q.trim());
      return qs;
    },
    [filters],
  );

  const loadMetrics = useCallback(async () => {
    try {
      const res = await fetch(`/api/observability/metrics?${buildQuery(null, 1).toString()}`);
      if (!res.ok) return;
      const payload = (await res.json()) as ObservabilityMetricsResponse;
      setMetrics(payload);
    } catch {
      /* best effort */
    }
  }, [buildQuery]);

  const loadIncidents = useCallback(async () => {
    setIncidentLoading(true);
    setIncidentError(null);
    try {
      const res = await fetch("/api/incidents?limit=200");
      if (!res.ok) throw new Error(`Incident request failed (${res.status})`);
      const payload = (await res.json()) as { items?: CriticalIncident[] };
      const rows = Array.isArray(payload.items) ? payload.items : [];
      rows.sort((a, b) => b.createdAt - a.createdAt);
      setIncidents(rows);
    } catch (err) {
      setIncidentError(err instanceof Error ? err.message : "Failed to load incidents");
      setIncidents([]);
    } finally {
      setIncidentLoading(false);
    }
  }, []);

  const loadPage = useCallback(
    async (cursor: string | null, targetPage: number) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/observability/events?${buildQuery(cursor).toString()}`);
        if (!res.ok) throw new Error(`Observability request failed (${res.status})`);
        const payload = (await res.json()) as ObservabilityEventsPageResponse;
        setRows(normalizeRows([...payload.items]));
        setNextCursor(payload.nextCursor);
        setPageIndex(targetPage);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load observability events");
        setRows([]);
        setNextCursor(null);
      } finally {
        setLoading(false);
      }
    },
    [buildQuery],
  );

  const resolveIncident = useCallback(
    async (incidentId: string) => {
      if (!incidentId || resolvingIncidentId) return;
      setResolvingIncidentId(incidentId);
      setIncidentError(null);
      try {
        const res = await fetch(`/api/incidents/${encodeURIComponent(incidentId)}/resolve`, {
          method: "POST",
        });
        if (!res.ok) throw new Error(`Resolve request failed (${res.status})`);
        await loadIncidents();
        void loadPage(cursorHistory[pageIndex] ?? null, pageIndex);
        void loadMetrics();
      } catch (err) {
        setIncidentError(err instanceof Error ? err.message : "Failed to resolve incident");
      } finally {
        setResolvingIncidentId(null);
      }
    },
    [cursorHistory, loadIncidents, loadMetrics, loadPage, pageIndex, resolvingIncidentId],
  );

  useEffect(() => {
    setCursorHistory([null]);
    void loadPage(null, 0);
    void loadMetrics();
    void loadIncidents();
  }, [loadIncidents, loadMetrics, loadPage]);

  useEffect(() => {
    if (pageIndex !== 0 || liveEvents.length === 0) return;
    setRows((prev) => {
      const merged = new Map<string, ObservabilityEvent>();
      for (const e of prev) merged.set(e.eventId, e);
      for (const e of liveEvents) merged.set(e.eventId, e);
      return normalizeRows(Array.from(merged.values())).slice(0, PAGE_SIZE);
    });
  }, [liveEvents, pageIndex]);

  const goNext = async () => {
    if (!nextCursor || loading) return;
    const nextPage = pageIndex + 1;
    setCursorHistory((prev) => {
      const copy = prev.slice(0, nextPage);
      copy[nextPage] = nextCursor;
      return copy;
    });
    await loadPage(nextCursor, nextPage);
  };

  const goPrev = async () => {
    if (pageIndex === 0 || loading) return;
    const prevPage = pageIndex - 1;
    await loadPage(cursorHistory[prevPage] ?? null, prevPage);
  };

  const categoryCounts = useMemo(
    () => metrics?.byCategory ?? [],
    [metrics],
  );

  const activeIncidents = useMemo(
    () => incidents.filter((incident) => incident.resolvedAt === null),
    [incidents],
  );

  const saveCurrentFilter = () => {
    const name = window.prompt("Name this filter preset:");
    if (!name || name.trim().length === 0) return;
    const next: SavedFilter[] = [
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: name.trim(),
        filters: { ...filters },
      },
      ...savedFilters,
    ].slice(0, 10);
    persistSavedFilters(next);
  };

  const applySavedFilter = (item: SavedFilter) => {
    setFilters({ ...item.filters });
  };

  const resetKillSwitchPauses = useCallback(async () => {
    setGateActionError(null);
    setGateActionLoading("reset");
    try {
      await resetMarketKillSwitches(activeMarketId);
    } catch (err) {
      setGateActionError(err instanceof Error ? err.message : "Failed to reset kill switches");
    } finally {
      setGateActionLoading(null);
    }
  }, [activeMarketId]);

  const startTrading = useCallback(async () => {
    setGateActionError(null);
    setGateActionLoading("start");
    try {
      await toggleMarketTrading(activeMarketId);
    } catch (err) {
      setGateActionError(err instanceof Error ? err.message : "Failed to start trading");
    } finally {
      setGateActionLoading(null);
    }
  }, [activeMarketId]);

  const activeKillSwitches = useMemo(
    () => killSwitches.filter((ks) => ks.active),
    [killSwitches],
  );

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity size={16} className="text-[var(--accent-blue)]" />
            <h2 className="text-lg font-semibold">Observability & Data Discovery</h2>
            <span className="text-xs text-[var(--text-secondary)]">
              {loading ? "Loading..." : `${rows.length} events on page`}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setViewMode("timeline")}
              className={`rounded px-2 py-1 text-xs ${viewMode === "timeline" ? "bg-[var(--accent-blue)] text-white" : "bg-[var(--bg-secondary)] text-[var(--text-secondary)]"}`}
            >
              <Clock3 size={12} className="mr-1 inline" />
              Timeline
            </button>
            <button
              onClick={() => setViewMode("table")}
              className={`rounded px-2 py-1 text-xs ${viewMode === "table" ? "bg-[var(--accent-blue)] text-white" : "bg-[var(--bg-secondary)] text-[var(--text-secondary)]"}`}
            >
              <Table2 size={12} className="mr-1 inline" />
              Table
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
          <select value={filters.timeframe} onChange={(e) => setFilters((f) => ({ ...f, timeframe: e.target.value as TradeTimeframe }))} className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs">
            {TIMEFRAME_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
          <select value={filters.category} onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value as ObservabilityCategory | "" }))} className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs">
            <option value="">all categories</option>
            {CATEGORY_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          <select value={filters.source} onChange={(e) => setFilters((f) => ({ ...f, source: e.target.value as ObservabilitySource | "" }))} className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs">
            <option value="">all sources</option>
            {SOURCE_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          <select value={filters.mode} onChange={(e) => setFilters((f) => ({ ...f, mode: e.target.value as TradingMode | "" }))} className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs">
            <option value="">all modes</option>
            <option value="live">live</option>
            <option value="shadow">shadow</option>
          </select>
          <input value={filters.strategy} onChange={(e) => setFilters((f) => ({ ...f, strategy: e.target.value }))} placeholder="strategy" className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs" />
          <input value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))} placeholder="status" className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs" />
          <select value={filters.entityType} onChange={(e) => setFilters((f) => ({ ...f, entityType: e.target.value as ObservabilityEntityType | "" }))} className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs">
            <option value="">all entity types</option>
            {ENTITY_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          <input value={filters.entityId} onChange={(e) => setFilters((f) => ({ ...f, entityId: e.target.value }))} placeholder="entity id" className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs" />
          <div className="col-span-2 flex gap-2 md:col-span-2">
            <input value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} placeholder="search" className="w-full rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs" />
            <button onClick={() => { setCursorHistory([null]); void loadPage(null, 0); void loadMetrics(); }} className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs">
              <Search size={12} className="mr-1 inline" />
              Apply
            </button>
            <button onClick={saveCurrentFilter} className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs">
              <Save size={12} className="mr-1 inline" />
              Save
            </button>
          </div>
        </div>

        {savedFilters.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {savedFilters.map((s) => (
              <button
                key={s.id}
                onClick={() => applySavedFilter(s)}
                className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                {s.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3">
          <div className="text-xs text-[var(--text-secondary)]">Total</div>
          <div className="text-2xl font-semibold">{metrics?.total ?? 0}</div>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3 md:col-span-3">
          <div className="mb-2 text-xs text-[var(--text-secondary)]">By category</div>
          <div className="flex flex-wrap gap-2 text-xs">
            {categoryCounts.map((row) => (
              <span key={row.category} className="rounded bg-[var(--bg-secondary)] px-2 py-1">
                {row.category}: {row.count}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <ShieldAlert size={14} className="text-[var(--accent-yellow)]" />
            <span>Rejection Gates</span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => void resetKillSwitchPauses()}
              disabled={gateActionLoading !== null}
              className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs disabled:opacity-50"
            >
              <RefreshCw size={11} className="mr-1 inline" />
              {gateActionLoading === "reset" ? "Resetting..." : "Reset Pauses"}
            </button>
            {!tradingActive && (
              <button
                onClick={() => void startTrading()}
                disabled={gateActionLoading !== null}
                className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs disabled:opacity-50"
              >
                <Play size={11} className="mr-1 inline" />
                {gateActionLoading === "start" ? "Starting..." : "Start Trading"}
              </button>
            )}
          </div>
        </div>
        {gateActionError && (
          <div className="mb-2 text-xs text-[var(--accent-red)]">{gateActionError}</div>
        )}
        <div className="grid gap-2 md:grid-cols-2">
          <div className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] p-2 text-xs">
            <div className="text-[var(--text-secondary)]">Trading Active</div>
            <div className={tradingActive ? "text-[var(--accent-green)]" : "text-[var(--accent-red)]"}>
              {tradingActive ? "yes" : "no"}
            </div>
          </div>
          <div className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] p-2 text-xs">
            <div className="text-[var(--text-secondary)]">Exchange Connected</div>
            <div className={exchangeConnected ? "text-[var(--accent-green)]" : "text-[var(--accent-red)]"}>
              {exchangeConnected ? "yes" : "no"}
            </div>
          </div>
          <div className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] p-2 text-xs">
            <div className="text-[var(--text-secondary)]">Auto-Pause Remaining</div>
            <div className={risk.pauseRemainingSec > 0 ? "text-[var(--accent-yellow)]" : "text-[var(--accent-green)]"}>
              {Math.max(0, Math.round(risk.pauseRemainingSec))}s
            </div>
          </div>
          <div className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] p-2 text-xs">
            <div className="text-[var(--text-secondary)]">Active Kill Switches</div>
            <div className={activeKillSwitches.length > 0 ? "text-[var(--accent-red)]" : "text-[var(--accent-green)]"}>
              {activeKillSwitches.length}
            </div>
          </div>
        </div>
        {killSwitches.length > 0 && (
          <div className="mt-2 max-h-[16vh] overflow-auto rounded border border-[var(--border)] bg-[var(--bg-secondary)] p-2">
            {killSwitches.map((ks) => (
              <div key={ks.name} className="mb-1 flex items-center justify-between text-xs last:mb-0">
                <span className={ks.active ? "text-[var(--accent-red)]" : "text-[var(--text-secondary)]"}>
                  {ks.name}
                </span>
                <span className="font-mono text-[10px] text-[var(--text-secondary)]">{ks.reason}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle size={14} className="text-[var(--accent-red)]" />
            <span>Critical Incidents</span>
            <span className="text-xs text-[var(--text-secondary)]">
              {incidentLoading ? "Loading..." : `${activeIncidents.length} active / ${incidents.length} total`}
            </span>
          </div>
          <button
            onClick={() => void loadIncidents()}
            className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs"
          >
            Refresh
          </button>
        </div>
        {incidentError ? (
          <div className="py-2 text-xs text-[var(--accent-red)]">{incidentError}</div>
        ) : incidents.length === 0 ? (
          <div className="py-2 text-xs text-[var(--text-secondary)]">No incidents found.</div>
        ) : (
          <div className="max-h-[28vh] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[var(--bg-card)]">
                <tr className="border-b border-[var(--border)] text-[var(--text-secondary)]">
                  <th className="px-2 py-2 text-left">Created</th>
                  <th className="px-2 py-2 text-left">Kind</th>
                  <th className="px-2 py-2 text-left">Message</th>
                  <th className="px-2 py-2 text-left">State</th>
                  <th className="px-2 py-2 text-left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {incidents.map((incident) => {
                  const isResolved = incident.resolvedAt !== null;
                  const canResolve = !isResolved;
                  return (
                    <tr
                      key={incident.id}
                      className="border-t border-[var(--border)]/50 hover:bg-[var(--bg-secondary)]/35"
                    >
                      <td className="px-2 py-2 text-[var(--text-secondary)]">
                        {new Date(incident.createdAt).toLocaleString()}
                      </td>
                      <td className="px-2 py-2">{incident.kind}</td>
                      <td className="max-w-[28rem] truncate px-2 py-2">{incident.message}</td>
                      <td className="px-2 py-2">{isResolved ? "resolved" : "active"}</td>
                      <td className="px-2 py-2">
                        <div className="flex gap-2">
                          <button
                            onClick={() => setSelectedIncident(incident)}
                            className="rounded border border-[var(--border)] px-2 py-1 text-[11px]"
                          >
                            View
                          </button>
                          <button
                            onClick={() => void resolveIncident(incident.id)}
                            disabled={!canResolve || resolvingIncidentId === incident.id}
                            className="rounded border border-[var(--border)] px-2 py-1 text-[11px] disabled:opacity-50"
                          >
                            {resolvingIncidentId === incident.id ? "Resolving..." : "Resolve"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3">
        <div className="mb-2 flex items-center justify-between text-xs text-[var(--text-secondary)]">
          <span>Page {pageIndex + 1}</span>
          <div className="flex gap-2">
            <button onClick={() => void goPrev()} disabled={pageIndex === 0 || loading} className="rounded border border-[var(--border)] px-2 py-1 disabled:opacity-50">Previous</button>
            <button onClick={() => void goNext()} disabled={!nextCursor || loading} className="rounded border border-[var(--border)] px-2 py-1 disabled:opacity-50">Next</button>
          </div>
        </div>

        {error ? (
          <div className="py-8 text-center text-sm text-[var(--accent-red)]">{error}</div>
        ) : rows.length === 0 ? (
          <div className="py-8 text-center text-sm text-[var(--text-secondary)]">No events found.</div>
        ) : viewMode === "timeline" ? (
          <div className="max-h-[62vh] space-y-2 overflow-y-auto">
            {rows.map((e) => (
              <button
                key={e.eventId}
                onClick={() => setSelected(e)}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-2 text-left hover:bg-[var(--bg-card)]"
              >
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium">{e.action}</span>
                  <span className="text-[var(--text-secondary)]">{new Date(e.timestamp).toLocaleString()}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-[var(--text-secondary)]">
                  <span>{e.category}</span>
                  <span>• {e.source}</span>
                  {e.strategy && <span>• {e.strategy}</span>}
                  {e.mode && <span>• {e.mode}</span>}
                  {e.status && <span>• {e.status}</span>}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="max-h-[62vh] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[var(--bg-card)]">
                <tr className="border-b border-[var(--border)] text-[var(--text-secondary)]">
                  <th className="px-2 py-2 text-left">Time</th>
                  <th className="px-2 py-2 text-left">Action</th>
                  <th className="px-2 py-2 text-left">Category</th>
                  <th className="px-2 py-2 text-left">Source</th>
                  <th className="px-2 py-2 text-left">Entity</th>
                  <th className="px-2 py-2 text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.eventId} className="cursor-pointer border-t border-[var(--border)]/50 hover:bg-[var(--bg-secondary)]/35" onClick={() => setSelected(e)}>
                    <td className="px-2 py-2 font-mono text-[var(--text-secondary)]">{new Date(e.timestamp).toLocaleTimeString()}</td>
                    <td className="px-2 py-2">{e.action}</td>
                    <td className="px-2 py-2">{e.category}</td>
                    <td className="px-2 py-2">{e.source}</td>
                    <td className="px-2 py-2">{e.entityType}:{e.entityId ?? "—"}</td>
                    <td className="px-2 py-2">{e.status ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selected && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Event Detail</h3>
            <button onClick={() => setSelected(null)} className="text-xs text-[var(--text-secondary)]">Close</button>
          </div>
          <pre className="max-h-[40vh] overflow-auto rounded bg-[var(--bg-secondary)] p-2 text-[11px] leading-relaxed">
            {JSON.stringify(selected, null, 2)}
          </pre>
        </div>
      )}
      {selectedIncident && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Incident Detail</h3>
            <button onClick={() => setSelectedIncident(null)} className="text-xs text-[var(--text-secondary)]">Close</button>
          </div>
          <pre className="max-h-[40vh] overflow-auto rounded bg-[var(--bg-secondary)] p-2 text-[11px] leading-relaxed">
            {JSON.stringify(selectedIncident, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

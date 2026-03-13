import { useEffect, useLayoutEffect, useContext } from "react";
import { Rx } from "@effect-rx/rx";
import { RegistryContext, useRxValue } from "@effect-rx/rx-react";
import {
  connectedRx,
  exchangeConnectedRx,
  walletAddressRx,
  tradingActiveRx,
  modeRx,
  pricesRx,
  orderBookRx,
  strategiesRx,
  tradesRx,
  pnlRx,
  shadowPnlRx,
  regimeRx,
  killSwitchesRx,
  riskRx,
  metricsRx,
  feedHealthRx,
  storageHealthRx,
  wsLastMessageTsRx,
  incidentsRx,
  observabilityEventsRx,
  activeMarketIdRx,
  enabledMarketsRx,
  perMarketStateRx,
  MAX_PNL_HISTORY,
  emptyOrderBook,
  emptyPnl,
  defaultRegime,
  emptyRisk,
  emptyMetrics,
  emptyFeedHealth,
  emptyStorageHealth,
} from "../store/index.js";
import type { PerMarketSnapshot } from "../store/index.js";
import type {
  WSMessage,
  PricePoint,
  TradeRecord,
  PnLSummary,
  WSStatusSnapshot,
  TradesPageResponse,
  CriticalIncident,
  ObservabilityEvent,
} from "../types/index.js";

const TRADE_FLUSH_MS = 120;
const STALE_WS_MS = 8000;
const RESUME_RECONNECT_COOLDOWN_MS = 2000;
const STATUS_REHYDRATE_COOLDOWN_MS = 5000;
const TRADE_BACKFILL_COOLDOWN_MS = 5000;
const TRADE_BACKFILL_MAX_PAGES = 6;
const TRADE_BUFFER_LIMIT = 2000;
const OBSERVABILITY_BUFFER_LIMIT = 5000;

type RxRegistry = {
  set: (atom: unknown, value: unknown) => void;
  get: (atom: unknown) => any;
  update: (atom: unknown, fn: (current: any) => any) => void;
};

function defaultPerMarketSnapshot(): PerMarketSnapshot {
  return {
    tradingActive: false,
    mode: "shadow",
    strategies: [],
    market: null,
    orderbook: { ...emptyOrderBook },
    prices: {},
    oracleEstimate: 0,
    feedHealth: { ...emptyFeedHealth },
    pnl: { ...emptyPnl },
    shadowPnl: { ...emptyPnl },
    trades: [],
    regime: { ...defaultRegime },
    killSwitches: [],
    risk: { ...emptyRisk },
    metrics: { ...emptyMetrics },
  };
}

function applyPerMarketSnapshot(registry: RxRegistry, snapshot: PerMarketSnapshot) {
  registry.set(tradingActiveRx, snapshot.tradingActive);
  registry.set(modeRx, snapshot.mode);
  registry.set(strategiesRx, [...snapshot.strategies]);
  registry.set(orderBookRx, snapshot.orderbook ?? { ...emptyOrderBook });
  registry.set(pnlRx, normalizePnlSummary(snapshot.pnl));
  registry.set(shadowPnlRx, normalizePnlSummary(snapshot.shadowPnl));
  registry.set(pricesRx, snapshot.prices);
  registry.set(regimeRx, { ...defaultRegime, ...snapshot.regime });
  registry.set(killSwitchesRx, [...snapshot.killSwitches]);
  registry.set(riskRx, { ...emptyRisk, ...snapshot.risk });
  registry.set(metricsRx, { ...emptyMetrics, ...snapshot.metrics });
  registry.set(feedHealthRx, { ...emptyFeedHealth, ...snapshot.feedHealth });
}

function shallowEqualPrices(
  a: Record<string, PricePoint>,
  b: Record<string, PricePoint>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    const pa = a[key];
    const pb = b[key];
    if (!pb) return false;
    if (
      pa.price !== pb.price ||
      pa.timestamp !== pb.timestamp ||
      pa.bid !== pb.bid ||
      pa.ask !== pb.ask
    ) {
      return false;
    }
  }
  return true;
}

function normalizePnlSummary(summary: PnLSummary | null | undefined): PnLSummary {
  const source = summary ?? emptyPnl;
  return {
    ...source,
    byStrategy: source.byStrategy ?? {},
    history: Array.isArray(source.history)
      ? source.history.slice(-MAX_PNL_HISTORY)
      : [],
  };
}

function equalPnlSummary(a: PnLSummary, b: PnLSummary): boolean {
  if (
    a.totalPnl !== b.totalPnl ||
    a.todayPnl !== b.todayPnl ||
    a.totalTrades !== b.totalTrades ||
    a.winRate !== b.winRate
  ) {
    return false;
  }

  const aHistory = a.history;
  const bHistory = b.history;
  if (aHistory.length !== bHistory.length) return false;
  if (aHistory.length > 0) {
    const aLast = aHistory[aHistory.length - 1]!;
    const bLast = bHistory[bHistory.length - 1]!;
    if (
      aLast.timestamp !== bLast.timestamp ||
      aLast.cumulativePnl !== bLast.cumulativePnl
    ) {
      return false;
    }
  }

  const aKeys = Object.keys(a.byStrategy);
  const bKeys = Object.keys(b.byStrategy);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    const sa = a.byStrategy[key];
    const sb = b.byStrategy[key];
    if (!sb) return false;
    if (
      sa.pnl !== sb.pnl ||
      sa.trades !== sb.trades ||
      sa.winRate !== sb.winRate
    ) {
      return false;
    }
  }

  return true;
}

export function useWebSocket() {
  const registry = useContext(RegistryContext);
  const activeMarketId = useRxValue(activeMarketIdRx);

  // Restore per-market state when the user switches tabs.
  // useLayoutEffect fires synchronously after DOM mutation, before paint — no flash of wrong data.
  useLayoutEffect(() => {
    const perMarket = registry.get(perMarketStateRx);
    // Skip if we have no per-market data yet (WS hasn't connected) — handleInitialState will populate
    if (Object.keys(perMarket).length === 0) return;
    const snap = perMarket[activeMarketId] ?? defaultPerMarketSnapshot();
    Rx.batch(() => {
      applyPerMarketSnapshot(registry as RxRegistry, snap);
    });
  }, [activeMarketId, registry]);

  useEffect(() => {
    let destroyed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let tradeFlushTimer: ReturnType<typeof setTimeout> | undefined;
    let activeSocket: WebSocket | null = null;
    let forceReconnectPending = false;
    let lastResumeReconnectAt = 0;
    let rehydrateInFlight = false;
    let lastStatusRehydrateAt = 0;
    let tradeBackfillInFlight = false;
    let lastTradeBackfillAt = 0;
    const pendingTrades = new Map<string, TradeRecord>();
    const mergeIncidents = (
      current: CriticalIncident[],
      incoming: CriticalIncident[],
      limit = 200,
    ): CriticalIncident[] => {
      const merged = new Map<string, CriticalIncident>();
      for (const i of current) merged.set(i.id, i);
      for (const i of incoming) merged.set(i.id, i);
      return Array.from(merged.values())
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit);
    };
    const mergeObservability = (
      current: ObservabilityEvent[],
      incoming: ObservabilityEvent[],
      limit = OBSERVABILITY_BUFFER_LIMIT,
    ): ObservabilityEvent[] => {
      const merged = new Map<string, ObservabilityEvent>();
      for (const e of current) merged.set(e.eventId, e);
      for (const e of incoming) merged.set(e.eventId, e);
      return Array.from(merged.values())
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit);
    };

    const clearReconnectTimer = () => {
      if (!reconnectTimer) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    };
    
    // Cleanup function for pendingTrades to prevent closure retention
    const clearPendingTrades = () => {
      pendingTrades.clear();
    };

    const mergeTrades = (
      current: TradeRecord[],
      incoming: TradeRecord[],
      limit = TRADE_BUFFER_LIMIT,
    ): TradeRecord[] => {
      const merged = new Map<string, TradeRecord>();
      for (const t of current) merged.set(t.id, t);
      for (const t of incoming) merged.set(t.id, t);
      return Array.from(merged.values())
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit);
    };

    // ── Per-market helpers ────────────────────────────────────────────────────

    /** Patch one field in the per-market state store.
     *  Creates a default entry for the market if it hasn't been seen before. */
    function patchPerMarket<K extends keyof PerMarketSnapshot>(
      mid: string,
      key: K,
      value: PerMarketSnapshot[K],
    ) {
      registry.update(perMarketStateRx, (prev) => {
        const ex = prev[mid] ?? defaultPerMarketSnapshot();
        return { ...prev, [mid]: { ...ex, [key]: value } };
      });
    }

    const protocol = window.location.protocol === "https:" ? "wss:"  : "ws:";
    const url = `${protocol}//${window.location.host}/ws`;

    const flushTrades = () => {
      tradeFlushTimer = undefined;
      if (pendingTrades.size === 0) return;
      const incoming = Array.from(pendingTrades.values());
      pendingTrades.clear();
      registry.update(tradesRx, (prev) => mergeTrades(prev, incoming));
    };

    const scheduleTradeFlush = () => {
      if (tradeFlushTimer) return;
      tradeFlushTimer = setTimeout(flushTrades, TRADE_FLUSH_MS);
    };

    const rehydrateFromHttpStatus = () => {
      if (destroyed || rehydrateInFlight) return;
      const now = Date.now();
      if (now - lastStatusRehydrateAt < STATUS_REHYDRATE_COOLDOWN_MS) return;
      lastStatusRehydrateAt = now;
      rehydrateInFlight = true;
      void fetch("/api/status")
        .then(async (res) => {
          if (!res.ok) return null;
          return (await res.json()) as {
            storage?: {
              backend: "file" | "dual" | "postgres";
              enabled: boolean;
              ok: boolean;
            };
          };
        })
        .then((data) => {
          if (!data || destroyed) return;
          // Don't set tradingActive/mode — per-market; WS events handle them.
          if (data.storage) {
            registry.set(storageHealthRx, {
              ...emptyStorageHealth,
              ...data.storage,
            });
          }
        })
        .catch(() => {
          /* best effort */
        })
        .finally(() => {
          rehydrateInFlight = false;
        });
    };

    const fetchIncidents = () => {
      if (destroyed) return;
      void fetch("/api/incidents?limit=200")
        .then(async (res) => {
          if (!res.ok) return null;
          return (await res.json()) as { items?: CriticalIncident[] };
        })
        .then((payload) => {
          if (!payload?.items || destroyed) return;
          registry.update(incidentsRx, (prev) => mergeIncidents(prev, payload.items ?? []));
        })
        .catch(() => {
          /* best effort */
        });
    };

    const refreshStorageHealth = () => {
      if (destroyed) return;
      void fetch("/api/storage/health")
        .then(async (res) => {
          if (!res.ok) return null;
          return (await res.json()) as {
            backend?: "file" | "dual" | "postgres";
            enabled?: boolean;
            ok?: boolean;
          };
        })
        .then((payload) => {
          if (!payload || destroyed) return;
          registry.set(storageHealthRx, {
            ...emptyStorageHealth,
            ...payload,
          });
        })
        .catch(() => {
          /* best effort */
        });
    };

    const backfillTrades = () => {
      if (destroyed || tradeBackfillInFlight) return;
      const now = Date.now();
      if (now - lastTradeBackfillAt < TRADE_BACKFILL_COOLDOWN_MS) return;
      lastTradeBackfillAt = now;
      tradeBackfillInFlight = true;
      void (async () => {
        let cursor: string | undefined;
        let page = 0;
        const collected: TradeRecord[] = [];
        try {
          while (page < TRADE_BACKFILL_MAX_PAGES) {
            const qs = new URLSearchParams({
              mode: "all",
              timeframe: "30d",
              limit: "500",
            });
            if (cursor) qs.set("cursor", cursor);
            const res = await fetch(`/api/trades?${qs.toString()}`);
            if (!res.ok) break;
            const payload = (await res.json()) as TradesPageResponse;
            collected.push(...payload.items);
            if (!payload.hasMore || !payload.nextCursor) break;
            cursor = payload.nextCursor;
            page += 1;
          }
          if (collected.length > 0 && !destroyed) {
            registry.update(tradesRx, (prev) => mergeTrades(prev, collected));
          }
        } catch {
          /* best effort */
        } finally {
          tradeBackfillInFlight = false;
        }
      })();
    };

    function handlePrices(data: any, msgMarketId: string) {
      const prices = data.prices as Record<string, PricePoint>;
      const oracleEstimate = data.oracleEstimate as number;

      // Always store in per-market state
      patchPerMarket(msgMarketId, "prices", prices);
      if (oracleEstimate > 0) patchPerMarket(msgMarketId, "oracleEstimate", oracleEstimate);

      // Only update display atoms for the active market
      const activeId = registry.get(activeMarketIdRx);
      if (msgMarketId !== activeId) return;

      const prevPrices = registry.get(pricesRx);
      if (!shallowEqualPrices(prevPrices, prices)) {
        registry.set(pricesRx, prices);
      }
    }

    function handleInitialState(data: WSStatusSnapshot) {
      registry.set(exchangeConnectedRx, data.exchangeConnected ?? false);
      if (data.walletAddress)
        registry.set(walletAddressRx, data.walletAddress);
      if (data.storage) {
        registry.set(storageHealthRx, { ...emptyStorageHealth, ...data.storage });
      }
      registry.update(
        observabilityEventsRx,
        (prev) => mergeObservability(prev, [...(data.observabilityEvents ?? [])]),
      );

      const marketSnapshots = data.markets ?? {};
      if (Object.keys(marketSnapshots).length === 0) {
        rehydrateFromHttpStatus();
        fetchIncidents();
        return;
      }

      const perMarket: Record<string, PerMarketSnapshot> = {};
      for (const [mid, snap] of Object.entries(marketSnapshots)) {
        perMarket[mid] = {
          tradingActive: snap.tradingActive,
          mode: snap.mode,
          strategies: [...(snap.strategies ?? [])],
          market: snap.market,
          orderbook: snap.orderbook ?? { ...emptyOrderBook },
          prices: snap.prices ?? {},
          oracleEstimate: snap.oracleEstimate ?? 0,
          feedHealth: snap.feedHealth ? { ...emptyFeedHealth, ...snap.feedHealth } : { ...emptyFeedHealth },
          pnl: normalizePnlSummary(snap.pnl),
          shadowPnl: normalizePnlSummary(snap.shadowPnl),
          trades: [...(snap.trades ?? [])],
          regime: { ...defaultRegime, ...snap.regime },
          killSwitches: [...(snap.killSwitches ?? [])],
          risk: { ...emptyRisk, ...snap.risk },
          metrics: { ...emptyMetrics, ...snap.metrics },
        };
      }
      registry.set(perMarketStateRx, perMarket);

      // Apply active market's snapshot to display atoms
      const activeId = registry.get(activeMarketIdRx);
      const activeSnap = perMarket[activeId] ?? perMarket["btc"];
      if (activeSnap) {
        applyPerMarketSnapshot(registry as RxRegistry, activeSnap);
        registry.update(tradesRx, (prev) => mergeTrades(prev, activeSnap.trades));
      }

      // Set enabled markets list and pre-seed per-market state for every market
      if (data.enabledMarkets && data.enabledMarkets.length > 0) {
        registry.set(enabledMarketsRx, [...data.enabledMarkets]);
        // Ensure all enabled markets have an entry in perMarketStateRx so events
        // and tab switches work even if buildMarketSnapshot failed for a market
        registry.update(perMarketStateRx, (prev) => {
          const next = { ...prev };
          for (const { id } of data.enabledMarkets!) {
            if (!next[id]) next[id] = defaultPerMarketSnapshot();
          }
          return next;
        });
        // If activeMarketId is not in the enabled list, reset to first
        const activeId = registry.get(activeMarketIdRx);
        if (!data.enabledMarkets.find((m) => m.id === activeId)) {
          registry.set(activeMarketIdRx, data.enabledMarkets[0]!.id);
        }
      }

      backfillTrades();
      fetchIncidents();
    }

    function connect() {
      if (destroyed) return;
      if (
        activeSocket &&
        (activeSocket.readyState === WebSocket.OPEN ||
          activeSocket.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }

      clearReconnectTimer();

      const ws = new WebSocket(url);
      activeSocket = ws;

      ws.onopen = () => {
        if (destroyed || activeSocket !== ws) return;
        registry.set(connectedRx, true);
        registry.set(wsLastMessageTsRx, Date.now());
        fetchIncidents();
        refreshStorageHealth();
      };

      ws.onmessage = (event) => {
        if (destroyed) return;
        try {
          const msg = JSON.parse(event.data) as WSMessage;
          registry.set(wsLastMessageTsRx, Date.now());
          Rx.batch(() => {
            const msgMarketId = (msg as any).marketId ?? "btc";
            const activeId = registry.get(activeMarketIdRx);
            const isActive = msgMarketId === activeId;

            switch (msg.type) {
              case "status":
                handleInitialState(msg.data as WSStatusSnapshot);
                break;
              case "prices":
                handlePrices(msg.data, msgMarketId);
                break;
              case "market":
                patchPerMarket(msgMarketId, "market", msg.data as any);
                break;
              case "orderbook":
                patchPerMarket(msgMarketId, "orderbook", msg.data as any);
                if (isActive) registry.set(orderBookRx, msg.data as any);
                break;
              case "strategies":
                patchPerMarket(msgMarketId, "strategies", msg.data as any);
                if (isActive) registry.set(strategiesRx, msg.data as any);
                break;
              case "trade": {
                // Trades are global (all markets shown together in trades tab)
                const trade = { ...(msg.data as TradeRecord), marketId: msgMarketId };
                pendingTrades.set(trade.id, trade);
                scheduleTradeFlush();
                break;
              }
              case "pnl":
                {
                  const next = normalizePnlSummary(msg.data as PnLSummary);
                  patchPerMarket(msgMarketId, "pnl", next);
                  if (isActive) {
                    const prev = registry.get(pnlRx);
                    if (!equalPnlSummary(prev, next)) registry.set(pnlRx, next);
                  }
                }
                break;
              case "shadowPnl":
                {
                  const next = normalizePnlSummary(msg.data as PnLSummary);
                  patchPerMarket(msgMarketId, "shadowPnl", next);
                  if (isActive) {
                    const prev = registry.get(shadowPnlRx);
                    if (!equalPnlSummary(prev, next)) registry.set(shadowPnlRx, next);
                  }
                }
                break;
              case "tradingActive":
                patchPerMarket(msgMarketId, "tradingActive", (msg.data as any).tradingActive);
                if (isActive) registry.set(tradingActiveRx, (msg.data as any).tradingActive);
                break;
              case "mode":
                patchPerMarket(msgMarketId, "mode", (msg.data as any).mode);
                if (isActive) registry.set(modeRx, (msg.data as any).mode);
                break;
              case "regime":
                {
                  const r = { ...defaultRegime, ...(msg.data as any) };
                  patchPerMarket(msgMarketId, "regime", r);
                  if (isActive) registry.set(regimeRx, r);
                }
                break;
              case "killswitch":
                patchPerMarket(msgMarketId, "killSwitches", msg.data as any);
                if (isActive) registry.set(killSwitchesRx, msg.data as any);
                break;
              case "risk":
                {
                  const r = { ...emptyRisk, ...(msg.data as any) };
                  patchPerMarket(msgMarketId, "risk", r);
                  if (isActive) registry.set(riskRx, r);
                }
                break;
              case "metrics":
                {
                  const m = { ...emptyMetrics, ...(msg.data as any) };
                  patchPerMarket(msgMarketId, "metrics", m);
                  if (isActive) registry.set(metricsRx, m);
                }
                break;
              case "criticalIncident":
                registry.update(incidentsRx, (prev) => mergeIncidents(prev, [msg.data as CriticalIncident]));
                break;
              case "observabilityEvent":
                registry.update(
                  observabilityEventsRx,
                  (prev) => mergeObservability(prev, [msg.data as ObservabilityEvent]),
                );
                break;
              case "feedHealth":
                patchPerMarket(msgMarketId, "feedHealth", { ...emptyFeedHealth, ...(msg.data as any) });
                if (isActive) registry.set(feedHealthRx, { ...emptyFeedHealth, ...(msg.data as any) });
                break;
              case "exchangeStatus":
                registry.set(exchangeConnectedRx, (msg.data as any).exchangeConnected);
                if ((msg.data as any).walletAddress)
                  registry.set(walletAddressRx, (msg.data as any).walletAddress);
                break;
            }
          });
        } catch {
          /* ignore parse errors */
        }
      };

      ws.onclose = () => {
        if (destroyed) return;
        if (activeSocket === ws) activeSocket = null;
        flushTrades();
        registry.set(connectedRx, false);
        registry.set(exchangeConnectedRx, false);
        if (forceReconnectPending) {
          forceReconnectPending = false;
          connect();
          return;
        }
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = undefined;
            connect();
          }, 3000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    const forceReconnect = () => {
      if (destroyed) return;
      const ws = activeSocket;
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        clearReconnectTimer();
        forceReconnectPending = true;
        ws.close();
        return;
      }
      clearReconnectTimer();
      connect();
    };

    const onResume = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      const wsAgeMs = now - registry.get(wsLastMessageTsRx);
      const connected = registry.get(connectedRx);
      const wsStale = !connected || wsAgeMs > STALE_WS_MS;
      // Don't use currentMarket as a staleness signal — XRP legitimately has null market.
      if (!wsStale) return;
      if (now - lastResumeReconnectAt < RESUME_RECONNECT_COOLDOWN_MS) return;
      lastResumeReconnectAt = now;
      forceReconnect();
      rehydrateFromHttpStatus();
      backfillTrades();
    };

    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("focus", onResume);
    const statusRehydrateTimer = setInterval(() => {
      // Only rehydrate if WS appears dead — don't use currentMarket as signal
      // because XRP legitimately has a null market window between event windows.
      const wsAge = Date.now() - registry.get(wsLastMessageTsRx);
      const connected = registry.get(connectedRx);
      if (!connected || wsAge > STALE_WS_MS) {
        rehydrateFromHttpStatus();
      }
    }, STATUS_REHYDRATE_COOLDOWN_MS);
    const storageHealthTimer = setInterval(refreshStorageHealth, 10000);

    connect();

    return () => {
      destroyed = true;
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("focus", onResume);
      if (tradeFlushTimer) clearTimeout(tradeFlushTimer);
      clearInterval(statusRehydrateTimer);
      clearInterval(storageHealthTimer);
      clearReconnectTimer();
      if (activeSocket && activeSocket.readyState !== WebSocket.CLOSED) {
        activeSocket.close();
      }
      // Clear pending trades to prevent memory retention
      clearPendingTrades();
    };
  }, [registry]);
}

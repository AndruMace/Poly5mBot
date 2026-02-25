import { useEffect, useContext } from "react";
import { Rx } from "@effect-rx/rx";
import { RegistryContext } from "@effect-rx/rx-react";
import {
  connectedRx,
  exchangeConnectedRx,
  walletAddressRx,
  tradingActiveRx,
  modeRx,
  pricesRx,
  oracleEstimateRx,
  priceHistoryRx,
  currentMarketRx,
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
  wsLastMessageTsRx,
  MAX_PRICE_HISTORY,
  emptyOrderBook,
  emptyPnl,
  defaultRegime,
  emptyRisk,
  emptyMetrics,
  emptyFeedHealth,
} from "../store/index.js";
import type { PriceHistory } from "../store/index.js";
import type {
  WSMessage,
  PricePoint,
  TradeRecord,
  WSStatusSnapshot,
  TradesPageResponse,
} from "../types/index.js";

const PRICE_HISTORY_FLUSH_MS = 1000;
const TRADE_FLUSH_MS = 120;
const STALE_WS_MS = 8000;
const RESUME_RECONNECT_COOLDOWN_MS = 2000;
const STATUS_REHYDRATE_COOLDOWN_MS = 5000;
const TRADE_BACKFILL_COOLDOWN_MS = 5000;
const TRADE_BACKFILL_MAX_PAGES = 6;
const TRADE_BUFFER_LIMIT = 2000;

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

export function useWebSocket() {
  const registry = useContext(RegistryContext);

  useEffect(() => {
    let destroyed = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let priceHistoryBuffer: PriceHistory[] = [];
    let lastPriceHistoryFlush = 0;
    let pendingPriceHistoryFlush: ReturnType<typeof setTimeout> | undefined;
    let tradeFlushTimer: ReturnType<typeof setTimeout> | undefined;
    let statusRehydrateTimer: ReturnType<typeof setInterval> | undefined;
    let activeSocket: WebSocket | null = null;
    let forceReconnectPending = false;
    let lastResumeReconnectAt = 0;
    let rehydrateInFlight = false;
    let lastStatusRehydrateAt = 0;
    let tradeBackfillInFlight = false;
    let lastTradeBackfillAt = 0;
    const pendingTrades = new Map<string, TradeRecord>();

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

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws`;

    const flushPriceHistory = () => {
      pendingPriceHistoryFlush = undefined;
      lastPriceHistoryFlush = Date.now();
      if (priceHistoryBuffer.length === 0) return;
      const batch = priceHistoryBuffer;
      priceHistoryBuffer = [];
      registry.update(priceHistoryRx, (prev) =>
        [...prev, ...batch].slice(-MAX_PRICE_HISTORY),
      );
    };

    const schedulePriceHistoryFlush = () => {
      const now = Date.now();
      const dueIn = PRICE_HISTORY_FLUSH_MS - (now - lastPriceHistoryFlush);
      if (dueIn <= 0) {
        flushPriceHistory();
        return;
      }
      if (pendingPriceHistoryFlush) return;
      pendingPriceHistoryFlush = setTimeout(flushPriceHistory, dueIn);
    };

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
          return (await res.json()) as { currentWindow?: any; tradingActive?: boolean; mode?: "live" | "shadow" };
        })
        .then((data) => {
          if (!data || destroyed) return;
          if (data.currentWindow) {
            registry.set(currentMarketRx, data.currentWindow);
          }
          if (typeof data.tradingActive === "boolean") {
            registry.set(tradingActiveRx, data.tradingActive);
          }
          if (data.mode === "live" || data.mode === "shadow") {
            registry.set(modeRx, data.mode);
          }
        })
        .catch(() => {
          /* best effort */
        })
        .finally(() => {
          rehydrateInFlight = false;
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

    function handlePrices(data: any) {
      const prices = data.prices as Record<string, PricePoint>;
      const oracleEstimate = data.oracleEstimate as number;
      const prevPrices = registry.get(pricesRx);
      if (!shallowEqualPrices(prevPrices, prices)) {
        registry.set(pricesRx, prices);
      }
      const validEst =
        oracleEstimate > 0
          ? oracleEstimate
          : registry.get(oracleEstimateRx);
      if (oracleEstimate > 0 && oracleEstimate !== registry.get(oracleEstimateRx)) {
        registry.set(oracleEstimateRx, oracleEstimate);
      }

      const now = Date.now();
      const newEntries: PriceHistory[] = [];
      for (const [exchange, p] of Object.entries(prices)) {
        if ((p as PricePoint).price > 0) {
          newEntries.push({
            exchange,
            price: (p as PricePoint).price,
            time: now,
          });
        }
      }
      if (validEst > 0) {
        newEntries.push({ exchange: "oracle", price: validEst, time: now });
      }
      if (newEntries.length > 0) {
        priceHistoryBuffer.push(...newEntries);
        schedulePriceHistoryFlush();
      }
    }

    function handleInitialState(data: WSStatusSnapshot) {
      registry.set(tradingActiveRx, data.tradingActive ?? false);
      registry.set(modeRx, data.mode ?? "shadow");
      registry.set(exchangeConnectedRx, data.exchangeConnected ?? false);
      if (data.walletAddress)
        registry.set(walletAddressRx, data.walletAddress);
      registry.set(strategiesRx, [...(data.strategies ?? [])]);
      if (data.market) {
        registry.set(currentMarketRx, data.market);
      } else if (registry.get(currentMarketRx) === null) {
        registry.set(currentMarketRx, null);
        rehydrateFromHttpStatus();
      }
      registry.set(
        orderBookRx,
        data.orderbook ?? { ...emptyOrderBook },
      );
      registry.set(pnlRx, data.pnl ?? { ...emptyPnl });
      registry.set(shadowPnlRx, data.shadowPnl ?? { ...emptyPnl });
      registry.update(tradesRx, (prev) => mergeTrades(prev, [...(data.trades ?? [])]));
      backfillTrades();
      if (data.prices) registry.set(pricesRx, data.prices);
      if (data.oracleEstimate > 0)
        registry.set(oracleEstimateRx, data.oracleEstimate);
      registry.set(
        regimeRx,
        data.regime
          ? { ...defaultRegime, ...data.regime }
          : { ...defaultRegime },
      );
      registry.set(killSwitchesRx, [...(data.killSwitches ?? [])]);
      registry.set(
        riskRx,
        data.risk ? { ...emptyRisk, ...data.risk } : { ...emptyRisk },
      );
      registry.set(
        metricsRx,
        data.metrics
          ? { ...emptyMetrics, ...data.metrics }
          : { ...emptyMetrics },
      );
      registry.set(
        feedHealthRx,
        data.feedHealth
          ? { ...emptyFeedHealth, ...data.feedHealth }
          : { ...emptyFeedHealth },
      );
    }

    function connect() {
      if (destroyed) return;

      const ws = new WebSocket(url);
      activeSocket = ws;

      ws.onopen = () => {
        if (destroyed || activeSocket !== ws) return;
        registry.set(connectedRx, true);
        registry.set(wsLastMessageTsRx, Date.now());
      };

      ws.onmessage = (event) => {
        if (destroyed) return;
        try {
          const msg = JSON.parse(event.data) as WSMessage;
          registry.set(wsLastMessageTsRx, Date.now());
          Rx.batch(() => {
            switch (msg.type) {
              case "status":
                handleInitialState(msg.data as WSStatusSnapshot);
                break;
              case "prices":
                handlePrices(msg.data);
                break;
              case "market":
                registry.set(currentMarketRx, msg.data as any);
                break;
              case "orderbook":
                registry.set(orderBookRx, msg.data as any);
                break;
              case "strategies":
                registry.set(strategiesRx, msg.data as any);
                break;
              case "trade":
                pendingTrades.set((msg.data as TradeRecord).id, msg.data as TradeRecord);
                scheduleTradeFlush();
                break;
              case "pnl":
                registry.set(pnlRx, msg.data as any);
                break;
              case "shadowPnl":
                registry.set(shadowPnlRx, msg.data as any);
                break;
              case "tradingActive":
                registry.set(
                  tradingActiveRx,
                  (msg.data as any).tradingActive,
                );
                break;
              case "mode":
                registry.set(modeRx, (msg.data as any).mode);
                break;
              case "regime":
                registry.set(regimeRx, {
                  ...defaultRegime,
                  ...(msg.data as any),
                });
                break;
              case "killswitch":
                registry.set(killSwitchesRx, msg.data as any);
                break;
              case "risk":
                registry.set(riskRx, {
                  ...emptyRisk,
                  ...(msg.data as any),
                });
                break;
              case "metrics":
                registry.set(metricsRx, {
                  ...emptyMetrics,
                  ...(msg.data as any),
                });
                break;
              case "feedHealth":
                registry.set(feedHealthRx, {
                  ...emptyFeedHealth,
                  ...(msg.data as any),
                });
                break;
              case "exchangeStatus":
                registry.set(
                  exchangeConnectedRx,
                  (msg.data as any).exchangeConnected,
                );
                if ((msg.data as any).walletAddress)
                  registry.set(
                    walletAddressRx,
                    (msg.data as any).walletAddress,
                  );
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
        flushPriceHistory();
        registry.set(connectedRx, false);
        registry.set(exchangeConnectedRx, false);
        if (forceReconnectPending) {
          forceReconnectPending = false;
          connect();
          return;
        }
        reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    const forceReconnect = () => {
      if (destroyed) return;
      const ws = activeSocket;
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        forceReconnectPending = true;
        ws.close();
        return;
      }
      connect();
    };

    const onResume = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      const wsAgeMs = now - registry.get(wsLastMessageTsRx);
      const connected = registry.get(connectedRx);
      const hasMarket = registry.get(currentMarketRx) !== null;
      const wsStale = !connected || wsAgeMs > STALE_WS_MS;
      if (!wsStale && hasMarket) return;
      if (now - lastResumeReconnectAt < RESUME_RECONNECT_COOLDOWN_MS) return;
      lastResumeReconnectAt = now;
      forceReconnect();
      rehydrateFromHttpStatus();
      backfillTrades();
    };

    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("focus", onResume);
    statusRehydrateTimer = setInterval(() => {
      if (registry.get(currentMarketRx) === null) {
        rehydrateFromHttpStatus();
      }
    }, STATUS_REHYDRATE_COOLDOWN_MS);
    connect();

    return () => {
      destroyed = true;
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("focus", onResume);
      if (pendingPriceHistoryFlush) clearTimeout(pendingPriceHistoryFlush);
      if (tradeFlushTimer) clearTimeout(tradeFlushTimer);
      if (statusRehydrateTimer) clearInterval(statusRehydrateTimer);
      clearTimeout(reconnectTimer);
      if (activeSocket && activeSocket.readyState !== WebSocket.CLOSED) {
        activeSocket.close();
      }
    };
  }, [registry]);
}

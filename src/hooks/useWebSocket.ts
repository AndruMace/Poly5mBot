import { useEffect, useRef } from "react";
import { useStore } from "../store/index.js";
import type { WSMessage } from "../types/index.js";

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const {
      setPrices,
      setMarket,
      setOrderBook,
      setStrategies,
      addTrade,
      setPnl,
      setShadowPnl,
      setInitialState,
      setConnected,
      setTradingActive,
      setMode,
      setRegime,
      setKillSwitches,
      setMetrics,
      setFeedHealth,
    } = useStore.getState();

    let reconnectTimer: ReturnType<typeof setTimeout>;
    let destroyed = false;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws`;

    function connect() {
      if (destroyed) return;

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("[WS] Connected");
        setConnected(true);
      };

      ws.onmessage = (event) => {
        if (destroyed) return;
        try {
          const msg: WSMessage = JSON.parse(event.data);
          switch (msg.type) {
            case "status":
              setInitialState(msg.data);
              break;
            case "prices":
              setPrices(msg.data.prices, msg.data.oracleEstimate);
              break;
            case "market":
              setMarket(msg.data);
              break;
            case "orderbook":
              setOrderBook(msg.data);
              break;
            case "strategies":
              setStrategies(msg.data);
              break;
            case "trade":
              addTrade(msg.data);
              break;
            case "pnl":
              setPnl(msg.data);
              break;
            case "shadowPnl":
              setShadowPnl(msg.data);
              break;
            case "tradingActive":
              setTradingActive(msg.data.tradingActive);
              break;
            case "mode":
              setMode(msg.data.mode);
              break;
            case "regime":
              setRegime(msg.data);
              break;
            case "killswitch":
              setKillSwitches(msg.data);
              break;
            case "metrics":
              setMetrics(msg.data);
              break;
            case "feedHealth":
              setFeedHealth(msg.data);
              break;
          }
        } catch {
          /* ignore parse errors */
        }
      };

      ws.onclose = () => {
        if (destroyed) return;
        console.log("[WS] Disconnected");
        setConnected(false);
        reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      destroyed = true;
      clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.onmessage = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);
}

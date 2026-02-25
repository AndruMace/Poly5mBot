import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import type { TradingEngine } from "../engine/engine.js";
import type { FeedManager } from "../feeds/manager.js";
import { isConnected, getWalletAddress } from "../polymarket/client.js";
import type { WSMessage } from "../types.js";

export function createWSServer(
  server: Server,
  engine: TradingEngine,
  feedManager: FeedManager,
): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });

  function broadcast(msg: WSMessage): void {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  let priceThrottle: ReturnType<typeof setInterval> | null = null;

  let lastExchangeConnected = isConnected();

  priceThrottle = setInterval(() => {
    broadcast({
      type: "prices",
      data: {
        prices: feedManager.getLatestPrices(),
        oracleEstimate: feedManager.getOracleEstimate(),
      },
      timestamp: Date.now(),
    });
    broadcast({
      type: "feedHealth",
      data: feedManager.getFeedHealth(),
      timestamp: Date.now(),
    });
    const nowConnected = isConnected();
    if (nowConnected !== lastExchangeConnected) {
      lastExchangeConnected = nowConnected;
      broadcast({
        type: "exchangeStatus",
        data: {
          exchangeConnected: nowConnected,
          walletAddress: getWalletAddress(),
        },
        timestamp: Date.now(),
      });
    }
  }, 500);

  engine.on("market", (market) => {
    broadcast({ type: "market", data: market, timestamp: Date.now() });
  });

  engine.on("orderbook", (orderbook) => {
    broadcast({ type: "orderbook", data: orderbook, timestamp: Date.now() });
  });

  engine.on("strategies", (strategies) => {
    broadcast({ type: "strategies", data: strategies, timestamp: Date.now() });
  });

  engine.on("trade", (trade) => {
    broadcast({ type: "trade", data: trade, timestamp: Date.now() });
  });

  engine.on("pnl", (pnl) => {
    broadcast({ type: "pnl", data: pnl, timestamp: Date.now() });
  });

  engine.on("shadowPnl", (pnl) => {
    broadcast({ type: "shadowPnl", data: pnl, timestamp: Date.now() });
  });

  engine.on("killswitch", (status) => {
    broadcast({ type: "killswitch", data: status, timestamp: Date.now() });
  });

  engine.on("tradingActive", (active: boolean) => {
    broadcast({
      type: "tradingActive",
      data: { tradingActive: active },
      timestamp: Date.now(),
    });
  });

  engine.on("mode", (mode: string) => {
    broadcast({
      type: "mode",
      data: { mode },
      timestamp: Date.now(),
    });
  });

  engine.on("regime", (regime) => {
    broadcast({ type: "regime", data: regime, timestamp: Date.now() });
  });

  engine.on("metrics", (metrics) => {
    broadcast({ type: "metrics", data: metrics, timestamp: Date.now() });
  });

  wss.on("connection", (ws) => {
    console.log("[WS] Client connected");

    const initial: WSMessage = {
      type: "status",
      data: {
        tradingActive: engine.tradingActive,
        mode: engine.mode,
        exchangeConnected: isConnected(),
        walletAddress: getWalletAddress(),
        strategies: engine.getStrategyStates(),
        market: engine.getCurrentWindow(),
        orderbook: engine.getOrderBookState(),
        prices: feedManager.getLatestPrices(),
        oracleEstimate: feedManager.getOracleEstimate(),
        feedHealth: feedManager.getFeedHealth(),
        pnl: engine.tracker.getSummary(),
        shadowPnl: engine.tracker.getSummary(true),
        trades: engine.tracker.getTrades(50),
        regime: engine.getRegime(),
        killSwitches: engine.getKillSwitchStatus(),
        metrics: engine.getMetrics(),
      },
      timestamp: Date.now(),
    };
    ws.send(JSON.stringify(initial));

    ws.on("close", () => {
      console.log("[WS] Client disconnected");
    });
  });

  wss.on("close", () => {
    if (priceThrottle) clearInterval(priceThrottle);
  });

  console.log("[WS] Server ready on /ws");
  return wss;
}

import type { Express } from "express";
import type { TradingEngine } from "./engine/engine.js";
import type { FeedManager } from "./feeds/manager.js";
import { isConnected, getWalletAddress, getPolymarketClient } from "./polymarket/client.js";

export function createRestApi(
  app: Express,
  engine: TradingEngine,
  feedManager: FeedManager,
): void {
  app.get("/api/status", (_req, res) => {
    res.json({
      connected: isConnected(),
      walletAddress: getWalletAddress(),
      tradingActive: engine.tradingActive,
      mode: engine.mode,
      feedsActive: {
        binance: feedManager.binance.getLatest() !== null,
        bybit: feedManager.bybit.getLatest() !== null,
        coinbase: feedManager.coinbase.getLatest() !== null,
      },
      currentWindow: engine.getCurrentWindow(),
      windowTitle: engine.getWindowTitle(),
      oracleEstimate: feedManager.getOracleEstimate(),
      btcPrice: feedManager.getCurrentBtcPrice(),
      feedHealth: feedManager.getFeedHealth(),
      regime: engine.getRegime(),
      killSwitches: engine.getKillSwitchStatus(),
      metrics: engine.getMetrics(),
    });
  });

  app.post("/api/trading/toggle", (_req, res) => {
    engine.setTradingActive(!engine.tradingActive);
    res.json({ tradingActive: engine.tradingActive });
  });

  app.post("/api/mode", (req, res) => {
    const mode = req.body?.mode;
    if (mode !== "live" && mode !== "shadow") {
      res.status(400).json({ error: 'mode must be "live" or "shadow"' });
      return;
    }
    engine.setMode(mode);
    res.json({ mode: engine.mode });
  });

  app.get("/api/strategies", (_req, res) => {
    res.json(engine.getStrategyStates());
  });

  app.post("/api/strategies/:name/toggle", (req, res) => {
    const enabled = engine.toggleStrategy(req.params.name);
    res.json({ name: req.params.name, enabled });
  });

  app.post("/api/strategies/:name/config", (req, res) => {
    const result = engine.updateStrategyConfig(req.params.name, req.body);
    if (result === "not_found") {
      res.status(404).json({ error: "Strategy not found" });
    } else if (result === "invalid") {
      res.status(400).json({ error: "Invalid config values (must be finite numbers >= 0)" });
    } else {
      res.json({ ok: true });
    }
  });

  app.post("/api/strategies/:name/regime-filter", (req, res) => {
    const result = engine.updateStrategyRegimeFilter(req.params.name, req.body);
    if (result === "not_found") {
      res.status(404).json({ error: "Strategy not found" });
    } else {
      res.json({ ok: true });
    }
  });

  app.get("/api/trades", (req, res) => {
    const limit = parseInt((req.query.limit as string) ?? "100", 10);
    res.json(engine.tracker.getTrades(limit));
  });

  app.get("/api/pnl", (_req, res) => {
    res.json(engine.tracker.getSummary());
  });

  app.get("/api/shadow/summary", (_req, res) => {
    res.json(engine.tracker.getSummary(true));
  });

  app.get("/api/regime", (_req, res) => {
    res.json(engine.getRegime());
  });

  app.get("/api/killswitches", (_req, res) => {
    res.json(engine.getKillSwitchStatus());
  });

  app.post("/api/killswitches/reset", (_req, res) => {
    engine.resetKillSwitchPause();
    res.json({ ok: true, killSwitches: engine.getKillSwitchStatus() });
  });

  app.get("/api/orderbook", (_req, res) => {
    res.json(engine.getOrderBookState());
  });

  app.get("/api/prices", (_req, res) => {
    res.json({
      prices: feedManager.getLatestPrices(),
      oracleEstimate: feedManager.getOracleEstimate(),
    });
  });

  app.post("/api/connect", async (_req, res) => {
    try {
      await getPolymarketClient();
      res.json({
        connected: true,
        walletAddress: getWalletAddress(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log("[API] REST endpoints registered");
}

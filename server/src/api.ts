import type { Express, Request, Response, NextFunction } from "express";
import type { TradingEngine } from "./engine/engine.js";
import type { FeedManager } from "./feeds/manager.js";
import { isConnected, getWalletAddress, getPolymarketClient } from "./polymarket/client.js";
import { config } from "./config.js";
import { loadNotes, saveNotes } from "./notes-store.js";

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = config.server.operatorToken;
  if (!token) {
    next();
    return;
  }
  const header = req.headers.authorization;
  if (header === `Bearer ${token}`) {
    next();
    return;
  }
  console.warn(
    `[API] Unauthorized ${req.method} ${req.path} from ${req.ip}`,
  );
  res.status(401).json({ error: "Unauthorized" });
}

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
      redeemer: engine.redeemer.getStatus(),
    });
  });

  app.post("/api/trading/toggle", requireAuth, (_req, res) => {
    engine.setTradingActive(!engine.tradingActive);
    res.json({ tradingActive: engine.tradingActive });
  });

  app.post("/api/mode", requireAuth, (req, res) => {
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

  app.post("/api/strategies/:name/toggle", requireAuth, (req, res) => {
    const name = req.params.name as string;
    const enabled = engine.toggleStrategy(name);
    res.json({ name, enabled });
  });

  app.post("/api/strategies/:name/config", requireAuth, (req, res) => {
    const name = req.params.name as string;
    const result = engine.updateStrategyConfig(name, req.body);
    if (result === "not_found") {
      res.status(404).json({ error: "Strategy not found" });
    } else if (result === "invalid") {
      res.status(400).json({ error: "Invalid config values (must be finite numbers >= 0)" });
    } else {
      res.json({ ok: true });
    }
  });

  app.post("/api/strategies/:name/regime-filter", requireAuth, (req, res) => {
    const name = req.params.name as string;
    const result = engine.updateStrategyRegimeFilter(name, req.body);
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

  app.post("/api/killswitches/reset", requireAuth, (_req, res) => {
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

  app.get("/api/notes", (_req, res) => {
    res.json(loadNotes());
  });

  app.put("/api/notes", requireAuth, (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const saved = saveNotes(text);
    res.json(saved);
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

  app.get("/api/redeemer", async (_req, res) => {
    const status = engine.redeemer.getStatus();
    const [usdc, matic] = await Promise.all([
      engine.redeemer.getUsdcBalance(),
      engine.redeemer.getMaticBalance(),
    ]);
    res.json({ ...status, usdcBalance: usdc, maticBalance: matic });
  });

  app.post("/api/redeemer/redeem-now", requireAuth, async (_req, res) => {
    try {
      await (engine.redeemer as any).checkAndRedeem();
      res.json({ ok: true, status: engine.redeemer.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/redeemer/toggle", requireAuth, (_req, res) => {
    engine.redeemer.enabled = !engine.redeemer.enabled;
    if (engine.redeemer.enabled && !engine.redeemer.getStatus().running) {
      engine.redeemer.start().catch(console.error);
    }
    res.json({ enabled: engine.redeemer.enabled });
  });

  console.log("[API] REST endpoints registered");
}

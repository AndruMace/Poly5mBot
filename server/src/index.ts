import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { FeedManager } from "./feeds/manager.js";
import { TradingEngine } from "./engine/engine.js";
import { createWSServer } from "./ws/server.js";
import { createRestApi } from "./api.js";
import { getPolymarketClient, getWalletAddress } from "./polymarket/client.js";

const app = express();
app.use(
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
  }),
);
app.use(express.json());

const feedManager = new FeedManager();
const engine = new TradingEngine(feedManager);

const server = app.listen(config.server.port, "127.0.0.1", () => {
  console.log(`Server running on http://127.0.0.1:${config.server.port}`);
});

const wss = createWSServer(server, engine, feedManager);
createRestApi(app, engine, feedManager);

feedManager.start();
engine.start();

if (config.poly.privateKey) {
  getPolymarketClient()
    .then(() => {
      console.log(`[Startup] Polymarket auto-connected: ${getWalletAddress()}`);
    })
    .catch((err) => {
      console.error("[Startup] Polymarket auto-connect failed:", err.message);
    });
}

process.on("SIGINT", () => {
  console.log("Shutting down...");
  feedManager.stop();
  engine.stop();
  wss.close();
  server.close();
  process.exit(0);
});

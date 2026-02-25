import { WebSocketServer, WebSocket } from "ws";
import type http from "http";
import { Effect, Queue, Chunk, Schedule, PubSub } from "effect";
import { TradingEngine } from "../engine/engine.js";
import { FeedService } from "../feeds/manager.js";
import { PolymarketClient } from "../polymarket/client.js";
import { EventBus } from "../engine/event-bus.js";
import type { WSMessage, EngineEvent, WSStatusSnapshot } from "../types.js";

function broadcast(wss: WebSocketServer, msg: WSMessage): void {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

export class WebSocketService extends Effect.Service<WebSocketService>()("WebSocketService", {
  scoped: Effect.gen(function* () {
    const engine = yield* TradingEngine;
    const feedService = yield* FeedService;
    const polyClient = yield* PolymarketClient;
    const eventBus = yield* EventBus;

    let wss: WebSocketServer | null = null;
    let lastExchangeConnected: boolean | null = null;
    let lastWalletAddress: string | null = null;

    const attach = (server: http.Server) =>
      Effect.gen(function* () {
        wss = new WebSocketServer({ server, path: "/ws" });

        wss.on("connection", (ws) => {
          Effect.gen(function* () {
            yield* Effect.log("[WS] Client connected");

            const [tradingActive, mode, strategies, market, orderbook, prices, oracleEst, feedHealth, pnl, shadowPnl, trades, regime, killSwitches, risk, metrics, connected, walletAddr] = yield* Effect.all([
              engine.isTradingActive,
              engine.getMode,
              engine.getStrategyStates,
              engine.getCurrentWindow,
              engine.getOrderBookState,
              feedService.getLatestPrices,
              feedService.getOracleEstimate,
              feedService.getFeedHealth,
              engine.tracker.getSummary(false),
              engine.tracker.getSummary(true),
              engine.tracker.getTrades(50),
              engine.getRegime,
              engine.getKillSwitchStatus,
              engine.getRiskSnapshot,
              engine.getMetrics,
              polyClient.isConnected,
              polyClient.getWalletAddress,
            ]);

            const snapshot: WSStatusSnapshot = {
              tradingActive,
              mode,
              exchangeConnected: connected,
              walletAddress: walletAddr,
              strategies,
              market,
              orderbook,
              prices,
              oracleEstimate: oracleEst,
              feedHealth,
              pnl,
              shadowPnl,
              trades,
              regime,
              killSwitches,
              risk,
              metrics,
            };

            const initial: WSMessage = {
              type: "status",
              data: snapshot,
              timestamp: Date.now(),
            };
            ws.send(JSON.stringify(initial));
          }).pipe(Effect.runSync);

          ws.on("close", () => {
            Effect.runSync(Effect.log("[WS] Client disconnected"));
          });
        });

        // Subscribe to engine events and broadcast
        const eventQueue = yield* eventBus.subscribe;

        yield* Effect.gen(function* () {
          const items = yield* Queue.takeAll(eventQueue);
          const events = Chunk.toReadonlyArray(items);
          for (const event of events) {
            if (!wss) continue;
            const type = eventTagToWSType(event._tag);
            if (type) {
              broadcast(wss, { type, data: event.data, timestamp: Date.now() });
            }
          }
        }).pipe(
          Effect.repeat(Schedule.fixed("50 millis")),
          Effect.catchAll(() => Effect.void),
          Effect.forkScoped,
        );

        // Throttled price + feed health broadcasts
        yield* Effect.gen(function* () {
          if (!wss) return;
          const [prices, oracleEst, feedHealth, connected, walletAddr] = yield* Effect.all([
            feedService.getLatestPrices,
            feedService.getOracleEstimate,
            feedService.getFeedHealth,
            polyClient.isConnected,
            polyClient.getWalletAddress,
          ]);
          broadcast(wss, {
            type: "prices",
            data: { prices, oracleEstimate: oracleEst },
            timestamp: Date.now(),
          });
          broadcast(wss, {
            type: "feedHealth",
            data: feedHealth,
            timestamp: Date.now(),
          });
          if (connected !== lastExchangeConnected || walletAddr !== lastWalletAddress) {
            lastExchangeConnected = connected;
            lastWalletAddress = walletAddr;
            broadcast(wss, {
              type: "exchangeStatus",
              data: { exchangeConnected: connected, walletAddress: walletAddr },
              timestamp: Date.now(),
            });
          }
        }).pipe(
          Effect.repeat(Schedule.fixed("500 millis")),
          Effect.catchAll(() => Effect.void),
          Effect.forkScoped,
        );

        yield* Effect.log("[WS] Server ready on /ws");
      });

    return { attach } as const;
  }),
}) {}

function eventTagToWSType(tag: EngineEvent["_tag"]): WSMessage["type"] | null {
  const map: Record<string, string> = {
    Market: "market",
    OrderBook: "orderbook",
    Strategies: "strategies",
    Trade: "trade",
    Pnl: "pnl",
    ShadowPnl: "shadowPnl",
    KillSwitch: "killswitch",
    Risk: "risk",
    TradingActive: "tradingActive",
    Mode: "mode",
    Regime: "regime",
    Metrics: "metrics",
  };
  return (map[tag] as WSMessage["type"]) ?? null;
}

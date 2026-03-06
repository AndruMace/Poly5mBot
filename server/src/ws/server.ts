import { WebSocketServer, WebSocket } from "ws";
import type http from "http";
import { Effect, Queue, Chunk, Schedule, Runtime } from "effect";
import { TradingEngine } from "../engine/engine.js";
import { PolymarketClient } from "../polymarket/client.js";
import { EventBus } from "../engine/event-bus.js";
import { ObservabilityStore } from "../observability/store.js";
import { PostgresStorage } from "../storage/postgres.js";
import { AppConfig } from "../config.js";
import { MarketOrchestrator } from "../markets/orchestrator.js";
import type { WSMessage, EngineEvent, WSStatusSnapshot, WSMarketSnapshot } from "../types.js";
import type { PnLSummary } from "../types.js";
import type { MarketEngineInstance } from "../markets/market-engine.js";

const WS_BOOTSTRAP_TRADES = 200;

function pnlSignature(summary: PnLSummary): string {
  const last = summary.history[summary.history.length - 1];
  return [
    summary.totalPnl,
    summary.todayPnl,
    summary.totalTrades,
    summary.winRate,
    last?.timestamp ?? 0,
    last?.cumulativePnl ?? 0,
  ].join("|");
}

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
    const polyClient = yield* PolymarketClient;
    const eventBus = yield* EventBus;
    const observability = yield* ObservabilityStore;
    const postgres = yield* PostgresStorage;
    const config = yield* AppConfig;
    const orchestrator = yield* MarketOrchestrator;

    let wss: WebSocketServer | null = null;
    let lastExchangeConnected: boolean | null = null;
    let lastWalletAddress: string | null = null;
    let lastLivePnlSig: string | null = null;
    let lastShadowPnlSig: string | null = null;

    /** Build a per-market snapshot from a MarketEngineInstance. */
    const buildMarketSnapshot = (mkt: MarketEngineInstance): Effect.Effect<WSMarketSnapshot, unknown> =>
      Effect.gen(function* () {
        const [tradingActive, mode, strategies, market, orderbook, prices, oracleEst, feedHealth, pnl, shadowPnl, trades, regime, killSwitches, risk, metrics] = yield* Effect.all([
          mkt.isTradingActive,
          mkt.getMode,
          mkt.getStrategyStates,
          mkt.getCurrentWindow,
          mkt.getOrderBookState,
          mkt.feedManager.getLatestPrices,
          mkt.feedManager.getOracleEstimate,
          mkt.getFeedHealth,
          mkt.getPnLSummary,
          mkt.getShadowPnLSummary,
          mkt.getTradeRecords(WS_BOOTSTRAP_TRADES),
          mkt.getRegime,
          mkt.getKillSwitchStatus,
          mkt.getRiskSnapshot,
          mkt.getMetrics,
        ]);
        return {
          marketId: mkt.marketId,
          displayName: mkt.displayName,
          tradingActive,
          mode,
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
        } satisfies WSMarketSnapshot;
      });

    const attach = (server: http.Server) =>
      Effect.gen(function* () {
        wss = new WebSocketServer({ server, path: "/ws" });
        // Capture the current Effect runtime so we can run effects inside
        // plain Node.js callbacks (e.g. the WS "connection" event handler).
        const runtime = yield* Effect.runtime();

        wss.on("connection", (ws) => {
          Runtime.runPromise(runtime)(
            Effect.gen(function* () {
              yield* Effect.log("[WS] Client connected");

              // Build per-market snapshots for all enabled markets
              const allEngines = orchestrator.getAllEngines();
              const marketSnapshots: Record<string, WSMarketSnapshot> = {};
              for (const mkt of allEngines) {
                const snap = yield* buildMarketSnapshot(mkt).pipe(
                  Effect.catchAll(() => Effect.succeed(null)),
                );
                if (snap) marketSnapshots[mkt.marketId] = snap;
              }

              // Use first market as the "primary" for backward-compat top-level fields
              const primaryId = orchestrator.getEnabledMarketIds()[0] ?? "btc";
              const primary = marketSnapshots[primaryId];

              const [connected, walletAddr, observabilityEvents, storageHealth] = yield* Effect.all([
                polyClient.isConnected,
                polyClient.getWalletAddress,
                observability.latest(300),
                postgres.health,
              ]);

              const snapshot: WSStatusSnapshot = {
                tradingActive: primary?.tradingActive ?? false,
                mode: primary?.mode ?? "shadow",
                exchangeConnected: connected,
                walletAddress: walletAddr,
                strategies: primary?.strategies ?? [],
                market: primary?.market ?? null,
                orderbook: primary?.orderbook ?? { bids: [], asks: [], bestBid: null, bestAsk: null, spread: null, midpoint: null, timestamp: 0 },
                prices: primary?.prices ?? {},
                oracleEstimate: primary?.oracleEstimate ?? 0,
                feedHealth: primary?.feedHealth ?? { feeds: [], healthyCount: 0, totalCount: 0, overallStatus: "unhealthy" as any },
                pnl: primary?.pnl ?? { totalPnl: 0, todayPnl: 0, totalTrades: 0, winRate: 0, avgPnl: 0, maxDrawdown: 0, sharpe: 0, history: [] },
                shadowPnl: primary?.shadowPnl ?? { totalPnl: 0, todayPnl: 0, totalTrades: 0, winRate: 0, avgPnl: 0, maxDrawdown: 0, sharpe: 0, history: [] },
                trades: primary?.trades ?? [],
                regime: primary?.regime ?? { current: "unknown", confidence: 0, volatility: 0, trend: 0, timestamp: 0 },
                killSwitches: primary?.killSwitches ?? [],
                risk: primary?.risk ?? { currentExposure: 0, maxExposure: 0, windowLoss: 0, windowSpend: 0, consecutiveLosses: 0, dailyPnl: 0, holdingPeriodMs: 0 },
                metrics: primary?.metrics ?? { totalCycles: 0, signalsGenerated: 0, tradesAttempted: 0, avgCycleMs: 0, uptimeMs: 0 },
                storage: {
                  backend: config.storage.backend,
                  ...storageHealth,
                },
                observabilityEvents,
                markets: marketSnapshots,
                enabledMarkets: orchestrator.getEnabledMarkets(),
              };

              const initial: WSMessage = {
                type: "status",
                data: snapshot,
                timestamp: Date.now(),
              };
              ws.send(JSON.stringify(initial));
            }),
          ).catch((err) => {
            Runtime.runFork(runtime)(Effect.logError(`[WS] Failed to send initial status snapshot: ${err}`));
          });

          ws.on("close", () => {
            Runtime.runFork(runtime)(Effect.log("[WS] Client disconnected"));
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
              if (type === "pnl") {
                const sig = pnlSignature(event.data as PnLSummary);
                if (sig === lastLivePnlSig) continue;
                lastLivePnlSig = sig;
              }
              if (type === "shadowPnl") {
                const sig = pnlSignature(event.data as PnLSummary);
                if (sig === lastShadowPnlSig) continue;
                lastShadowPnlSig = sig;
              }
              broadcast(wss, { type, data: event.data, marketId: event.marketId ?? "btc", timestamp: Date.now() });
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
          // Broadcast prices per-market so the frontend can route to the right market
          for (const mkt of orchestrator.getAllEngines()) {
            const [prices, oracleEst] = yield* Effect.all([
              mkt.feedManager.getLatestPrices,
              mkt.feedManager.getOracleEstimate,
            ]);
            broadcast(wss, {
              type: "prices",
              data: { prices, oracleEstimate: oracleEst },
              marketId: mkt.marketId,
              timestamp: Date.now(),
            });
            const feedHealth = yield* mkt.getFeedHealth;
            broadcast(wss, {
              type: "feedHealth",
              data: feedHealth,
              marketId: mkt.marketId,
              timestamp: Date.now(),
            });
          }
          const [connected, walletAddr] = yield* Effect.all([
            polyClient.isConnected,
            polyClient.getWalletAddress,
          ]);
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
    CriticalIncident: "criticalIncident",
    Observability: "observabilityEvent",
  };
  return (map[tag] as WSMessage["type"]) ?? null;
}

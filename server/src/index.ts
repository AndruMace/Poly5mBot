import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import http from "http";
import { Effect, Layer, Runtime, Scope } from "effect";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { AppConfig } from "./config.js";
import { FeedService } from "./feeds/manager.js";
import { PolymarketClient } from "./polymarket/client.js";
import { OrderService } from "./polymarket/orders.js";
import { MarketService } from "./polymarket/markets.js";
import { AutoRedeemer } from "./polymarket/redeemer.js";
import { TradeStore, ShadowTradeStore } from "./engine/trade-store.js";
import { PnLTracker } from "./engine/tracker.js";
import { RiskManager } from "./engine/risk.js";
import { FillSimulator } from "./engine/fill-simulator.js";
import { PositionSizer } from "./engine/position-sizer.js";
import { RegimeDetector } from "./engine/regime-detector.js";
import { EventBus } from "./engine/event-bus.js";
import { TradingEngine } from "./engine/engine.js";
import { NotesStore } from "./notes-store.js";
import { AccountActivityStore } from "./activity/store.js";
import { CriticalIncidentStore } from "./incident/store.js";
import { PostgresStorage } from "./storage/postgres.js";
import { ObservabilityStore } from "./observability/store.js";
import { WebSocketService } from "./ws/server.js";
import { handleRequest } from "./api.js";

// Always resolve env from workspace root regardless of cwd (server/src or server/dist).
dotenv.config({
  path: fileURLToPath(new URL("../../.env", import.meta.url)),
});

const AppLive = WebSocketService.Default.pipe(
  Layer.provideMerge(TradingEngine.Default),
  Layer.provideMerge(AutoRedeemer.Default),
  Layer.provideMerge(PnLTracker.Default),
  Layer.provideMerge(TradeStore.Default),
  Layer.provideMerge(ShadowTradeStore.Default),
  Layer.provideMerge(FeedService.Default),
  Layer.provideMerge(RiskManager.Default),
  Layer.provideMerge(FillSimulator.Default),
  Layer.provideMerge(PositionSizer.Default),
  Layer.provideMerge(RegimeDetector.Default),
  Layer.provideMerge(EventBus.Default),
  Layer.provideMerge(OrderService.Default),
  Layer.provideMerge(MarketService.Default),
).pipe(
  Layer.provideMerge(PolymarketClient.Default),
  Layer.provideMerge(NotesStore.Default),
  Layer.provideMerge(AccountActivityStore.Default),
  Layer.provideMerge(CriticalIncidentStore.Default),
  Layer.provideMerge(ObservabilityStore.Default),
  Layer.provideMerge(PostgresStorage.Default),
  Layer.provideMerge(AppConfig.Default),
  Layer.provideMerge(NodeContext.layer),
);

const program = Effect.gen(function* () {
  const config = yield* AppConfig;
  const wsService = yield* WebSocketService;
  const polyClient = yield* PolymarketClient;
  const runtime = yield* Effect.runtime<
    TradingEngine | FeedService | PolymarketClient | NotesStore | AccountActivityStore | CriticalIncidentStore | ObservabilityStore | PostgresStorage | AppConfig
  >();
  const runFork = Runtime.runFork(runtime);

  const httpServer = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      let parsed: any = undefined;
      let parseError = false;
      if (body) {
        try {
          parsed = JSON.parse(body);
        } catch {
          parseError = true;
        }
      }

      const fiber = runFork(
        handleRequest(url, method, parsed, parseError, req.headers).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              const commonHeaders = {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
              };
              const contentType = result.contentType ?? "application/json";
              const headers: Record<string, string> = {
                ...commonHeaders,
                "Content-Type": contentType,
              };
              if (result.contentDisposition) {
                headers["Content-Disposition"] = result.contentDisposition;
              }
              res.writeHead(result.status, headers);
              if (result.rawBody) {
                res.end(String(result.body ?? ""));
                return;
              }
              res.end(JSON.stringify(result.body));
            }),
          ),
          Effect.catchAllDefect((defect) =>
            Effect.sync(() => {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: String(defect) }));
            }),
          ),
        ),
      );
    });
  });

  yield* wsService.attach(httpServer);

  yield* Effect.async<void, never>((resume) => {
    httpServer.listen(config.server.port, "127.0.0.1", () => {
      resume(Effect.void);
    });
  });

  yield* Effect.log(`Server running on http://127.0.0.1:${config.server.port}`);

  if (config.poly.privateKey) {
    yield* Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* polyClient.getClient;
        const addr = yield* polyClient.getWalletAddress;
        yield* Effect.log(`[Startup] Polymarket auto-connected: ${addr}`);
      }).pipe(
        Effect.catchAll((err) =>
          Effect.logError(`[Startup] Polymarket auto-connect failed: ${err}`),
        ),
        Effect.forkDaemon,
      );
    });
  }

  yield* Effect.never;
});

const main = program.pipe(Effect.scoped, Effect.provide(AppLive));

NodeRuntime.runMain(main);

import http from "http";
import { Effect } from "effect";
import { TradingEngine } from "./engine/engine.js";
import { FeedService } from "./feeds/manager.js";
import { PolymarketClient } from "./polymarket/client.js";
import { NotesStore } from "./notes-store.js";
import { AppConfig } from "./config.js";

interface RouteResult {
  status: number;
  body: unknown;
}

export const handleRequest = (
  url: string,
  method: string,
  body: any,
  bodyParseError: boolean,
  headers: http.IncomingHttpHeaders,
): Effect.Effect<
  RouteResult,
  never,
  TradingEngine | FeedService | PolymarketClient | NotesStore | AppConfig
> =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const engine = yield* TradingEngine;
    const feedService = yield* FeedService;
    const polyClient = yield* PolymarketClient;
    const notesStore = yield* NotesStore;
    yield* Effect.annotateCurrentSpan("http.method", method);
    yield* Effect.annotateCurrentSpan("http.url", url);

    const checkAuth = () => {
      const token = config.server.operatorToken;
      if (!token) return true;
      return headers.authorization === `Bearer ${token}`;
    };

    const path = url.split("?")[0]!;

    if ((method === "POST" || method === "PUT") && bodyParseError) {
      return { status: 400, body: { error: "Invalid JSON body" } };
    }

    if (method === "GET") {
      if (path === "/api/status") {
        const [tradingActive, mode, currentWindow, windowTitle, regime, killSwitches, risk, metrics, prices, oracleEst, btcPrice, feedHealth, connected, walletAddr] = yield* Effect.all([
          engine.isTradingActive, engine.getMode, engine.getCurrentWindow, engine.getWindowTitle,
          engine.getRegime, engine.getKillSwitchStatus, engine.getRiskSnapshot, engine.getMetrics,
          feedService.getLatestPrices, feedService.getOracleEstimate, feedService.getCurrentBtcPrice,
          feedService.getFeedHealth, polyClient.isConnected, polyClient.getWalletAddress,
        ]);
        return { status: 200, body: { connected, walletAddress: walletAddr, tradingActive, mode, currentWindow, windowTitle, oracleEstimate: oracleEst, btcPrice, feedHealth, regime, killSwitches, risk, metrics } };
      }
      if (path === "/api/strategies") {
        const states = yield* engine.getStrategyStates;
        return { status: 200, body: states };
      }
      if (path === "/api/trades") {
        const trades = yield* engine.tracker.getTrades(100);
        return { status: 200, body: trades };
      }
      if (path === "/api/pnl") {
        const summary = yield* engine.tracker.getSummary(false);
        return { status: 200, body: summary };
      }
      if (path === "/api/shadow/summary") {
        const summary = yield* engine.tracker.getSummary(true);
        return { status: 200, body: summary };
      }
      if (path === "/api/regime") {
        const regime = yield* engine.getRegime;
        return { status: 200, body: regime };
      }
      if (path === "/api/killswitches") {
        const status = yield* engine.getKillSwitchStatus;
        return { status: 200, body: status };
      }
      if (path === "/api/orderbook") {
        const ob = yield* engine.getOrderBookState;
        return { status: 200, body: ob };
      }
      if (path === "/api/prices") {
        const [prices, oracleEst] = yield* Effect.all([
          feedService.getLatestPrices,
          feedService.getOracleEstimate,
        ]);
        return { status: 200, body: { prices, oracleEstimate: oracleEst } };
      }
      if (path === "/api/notes") {
        const notes = yield* notesStore.load;
        return { status: 200, body: notes };
      }
    }

    if (method === "POST") {
      if (path === "/api/trading/toggle") {
        if (!checkAuth()) return { status: 401, body: { error: "Unauthorized" } };
        const current = yield* engine.isTradingActive;
        yield* engine.setTradingActive(!current);
        const updated = yield* engine.isTradingActive;
        return { status: 200, body: { tradingActive: updated } };
      }
      if (path === "/api/mode") {
        if (!checkAuth()) return { status: 401, body: { error: "Unauthorized" } };
        const mode = body?.mode;
        if (mode !== "live" && mode !== "shadow") {
          return { status: 400, body: { error: 'mode must be "live" or "shadow"' } };
        }
        yield* engine.setMode(mode);
        return { status: 200, body: { mode } };
      }
      if (path === "/api/connect") {
        const result = yield* Effect.gen(function* () {
          yield* polyClient.getClient;
          const addr = yield* polyClient.getWalletAddress;
          return { status: 200, body: { connected: true, walletAddress: addr } };
        }).pipe(
          Effect.catchAll((err) =>
            Effect.succeed({ status: 500, body: { error: String(err) } } as RouteResult),
          ),
        );
        return result;
      }
      if (path === "/api/killswitches/reset") {
        if (!checkAuth()) return { status: 401, body: { error: "Unauthorized" } };
        yield* engine.resetKillSwitchPause;
        const status = yield* engine.getKillSwitchStatus;
        return { status: 200, body: { ok: true, killSwitches: status } };
      }

      const stratToggle = path.match(/^\/api\/strategies\/([^/]+)\/toggle$/);
      if (stratToggle) {
        if (!checkAuth()) return { status: 401, body: { error: "Unauthorized" } };
        const name = decodeURIComponent(stratToggle[1]!);
        const enabled = yield* engine.toggleStrategy(name);
        return { status: 200, body: { name, enabled } };
      }

      const stratConfig = path.match(/^\/api\/strategies\/([^/]+)\/config$/);
      if (stratConfig) {
        if (!checkAuth()) return { status: 401, body: { error: "Unauthorized" } };
        const name = decodeURIComponent(stratConfig[1]!);
        if (!body || typeof body !== "object" || Object.keys(body).length === 0) {
          return { status: 400, body: { error: "Empty config payload", rejectedKeys: [] } };
        }
        const result = yield* engine.updateStrategyConfig(name, body ?? {});
        if (result.status === "not_found") return { status: 404, body: { error: "Strategy not found" } };
        if (result.status === "invalid") {
          return {
            status: 400,
            body: {
              error: result.error,
              appliedKeys: result.appliedKeys,
              rejectedKeys: result.rejectedKeys,
            },
          };
        }
        return { status: 200, body: { ok: true } };
      }

      const stratRegime = path.match(/^\/api\/strategies\/([^/]+)\/regime-filter$/);
      if (stratRegime) {
        if (!checkAuth()) return { status: 401, body: { error: "Unauthorized" } };
        const name = decodeURIComponent(stratRegime[1]!);
        const result = yield* engine.updateStrategyRegimeFilter(name, body ?? {});
        if (result === "not_found") return { status: 404, body: { error: "Strategy not found" } };
        return { status: 200, body: { ok: true } };
      }
    }

    if (method === "PUT") {
      if (path === "/api/notes") {
        if (!checkAuth()) return { status: 401, body: { error: "Unauthorized" } };
        const text = typeof body?.text === "string" ? body.text : "";
        const result = yield* notesStore.save(text).pipe(
          Effect.map((saved) => ({ status: 200, body: saved } as RouteResult)),
          Effect.catchAll((err) =>
            Effect.succeed({ status: 500, body: { error: String(err) } } as RouteResult),
          ),
        );
        return result;
      }
    }

    return { status: 404, body: { error: "Not found" } };
  }).pipe(
    Effect.withSpan("http.request"),
    Effect.catchAll((err) => Effect.succeed({ status: 500, body: { error: String(err) } } as RouteResult)),
  );

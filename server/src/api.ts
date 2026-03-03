import http from "http";
import { Effect } from "effect";
import { TradingEngine } from "./engine/engine.js";
import { FeedService } from "./feeds/manager.js";
import { PolymarketClient } from "./polymarket/client.js";
import { NotesStore } from "./notes-store.js";
import { AppConfig } from "./config.js";
import { AccountActivityStore } from "./activity/store.js";
import { CriticalIncidentStore } from "./incident/store.js";
import { PostgresStorage } from "./storage/postgres.js";
import { ObservabilityStore } from "./observability/store.js";
import {
  OBSERVABILITY_CATEGORIES,
  OBSERVABILITY_ENTITY_TYPES,
  OBSERVABILITY_SOURCES,
} from "./shared/observability.js";
import type {
  TradeRecord,
  ObservabilityCategory,
  ObservabilitySource,
  ObservabilityEntityType,
  TradingMode,
} from "./types.js";

interface RouteResult {
  status: number;
  body: unknown;
  contentType?: string;
  contentDisposition?: string;
  rawBody?: boolean;
}

type TradeModeParam = "all" | "live" | "shadow";
type TradeTimeframeParam = "1h" | "12h" | "1d" | "7d" | "30d" | "all";

function parseTradeMode(raw: string | null): TradeModeParam {
  if (raw === "live" || raw === "shadow" || raw === "all") return raw;
  return "all";
}

function parseTradeTimeframe(raw: string | null): TradeTimeframeParam {
  switch (raw) {
    case "1h":
    case "12h":
    case "1d":
    case "7d":
    case "30d":
    case "all":
      return raw;
    default:
      return "30d";
  }
}

function parsePositiveInt(raw: string | null, fallback: number, max = 1000): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(n, max));
}

function parseMode(raw: string | null): TradingMode | undefined {
  if (raw === "live" || raw === "shadow") return raw;
  return undefined;
}

function timeframeToSinceMs(timeframe: TradeTimeframeParam): number | undefined {
  const now = Date.now();
  switch (timeframe) {
    case "1h":
      return now - 60 * 60 * 1000;
    case "12h":
      return now - 12 * 60 * 60 * 1000;
    case "1d":
      return now - 24 * 60 * 60 * 1000;
    case "7d":
      return now - 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return now - 30 * 24 * 60 * 60 * 1000;
    case "all":
      return undefined;
  }
}

function timeframeToSinceSec(timeframe: TradeTimeframeParam): number | undefined {
  const ms = timeframeToSinceMs(timeframe);
  return typeof ms === "number" ? Math.floor(ms / 1000) : undefined;
}

function parseEnum<T extends string>(
  raw: string | null,
  allowed: readonly T[],
): T | undefined {
  if (!raw) return undefined;
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined;
}

function csvCell(value: unknown): string {
  const s = String(value ?? "");
  const needsQuote =
    s.includes(",") ||
    s.includes('"') ||
    s.includes("\n") ||
    /^[=+\-@\t\r]/.test(s);
  if (!needsQuote) return s;
  const escaped = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${escaped.replace(/"/g, '""')}"`;
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
  TradingEngine | FeedService | PolymarketClient | NotesStore | AccountActivityStore | CriticalIncidentStore | ObservabilityStore | PostgresStorage | AppConfig
> =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const engine = yield* TradingEngine;
    const feedService = yield* FeedService;
    const polyClient = yield* PolymarketClient;
    const notesStore = yield* NotesStore;
    const activityStore = yield* AccountActivityStore;
    const incidentStore = yield* CriticalIncidentStore;
    const observability = yield* ObservabilityStore;
    const postgres = yield* PostgresStorage;
    yield* Effect.annotateCurrentSpan("http.method", method);
    yield* Effect.annotateCurrentSpan("http.url", url);

    const checkAuth = () => {
      const token = config.server.operatorToken;
      if (!token || token.trim().length === 0) return true;
      return headers.authorization === `Bearer ${token.trim()}`;
    };
    const audit = (action: string, payload: Record<string, unknown>) =>
      observability.append({
        category: "api",
        source: "api",
        action,
        entityType: "system",
        entityId: path,
        status: "ok",
        mode: null,
        payload,
      }).pipe(Effect.catchAll(() => Effect.void));

    const path = url.split("?")[0]!;
    const parsedUrl = new URL(url, "http://localhost");
    const searchParams = parsedUrl.searchParams;

    if ((method === "POST" || method === "PUT") && bodyParseError) {
      return { status: 400, body: { error: "Invalid JSON body" } };
    }

    if (method === "GET") {
      if (path === "/api/status") {
        const [tradingActive, mode, currentWindow, windowTitle, regime, killSwitches, risk, metrics, oracleEst, btcPrice, feedHealth, connected, walletAddr, storageHealth] = yield* Effect.all([
          engine.isTradingActive, engine.getMode, engine.getCurrentWindow, engine.getWindowTitle,
          engine.getRegime, engine.getKillSwitchStatus, engine.getRiskSnapshot, engine.getMetrics,
          feedService.getOracleEstimate, feedService.getCurrentBtcPrice,
          feedService.getFeedHealth, polyClient.isConnected, polyClient.getWalletAddress, postgres.health,
        ]);
        return {
          status: 200,
          body: {
            connected,
            walletAddress: walletAddr,
            tradingActive,
            mode,
            currentWindow,
            windowTitle,
            oracleEstimate: oracleEst,
            btcPrice,
            feedHealth,
            regime,
            killSwitches,
            risk,
            metrics,
            storage: {
              backend: config.storage.backend,
              ...storageHealth,
            },
          },
        };
      }
      if (path === "/api/strategies") {
        const states = yield* engine.getStrategyStates;
        return { status: 200, body: states };
      }
      if (path === "/api/trades") {
        const mode = parseTradeMode(searchParams.get("mode"));
        const timeframe = parseTradeTimeframe(searchParams.get("timeframe"));
        const limit = parsePositiveInt(searchParams.get("limit"), 100, 500);
        const cursor = searchParams.get("cursor") ?? undefined;
        const sinceMs = timeframeToSinceMs(timeframe);
        const result = yield* engine.tracker.listTrades({
          mode,
          limit,
          cursor,
          sinceMs,
        });
        return {
          status: 200,
          body: {
            items: result.items,
            nextCursor: result.nextCursor,
            hasMore: result.hasMore,
            limit,
            mode,
            timeframe,
          },
        };
      }
      if (path === "/api/trades/export.csv") {
        const mode = parseTradeMode(searchParams.get("mode"));
        const timeframe = parseTradeTimeframe(searchParams.get("timeframe"));
        const sinceMs = timeframeToSinceMs(timeframe);
        const allItems: TradeRecord[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < 200; i++) {
          const page = yield* engine.tracker.listTrades({
            mode,
            limit: 500,
            sinceMs,
            cursor,
          });
          allItems.push(...page.items);
          if (!page.hasMore || !page.nextCursor) break;
          cursor = page.nextCursor;
        }
        const headers = [
          "ID",
          "Time",
          "Strategy",
          "Side",
          "Entry Price",
          "Size",
          "Shares",
          "Fee",
          "Status",
          "Outcome",
          "Last Event",
          "CLOB Result",
          "CLOB Order ID",
          "CLOB Reason",
          "P&L",
          "Shadow",
          "Resolution Source",
          "Settlement Winner Side",
        ];
        const rows = allItems.map((t) => [
          t.id,
          new Date(t.timestamp).toISOString(),
          t.strategy,
          t.side,
          t.entryPrice,
          t.size,
          t.shares,
          t.fee,
          t.status,
          t.outcome ?? "",
          t.lastEventType ?? "",
          t.clobResult ?? "",
          t.clobOrderId ?? "",
          t.clobReason ?? "",
          t.pnl,
          t.shadow ? "yes" : "no",
          t.resolutionSource ?? "estimated",
          t.settlementWinnerSide ?? "",
        ]);
        const csv = [
          headers.map(csvCell).join(","),
          ...rows.map((r) => r.map(csvCell).join(",")),
        ].join("\n");
        return {
          status: 200,
          body: csv,
          rawBody: true,
          contentType: "text/csv; charset=utf-8",
          contentDisposition: `attachment; filename="trades-${timeframe}-${new Date().toISOString().slice(0, 10)}.csv"`,
        };
      }
      if (path === "/api/activity") {
        const timeframe = parseTradeTimeframe(searchParams.get("timeframe"));
        const limit = parsePositiveInt(searchParams.get("limit"), 100, 500);
        const cursor = searchParams.get("cursor") ?? undefined;
        const sinceSec = timeframeToSinceSec(timeframe);
        const result = yield* activityStore.list({
          limit,
          cursor,
          sinceSec,
        });
        return {
          status: 200,
          body: {
            items: result.items,
            nextCursor: result.nextCursor,
            hasMore: result.hasMore,
            limit,
            timeframe,
          },
        };
      }
      if (path === "/api/activity/export.csv") {
        const timeframe = parseTradeTimeframe(searchParams.get("timeframe"));
        const sinceSec = timeframeToSinceSec(timeframe);
        const allItems: Array<any> = [];
        let cursor: string | undefined;
        for (let i = 0; i < 200; i++) {
          const page = yield* activityStore.list({
            limit: 500,
            sinceSec,
            cursor,
          });
          allItems.push(...page.items);
          if (!page.hasMore || !page.nextCursor) break;
          cursor = page.nextCursor;
        }
        const headers = [
          "ID",
          "Market",
          "Action",
          "USDC Amount",
          "Token Amount",
          "Token Name",
          "Timestamp",
          "Hash",
          "Source",
          "Imported At",
        ];
        const rows = allItems.map((a) => [
          a.id,
          a.marketName,
          a.action,
          a.usdcAmount,
          a.tokenAmount,
          a.tokenName,
          new Date(a.timestamp * 1000).toISOString(),
          a.hash,
          a.source,
          new Date(a.importedAt).toISOString(),
        ]);
        const csv = [
          headers.map(csvCell).join(","),
          ...rows.map((r) => r.map(csvCell).join(",")),
        ].join("\n");
        return {
          status: 200,
          body: csv,
          rawBody: true,
          contentType: "text/csv; charset=utf-8",
          contentDisposition: `attachment; filename="account-activity-${timeframe}-${new Date().toISOString().slice(0, 10)}.csv"`,
        };
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
      if (path === "/api/incidents") {
        const limit = parsePositiveInt(searchParams.get("limit"), 50, 500);
        const activeOnly = searchParams.get("activeOnly") === "true";
        const items = yield* incidentStore.list({ limit, activeOnly });
        return { status: 200, body: { items, limit, activeOnly } };
      }
      if (path === "/api/observability/events") {
        const limit = parsePositiveInt(searchParams.get("limit"), 200, 2000);
        const cursor = searchParams.get("cursor") ?? undefined;
        const timeframe = parseTradeTimeframe(searchParams.get("timeframe"));
        const sinceMs = timeframeToSinceMs(timeframe);
        const category = parseEnum<ObservabilityCategory>(searchParams.get("category"), OBSERVABILITY_CATEGORIES);
        const source = parseEnum<ObservabilitySource>(searchParams.get("source"), OBSERVABILITY_SOURCES);
        const entityType = parseEnum<ObservabilityEntityType>(searchParams.get("entityType"), OBSERVABILITY_ENTITY_TYPES);
        const mode = parseMode(searchParams.get("mode"));
        const strategy = searchParams.get("strategy") ?? undefined;
        const status = searchParams.get("status") ?? undefined;
        const entityId = searchParams.get("entityId") ?? undefined;
        const q = searchParams.get("q") ?? undefined;
        const result = yield* observability.list({
          limit,
          cursor,
          sinceMs,
          category,
          source,
          strategy,
          mode,
          status,
          entityType,
          entityId,
          q,
        });
        return {
          status: 200,
          body: {
            items: result.items,
            nextCursor: result.nextCursor,
            hasMore: result.hasMore,
            limit,
            timeframe,
          },
        };
      }
      if (path === "/api/observability/metrics") {
        const timeframe = parseTradeTimeframe(searchParams.get("timeframe"));
        const sinceMs = timeframeToSinceMs(timeframe);
        const category = parseEnum<ObservabilityCategory>(searchParams.get("category"), OBSERVABILITY_CATEGORIES);
        const source = parseEnum<ObservabilitySource>(searchParams.get("source"), OBSERVABILITY_SOURCES);
        const entityType = parseEnum<ObservabilityEntityType>(searchParams.get("entityType"), OBSERVABILITY_ENTITY_TYPES);
        const mode = parseMode(searchParams.get("mode"));
        const strategy = searchParams.get("strategy") ?? undefined;
        const status = searchParams.get("status") ?? undefined;
        const entityId = searchParams.get("entityId") ?? undefined;
        const q = searchParams.get("q") ?? undefined;
        const metrics = yield* observability.metrics({
          sinceMs,
          category,
          source,
          strategy,
          mode,
          status,
          entityType,
          entityId,
          q,
        });
        return { status: 200, body: { ...metrics, timeframe } };
      }
      if (path === "/api/storage/health") {
        const health = yield* postgres.health;
        return {
          status: 200,
          body: {
            backend: config.storage.backend,
            ...health,
          },
        };
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
        yield* audit("api_trading_toggle", { previous: current, updated });
        return { status: 200, body: { tradingActive: updated } };
      }
      if (path === "/api/mode") {
        if (!checkAuth()) return { status: 401, body: { error: "Unauthorized" } };
        const mode = body?.mode;
        if (mode !== "live" && mode !== "shadow") {
          return { status: 400, body: { error: 'mode must be "live" or "shadow"' } };
        }
        yield* engine.setMode(mode);
        yield* audit("api_mode_set", { mode });
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
        if (result.status === 200) {
          yield* audit("api_connect", { ok: true });
        }
        return result;
      }
      if (path === "/api/activity/import-csv") {
        if (!checkAuth()) return { status: 401, body: { error: "Unauthorized" } };
        const csv = typeof body?.csv === "string" ? body.csv : "";
        if (csv.trim().length === 0) {
          return { status: 400, body: { error: "csv is required" } };
        }
        const result = yield* activityStore.importCsv(csv);
        yield* audit("api_activity_import_csv", result as Record<string, unknown>);
        return { status: 200, body: result };
      }
      if (path === "/api/killswitches/reset") {
        if (!checkAuth()) return { status: 401, body: { error: "Unauthorized" } };
        yield* engine.resetKillSwitchPause;
        const status = yield* engine.getKillSwitchStatus;
        yield* audit("api_killswitches_reset", { ok: true, count: status.length });
        return { status: 200, body: { ok: true, killSwitches: status } };
      }
      const incidentResolve = path.match(/^\/api\/incidents\/([^/]+)\/resolve$/);
      if (incidentResolve) {
        if (!checkAuth()) return { status: 401, body: { error: "Unauthorized" } };
        const id = decodeURIComponent(incidentResolve[1]!);
        const updated = yield* incidentStore.resolve(id);
        if (!updated) return { status: 404, body: { error: "Incident not found" } };
        yield* audit("api_incident_resolve", { incidentId: id, resolvedAt: updated.resolvedAt });
        return { status: 200, body: { ok: true, incident: updated } };
      }

      const stratToggle = path.match(/^\/api\/strategies\/([^/]+)\/toggle$/);
      if (stratToggle) {
        if (!checkAuth()) return { status: 401, body: { error: "Unauthorized" } };
        const name = decodeURIComponent(stratToggle[1]!);
        const enabled = yield* engine.toggleStrategy(name);
        yield* audit("api_strategy_toggle", { name, enabled });
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
        yield* audit("api_strategy_config_update", { name, keys: Object.keys(body ?? {}) });
        return { status: 200, body: { ok: true } };
      }

      const stratRegime = path.match(/^\/api\/strategies\/([^/]+)\/regime-filter$/);
      if (stratRegime) {
        if (!checkAuth()) return { status: 401, body: { error: "Unauthorized" } };
        const name = decodeURIComponent(stratRegime[1]!);
        const result = yield* engine.updateStrategyRegimeFilter(name, body ?? {});
        if (result === "not_found") return { status: 404, body: { error: "Strategy not found" } };
        yield* audit("api_strategy_regime_filter_update", { name, keys: Object.keys(body ?? {}) });
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
        if (result.status === 200) {
          yield* audit("api_notes_save", { textLength: text.length });
        }
        return result;
      }
    }

    return { status: 404, body: { error: "Not found" } };
  }).pipe(
    Effect.withSpan("http.request"),
    Effect.catchAll((err) => Effect.succeed({ status: 500, body: { error: String(err) } } as RouteResult)),
  );

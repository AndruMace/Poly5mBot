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
import { MarketOrchestrator } from "./markets/orchestrator.js";
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
import type { MarketEngineInstance } from "./markets/market-engine.js";

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
  TradingEngine | FeedService | PolymarketClient | NotesStore | AccountActivityStore | CriticalIncidentStore | ObservabilityStore | PostgresStorage | AppConfig | MarketOrchestrator
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
    const orchestrator = yield* MarketOrchestrator;
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

    /** Resolve market engine from query param or path segment; defaults to first enabled market */
    const resolveMarketId = (pathMarketId?: string): string => {
      const raw = pathMarketId ?? searchParams.get("marketId");
      if (raw) {
        const mkt = orchestrator.getEngine(raw);
        if (mkt) return raw;
      }
      return orchestrator.getEnabledMarketIds()[0] ?? "btc";
    };
    const resolveEngine = (pathMarketId?: string): MarketEngineInstance | null => {
      const id = resolveMarketId(pathMarketId);
      return orchestrator.getEngine(id);
    };

    if ((method === "POST" || method === "PUT") && bodyParseError) {
      return { status: 400, body: { error: "Invalid JSON body" } };
    }

    if (method === "GET") {
      if (path === "/api/markets") {
        return { status: 200, body: orchestrator.getEnabledMarkets() };
      }
      if (path === "/api/status") {
        const mktEngine = resolveEngine();
        const [tradingActive, mode, currentWindow, windowTitle, regime, killSwitches, risk, metrics, oracleEst, btcPrice, feedHealth, connected, walletAddr, storageHealth] = yield* Effect.all([
          mktEngine ? mktEngine.isTradingActive : Effect.succeed(false),
          mktEngine ? mktEngine.getMode : Effect.succeed("shadow" as const),
          mktEngine ? mktEngine.getCurrentWindow : Effect.succeed(null),
          mktEngine ? mktEngine.getWindowTitle : Effect.succeed(""),
          mktEngine ? mktEngine.getRegime : engine.getRegime,
          mktEngine ? mktEngine.getKillSwitchStatus : engine.getKillSwitchStatus,
          mktEngine ? mktEngine.getRiskSnapshot : engine.getRiskSnapshot,
          mktEngine ? mktEngine.getMetrics : engine.getMetrics,
          mktEngine ? mktEngine.feedManager.getOracleEstimate : feedService.getOracleEstimate,
          mktEngine ? mktEngine.feedManager.getCurrentAssetPrice : feedService.getCurrentAssetPrice,
          mktEngine ? mktEngine.getFeedHealth : feedService.getFeedHealth,
          polyClient.isConnected, polyClient.getWalletAddress, postgres.health,
        ]);
        return {
          status: 200,
          body: {
            marketId: resolveMarketId(),
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
            orderPrecisionGuard: metrics.orderPrecisionGuard ?? null,
            enabledMarkets: orchestrator.getEnabledMarkets(),
            storage: {
              backend: config.storage.backend,
              ...storageHealth,
            },
          },
        };
      }
      if (path === "/api/strategies") {
        const mktEngine = resolveEngine();
        const states = mktEngine ? yield* mktEngine.getStrategyStates : yield* engine.getStrategyStates;
        return { status: 200, body: states };
      }
      if (path === "/api/trades") {
        const mode = parseTradeMode(searchParams.get("mode"));
        const timeframe = parseTradeTimeframe(searchParams.get("timeframe"));
        const limit = parsePositiveInt(searchParams.get("limit"), 100, 500);
        const cursor = searchParams.get("cursor") ?? undefined;
        const sinceMs = timeframeToSinceMs(timeframe);
        const mktEngine = resolveEngine();
        const result = mktEngine
          ? yield* mktEngine.listTrades({ mode, limit, cursor, sinceMs })
          : yield* engine.tracker.listTrades({ mode, limit, cursor, sinceMs });
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
        const mktEngine = resolveEngine();
        const allItems: TradeRecord[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < 200; i++) {
          const page = mktEngine
            ? yield* mktEngine.listTrades({ mode, limit: 500, sinceMs, cursor })
            : yield* engine.tracker.listTrades({ mode, limit: 500, sinceMs, cursor });
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
      if (path === "/api/activity/freshness") {
        const staleThresholdSec = parsePositiveInt(searchParams.get("staleThresholdSec"), 600, 86400);
        const freshness = yield* activityStore.getFreshness(staleThresholdSec);
        return { status: 200, body: freshness };
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
        const mktEngine = resolveEngine();
        const summary = mktEngine ? yield* mktEngine.getPnLSummary : yield* engine.tracker.getSummary(false);
        return { status: 200, body: summary };
      }
      if (path === "/api/shadow/summary") {
        const mktEngine = resolveEngine();
        const summary = mktEngine ? yield* mktEngine.getShadowPnLSummary : yield* engine.tracker.getSummary(true);
        return { status: 200, body: summary };
      }
      if (path === "/api/regime") {
        const mktEngine = resolveEngine();
        const regime = mktEngine ? yield* mktEngine.getRegime : yield* engine.getRegime;
        return { status: 200, body: regime };
      }
      if (path === "/api/killswitches") {
        const mktEngine = resolveEngine();
        const ks = mktEngine ? yield* mktEngine.getKillSwitchStatus : yield* engine.getKillSwitchStatus;
        return { status: 200, body: ks };
      }
      if (path === "/api/orderbook") {
        const mktEngine = resolveEngine();
        const ob = mktEngine ? yield* mktEngine.getOrderBookState : yield* engine.getOrderBookState;
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
      if (path === "/api/analytics/late-window") {
        const timeframe = parseTradeTimeframe(searchParams.get("timeframe"));
        const sinceMs = timeframeToSinceMs(timeframe);
        const minSamples = parsePositiveInt(searchParams.get("minSamples"), 20, 10_000);
        const mktEngine = resolveEngine();
        const all = mktEngine
          ? yield* mktEngine.getTradeRecords(5000)
          : yield* engine.tracker.getAllTradeRecords(false);
        const resolved = all.filter((t) => t.status === "resolved" && (!sinceMs || t.timestamp >= sinceMs));
        type Bucket = "<30s" | "30-60s" | "60-90s" | "90-120s" | ">=120s";
        const classify = (msRemaining: number): Bucket =>
          msRemaining < 30_000 ? "<30s"
            : msRemaining < 60_000 ? "30-60s"
              : msRemaining < 90_000 ? "60-90s"
                : msRemaining < 120_000 ? "90-120s"
                  : ">=120s";
        const byBucket = new Map<Bucket, { trades: number; wins: number; losses: number; pnl: number }>();
        const byStrategyBucket = new Map<string, { trades: number; wins: number; losses: number; pnl: number }>();
        for (const trade of resolved) {
          const windowEnd = trade.entryContext?.window?.windowEnd ?? trade.windowEnd;
          const msRemaining = Math.max(0, windowEnd - trade.timestamp);
          const bucket = classify(msRemaining);
          const bucketAgg = byBucket.get(bucket) ?? { trades: 0, wins: 0, losses: 0, pnl: 0 };
          bucketAgg.trades += 1;
          if (trade.outcome === "win") bucketAgg.wins += 1;
          if (trade.outcome === "loss") bucketAgg.losses += 1;
          bucketAgg.pnl += trade.pnl;
          byBucket.set(bucket, bucketAgg);

          const key = `${trade.strategy}|${bucket}`;
          const stratAgg = byStrategyBucket.get(key) ?? { trades: 0, wins: 0, losses: 0, pnl: 0 };
          stratAgg.trades += 1;
          if (trade.outcome === "win") stratAgg.wins += 1;
          if (trade.outcome === "loss") stratAgg.losses += 1;
          stratAgg.pnl += trade.pnl;
          byStrategyBucket.set(key, stratAgg);
        }
        const buckets: Bucket[] = ["<30s", "30-60s", "60-90s", "90-120s", ">=120s"];
        return {
          status: 200,
          body: {
            timeframe,
            minSamples,
            totalResolved: resolved.length,
            bucketStats: buckets.map((bucket) => {
              const agg = byBucket.get(bucket) ?? { trades: 0, wins: 0, losses: 0, pnl: 0 };
              return {
                bucket,
                trades: agg.trades,
                wins: agg.wins,
                losses: agg.losses,
                winRate: agg.trades > 0 ? agg.wins / agg.trades : 0,
                pnl: agg.pnl,
                meetsMinSamples: agg.trades >= minSamples,
              };
            }),
            strategyBucketStats: [...byStrategyBucket.entries()].map(([key, agg]) => {
              const [strategy, bucket] = key.split("|");
              return {
                strategy,
                bucket,
                trades: agg.trades,
                wins: agg.wins,
                losses: agg.losses,
                winRate: agg.trades > 0 ? agg.wins / agg.trades : 0,
                pnl: agg.pnl,
                meetsMinSamples: agg.trades >= minSamples,
              };
            }),
          },
        };
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
      const tradingToggleMatch = path.match(/^\/api\/trading(?:\/([^/]+))?\/toggle$/);
      if (tradingToggleMatch) {
        if (!checkAuth()) return { status: 401, body: { error: "Unauthorized" } };
        const mktEngine = resolveEngine(tradingToggleMatch[1]);
        if (!mktEngine) return { status: 404, body: { error: "Market not found" } };
        const current = yield* mktEngine.isTradingActive;
        yield* mktEngine.setTradingActive(!current);
        const updated = yield* mktEngine.isTradingActive;
        yield* audit("api_trading_toggle", { marketId: mktEngine.marketId, previous: current, updated });
        return { status: 200, body: { tradingActive: updated, marketId: mktEngine.marketId } };
      }
      const modeMatch = path.match(/^\/api\/mode(?:\/([^/]+))?$/);
      if (modeMatch) {
        if (!checkAuth()) return { status: 401, body: { error: "Unauthorized" } };
        const mode = body?.mode;
        if (mode !== "live" && mode !== "shadow") {
          return { status: 400, body: { error: 'mode must be "live" or "shadow"' } };
        }
        const mktEngine = resolveEngine(modeMatch[1]);
        if (!mktEngine) return { status: 404, body: { error: "Market not found" } };
        yield* mktEngine.setMode(mode);
        yield* audit("api_mode_set", { marketId: mktEngine.marketId, mode });
        return { status: 200, body: { mode, marketId: mktEngine.marketId } };
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
      const killswitchResetMatch = path.match(/^\/api\/killswitches(?:\/([^/]+))?\/reset$/);
      if (killswitchResetMatch) {
        if (!checkAuth()) return { status: 401, body: { error: "Unauthorized" } };
        const mktEngine = resolveEngine(killswitchResetMatch[1]);
        if (!mktEngine) return { status: 404, body: { error: "Market not found" } };
        yield* mktEngine.resetKillSwitchPause;
        const ks = yield* mktEngine.getKillSwitchStatus;
        yield* audit("api_killswitches_reset", { marketId: mktEngine.marketId, ok: true, count: ks.length });
        return { status: 200, body: { ok: true, killSwitches: ks, marketId: mktEngine.marketId } };
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

      // Strategy endpoints support /api/strategies/:name/toggle or /api/strategies/:marketId/:name/toggle
      const stratToggle = path.match(/^\/api\/strategies\/([^/]+)\/toggle$/) ?? path.match(/^\/api\/strategies\/([^/]+)\/([^/]+)\/toggle$/);
      if (stratToggle) {
        if (!checkAuth()) return { status: 401, body: { error: "Unauthorized" } };
        const hasMarketId = stratToggle.length > 2;
        const marketIdSeg = hasMarketId ? stratToggle[1] : undefined;
        const name = decodeURIComponent(hasMarketId ? stratToggle[2]! : stratToggle[1]!);
        const mktEngine = resolveEngine(marketIdSeg);
        if (!mktEngine) return { status: 404, body: { error: "Market not found" } };
        const enabled = yield* mktEngine.toggleStrategy(name);
        yield* audit("api_strategy_toggle", { marketId: mktEngine.marketId, name, enabled });
        return { status: 200, body: { name, enabled, marketId: mktEngine.marketId } };
      }

      const stratConfig = path.match(/^\/api\/strategies\/([^/]+)\/config$/) ?? path.match(/^\/api\/strategies\/([^/]+)\/([^/]+)\/config$/);
      if (stratConfig) {
        if (!checkAuth()) return { status: 401, body: { error: "Unauthorized" } };
        const hasMarketId = stratConfig.length > 2;
        const marketIdSeg = hasMarketId ? stratConfig[1] : undefined;
        const name = decodeURIComponent(hasMarketId ? stratConfig[2]! : stratConfig[1]!);
        if (!body || typeof body !== "object" || Object.keys(body).length === 0) {
          return { status: 400, body: { error: "Empty config payload", rejectedKeys: [] } };
        }
        const mktEngine = resolveEngine(marketIdSeg);
        if (!mktEngine) return { status: 404, body: { error: "Market not found" } };
        const result = yield* mktEngine.updateStrategyConfig(name, body ?? {});
        if (result.status === "not_found") return { status: 404, body: { error: "Strategy not found" } };
        if (result.status === "persist_failed") {
          return { status: 500, body: { error: result.error ?? "Failed to persist strategy config" } };
        }
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
        yield* audit("api_strategy_config_update", { marketId: mktEngine.marketId, name, keys: Object.keys(body ?? {}) });
        return { status: 200, body: { ok: true } };
      }

      const stratRegime = path.match(/^\/api\/strategies\/([^/]+)\/regime-filter$/) ?? path.match(/^\/api\/strategies\/([^/]+)\/([^/]+)\/regime-filter$/);
      if (stratRegime) {
        if (!checkAuth()) return { status: 401, body: { error: "Unauthorized" } };
        const hasMarketId = stratRegime.length > 2;
        const marketIdSeg = hasMarketId ? stratRegime[1] : undefined;
        const name = decodeURIComponent(hasMarketId ? stratRegime[2]! : stratRegime[1]!);
        const mktEngine = resolveEngine(marketIdSeg);
        if (!mktEngine) return { status: 404, body: { error: "Market not found" } };
        const result = yield* mktEngine.updateStrategyRegimeFilter(name, body ?? {});
        if (result.status === "not_found") return { status: 404, body: { error: "Strategy not found" } };
        if (result.status === "persist_failed") {
          return { status: 500, body: { error: result.error ?? "Failed to persist strategy regime filter" } };
        }
        yield* audit("api_strategy_regime_filter_update", { marketId: mktEngine.marketId, name, keys: Object.keys(body ?? {}) });
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

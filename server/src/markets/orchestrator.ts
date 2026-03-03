import { Effect, Option } from "effect";
import { AppConfig } from "../config.js";
import { TradingEngine } from "../engine/engine.js";
import { FeedService } from "../feeds/manager.js";
import { EventBus } from "../engine/event-bus.js";
import { OrderService } from "../polymarket/orders.js";
import { PolymarketClient } from "../polymarket/client.js";
import { FillSimulator } from "../engine/fill-simulator.js";
import { PositionSizer } from "../engine/position-sizer.js";
import { GlobalRiskManager } from "../engine/global-risk.js";
import { CriticalIncidentStore } from "../incident/store.js";
import { ObservabilityStore } from "../observability/store.js";
import { PostgresStorage } from "../storage/postgres.js";
import { ALL_MARKETS, getMarketConfig } from "./definitions.js";
import type { MarketEngineInstance } from "./market-engine.js";
import type { MarketFeedInstance } from "../feeds/market-feed-manager.js";
import type { MarketAssetConfig } from "./registry.js";
import { createStandaloneMarketEngine } from "./engine-factory.js";

/**
 * Wraps the existing singleton TradingEngine as a MarketEngineInstance for BTC.
 * This allows the orchestrator to expose a uniform API for all markets.
 */
function wrapExistingEngine(
  engine: TradingEngine,
  feedService: FeedService,
  marketConfig: MarketAssetConfig,
): MarketEngineInstance {
  // Create a thin MarketFeedInstance adapter from the existing FeedService singleton
  const feedManager: MarketFeedInstance = {
    marketId: marketConfig.id,
    getLatestPrices: feedService.getLatestPrices,
    getOracleEstimate: feedService.getOracleEstimate,
    getOracleTimestamp: feedService.getOracleTimestamp,
    getCurrentAssetPrice: feedService.getCurrentAssetPrice,
    getFeedHealth: feedService.getFeedHealth,
    getRecentPrices: feedService.getRecentPrices,
    priceChanges: feedService.priceChanges,
  };

  return {
    marketId: marketConfig.id,
    displayName: marketConfig.displayName,
    feedManager,
    getStrategyStates: engine.getStrategyStates,
    getOrderBookState: engine.getOrderBookState,
    getCurrentWindow: engine.getCurrentWindow,
    getWindowTitle: engine.getWindowTitle,
    isTradingActive: engine.isTradingActive,
    setTradingActive: engine.setTradingActive,
    getMode: engine.getMode,
    setMode: engine.setMode,
    getRegime: engine.getRegime,
    getRiskSnapshot: engine.getRiskSnapshot,
    getKillSwitchStatus: engine.getKillSwitchStatus,
    resetKillSwitchPause: engine.resetKillSwitchPause,
    getMetrics: engine.getMetrics,
    toggleStrategy: engine.toggleStrategy,
    updateStrategyConfig: engine.updateStrategyConfig,
    updateStrategyRegimeFilter: engine.updateStrategyRegimeFilter,
    listTrades: (query) => engine.tracker.listTrades(query),
    getTradeRecords: (limit) => engine.tracker.listTrades({ mode: "all", limit }).pipe(Effect.map((r) => r.items)),
    getPnLSummary: engine.tracker.getSummary(false),
    getShadowPnLSummary: engine.tracker.getSummary(true),
    getFeedHealth: feedService.getFeedHealth,
  };
}

export class MarketOrchestrator extends Effect.Service<MarketOrchestrator>()("MarketOrchestrator", {
  scoped: Effect.gen(function* () {
    const config = yield* AppConfig;
    const engine = yield* TradingEngine;
    const feedService = yield* FeedService;
    const _globalRisk = yield* GlobalRiskManager;

    // Shared services for standalone engines
    const orderService = yield* OrderService;
    const polyClient = yield* PolymarketClient;
    const eventBus = yield* EventBus;
    const fillSimulator = yield* FillSimulator;
    const positionSizer = yield* PositionSizer;
    const incidentStore = yield* CriticalIncidentStore;
    const observabilityOpt = yield* Effect.serviceOption(ObservabilityStore);
    const observability = Option.getOrUndefined(observabilityOpt);

    const engines = new Map<string, MarketEngineInstance>();
    const enabledIds = config.markets.enabledIds;

    // BTC uses the existing singleton TradingEngine
    if (enabledIds.includes("btc")) {
      const btcConfig = getMarketConfig("btc");
      if (btcConfig) {
        const wrapped = wrapExistingEngine(engine, feedService, btcConfig);
        engines.set("btc", wrapped);
        yield* Effect.log(`[Orchestrator] BTC market engine (singleton) ready`);
      }
    }

    // Non-BTC markets: construct standalone engines
    for (const marketId of enabledIds) {
      if (marketId === "btc") continue;
      const mktConfig = getMarketConfig(marketId);
      if (!mktConfig) {
        yield* Effect.logWarning(`[Orchestrator] Unknown market: ${marketId} — skipping`);
        continue;
      }

      yield* Effect.log(`[Orchestrator] Starting standalone engine for '${marketId}' (${mktConfig.displayName})`);

      const standaloneEngine = yield* createStandaloneMarketEngine(mktConfig, {
        config,
        orderService,
        polyClient,
        eventBus,
        fillSimulator,
        positionSizer,
        incidentStore,
        observability,
      }).pipe(
        Effect.catchAll((err) => {
          return Effect.logError(`[Orchestrator] Failed to start '${marketId}' engine: ${err}`).pipe(
            Effect.as(null as MarketEngineInstance | null),
          );
        }),
      );

      if (standaloneEngine) {
        engines.set(marketId, standaloneEngine);
        yield* Effect.log(`[Orchestrator] '${marketId}' (${mktConfig.displayName}) engine ready`);
      }
    }

    const getEngine = (marketId: string) => engines.get(marketId) ?? null;
    const getAllEngines = () => [...engines.values()];
    const getEnabledMarketIds = () => [...engines.keys()];
    const getEnabledMarkets = () =>
      getEnabledMarketIds().map((id) => {
        const cfg = getMarketConfig(id);
        return { id, displayName: cfg?.displayName ?? id.toUpperCase() };
      });

    return {
      getEngine,
      getAllEngines,
      getEnabledMarketIds,
      getEnabledMarkets,
    } as const;
  }),
}) {}

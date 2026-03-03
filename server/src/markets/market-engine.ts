import { Effect, Scope } from "effect";
import type {
  MarketWindow,
  OrderBookState,
  StrategyState,
  TradeRecord,
  RegimeState,
  RiskSnapshot,
  KillSwitchStatus,
  EngineMetrics,
  TradingMode,
  PnLSummary,
} from "../types.js";
import type { FeedHealthSnapshot } from "../types.js";
import type { MarketFeedInstance } from "../feeds/market-feed-manager.js";
import type { TradeListQuery, TradeListResult } from "../engine/tracker.js";

/**
 * Uniform interface for a per-market engine instance.
 * Error channels use `unknown` to accommodate different backing implementations
 * (e.g. singleton TradingEngine with PlatformError vs. future standalone engines).
 */
export interface MarketEngineInstance {
  readonly marketId: string;
  readonly displayName: string;
  readonly feedManager: MarketFeedInstance;
  readonly getStrategyStates: Effect.Effect<ReadonlyArray<StrategyState>, unknown>;
  readonly getOrderBookState: Effect.Effect<OrderBookState>;
  readonly getCurrentWindow: Effect.Effect<MarketWindow | null>;
  readonly getWindowTitle: Effect.Effect<string>;
  readonly isTradingActive: Effect.Effect<boolean>;
  readonly setTradingActive: (active: boolean) => Effect.Effect<void>;
  readonly getMode: Effect.Effect<TradingMode>;
  readonly setMode: (mode: TradingMode) => Effect.Effect<void, unknown>;
  readonly getRegime: Effect.Effect<RegimeState>;
  readonly getRiskSnapshot: Effect.Effect<RiskSnapshot>;
  readonly getKillSwitchStatus: Effect.Effect<ReadonlyArray<KillSwitchStatus>>;
  readonly resetKillSwitchPause: Effect.Effect<void, unknown>;
  readonly getMetrics: Effect.Effect<EngineMetrics, unknown>;
  readonly toggleStrategy: (name: string) => Effect.Effect<boolean, unknown>;
  readonly updateStrategyConfig: (name: string, cfg: Record<string, unknown>) => Effect.Effect<any, unknown>;
  readonly updateStrategyRegimeFilter: (name: string, filter: Record<string, unknown>) => Effect.Effect<any, unknown>;
  readonly listTrades: (query: TradeListQuery) => Effect.Effect<TradeListResult, unknown>;
  readonly getTradeRecords: (limit?: number) => Effect.Effect<ReadonlyArray<TradeRecord>, unknown>;
  readonly getPnLSummary: Effect.Effect<PnLSummary, unknown>;
  readonly getShadowPnLSummary: Effect.Effect<PnLSummary, unknown>;
  readonly getFeedHealth: Effect.Effect<FeedHealthSnapshot>;
}

import { Schema } from "effect";

// ── Primitives ──

export type Side = "UP" | "DOWN";
export type TradingMode = "live" | "shadow";
export type TradeStatus = "pending" | "submitted" | "partial" | "filled" | "cancelled" | "rejected" | "expired" | "resolved";
export type TradeOutcome = "win" | "loss";
export type ResolutionSource = "venue" | "estimated";
export type TradeEventType =
  | "signal_generated"
  | "order_submitted"
  | "order_rejected"
  | "partial_fill"
  | "fill"
  | "cancel"
  | "hedge_submitted"
  | "hedge_filled"
  | "expired"
  | "resolved";

// ── Core data types ──

export interface PricePoint {
  exchange: string;
  price: number;
  timestamp: number;
  bid?: number;
  ask?: number;
}

export interface MarketWindow {
  conditionId: string;
  slug: string;
  title?: string;
  polymarketUrl?: string;
  upTokenId: string;
  downTokenId: string;
  startTime: number;
  endTime: number;
  priceToBeat: number | null;
  resolved: boolean;
}

export interface OrderBookEntry {
  price: number;
  size: number;
}

export interface OrderBookSide {
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
}

export interface OrderBookState {
  up: OrderBookSide;
  down: OrderBookSide;
  bestAskUp: number | null;
  bestAskDown: number | null;
  bestBidUp: number | null;
  bestBidDown: number | null;
}

export interface SignalTelemetry {
  dynamicWindowSec?: number;
  usedDynamicWindow?: boolean;
  earlyEntry?: boolean;
  reversalImprobability?: number;
}

export interface Signal {
  side: Side;
  confidence: number;
  size: number;
  maxPrice: number;
  strategy: string;
  reason: string;
  timestamp: number;
  telemetry?: SignalTelemetry;
}

export interface TradeRecord {
  id: string;
  strategy: string;
  side: Side;
  tokenId: string;
  entryPrice: number;
  size: number;
  shares: number;
  fee: number;
  status: TradeStatus;
  outcome: TradeOutcome | null;
  resolutionSource?: ResolutionSource;
  settlementWinnerSide?: Side | null;
  pnl: number;
  timestamp: number;
  windowEnd: number;
  shadow?: boolean;
  conditionId: string;
  priceToBeatAtEntry: number;
  closingBtcPrice?: number;
  lastEventType?: TradeEventType;
  clobOrderId?: string;
  clobResult?: string;
  clobReason?: string;
  entryContext?: EntryContext;
}

// ── Trade entry context (captured at signal acceptance for analysis) ──

export interface EntryContext {
  strategyName: string;
  mode: TradingMode;

  regime: RegimeState;
  strategyConfig: Record<string, number>;
  regimeFilter: RegimeFilter;

  signal: {
    side: Side;
    confidence: number;
    reason: string;
    maxPrice: number;
    timestamp: number;
    telemetry?: SignalTelemetry;
  };

  window: {
    conditionId: string;
    windowStart: number;
    windowEnd: number;
    priceToBeat: number | null;
  };

  microstructure: {
    bestAskUp: number | null;
    bestAskDown: number | null;
    bestBidUp: number | null;
    bestBidDown: number | null;
    oracleEstimate: number;
    currentBtcPrice: number;
  };

  riskAtEntry: {
    openPositions: number;
    openExposure: number;
    dailyPnl: number;
    hourlyPnl: number;
    consecutiveLosses: number;
  };

  sizing: {
    configuredTradeSize: number;
    computedSize: number;
    finalNotional: number;
  };
}

// ── Event-sourced trade types ──

export interface TradeEvent {
  id: string;
  tradeId: string;
  type: TradeEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface Trade {
  id: string;
  conditionId: string;
  strategy: string;
  side: Side;
  tokenId: string;
  priceToBeatAtEntry: number;
  windowEnd: number;
  shadow: boolean;
  events: TradeEvent[];
  status: TradeStatus;
  filledShares: number;
  avgFillPrice: number;
  requestedShares: number;
  totalFees: number;
  size: number;
  pnl: number;
  outcome: TradeOutcome | null;
  resolutionSource?: ResolutionSource;
  settlementWinnerSide?: Side | null;
  closingBtcPrice?: number;
  clobOrderId?: string;
  clobResult?: string;
  clobReason?: string;
  entryContext?: EntryContext;
}

// ── Regime types ──

export interface RegimeState {
  volatilityRegime: "low" | "normal" | "high" | "extreme";
  trendRegime: "strong_up" | "up" | "chop" | "down" | "strong_down";
  liquidityRegime: "thin" | "normal" | "deep";
  spreadRegime: "tight" | "normal" | "wide" | "blowout";
  volatilityValue?: number;
  trendStrength?: number;
  liquidityDepth?: number;
  spreadValue?: number;
}

export interface RegimeFilter {
  allowedVolatility?: RegimeState["volatilityRegime"][];
  allowedTrend?: RegimeState["trendRegime"][];
  allowedLiquidity?: RegimeState["liquidityRegime"][];
  allowedSpread?: RegimeState["spreadRegime"][];
}

// ── Strategy types ──

export interface StrategyState {
  name: string;
  enabled: boolean;
  status: "idle" | "watching" | "trading" | "regime_blocked";
  statusReason?: string | null;
  lastSignal: Signal | null;
  config: Record<string, number>;
  wins: number;
  losses: number;
  totalPnl: number;
  regimeBlockReason?: string | null;
  regimeFilter: RegimeFilter;
}

// ── PnL types ──

export interface PnLSummary {
  totalPnl: number;
  todayPnl: number;
  totalTrades: number;
  winRate: number;
  byStrategy: Record<string, { pnl: number; trades: number; winRate: number }>;
  history: Array<{ timestamp: number; cumulativePnl: number }>;
}

// ── Diagnostics / Metrics ──

export interface StrategyDiagnostics {
  signals: number;
  riskRejected: number;
  liveRejected: number;
  dynamicWindowUsed: number;
  earlyEntryAccepted: number;
  earlyEntryRejected: number;
  probabilityRejected: number;
  submitted: number;
  queueMiss: number;
  liquidityFail: number;
  lowFillCancel: number;
  partialFill: number;
  fullFill: number;
  wins: number;
  losses: number;
}

export interface LatencyMetrics {
  lastSignalToSubmitMs: number;
  avgSignalToSubmitMs: number;
  avgRecentSignalToSubmitMs: number;
  samples: number;
  lastSampleAt: number;
  priceDataAgeMs: number;
  orderbookAgeMs: number;
}

export interface ReconciliationStrategyMetrics {
  strategy: string;
  liveSignals: number;
  shadowSignals: number;
  liveSubmitted: number;
  shadowSubmitted: number;
  liveFillRate: number;
  shadowFillRate: number;
  liveRejectRate: number;
  shadowRejectRate: number;
  liveWinRate: number;
  shadowWinRate: number;
  livePnl: number;
  shadowPnl: number;
  signalDelta: number;
  fillRateDelta: number;
  pnlDelta: number;
}

export interface ReconciliationMetrics {
  updatedAt: number;
  liveTotalTrades: number;
  shadowTotalTrades: number;
  liveWinRate: number;
  shadowWinRate: number;
  liveTotalPnl: number;
  shadowTotalPnl: number;
  strategies: ReconciliationStrategyMetrics[];
}

export interface EngineMetrics {
  windowConditionId: string | null;
  rolling: Record<string, StrategyDiagnostics>;
  window: Record<string, StrategyDiagnostics>;
  latency: LatencyMetrics;
  reconciliation: ReconciliationMetrics;
}

// ── Feed health ──

export interface FeedSourceHealth {
  name: string;
  connected: boolean;
  status: "healthy" | "stale" | "down";
  lastUpdateTs: number | null;
  ageMs: number | null;
  price: number | null;
  bid: number | null;
  ask: number | null;
}

export interface FeedHealthSnapshot {
  sources: FeedSourceHealth[];
  healthyCount: number;
  staleCount: number;
  downCount: number;
  oracleEstimate: number;
  oracleSourceCount: number;
  updatedAt: number;
}

// ── Risk ──

export interface KillSwitchStatus {
  name: string;
  active: boolean;
  reason: string;
}

export interface RiskSnapshot {
  openPositions: number;
  maxConcurrentPositions: number;
  openExposure: number;
  maxTotalExposure: number;
  dailyPnl: number;
  maxDailyLoss: number;
  hourlyPnl: number;
  maxHourlyLoss: number;
  consecutiveLosses: number;
  maxConsecutiveLosses: number;
  windowLosses: number;
  maxLossPerWindow: number;
  pauseRemainingSec: number;
}

// ── Critical incidents ──

export type CriticalIncidentKind =
  | "unmatched_account_fill"
  | "oversize_account_fill"
  | "efficiency_partial_incident"
  | "reconciler_error";

export interface CriticalIncident {
  id: string;
  kind: CriticalIncidentKind;
  severity: "critical";
  message: string;
  fingerprint: string;
  details: Record<string, unknown>;
  createdAt: number;
  resolvedAt: number | null;
}

// ── Market context ──

export interface MarketContext {
  currentWindow: MarketWindow | null;
  orderBook: OrderBookState;
  prices: Record<string, PricePoint>;
  oracleEstimate: number;
  oracleTimestamp: number;
  windowElapsedMs: number;
  windowRemainingMs: number;
  priceToBeat: number | null;
  currentBtcPrice: number;
}

// ── WebSocket types ──

export type WSMessageType =
  | "prices"
  | "market"
  | "orderbook"
  | "strategies"
  | "trade"
  | "pnl"
  | "shadowPnl"
  | "status"
  | "tradingActive"
  | "mode"
  | "regime"
  | "killswitch"
  | "metrics"
  | "feedHealth"
  | "exchangeStatus"
  | "risk"
  | "criticalIncident"
  | "error";

export interface WSMessage {
  type: WSMessageType;
  data: unknown;
  timestamp: number;
}

export interface WSStatusSnapshot {
  tradingActive: boolean;
  mode: TradingMode;
  exchangeConnected: boolean;
  walletAddress: string | null;
  strategies: ReadonlyArray<StrategyState>;
  market: MarketWindow | null;
  orderbook: OrderBookState;
  prices: Record<string, PricePoint>;
  oracleEstimate: number;
  feedHealth: FeedHealthSnapshot;
  pnl: PnLSummary;
  shadowPnl: PnLSummary;
  trades: ReadonlyArray<TradeRecord>;
  regime: RegimeState;
  killSwitches: ReadonlyArray<KillSwitchStatus>;
  risk: RiskSnapshot;
  metrics: EngineMetrics;
}

// ── Notes ──

export interface NotesPayload {
  text: string;
  updatedAt: number;
}

// ── Risk approval ──

export interface RiskApproval {
  readonly approved: boolean;
  readonly reason: string;
}

// ── Engine event bus ──

export type EngineEvent =
  | { readonly _tag: "Market"; readonly data: MarketWindow }
  | { readonly _tag: "OrderBook"; readonly data: OrderBookState }
  | { readonly _tag: "Strategies"; readonly data: ReadonlyArray<StrategyState> }
  | { readonly _tag: "Trade"; readonly data: TradeRecord }
  | { readonly _tag: "Pnl"; readonly data: PnLSummary }
  | { readonly _tag: "ShadowPnl"; readonly data: PnLSummary }
  | { readonly _tag: "KillSwitch"; readonly data: ReadonlyArray<KillSwitchStatus> }
  | { readonly _tag: "Risk"; readonly data: RiskSnapshot }
  | { readonly _tag: "TradingActive"; readonly data: { readonly tradingActive: boolean } }
  | { readonly _tag: "Mode"; readonly data: { readonly mode: TradingMode } }
  | { readonly _tag: "Regime"; readonly data: RegimeState }
  | { readonly _tag: "Metrics"; readonly data: EngineMetrics }
  | { readonly _tag: "CriticalIncident"; readonly data: CriticalIncident };

// ── Schema definitions for serialization boundaries ──

export const PricePointSchema = Schema.Struct({
  exchange: Schema.String,
  price: Schema.Number,
  timestamp: Schema.Number,
  bid: Schema.optional(Schema.Number),
  ask: Schema.optional(Schema.Number),
});

export const WSMessageSchema = Schema.Struct({
  type: Schema.String,
  data: Schema.Unknown,
  timestamp: Schema.Number,
});

export const NotesPayloadSchema = Schema.Struct({
  text: Schema.String,
  updatedAt: Schema.Number,
});

export const TradeEventSchema = Schema.Struct({
  id: Schema.String,
  tradeId: Schema.String,
  type: Schema.String,
  timestamp: Schema.Number,
  data: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});

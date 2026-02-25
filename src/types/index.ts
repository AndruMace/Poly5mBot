// ── Primitives ──

export type Side = "UP" | "DOWN";
export type TradingMode = "live" | "shadow";
export type TradeStatus = "pending" | "submitted" | "partial" | "filled" | "cancelled" | "expired" | "resolved";
export type TradeOutcome = "win" | "loss";
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

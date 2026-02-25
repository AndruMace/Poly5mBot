import { Rx } from "@effect-rx/rx";
import type {
  PricePoint,
  MarketWindow,
  OrderBookState,
  StrategyState,
  TradeRecord,
  PnLSummary,
  RegimeState,
  KillSwitchStatus,
  RiskSnapshot,
  EngineMetrics,
  FeedHealthSnapshot,
} from "../types/index.js";

export interface PriceHistory {
  exchange: string;
  price: number;
  time: number;
}

export const MAX_PRICE_HISTORY = 600;

export const emptyPnl: PnLSummary = {
  totalPnl: 0,
  todayPnl: 0,
  totalTrades: 0,
  winRate: 0,
  byStrategy: {},
  history: [],
};

export const emptyOrderBook: OrderBookState = {
  up: { bids: [], asks: [] },
  down: { bids: [], asks: [] },
  bestAskUp: null,
  bestAskDown: null,
  bestBidUp: null,
  bestBidDown: null,
};

export const defaultRegime: RegimeState = {
  volatilityRegime: "normal",
  trendRegime: "chop",
  liquidityRegime: "normal",
  spreadRegime: "normal",
  volatilityValue: 0,
  trendStrength: 0,
  liquidityDepth: 0,
  spreadValue: 0,
};

export const emptyMetrics: EngineMetrics = {
  windowConditionId: null,
  rolling: {},
  window: {},
  latency: {
    lastSignalToSubmitMs: 0,
    avgSignalToSubmitMs: 0,
    avgRecentSignalToSubmitMs: 0,
    samples: 0,
    lastSampleAt: 0,
    priceDataAgeMs: 0,
    orderbookAgeMs: 0,
  },
  reconciliation: {
    updatedAt: 0,
    liveTotalTrades: 0,
    shadowTotalTrades: 0,
    liveWinRate: 0,
    shadowWinRate: 0,
    liveTotalPnl: 0,
    shadowTotalPnl: 0,
    strategies: [],
  },
};

export const emptyFeedHealth: FeedHealthSnapshot = {
  sources: ["binance", "bybit", "coinbase", "kraken", "bitstamp", "okx"].map(
    (name) => ({
      name,
      connected: false,
      status: "down" as const,
      lastUpdateTs: null,
      ageMs: null,
      price: null,
      bid: null,
      ask: null,
    }),
  ),
  healthyCount: 0,
  staleCount: 0,
  downCount: 6,
  oracleEstimate: 0,
  oracleSourceCount: 0,
  updatedAt: 0,
};

export const emptyRisk: RiskSnapshot = {
  openPositions: 0,
  maxConcurrentPositions: 0,
  openExposure: 0,
  maxTotalExposure: 0,
  dailyPnl: 0,
  maxDailyLoss: 0,
  hourlyPnl: 0,
  maxHourlyLoss: 0,
  consecutiveLosses: 0,
  maxConsecutiveLosses: 0,
  windowLosses: 0,
  maxLossPerWindow: 0,
  pauseRemainingSec: 0,
};

// Writable Rx atoms
export const connectedRx = Rx.make(false);
export const exchangeConnectedRx = Rx.make(false);
export const walletAddressRx = Rx.make<string | null>(null);
export const tradingActiveRx = Rx.make(false);
export const modeRx = Rx.make<"live" | "shadow">("shadow");
export const pricesRx = Rx.make<Record<string, PricePoint>>({});
export const oracleEstimateRx = Rx.make(0);
export const priceHistoryRx = Rx.make<PriceHistory[]>([]);
export const currentMarketRx = Rx.make<MarketWindow | null>(null);
export const orderBookRx = Rx.make<OrderBookState>({ ...emptyOrderBook });
export const strategiesRx = Rx.make<StrategyState[]>([]);
export const tradesRx = Rx.make<TradeRecord[]>([]);
export const pnlRx = Rx.make<PnLSummary>({ ...emptyPnl });
export const shadowPnlRx = Rx.make<PnLSummary>({ ...emptyPnl });
export const regimeRx = Rx.make<RegimeState>({ ...defaultRegime });
export const killSwitchesRx = Rx.make<KillSwitchStatus[]>([]);
export const riskRx = Rx.make<RiskSnapshot>({ ...emptyRisk });
export const metricsRx = Rx.make<EngineMetrics>({ ...emptyMetrics });
export const feedHealthRx = Rx.make<FeedHealthSnapshot>({ ...emptyFeedHealth });

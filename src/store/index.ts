import { create } from "zustand";
import type {
  PricePoint,
  MarketWindow,
  OrderBookState,
  StrategyState,
  TradeRecord,
  PnLSummary,
  RegimeState,
  KillSwitchStatus,
  EngineMetrics,
  FeedHealthSnapshot,
} from "../types/index.js";

interface PriceHistory {
  exchange: string;
  price: number;
  time: number;
}

interface AppState {
  connected: boolean;
  exchangeConnected: boolean;
  walletAddress: string | null;
  tradingActive: boolean;
  mode: "live" | "shadow";

  prices: Record<string, PricePoint>;
  oracleEstimate: number;
  priceHistory: PriceHistory[];

  currentMarket: MarketWindow | null;

  orderBook: OrderBookState;

  strategies: StrategyState[];

  trades: TradeRecord[];

  pnl: PnLSummary;
  shadowPnl: PnLSummary;

  regime: RegimeState;
  killSwitches: KillSwitchStatus[];
  metrics: EngineMetrics;
  feedHealth: FeedHealthSnapshot;

  setConnected: (connected: boolean, wallet?: string | null) => void;
  setExchangeConnected: (connected: boolean, wallet?: string | null) => void;
  setTradingActive: (active: boolean) => void;
  setMode: (mode: "live" | "shadow") => void;
  setPrices: (
    prices: Record<string, PricePoint>,
    oracleEstimate: number,
  ) => void;
  setMarket: (market: MarketWindow) => void;
  setOrderBook: (ob: OrderBookState) => void;
  setStrategies: (strategies: StrategyState[]) => void;
  addTrade: (trade: TradeRecord) => void;
  setTrades: (trades: TradeRecord[]) => void;
  setPnl: (pnl: PnLSummary) => void;
  setShadowPnl: (pnl: PnLSummary) => void;
  setRegime: (regime: RegimeState) => void;
  setKillSwitches: (ks: KillSwitchStatus[]) => void;
  setMetrics: (m: EngineMetrics) => void;
  setFeedHealth: (f: FeedHealthSnapshot) => void;
  setInitialState: (data: any) => void;
}

const MAX_PRICE_HISTORY = 600;

const emptyPnl: PnLSummary = {
  totalPnl: 0,
  todayPnl: 0,
  totalTrades: 0,
  winRate: 0,
  byStrategy: {},
  history: [],
};

const emptyOrderBook: OrderBookState = {
  up: { bids: [], asks: [] },
  down: { bids: [], asks: [] },
  bestAskUp: null,
  bestAskDown: null,
  bestBidUp: null,
  bestBidDown: null,
};

const defaultRegime: RegimeState = {
  volatilityRegime: "normal",
  trendRegime: "chop",
  liquidityRegime: "normal",
  spreadRegime: "normal",
  volatilityValue: 0,
  trendStrength: 0,
  liquidityDepth: 0,
  spreadValue: 0,
};

const emptyMetrics: EngineMetrics = {
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

const emptyFeedHealth: FeedHealthSnapshot = {
  sources: [
    "binance",
    "bybit",
    "coinbase",
    "kraken",
    "bitstamp",
    "okx",
  ].map((name) => ({
    name,
    connected: false,
    status: "down",
    lastUpdateTs: null,
    ageMs: null,
    price: null,
    bid: null,
    ask: null,
  })),
  healthyCount: 0,
  staleCount: 0,
  downCount: 6,
  oracleEstimate: 0,
  oracleSourceCount: 0,
  updatedAt: 0,
};

export const useStore = create<AppState>((set) => ({
  connected: false,
  exchangeConnected: false,
  walletAddress: null,
  tradingActive: false,
  mode: "shadow",

  prices: {},
  oracleEstimate: 0,
  priceHistory: [],

  currentMarket: null,

  orderBook: emptyOrderBook,

  strategies: [],
  trades: [],
  pnl: { ...emptyPnl },
  shadowPnl: { ...emptyPnl },

  regime: { ...defaultRegime },
  killSwitches: [],
  metrics: { ...emptyMetrics },
  feedHealth: { ...emptyFeedHealth },

  setConnected: (connected, wallet) =>
    set({ connected, walletAddress: wallet ?? null }),

  setExchangeConnected: (exchangeConnected, wallet) =>
    set((state) => ({
      exchangeConnected,
      walletAddress: wallet ?? state.walletAddress,
    })),

  setTradingActive: (active) => set({ tradingActive: active }),

  setMode: (mode) => set({ mode }),

  setPrices: (prices, oracleEstimate) =>
    set((state) => {
      const validEstimate =
        oracleEstimate > 0 ? oracleEstimate : state.oracleEstimate;
      const newHistory = [...state.priceHistory];
      const now = Date.now();
      for (const [exchange, p] of Object.entries(prices)) {
        if (p.price > 0) {
          newHistory.push({ exchange, price: p.price, time: now });
        }
      }
      if (validEstimate > 0) {
        newHistory.push({ exchange: "oracle", price: validEstimate, time: now });
      }
      return {
        prices,
        oracleEstimate: validEstimate,
        priceHistory: newHistory.slice(-MAX_PRICE_HISTORY),
      };
    }),

  setMarket: (market) => set({ currentMarket: market }),

  setOrderBook: (ob) => set({ orderBook: ob }),

  setStrategies: (strategies) => set({ strategies }),

  addTrade: (trade) =>
    set((state) => ({
      trades: [trade, ...state.trades.filter((t) => t.id !== trade.id)].slice(
        0,
        200,
      ),
    })),

  setTrades: (trades) => set({ trades }),

  setPnl: (pnl) => set({ pnl }),

  setShadowPnl: (pnl) => set({ shadowPnl: pnl }),

  setRegime: (regime) =>
    set({
      regime: {
        ...defaultRegime,
        ...regime,
      },
    }),

  setKillSwitches: (killSwitches) => set({ killSwitches }),

  setMetrics: (metrics) =>
    set({
      metrics: {
        ...emptyMetrics,
        ...metrics,
      },
    }),

  setFeedHealth: (feedHealth) =>
    set({
      feedHealth: {
        ...emptyFeedHealth,
        ...feedHealth,
      },
    }),

  setInitialState: (data) =>
    set((state) => ({
      tradingActive: data.tradingActive ?? false,
      mode: data.mode ?? "shadow",
      exchangeConnected: data.exchangeConnected ?? false,
      walletAddress: data.walletAddress ?? state.walletAddress,
      strategies: data.strategies ?? [],
      currentMarket: data.market ?? null,
      orderBook: data.orderbook ?? emptyOrderBook,
      pnl: data.pnl ?? { ...emptyPnl },
      shadowPnl: data.shadowPnl ?? { ...emptyPnl },
      trades: data.trades ?? [],
      prices: data.prices ?? state.prices,
      oracleEstimate:
        data.oracleEstimate > 0
          ? data.oracleEstimate
          : state.oracleEstimate,
      regime: data.regime
        ? {
            ...defaultRegime,
            ...data.regime,
          }
        : { ...defaultRegime },
      killSwitches: data.killSwitches ?? [],
      metrics: data.metrics
        ? {
            ...emptyMetrics,
            ...data.metrics,
          }
        : { ...emptyMetrics },
      feedHealth: data.feedHealth
        ? {
            ...emptyFeedHealth,
            ...data.feedHealth,
          }
        : { ...emptyFeedHealth },
    })),
}));

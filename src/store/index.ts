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
  StorageHealthStatus,
  CriticalIncident,
  ObservabilityEvent,
} from "../types/index.js";

export const MAX_PNL_HISTORY = 300;

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
  windowSpend: 0,
  maxWindowSpend: 0,
  windowTradeCount: 0,
  maxWindowTrades: 0,
};

export const emptyStorageHealth: StorageHealthStatus = {
  backend: "file",
  enabled: false,
  ok: true,
};

export interface EnabledMarket {
  id: string;
  displayName: string;
}

export type WorkspaceDensity = "compact" | "comfortable";
export type WorkspaceSortField =
  | "symbol"
  | "pnl"
  | "todayPnl"
  | "winRate"
  | "risk"
  | "latency";

export interface WorkspaceLayoutPrefs {
  density: WorkspaceDensity;
  showFocusPanel: boolean;
  focusMarketId: string | null;
  query: string;
  riskOnly: boolean;
  sortBy: WorkspaceSortField;
  sortDir: "asc" | "desc";
}

/** Snapshot of one market's display state, used when switching tabs. */
export interface PerMarketSnapshot {
  tradingActive: boolean;
  mode: "live" | "shadow";
  strategies: StrategyState[];
  market: MarketWindow | null;
  orderbook: OrderBookState;
  prices: Record<string, PricePoint>;
  oracleEstimate: number;
  feedHealth: FeedHealthSnapshot;
  pnl: PnLSummary;
  shadowPnl: PnLSummary;
  trades: TradeRecord[];
  regime: RegimeState;
  killSwitches: KillSwitchStatus[];
  risk: RiskSnapshot;
  metrics: EngineMetrics;
}

// Writable Rx atoms — multi-market
export const activeMarketIdRx = Rx.make(
  new URLSearchParams(window.location.search).get("market") ?? "btc"
);
export const enabledMarketsRx = Rx.make<EnabledMarket[]>([{ id: "btc", displayName: "BTC" }]);
export const perMarketStateRx = Rx.keepAlive(Rx.make<Record<string, PerMarketSnapshot>>({}));
export const pinnedMarketsRx = Rx.make<string[]>([]);
export const workspaceLayoutPrefsRx = Rx.make<WorkspaceLayoutPrefs>({
  density: "comfortable",
  showFocusPanel: false,
  focusMarketId: null,
  query: "",
  riskOnly: false,
  sortBy: "pnl",
  sortDir: "desc",
});

export interface MarketListViewRow {
  marketId: string;
  displayName: string;
  pinned: boolean;
  tradingActive: boolean;
  mode: "live" | "shadow";
  latestPrice: number | null;
  upMid: number | null;
  downMid: number | null;
  totalPnl: number;
  todayPnl: number;
  winRate: number;
  riskScore: number;
  latencyMs: number;
  stale: boolean;
  volatilityRegime: string;
  trendRegime: string;
}

export const marketListViewRx = Rx.make((get: Rx.Context): MarketListViewRow[] => {
  const enabled = get(enabledMarketsRx);
  const perMarket = get(perMarketStateRx);
  const pinned = new Set(get(pinnedMarketsRx));

  return enabled.map((market) => {
    const snapshot = perMarket[market.id];
    const prices = snapshot?.prices ?? {};
    let latestPrice: number | null = null;
    let latestTs = 0;
    for (const point of Object.values(prices)) {
      if (point.price > 0 && point.timestamp > latestTs) {
        latestPrice = point.price;
        latestTs = point.timestamp;
      }
    }

    const orderbook = snapshot?.orderbook ?? emptyOrderBook;
    const upMid = orderbook.bestBidUp !== null && orderbook.bestAskUp !== null
      ? (orderbook.bestBidUp + orderbook.bestAskUp) / 2
      : null;
    const downMid = orderbook.bestBidDown !== null && orderbook.bestAskDown !== null
      ? (orderbook.bestBidDown + orderbook.bestAskDown) / 2
      : null;
    const feed = snapshot?.feedHealth ?? emptyFeedHealth;
    const pnl = snapshot?.pnl ?? emptyPnl;
    const risk = snapshot?.risk ?? emptyRisk;
    const regime = snapshot?.regime ?? defaultRegime;
    const metrics = snapshot?.metrics ?? emptyMetrics;
    const riskScore = Math.abs(risk.dailyPnl) + risk.openExposure + risk.windowSpend;

    return {
      marketId: market.id,
      displayName: market.displayName,
      pinned: pinned.has(market.id),
      tradingActive: snapshot?.tradingActive ?? false,
      mode: snapshot?.mode ?? "shadow",
      latestPrice,
      upMid,
      downMid,
      totalPnl: pnl.totalPnl ?? 0,
      todayPnl: pnl.todayPnl ?? 0,
      winRate: pnl.winRate ?? 0,
      riskScore,
      latencyMs: metrics.latency?.avgRecentSignalToSubmitMs ?? 0,
      stale: feed.staleCount > 0 || feed.sources.some((s) => s.status === "stale" || s.status === "down"),
      volatilityRegime: regime.volatilityRegime,
      trendRegime: regime.trendRegime,
    };
  });
});

function compareRows(a: MarketListViewRow, b: MarketListViewRow, sortBy: WorkspaceSortField): number {
  switch (sortBy) {
    case "symbol":
      return a.displayName.localeCompare(b.displayName);
    case "todayPnl":
      return a.todayPnl - b.todayPnl;
    case "winRate":
      return a.winRate - b.winRate;
    case "risk":
      return a.riskScore - b.riskScore;
    case "latency":
      return a.latencyMs - b.latencyMs;
    case "pnl":
    default:
      return a.totalPnl - b.totalPnl;
  }
}

export const marketComparisonRx = Rx.make((get: Rx.Context): MarketListViewRow[] => {
  const rows = [...get(marketListViewRx)];
  const prefs = get(workspaceLayoutPrefsRx);
  const query = prefs.query.trim().toLowerCase();
  const filtered = rows.filter((row) => {
    if (prefs.riskOnly && row.riskScore <= 0) return false;
    if (query.length > 0) {
      const text = `${row.marketId} ${row.displayName}`.toLowerCase();
      if (!text.includes(query)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const cmp = compareRows(a, b, prefs.sortBy);
    return prefs.sortDir === "asc" ? cmp : -cmp;
  });
  return filtered;
});

// Writable Rx atoms
export const connectedRx = Rx.make(false);
export const exchangeConnectedRx = Rx.make(false);
export const walletAddressRx = Rx.make<string | null>(null);
export const tradingActiveRx = Rx.make(false);
export const modeRx = Rx.make<"live" | "shadow">("shadow");
export const pricesRx = Rx.make<Record<string, PricePoint>>({});
export const currentMarketRx = Rx.make((get: Rx.Context) =>
  get(perMarketStateRx)[get(activeMarketIdRx)]?.market ?? null
);
export const orderBookRx = Rx.make<OrderBookState>({ ...emptyOrderBook });
export const strategiesRx = Rx.make<StrategyState[]>([]);
export const tradesRx = Rx.keepAlive(Rx.make<TradeRecord[]>([]));
export const pnlRx = Rx.make<PnLSummary>({ ...emptyPnl });
export const shadowPnlRx = Rx.make<PnLSummary>({ ...emptyPnl });
export const regimeRx = Rx.make<RegimeState>({ ...defaultRegime });
export const killSwitchesRx = Rx.make<KillSwitchStatus[]>([]);
export const riskRx = Rx.make<RiskSnapshot>({ ...emptyRisk });
export const metricsRx = Rx.make<EngineMetrics>({ ...emptyMetrics });
export const feedHealthRx = Rx.make<FeedHealthSnapshot>({ ...emptyFeedHealth });
export const storageHealthRx = Rx.make<StorageHealthStatus>({ ...emptyStorageHealth });
export const wsLastMessageTsRx = Rx.make(0);
export const incidentsRx = Rx.make<CriticalIncident[]>([]);
export const observabilityEventsRx = Rx.make<ObservabilityEvent[]>([]);

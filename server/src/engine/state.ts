import type {
  EngineMetrics,
  MarketContext,
  MarketWindow,
  OrderBookState,
  RegimeState,
  Signal,
  StrategyDiagnostics,
} from "../types.js";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function adjustMomentumMaxPrice(
  signal: Signal,
  regime: RegimeState,
  _ctx: MarketContext,
  config: Record<string, number>,
): number {
  const base = signal.maxPrice;
  if (signal.strategy !== "momentum") return base;

  let allowance = 0;
  const thinDiscount = (config["thinLiquidityDiscount"] as number | undefined) ?? 0.02;
  const blowoutDiscount = (config["blowoutSpreadDiscount"] as number | undefined) ?? 0.03;

  if (regime.liquidityRegime === "thin") allowance -= thinDiscount;
  if (regime.spreadRegime === "blowout") allowance -= blowoutDiscount;

  return Math.round(clamp(base + allowance, 0.5, base) * 1000) / 1000;
}

export function zeroDiagnostics(): StrategyDiagnostics {
  return {
    signals: 0,
    riskRejected: 0,
    liveRejected: 0,
    dynamicWindowUsed: 0,
    earlyEntryAccepted: 0,
    earlyEntryRejected: 0,
    probabilityRejected: 0,
    submitted: 0,
    queueMiss: 0,
    liquidityFail: 0,
    lowFillCancel: 0,
    partialFill: 0,
    fullFill: 0,
    wins: 0,
    losses: 0,
  };
}

export function emptyReconciliation(): EngineMetrics["reconciliation"] {
  return {
    updatedAt: 0,
    liveTotalTrades: 0,
    shadowTotalTrades: 0,
    liveWinRate: 0,
    shadowWinRate: 0,
    liveTotalPnl: 0,
    shadowTotalPnl: 0,
    strategies: [],
  };
}

export interface EngineState {
  currentWindow: MarketWindow | null;
  windowTitle: string;
  orderBook: OrderBookState;
  running: boolean;
  tradingActive: boolean;
  tickInFlight: boolean;
  mode: "live" | "shadow";
  regime: RegimeState;
  lastStrategyExecution: Map<string, number>;
  entriesThisWindow: Map<string, number>;
  lastOrderbookUpdateTs: number;
  windowEndPriceSnapshot: number | null;
  windowEndSnapshotTs: number;
  recentSignalLatencies: number[];
  windowDiagnostics: Record<string, StrategyDiagnostics>;
  rollingDiagnostics: Record<string, StrategyDiagnostics>;
  liveModeDiagnostics: Record<string, StrategyDiagnostics>;
  shadowModeDiagnostics: Record<string, StrategyDiagnostics>;
  metrics: EngineMetrics;
  lastPoll: number;
  lastReconcileAt: number;
  efficiencyIncidentBlocked: boolean;
}

export function initialEngineState(mode: "live" | "shadow"): EngineState {
  return {
    currentWindow: null,
    windowTitle: "",
    orderBook: {
      up: { bids: [], asks: [] },
      down: { bids: [], asks: [] },
      bestAskUp: null,
      bestAskDown: null,
      bestBidUp: null,
      bestBidDown: null,
    },
    running: false,
    tradingActive: false,
    tickInFlight: false,
    mode,
    regime: {
      volatilityRegime: "normal",
      trendRegime: "chop",
      liquidityRegime: "normal",
      spreadRegime: "normal",
      volatilityValue: 0,
      trendStrength: 0,
      liquidityDepth: 0,
      spreadValue: 0,
    },
    lastStrategyExecution: new Map(),
    entriesThisWindow: new Map(),
    lastOrderbookUpdateTs: 0,
    windowEndPriceSnapshot: null,
    windowEndSnapshotTs: 0,
    recentSignalLatencies: [],
    windowDiagnostics: {},
    rollingDiagnostics: {},
    liveModeDiagnostics: {},
    shadowModeDiagnostics: {},
    metrics: {
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
        ptbLookupLastMs: 0,
        ptbLookupAvgMs: 0,
        ptbLookupSamples: 0,
        ptbWindowToExactLastMs: 0,
        ptbWindowToExactAvgMs: 0,
        ptbWindowToExactSamples: 0,
      },
      reconciliation: emptyReconciliation(),
    },
    lastPoll: 0,
    lastReconcileAt: 0,
    efficiencyIncidentBlocked: false,
  };
}

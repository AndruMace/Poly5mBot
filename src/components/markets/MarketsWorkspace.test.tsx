import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { MarketsWorkspace } from "./MarketsWorkspace.js";
import { renderWithRegistry, type RegistryLike } from "../../test-utils/renderWithRegistry.js";
import {
  activeMarketIdRx,
  enabledMarketsRx,
  perMarketStateRx,
  workspaceLayoutPrefsRx,
  type PerMarketSnapshot,
} from "../../store/index.js";

function seedMarketState(registry: RegistryLike) {
  const baseSnapshot: PerMarketSnapshot = {
    tradingActive: false,
    mode: "shadow",
    strategies: [],
    market: null,
    orderbook: {
      up: { bids: [], asks: [] },
      down: { bids: [], asks: [] },
      bestAskUp: null,
      bestAskDown: null,
      bestBidUp: null,
      bestBidDown: null,
    },
    prices: {},
    oracleEstimate: 0,
    feedHealth: {
      sources: [],
      healthyCount: 0,
      staleCount: 0,
      downCount: 0,
      oracleEstimate: 0,
      oracleSourceCount: 0,
      updatedAt: 0,
    },
    pnl: {
      totalPnl: 0,
      todayPnl: 0,
      totalTrades: 0,
      winRate: 0,
      byStrategy: {},
      history: [],
    },
    shadowPnl: {
      totalPnl: 0,
      todayPnl: 0,
      totalTrades: 0,
      winRate: 0,
      byStrategy: {},
      history: [],
    },
    trades: [],
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
    killSwitches: [],
    risk: {
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
    },
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
    },
  };

  registry.set(enabledMarketsRx, [
    { id: "btc", displayName: "BTC" },
    { id: "eth-15m", displayName: "ETH 15m" },
    { id: "sol-15m", displayName: "SOL 15m" },
  ]);
  registry.set(activeMarketIdRx, "btc");
  registry.set(perMarketStateRx, {
    btc: baseSnapshot,
    "eth-15m": baseSnapshot,
    "sol-15m": baseSnapshot,
  });
  registry.set(workspaceLayoutPrefsRx, {
    density: "comfortable",
    showFocusPanel: false,
    focusMarketId: null,
    query: "",
    riskOnly: false,
    sortBy: "symbol",
    sortDir: "asc",
  });
}

describe("MarketsWorkspace", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders multi-market overview cards", () => {
    renderWithRegistry(<MarketsWorkspace />, seedMarketState);
    expect(screen.getByTestId("market-card-btc")).toBeInTheDocument();
    expect(screen.getByTestId("market-card-eth-15m")).toBeInTheDocument();
    expect(screen.getByTestId("market-card-sol-15m")).toBeInTheDocument();
  });

  it("filters cards by search query", () => {
    renderWithRegistry(<MarketsWorkspace />, seedMarketState);
    const search = screen.getByPlaceholderText(/search by symbol or market id/i);
    fireEvent.change(search, { target: { value: "eth" } });
    expect(screen.queryByTestId("market-card-btc")).not.toBeInTheDocument();
    expect(screen.getByTestId("market-card-eth-15m")).toBeInTheDocument();
  });

  it("syncs active market and toggles focus panel", () => {
    let registryRef: RegistryLike | undefined;
    renderWithRegistry(<MarketsWorkspace />, (registry) => {
      registryRef = registry;
      seedMarketState(registry);
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Select" })[1]!);
    expect(registryRef?.get(activeMarketIdRx)).toBe("eth-15m");

    fireEvent.click(screen.getAllByRole("button", { name: /focus/i })[1]!);
    expect(screen.getByTestId("focused-market-panel")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /close focus panel/i }));
    expect(screen.queryByTestId("focused-market-panel")).not.toBeInTheDocument();
  });
});

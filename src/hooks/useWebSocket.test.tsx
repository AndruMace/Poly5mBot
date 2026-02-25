import { act, render, screen } from "@testing-library/react";
import { useRxValue } from "@effect-rx/rx-react";
import { RegistryProvider } from "@effect-rx/rx-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWebSocket } from "./useWebSocket.js";
import {
  connectedRx,
  currentMarketRx,
  modeRx,
  tradesRx,
  tradingActiveRx,
  exchangeConnectedRx,
} from "../store/index.js";

function Probe() {
  useWebSocket();
  const connected = useRxValue(connectedRx);
  const tradingActive = useRxValue(tradingActiveRx);
  const mode = useRxValue(modeRx);
  const exchangeConnected = useRxValue(exchangeConnectedRx);
  const currentMarket = useRxValue(currentMarketRx);
  const trades = useRxValue(tradesRx);

  return (
    <div>
      <div data-testid="connected">{String(connected)}</div>
      <div data-testid="trading-active">{String(tradingActive)}</div>
      <div data-testid="mode">{mode}</div>
      <div data-testid="exchange">{String(exchangeConnected)}</div>
      <div data-testid="has-market">{String(currentMarket !== null)}</div>
      <div data-testid="trade-count">{trades.length}</div>
      <div data-testid="trade-pnl">{trades[0]?.pnl ?? -1}</div>
    </div>
  );
}

function getMockSocketClass() {
  return (globalThis as any).__MockWebSocket as {
    instances: Array<{
      onmessage?: (event: { data: string }) => void;
      close: () => void;
    }>;
  };
}

describe("useWebSocket", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    getMockSocketClass().instances.length = 0;
    if ("fetch" in globalThis) {
      fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("status endpoint unavailable in test"));
    }
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
    vi.useRealTimers();
  });

  it("hydrates UI state from status payload", async () => {
    render(
      <RegistryProvider>
        <Probe />
      </RegistryProvider>,
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(screen.getByTestId("connected")).toHaveTextContent("true");

    const ws = getMockSocketClass().instances[0];
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "status",
          timestamp: Date.now(),
          data: {
            tradingActive: true,
            mode: "live",
            exchangeConnected: true,
            walletAddress: "0xabc",
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
          },
        }),
      });
    });

    expect(screen.getByTestId("trading-active")).toHaveTextContent("true");
    expect(screen.getByTestId("mode")).toHaveTextContent("live");
    expect(screen.getByTestId("exchange")).toHaveTextContent("true");
  });

  it("dedupes trades and reconnects after disconnect", async () => {
    const rendered = render(
      <RegistryProvider>
        <Probe />
      </RegistryProvider>,
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });

    const ws = getMockSocketClass().instances[0];

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "trade",
          timestamp: Date.now(),
          data: {
            id: "trade-1",
            strategy: "arb",
            side: "UP",
            tokenId: "tok",
            entryPrice: 0.4,
            size: 10,
            shares: 25,
            fee: 0.1,
            status: "filled",
            outcome: null,
            pnl: 1,
            timestamp: Date.now(),
            windowEnd: Date.now() + 30_000,
            conditionId: "c-1",
            priceToBeatAtEntry: 100,
          },
        }),
      });

      ws.onmessage?.({
        data: JSON.stringify({
          type: "trade",
          timestamp: Date.now(),
          data: {
            id: "trade-1",
            strategy: "arb",
            side: "UP",
            tokenId: "tok",
            entryPrice: 0.4,
            size: 10,
            shares: 25,
            fee: 0.1,
            status: "resolved",
            outcome: "win",
            pnl: 2,
            timestamp: Date.now(),
            windowEnd: Date.now() + 30_000,
            conditionId: "c-1",
            priceToBeatAtEntry: 100,
          },
        }),
      });
    });

    act(() => {
      vi.advanceTimersByTime(140);
    });

    expect(screen.getByTestId("trade-count")).toHaveTextContent("1");
    expect(screen.getByTestId("trade-pnl")).toHaveTextContent("2");

    act(() => {
      ws.close();
      vi.advanceTimersByTime(3000);
    });

    expect(getMockSocketClass().instances.length).toBe(2);

    rendered.unmount();
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(getMockSocketClass().instances.length).toBe(2);
  });

  it("reconnects when tab resumes with stale websocket data", async () => {
    render(
      <RegistryProvider>
        <Probe />
      </RegistryProvider>,
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(getMockSocketClass().instances.length).toBe(1);

    act(() => {
      vi.advanceTimersByTime(9000);
      window.dispatchEvent(new Event("focus"));
      vi.runOnlyPendingTimers();
    });

    expect(getMockSocketClass().instances.length).toBe(2);
  });

  it("does not clear existing market when status payload market is null", async () => {
    render(
      <RegistryProvider>
        <Probe />
      </RegistryProvider>,
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });

    const ws = getMockSocketClass().instances[0];
    const now = Date.now();

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "market",
          timestamp: now,
          data: {
            conditionId: "c-123",
            title: "BTC Up or Down - 5m",
            startTime: now - 30_000,
            endTime: now + 270_000,
            upTokenId: "up",
            downTokenId: "down",
            priceToBeat: 100_000,
            polymarketUrl: "https://example.com",
          },
        }),
      });
    });
    expect(screen.getByTestId("has-market")).toHaveTextContent("true");

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "status",
          timestamp: now + 1,
          data: {
            tradingActive: false,
            mode: "shadow",
            exchangeConnected: false,
            walletAddress: null,
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
          },
        }),
      });
    });

    expect(screen.getByTestId("has-market")).toHaveTextContent("true");
  });
});

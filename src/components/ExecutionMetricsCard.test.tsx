import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExecutionMetricsCard } from "./ExecutionMetricsCard.js";
import { metricsRx } from "../store/index.js";
import { renderWithRegistry } from "../test-utils/renderWithRegistry.js";

describe("ExecutionMetricsCard", () => {
  it("renders latency and reconciliation rows", () => {
    renderWithRegistry(<ExecutionMetricsCard />, (registry) => {
      registry.set(metricsRx, {
        windowConditionId: "w1",
        rolling: {},
        window: {
          arb: {
            signals: 10,
            riskRejected: 1,
            liveRejected: 2,
            dynamicWindowUsed: 3,
            earlyEntryAccepted: 4,
            earlyEntryRejected: 1,
            probabilityRejected: 1,
            submitted: 7,
            queueMiss: 0,
            liquidityFail: 0,
            partialFill: 1,
            fullFill: 6,
            wins: 5,
            losses: 2,
          },
        },
        latency: {
          lastSignalToSubmitMs: 120,
          avgSignalToSubmitMs: 80,
          avgRecentSignalToSubmitMs: 70,
          samples: 9,
          lastSampleAt: Date.now(),
          priceDataAgeMs: 20,
          orderbookAgeMs: 35,
        },
        reconciliation: {
          updatedAt: Date.now(),
          liveTotalTrades: 6,
          shadowTotalTrades: 8,
          liveWinRate: 50,
          shadowWinRate: 60,
          liveTotalPnl: 12,
          shadowTotalPnl: 15,
          strategies: [
            {
              strategy: "arb",
              liveSignals: 10,
              shadowSignals: 11,
              liveSubmitted: 7,
              shadowSubmitted: 8,
              liveFillRate: 0.71,
              shadowFillRate: 0.72,
              liveRejectRate: 0.1,
              shadowRejectRate: 0.08,
              livePnl: 6,
              shadowPnl: 7,
              signalDelta: -1,
              fillRateDelta: -0.01,
              pnlDelta: -1,
            },
          ],
        },
      });
    });

    expect(screen.getByText(/execution metrics/i)).toBeInTheDocument();
    expect(screen.getByText(/last signal→submit/i)).toBeInTheDocument();
    expect(screen.getAllByText(/arbitrage/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/trades \(l\/s\)/i)).toBeInTheDocument();
  });
});

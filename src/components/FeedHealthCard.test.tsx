import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FeedHealthCard } from "./FeedHealthCard.js";
import { feedHealthRx } from "../store/index.js";
import { renderWithRegistry } from "../test-utils/renderWithRegistry.js";

describe("FeedHealthCard", () => {
  it("renders source statuses and confidence label", () => {
    renderWithRegistry(<FeedHealthCard />, (registry) => {
      registry.set(feedHealthRx, {
        sources: [
          {
            name: "binance",
            connected: true,
            status: "healthy",
            lastUpdateTs: Date.now(),
            ageMs: 300,
            price: 110000,
            bid: 109990,
            ask: 110010,
          },
          {
            name: "kraken",
            connected: true,
            status: "stale",
            lastUpdateTs: Date.now() - 2200,
            ageMs: 2200,
            price: 110001,
            bid: 109991,
            ask: 110011,
          },
          {
            name: "okx",
            connected: false,
            status: "down",
            lastUpdateTs: null,
            ageMs: null,
            price: null,
            bid: null,
            ask: null,
          },
        ],
        healthyCount: 5,
        staleCount: 0,
        downCount: 1,
        oracleEstimate: 110000,
        oracleSourceCount: 5,
        updatedAt: Date.now(),
      });
    });

    expect(screen.getByText(/feed health/i)).toBeInTheDocument();
    expect(screen.getByText(/high confidence/i)).toBeInTheDocument();
    expect(screen.getByText(/binance/i)).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: /healthy/i })).toBeInTheDocument();
  });
});

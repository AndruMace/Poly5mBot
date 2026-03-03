import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrategyPanel } from "./StrategyPanel.js";
import { renderWithRegistry } from "../test-utils/renderWithRegistry.js";
import { strategiesRx } from "../store/index.js";

vi.mock("./StrategyCard.js", () => ({
  StrategyCard: ({ strategy, onToggle, onConfigChange, onRegimeFilterChange }: any) => (
    <div data-testid={`strategy-${strategy.name}`}>
      <span>{strategy.name}</span>
      <button onClick={onToggle}>toggle-{strategy.name}</button>
      <button onClick={() => onConfigChange({ tradeSize: 42 })}>config-{strategy.name}</button>
      <button
        onClick={() =>
          onRegimeFilterChange({ allowedSpread: ["normal", "tight"] })
        }
      >
        regime-{strategy.name}
      </button>
    </div>
  ),
}));

describe("StrategyPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows empty-state guidance when strategies are unavailable", () => {
    renderWithRegistry(<StrategyPanel />);
    expect(
      screen.getByText(/connect to the backend to view and manage strategies/i),
    ).toBeInTheDocument();
  });

  it("posts toggle/config/filter updates and refreshes strategy list", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/strategies?")) {
        return Promise.resolve({
          ok: true,
          json: async () => [],
        } as Response);
      }
      return Promise.resolve({ ok: true } as Response);
      });

    renderWithRegistry(<StrategyPanel />, (registry) => {
      registry.set(strategiesRx, [
        {
          name: "arb",
          enabled: true,
          status: "watching",
          statusReason: null,
          lastSignal: null,
          config: { tradeSize: 10 },
          wins: 0,
          losses: 0,
          totalPnl: 0,
          regimeFilter: {},
        },
      ]);
    });

    fireEvent.click(screen.getByText("toggle-arb"));
    fireEvent.click(screen.getByText("config-arb"));
    fireEvent.click(screen.getByText("regime-arb"));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });

    expect(fetchSpy).toHaveBeenCalledWith("/api/strategies/btc/arb/toggle", {
      method: "POST",
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/strategies/btc/arb/config",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/strategies/btc/arb/regime-filter",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchSpy).toHaveBeenCalledWith("/api/strategies?marketId=btc");
  });
});

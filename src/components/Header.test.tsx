import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Header } from "./Header.js";
import { renderWithRegistry } from "../test-utils/renderWithRegistry.js";
import {
  pricesRx,
  walletAddressRx,
  connectedRx,
  exchangeConnectedRx,
} from "../store/index.js";

describe("Header", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders connection state and latest price", () => {
    renderWithRegistry(<Header />, (registry) => {
      registry.set(connectedRx, true);
      registry.set(exchangeConnectedRx, true);
      registry.set(walletAddressRx, "0x1234567890abcdef");
      registry.set(pricesRx, {
        binance: {
          exchange: "binance",
          price: 110_000,
          timestamp: Date.now(),
        },
      });
    });

    expect(screen.getByText("WS")).toBeInTheDocument();
    expect(screen.getByText("CLOB")).toBeInTheDocument();
    expect(screen.getByText("DB N/A")).toBeInTheDocument();
    expect(screen.getByText(/0x1234...cdef/i)).toBeInTheDocument();
    expect(screen.getByText(/\$110,000.00/)).toBeInTheDocument();
  });

  it("calls trading and mode endpoints", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true } as Response);

    renderWithRegistry(<Header />);

    fireEvent.click(screen.getByRole("button", { name: /shadow/i }));
    fireEvent.click(screen.getByRole("button", { name: /start trading/i }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/mode",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/trading/toggle",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

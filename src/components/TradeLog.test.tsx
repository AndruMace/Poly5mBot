import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TradeLog } from "./TradeLog.js";
import { tradesRx } from "../store/index.js";
import { renderWithRegistry } from "../test-utils/renderWithRegistry.js";

vi.mock("./PnLCard.js", () => ({
  PnLCard: () => <div data-testid="pnl-card">PnL</div>,
}));

describe("TradeLog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("loads paged trades and exports csv via backend endpoint", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/trades?")) {
          return {
            ok: true,
            json: async () => ({
              items: [
                {
                  id: "t-1",
                  strategy: "arb",
                  side: "UP",
                  tokenId: "tok",
                  entryPrice: 0.45,
                  size: 10,
                  shares: 22.2,
                  fee: 0.1,
                  status: "resolved",
                  outcome: "loss",
                  pnl: -1,
                  timestamp: Date.now(),
                  windowEnd: Date.now() + 30_000,
                  shadow: false,
                  conditionId: "c-1",
                  priceToBeatAtEntry: 100,
                  clobResult: "accepted",
                },
              ],
              nextCursor: null,
              hasMore: false,
              limit: 100,
              mode: "all",
              timeframe: "30d",
            }),
          } as any;
        }
        if (url.includes("/api/trades/export.csv")) {
          return {
            ok: true,
            blob: async () => new Blob(["id\n1"], { type: "text/csv" }),
          } as any;
        }
        return { ok: false, status: 404 } as any;
      });

    let exportedBlob: Blob | null = null;
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
      exportedBlob = blob as Blob;
      return "blob:trade-log";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const clickSpy = vi.fn();
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      if (tagName === "a") {
        return { href: "", download: "", click: clickSpy } as any;
      }
      return originalCreateElement(tagName);
    });

    renderWithRegistry(<TradeLog />, (registry) => {
      registry.set(tradesRx, []);
    });

    expect(await screen.findByText(/1 trades/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /export csv/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/trades/export.csv"),
      ),
    );
    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
    expect(exportedBlob).not.toBeNull();
  });
});

import { fireEvent, screen } from "@testing-library/react";
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

  it("filters trades and exports csv with formula-safe cells", async () => {
    const RealBlob = globalThis.Blob;
    class MockBlob {
      private readonly content: string;
      constructor(parts: any[]) {
        this.content = parts.map((p) => String(p)).join("");
      }
      async text() {
        return this.content;
      }
    }
    (globalThis as any).Blob = MockBlob;

    try {
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
        registry.set(tradesRx, [
          {
            id: "=danger",
            strategy: "=SUM(1,1)",
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
        ]);
      });

      fireEvent.click(screen.getByRole("button", { name: /live/i }));
      expect(screen.getByText(/1 trades/i)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /export csv/i }));

      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(exportedBlob).not.toBeNull();

      const csv = await (exportedBlob as any).text();
      expect(csv).toContain("\"'=danger\"");
      expect(csv).toContain("\"'=SUM(1,1)\"");
    } finally {
      (globalThis as any).Blob = RealBlob;
    }
  });
});

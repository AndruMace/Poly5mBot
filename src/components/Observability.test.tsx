import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Observability } from "./Observability.js";
import { observabilityEventsRx } from "../store/index.js";
import { renderWithRegistry } from "../test-utils/renderWithRegistry.js";

describe("Observability", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("loads events and metrics, then supports filter save", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/observability/events?")) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                eventId: "obs-1",
                timestamp: Date.now(),
                category: "signal",
                source: "engine",
                action: "signal_generated",
                entityType: "signal",
                entityId: "arb:1",
                status: "generated",
                strategy: "arb",
                mode: "live",
                searchText: "signal_generated",
                payload: {},
              },
            ],
            nextCursor: null,
            hasMore: false,
            limit: 200,
          }),
        } as any;
      }
      if (url.includes("/api/observability/metrics?")) {
        return {
          ok: true,
          json: async () => ({
            total: 1,
            byCategory: [{ category: "signal", count: 1 }],
            byStatus: [{ status: "generated", count: 1 }],
          }),
        } as any;
      }
      if (url.includes("/api/incidents?")) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: "inc-1",
                kind: "efficiency_partial_incident",
                severity: "critical",
                message: "Efficiency dual-leg incident detected.",
                fingerprint: "fp-1",
                details: { conditionId: "abc" },
                createdAt: Date.now(),
                resolvedAt: null,
              },
            ],
          }),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    });

    vi.spyOn(window, "prompt").mockReturnValue("Signals");

    renderWithRegistry(<Observability />, (registry) => {
      registry.set(observabilityEventsRx, []);
    });

    expect(await screen.findByText(/observability & data discovery/i)).toBeTruthy();
    expect(await screen.findByText(/signal_generated/i)).toBeTruthy();
    expect(await screen.findByText(/^Total$/)).toBeTruthy();
    expect(await screen.findByText(/critical incidents/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Signals" })).toBeTruthy());
  });
});

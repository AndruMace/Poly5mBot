import { describe, expect, it } from "vitest";
import { Effect, Ref } from "effect";
import { makeMarketPoller } from "../../src/engine/window-manager.js";
import { initialEngineState } from "../../src/engine/state.js";
import type { MarketWindow } from "../../src/types.js";

describe("window manager PTB behavior", () => {
  it("keeps priceToBeat unavailable when market window has no exact PTB", async () => {
    const stateRef = await Effect.runPromise(Ref.make(initialEngineState("shadow")));
    const sampleWindow: MarketWindow = {
      conditionId: "cond-1",
      slug: "btc-updown-5m-123",
      title: "Test Window",
      polymarketUrl: "https://polymarket.com/event/btc-updown-5m-123",
      upTokenId: "up",
      downTokenId: "down",
      startTime: Date.now() - 60_000,
      endTime: Date.now() + 120_000,
      priceToBeat: null,
      priceToBeatStatus: "unavailable",
      priceToBeatSource: "unavailable",
      priceToBeatReason: "ptb_not_found_in_page",
      resolved: false,
    };

    const emitted: MarketWindow[] = [];
    const poll = makeMarketPoller({
      stateRef,
      strategies: [{ name: "momentum" } as any],
      fetchCurrentWindow: Effect.succeed(sampleWindow),
      isConnected: Effect.succeed(false),
      onNewWindow: () => Effect.void,
      emit: (event) => {
        if (event._tag === "Market") emitted.push(event.data);
        return Effect.void;
      },
      obs: () => Effect.void,
      refreshOrderBook: () => Effect.void,
      formatWindowTitle: (w) => w.title ?? "Window",
      logPrefix: "[Engine:test]",
    });

    await Effect.runPromise(poll);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.priceToBeat).toBe(null);
    expect(emitted[0]?.priceToBeatStatus).toBe("unavailable");
    expect(emitted[0]?.priceToBeatSource).toBe("unavailable");
  });

  it("records PTB resolution latency when an existing window resolves", async () => {
    const stateRef = await Effect.runPromise(Ref.make(initialEngineState("shadow")));
    const startTime = Date.now() - 30_000;
    const endTime = Date.now() + 120_000;
    let callCount = 0;
    const unresolved: MarketWindow = {
      conditionId: "cond-lat",
      slug: "btc-updown-5m-lat",
      title: "Latency Window",
      polymarketUrl: "https://polymarket.com/event/btc-updown-5m-lat",
      upTokenId: "up",
      downTokenId: "down",
      startTime,
      endTime,
      priceToBeat: null,
      priceToBeatStatus: "unavailable",
      priceToBeatSource: "unavailable",
      priceToBeatReason: "ptb_not_found_in_page",
      resolved: false,
    };
    const resolved: MarketWindow = {
      ...unresolved,
      priceToBeat: 68000.12,
      priceToBeatStatus: "exact",
      priceToBeatSource: "polymarket_page_json",
    };
    const poll = makeMarketPoller({
      stateRef,
      strategies: [{ name: "momentum" } as any],
      fetchCurrentWindow: Effect.sync(() => {
        callCount += 1;
        return callCount < 2 ? unresolved : resolved;
      }),
      isConnected: Effect.succeed(false),
      onNewWindow: () => Effect.void,
      emit: () => Effect.void,
      obs: () => Effect.void,
      refreshOrderBook: () => Effect.void,
      formatWindowTitle: (w) => w.title ?? "Window",
      logPrefix: "[Engine:test]",
    });

    await Effect.runPromise(poll);
    await Effect.runPromise(poll);
    const state = await Effect.runPromise(Ref.get(stateRef));
    expect(state.currentWindow?.priceToBeat).toBe(68000.12);
    expect(state.metrics.latency.ptbWindowToExactSamples).toBe(1);
    expect((state.metrics.latency.ptbWindowToExactLastMs ?? 0)).toBeGreaterThanOrEqual(0);
  });
});

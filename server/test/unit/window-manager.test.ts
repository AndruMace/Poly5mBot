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
    });

    await Effect.runPromise(poll);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.priceToBeat).toBe(null);
    expect(emitted[0]?.priceToBeatStatus).toBe("unavailable");
    expect(emitted[0]?.priceToBeatSource).toBe("unavailable");
  });
});

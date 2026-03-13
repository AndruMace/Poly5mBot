import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { OrderService } from "../../src/polymarket/orders.js";
import { PolymarketClient } from "../../src/polymarket/client.js";
import type { Signal } from "../../src/types.js";

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    side: "UP",
    confidence: 0.8,
    size: 10,
    maxPrice: 0.55,
    strategy: "arb",
    reason: "test",
    timestamp: Date.now(),
    ...overrides,
  };
}

const runWithClient = <A>(effect: Effect.Effect<A, unknown, OrderService>, client: unknown) => {
  const clientLayer = Layer.succeed(PolymarketClient, {
    getClient: Effect.succeed(client),
  } as any);
  const layer = OrderService.Default.pipe(Layer.provideMerge(clientLayer));
  return Effect.runPromise(effect.pipe(Effect.provide(layer)));
};

describe("OrderService", () => {
  it("keeps attempting during liquidity backoff using reduced scales", async () => {
    let calls = 0;
    const client = {
      createAndPostOrder: async () => {
        calls += 1;
        throw { message: "order couldn't be fully filled. FOK orders are fully filled or killed." };
      },
    };

    const [first, second] = await runWithClient(
      Effect.gen(function* () {
        const orders = yield* OrderService;
        const firstAttempt = yield* orders.executeSignal(
          makeSignal({ strategy: "momentum", size: 12, maxPrice: 0.67 }),
          "up-token",
          "down-token",
          Date.now() + 60_000,
          "cond-backoff-1",
          100_000,
        );
        const secondAttempt = yield* orders.executeSignal(
          makeSignal({ strategy: "momentum", size: 12, maxPrice: 0.67 }),
          "up-token",
          "down-token",
          Date.now() + 60_000,
          "cond-backoff-1",
          100_000,
        );
        return [firstAttempt, secondAttempt] as const;
      }),
      client,
    );

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(calls).toBeGreaterThanOrEqual(8);
  });

  it("retries FOK liquidity rejects with smaller size and succeeds", async () => {
    let calls = 0;
    const client = {
      createAndPostOrder: async () => {
        calls += 1;
        if (calls === 1) {
          throw { message: "order couldn't be fully filled or killed" };
        }
        return { orderID: "ord-1", status: "accepted" };
      },
    };

    const record = await runWithClient(
      Effect.gen(function* () {
        const orders = yield* OrderService;
        return yield* orders.executeSignal(
          makeSignal({ size: 25, maxPrice: 0.61 }),
          "up-token",
          "down-token",
          Date.now() + 60_000,
          "cond-1",
          100_000,
        );
      }),
      client,
    );

    expect(calls).toBe(2);
    expect(record).not.toBeNull();
    expect(record?.status).toBe("submitted");
    expect(record?.clobOrderId).toBe("ord-1");
  });

  it("returns rejected trade on non-liquidity order errors", async () => {
    const client = {
      createAndPostOrder: async () => {
        throw { message: "invalid signature" };
      },
    };

    const record = await runWithClient(
      Effect.gen(function* () {
        const orders = yield* OrderService;
        return yield* orders.executeSignal(
          makeSignal(),
          "up-token",
          "down-token",
          Date.now() + 60_000,
          "cond-2",
          100_100,
        );
      }),
      client,
    );

    expect(record).not.toBeNull();
    expect(record?.status).toBe("rejected");
    expect(record?.clobReason).toContain("invalid signature");
  });

  it("classifies venue precision rejects with structured clobResult", async () => {
    const client = {
      createAndPostOrder: async () => {
        throw {
          message:
            "invalid amounts, the market buy orders maker amount supports a max accuracy of 2 decimals, taker amount a max of 4 decimals",
        };
      },
    };

    const record = await runWithClient(
      Effect.gen(function* () {
        const orders = yield* OrderService;
        return yield* orders.executeSignal(
          makeSignal({ strategy: "momentum", side: "DOWN", size: 12.37, maxPrice: 0.671 }),
          "up-token",
          "down-token",
          Date.now() + 60_000,
          "cond-precision-classify",
          100_100,
        );
      }),
      client,
    );

    expect(record).not.toBeNull();
    expect(record?.status).toBe("rejected");
    expect(record?.clobResult).toBe("precision_rejected_by_venue");
  });

  it("falls back to FAK partial fills after FOK liquidity exhaustion", async () => {
    const client = {
      createAndPostOrder: async (
        _order: { price: number; size: number },
        _opts: unknown,
        tif: string,
      ) => {
        if (tif === "FOK") {
          throw {
            message:
              "order couldn't be fully filled. FOK orders are fully filled or killed.",
          };
        }
        return {
          orderID: "ioc-1",
          status: "partially_filled",
          avgPrice: "0.57",
          sizeMatched: "6.0",
        };
      },
      getOrderById: async () => ({
        status: "partially_filled",
        averagePrice: "0.57",
        filledSize: "6.0",
      }),
    };

    const record = await runWithClient(
      Effect.gen(function* () {
        const orders = yield* OrderService;
        return yield* orders.executeSignal(
          makeSignal({ strategy: "momentum", size: 10, maxPrice: 0.67 }),
          "up-token",
          "down-token",
          Date.now() + 60_000,
          "cond-ioc-1",
          100_000,
        );
      }),
      client,
    );

    expect(record).not.toBeNull();
    expect(record?.status).toBe("partial");
    expect(record?.shares).toBeCloseTo(6, 6);
    expect(record?.entryPrice).toBeCloseTo(0.57, 6);
    expect(record?.clobOrderId).toBe("ioc-1");
  });

  it("marks efficiency trade as partial incident when second leg fails", async () => {
    let calls = 0;
    const client = {
      createAndPostOrder: async () => {
        calls += 1;
        if (calls === 1) return { orderID: "leg-1", status: "accepted" };
        throw { message: "second leg failure" };
      },
    };

    const trades = await runWithClient(
      Effect.gen(function* () {
        const orders = yield* OrderService;
        return yield* orders.executeDualBuy(
          "up-token",
          "down-token",
          0.5,
          0.49,
          20,
          Date.now() + 60_000,
          "cond-3",
          100_200,
        );
      }),
      client,
    );

    expect(trades).toHaveLength(1);
    expect(trades[0]?.strategy).toBe("efficiency-partial");
  });

  it("quantizes dual-buy amounts to satisfy maker 2dp / taker 4dp constraints", async () => {
    let calls = 0;
    const client = {
      createAndPostOrder: async (order: { price: number; size: number }) => {
        calls += 1;
        // Simulate CLOB BUY semantics: submitted size is taker shares.
        const roundedShares = Math.floor(order.size * 100) / 100;
        const rawMaker = roundedShares * order.price;
        const normalizedMaker = Number(rawMaker.toFixed(4));
        const makerDp = (normalizedMaker.toString().split(".")[1] ?? "").length;
        if (makerDp > 2) {
          throw {
            message:
              "invalid amounts, the market buy orders maker amount supports a max accuracy of 2 decimals, taker amount a max of 4 decimals",
          };
        }
        return { orderID: `leg-${calls}`, status: "accepted" };
      },
    };

    const trades = await runWithClient(
      Effect.gen(function* () {
        const orders = yield* OrderService;
        return yield* orders.executeDualBuy(
          "up-token",
          "down-token",
          0.63,
          0.38,
          20,
          Date.now() + 60_000,
          "cond-precision-1",
          100_250,
        );
      }),
      client,
    );

    expect(calls).toBe(2);
    expect(trades).toHaveLength(2);
    expect(trades.every((t) => t.status === "submitted")).toBe(true);
  });

  it("quantizes single-leg amounts to satisfy maker 2dp / taker 4dp constraints (momentum DOWN)", async () => {
    const cases: Array<{ size: number; maxPrice: number }> = [
      { size: 12.37, maxPrice: 0.671 },
      { size: 9.99, maxPrice: 0.533 },
      { size: 20, maxPrice: 0.5799 },
      { size: 6.41, maxPrice: 0.487 },
      { size: 25, maxPrice: 0.631 },
    ];
    const submitted: Array<{ tokenID: string; price: number; size: number }> = [];
    const client = {
      createAndPostOrder: async (order: { tokenID: string; price: number; size: number }) => {
        // Simulate the CLOB library: size = shares (taker amount).
        // CLOB computes maker = roundDown(shares, 2) * price. If the raw float has
        // >4dp (IEEE-754 noise), the CLOB normalizes it down to 4dp before sending.
        // The venue then requires that normalized maker to have ≤2dp.
        const roundedShares = Math.floor(order.size * 100) / 100;
        const rawMaker = roundedShares * order.price;
        const normalizedMaker = Number(rawMaker.toFixed(4)); // CLOB's 4dp fallback
        const makerDp = (normalizedMaker.toString().split(".")[1] ?? "").length;
        if (makerDp > 2) {
          throw {
            message:
              "invalid amounts, the market buy orders maker amount supports a max accuracy of 2 decimals, taker amount a max of 4 decimals",
          };
        }
        submitted.push(order);
        return { orderID: `single-${submitted.length}`, status: "accepted" };
      },
    };

    await runWithClient(
      Effect.gen(function* () {
        const orders = yield* OrderService;
        for (const c of cases) {
          const rec = yield* orders.executeSignal(
            makeSignal({
              strategy: "momentum",
              side: "DOWN",
              size: c.size,
              maxPrice: c.maxPrice,
            }),
            "up-token",
            "down-token",
            Date.now() + 60_000,
            `cond-single-${c.size}-${c.maxPrice}`,
            100_250,
          );
          expect(rec).not.toBeNull();
          expect(rec?.status).toBe("submitted");
        }
      }),
      client,
    );

    expect(submitted.length).toBe(cases.length);
    expect(submitted.every((o) => o.tokenID === "down-token")).toBe(true);
  });

  it("normalizes order status from fallback client methods", async () => {
    const client = {
      getOrderById: async () => ({
        status: "partially_filled",
        averagePrice: "0.52",
        filledSize: "11.5",
      }),
    };

    const status = await runWithClient(
      Effect.gen(function* () {
        const orders = yield* OrderService;
        return yield* orders.getOrderStatusById("ord-status-1");
      }),
      client,
    );

    expect(status.mappedStatus).toBe("partial");
    expect(status.avgPrice).toBeCloseTo(0.52, 6);
    expect(status.filledShares).toBeCloseTo(11.5, 6);
  });

  it("clamps single-leg FOK orders to at least 5 shares", async () => {
    const submittedSizes: number[] = [];
    const client = {
      createAndPostOrder: async (order: { size: number }) => {
        submittedSizes.push(order.size);
        return { orderID: "ord-min-fok", status: "accepted" };
      },
    };

    const record = await runWithClient(
      Effect.gen(function* () {
        const orders = yield* OrderService;
        return yield* orders.executeSignal(
          makeSignal({ strategy: "momentum", size: 2, maxPrice: 0.9 }),
          "up-token",
          "down-token",
          Date.now() + 60_000,
          "cond-min-fok-1",
          100_000,
        );
      }),
      client,
    );

    expect(record).not.toBeNull();
    // size sent to CLOB is shares (taker amount), not notional — the CLOB computes USDC internally.
    expect(submittedSizes[0]).toBe(5);
    expect(record?.shares).toBe(5);
  });

  it("returns local precision rejection instead of null when price quantization is invalid", async () => {
    let calls = 0;
    const client = {
      createAndPostOrder: async () => {
        calls += 1;
        return { orderID: "ord-should-not-submit", status: "accepted" };
      },
    };

    const record = await runWithClient(
      Effect.gen(function* () {
        const orders = yield* OrderService;
        return yield* orders.executeSignal(
          makeSignal({ strategy: "momentum", size: 2, maxPrice: 0.001 }),
          "up-token",
          "down-token",
          Date.now() + 60_000,
          "cond-local-precision",
          100_000,
        );
      }),
      client,
    );

    expect(calls).toBe(0);
    expect(record).not.toBeNull();
    expect(record?.status).toBe("rejected");
    expect(record?.clobReason).toBe("precision_invalid_local");
    expect(record?.clobResult).toBe("rejected");
  });

  it("exposes order precision guard metadata for runtime parity checks", async () => {
    const info = await runWithClient(
      Effect.gen(function* () {
        const orders = yield* OrderService;
        return yield* orders.getPrecisionGuardInfo;
      }),
      {},
    );

    expect(info.version.length).toBeGreaterThan(0);
    expect(info.quantizedSingleLegBuy).toBe(true);
    expect(info.quantizedSingleLegSell).toBe(true);
    expect(info.quantizedDualLegBuy).toBe(true);
    expect(info.localPrecisionValidation).toBe(true);
  });

  it("executes SELL close flow with FAK when flattening a leg", async () => {
    const submitted: Array<{ side: string; size: number; price: number; tif: string }> = [];
    const client = {
      createAndPostOrder: async (
        order: { side: string; size: number; price: number },
        _opts: unknown,
        tif: string,
      ) => {
        submitted.push({ side: order.side, size: order.size, price: order.price, tif });
        return {
          orderID: "sell-close-1",
          status: "partially_filled",
          avgPrice: "0.53",
          sizeMatched: "6.0",
        };
      },
      getOrderById: async () => ({
        status: "partially_filled",
        averagePrice: "0.53",
        filledSize: "6.0",
      }),
    };

    const record = await runWithClient(
      Effect.gen(function* () {
        const orders = yield* OrderService;
        return yield* orders.executeSell(
          "up-token",
          "UP",
          "efficiency-flatten",
          6,
          0.53,
          Date.now() + 60_000,
          "cond-close-1",
          100_000,
        );
      }),
      client,
    );

    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.side).toBe("SELL");
    expect(submitted[0]?.tif).toBe("FAK");
    expect(record.status).toBe("partial");
    expect(record.shares).toBeCloseTo(6, 6);
    expect(record.entryPrice).toBeCloseTo(0.53, 6);
  });

  it("returns rejected close record when SELL order fails", async () => {
    const client = {
      createAndPostOrder: async () => {
        throw { message: "sell not allowed for token" };
      },
    };

    const record = await runWithClient(
      Effect.gen(function* () {
        const orders = yield* OrderService;
        return yield* orders.executeSell(
          "down-token",
          "DOWN",
          "efficiency-flatten",
          8,
          0.47,
          Date.now() + 60_000,
          "cond-close-2",
          100_000,
        );
      }),
      client,
    );

    expect(record.status).toBe("rejected");
    expect(record.clobReason).toContain("sell not allowed");
  });

  it("clamps IOC fallback orders to at least 5 shares", async () => {
    const iocSubmittedSizes: number[] = [];
    const client = {
      createAndPostOrder: async (
        order: { size: number },
        _opts: unknown,
        tif: string,
      ) => {
        if (tif === "FOK") {
          throw { message: "order couldn't be fully filled. FOK orders are fully filled or killed." };
        }
        iocSubmittedSizes.push(order.size);
        return {
          orderID: "ord-min-ioc",
          status: "partially_filled",
          avgPrice: "0.9",
          sizeMatched: "5",
        };
      },
      getOrderById: async () => ({
        status: "partially_filled",
        averagePrice: "0.9",
        filledSize: "5",
      }),
    };

    const record = await runWithClient(
      Effect.gen(function* () {
        const orders = yield* OrderService;
        return yield* orders.executeSignal(
          makeSignal({ strategy: "momentum", size: 2, maxPrice: 0.9 }),
          "up-token",
          "down-token",
          Date.now() + 60_000,
          "cond-min-ioc-1",
          100_000,
        );
      }),
      client,
    );

    expect(record).not.toBeNull();
    // size sent to CLOB is shares (taker amount), not notional — the CLOB computes USDC internally.
    expect(iocSubmittedSizes[0]).toBe(5);
    expect(record?.shares).toBe(5);
  });

  it("clamps dual-buy orders to at least 5 shares on both legs", async () => {
    const submittedSizes: number[] = [];
    const client = {
      createAndPostOrder: async (order: { size: number }) => {
        submittedSizes.push(order.size);
        return { orderID: `dual-min-${submittedSizes.length}`, status: "accepted" };
      },
    };

    const trades = await runWithClient(
      Effect.gen(function* () {
        const orders = yield* OrderService;
        return yield* orders.executeDualBuy(
          "up-token",
          "down-token",
          0.52,
          0.47,
          2,
          Date.now() + 60_000,
          "cond-min-dual-1",
          100_250,
        );
      }),
      client,
    );

    expect(trades).toHaveLength(2);
    expect(submittedSizes).toEqual([5, 5]);
    expect(trades[0]?.shares).toBe(5);
    expect(trades[1]?.shares).toBe(5);
    expect(trades[0]?.size).toBeCloseTo(2.6, 6);
    expect(trades[1]?.size).toBeCloseTo(2.35, 6);
  });
});

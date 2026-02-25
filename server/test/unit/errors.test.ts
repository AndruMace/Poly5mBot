import { describe, it, expect } from "vitest";
import {
  ConfigError,
  PolymarketError,
  OrderError,
  FeedError,
  PersistenceError,
  RiskRejection,
  AuthError,
} from "../../src/errors.js";

describe("Tagged error types", () => {
  it("constructs tagged errors with expected tags", () => {
    const errs = [
      new ConfigError({ message: "bad" }),
      new PolymarketError({ message: "poly" }),
      new OrderError({ message: "order" }),
      new FeedError({ source: "binance", message: "feed" }),
      new PersistenceError({ path: "data/file", message: "persist" }),
      new RiskRejection({ reason: "risk" }),
      new AuthError({ message: "auth" }),
    ];

    expect(errs.every((e) => typeof (e as any)._tag === "string")).toBe(true);
  });
});

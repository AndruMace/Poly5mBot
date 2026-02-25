import { describe, expect, it } from "vitest";
import { preflightShadowBuy } from "../../src/engine/shadow-preflight.js";

describe("shadow preflight", () => {
  it("rejects notional below CLOB minimum", () => {
    const result = preflightShadowBuy(0.99, 0.55, {
      bids: [],
      asks: [{ price: 0.55, size: 100 }],
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("below_min_notional");
    }
  });

  it("rejects when no visible asks are at or below limit", () => {
    const result = preflightShadowBuy(10, 0.55, {
      bids: [],
      asks: [{ price: 0.56, size: 100 }],
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("no_visible_liquidity_at_limit");
    }
  });

  it("allows order when visible asks exist at limit or better", () => {
    const result = preflightShadowBuy(10, 0.55, {
      bids: [],
      asks: [{ price: 0.55, size: 1.2 }],
    });
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.requestedShares).toBeCloseTo(18.1818, 3);
      expect(result.visibleShares).toBe(1.2);
    }
  });
});

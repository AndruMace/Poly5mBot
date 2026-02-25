import { describe, it, expect } from "vitest";
import { calculateFeeStatic, effectiveFeeRateStatic } from "../../src/polymarket/orders.js";

describe("Order fee utilities", () => {
  it("calculates fee as positive value", () => {
    const fee = calculateFeeStatic(10, 0.55);
    expect(fee).toBeGreaterThan(0);
  });

  it("effective fee rate is deterministic", () => {
    const r1 = effectiveFeeRateStatic(0.55);
    const r2 = effectiveFeeRateStatic(0.55);
    expect(r1).toBe(r2);
  });
});

import { describe, expect, it } from "vitest";
import { getMarketConfig } from "../../src/markets/definitions.js";

describe("market strategy defaults", () => {
  it("defines strategy overrides for btc, xrp, eth, and sol", () => {
    const btc = getMarketConfig("btc");
    const xrp = getMarketConfig("xrp");
    const eth = getMarketConfig("eth");
    const sol = getMarketConfig("sol");

    expect(btc?.strategyConfigOverrides?.arb).toEqual({
      minSpreadPct: 0.08,
      minConfirmingExchanges: 2,
    });

    expect(xrp?.strategyConfigOverrides?.arb).toEqual({
      minSpreadPct: 0.18,
      minConfirmingExchanges: 2,
    });

    expect(eth?.strategies).toEqual(["arb", "momentum"]);
    expect(eth?.strategyConfigOverrides?.arb).toMatchObject({
      minSpreadPct: 0.12,
      minConfirmingExchanges: 2,
      minReferenceSources: 2,
    });
    expect(eth?.strategyConfigOverrides?.momentum).toMatchObject({
      rsiPeriod: 14,
      minPriceMovePct: 0.04,
      minPtbDistancePct: 0.05,
    });

    expect(sol?.strategies).toEqual(["arb", "momentum"]);
    expect(sol?.strategyConfigOverrides?.arb).toMatchObject({
      minSpreadPct: 0.2,
      minConfirmingExchanges: 2,
      minReferenceSources: 3,
    });
    expect(sol?.strategyConfigOverrides?.momentum).toMatchObject({
      rsiPeriod: 16,
      minPriceMovePct: 0.06,
      minPtbDistancePct: 0.08,
    });
  });
});

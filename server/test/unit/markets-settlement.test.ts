import { describe, it, expect } from "vitest";
import { inferSettlementWinnerFromMarket } from "../../src/polymarket/markets.js";

describe("inferSettlementWinnerFromMarket", () => {
  it("maps closed market outcome prices to UP winner", () => {
    const result = inferSettlementWinnerFromMarket({
      id: "m1",
      conditionId: "0xabc",
      slug: "slug",
      question: "q",
      outcomes: JSON.stringify(["Up", "Down"]),
      clobTokenIds: JSON.stringify(["1", "2"]),
      endDate: new Date().toISOString(),
      description: "",
      active: false,
      closed: true,
      acceptingOrders: false,
      outcomePrices: JSON.stringify([1, 0]),
    });
    expect(result.resolved).toBe(true);
    expect(result.winnerSide).toBe("UP");
  });

  it("returns null winner when closed market is ambiguous", () => {
    const result = inferSettlementWinnerFromMarket({
      id: "m2",
      conditionId: "0xdef",
      slug: "slug",
      question: "q",
      outcomes: JSON.stringify(["Up", "Down"]),
      clobTokenIds: JSON.stringify(["1", "2"]),
      endDate: new Date().toISOString(),
      description: "",
      active: false,
      closed: true,
      acceptingOrders: false,
      outcomePrices: JSON.stringify([0.5, 0.5]),
    });
    expect(result.resolved).toBe(true);
    expect(result.winnerSide).toBe(null);
  });
});

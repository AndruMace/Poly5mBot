import { describe, expect, it } from "vitest";
import {
  emptyFeedHealth,
  emptyMetrics,
  emptyOrderBook,
  emptyPnl,
  emptyRisk,
  defaultRegime,
} from "./index.js";

describe("store defaults", () => {
  it("defines baseline defaults for deterministic UI fallback", () => {
    expect(emptyOrderBook.up.bids).toEqual([]);
    expect(emptyPnl.totalTrades).toBe(0);
    expect(defaultRegime.trendRegime).toBe("chop");
    expect(emptyRisk.pauseRemainingSec).toBe(0);
    expect(emptyMetrics.latency.samples).toBe(0);
    expect(emptyFeedHealth.downCount).toBeGreaterThanOrEqual(1);
  });
});

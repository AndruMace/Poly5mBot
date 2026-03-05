import { describe, expect, it } from "vitest";
import {
  DEFAULT_WHALE_HUNT_CONFIG,
  mergeWhaleHuntConfig,
  normalizeWhaleHuntConfig,
  toWhaleHuntStrategyConfig,
} from "../../src/strategies/whale-hunt-config.js";

describe("whale-hunt runtime config", () => {
  it("normalizes and clamps out-of-range values", () => {
    const cfg = normalizeWhaleHuntConfig({
      orderBookBandPct: -1,
      maxAdverseImbalance: 2,
      imbalanceWeight: -0.5,
      latencyMultiplier: 0,
      latencyBufferMs: -100,
      minRequiredLeadMs: 999999,
      minLiveSubmittedForSizing: 0,
    });
    expect(cfg.orderBookBandPct).toBe(0.001);
    expect(cfg.maxAdverseImbalance).toBe(1);
    expect(cfg.imbalanceWeight).toBe(0);
    expect(cfg.latencyMultiplier).toBe(1);
    expect(cfg.latencyBufferMs).toBe(0);
    expect(cfg.minRequiredLeadMs).toBe(30000);
    expect(cfg.minLiveSubmittedForSizing).toBe(1);
  });

  it("merges per-market overrides over global values", () => {
    const cfg = mergeWhaleHuntConfig(DEFAULT_WHALE_HUNT_CONFIG, {
      maxAdverseImbalance: 0.08,
      minRequiredLeadMs: 5500,
      minLiveSubmittedForSizing: 80,
    });
    expect(cfg.maxAdverseImbalance).toBe(0.08);
    expect(cfg.minRequiredLeadMs).toBe(5500);
    expect(cfg.minLiveSubmittedForSizing).toBe(80);
    expect(cfg.orderBookBandPct).toBe(DEFAULT_WHALE_HUNT_CONFIG.orderBookBandPct);
  });

  it("maps runtime config to whale-hunt strategy keys", () => {
    const strategyCfg = toWhaleHuntStrategyConfig(DEFAULT_WHALE_HUNT_CONFIG);
    expect(strategyCfg.orderBookBandPct).toBe(DEFAULT_WHALE_HUNT_CONFIG.orderBookBandPct);
    expect(strategyCfg.maxAdverseImbalance).toBe(DEFAULT_WHALE_HUNT_CONFIG.maxAdverseImbalance);
    expect(strategyCfg.imbalanceWeight).toBe(DEFAULT_WHALE_HUNT_CONFIG.imbalanceWeight);
  });

  it("keeps explicit global overrides instead of per-market defaults", () => {
    const cfg = mergeWhaleHuntConfig(
      {
        ...DEFAULT_WHALE_HUNT_CONFIG,
        latencyMultiplier: 1,
        latencyBufferMs: 0,
        minRequiredLeadMs: 1000,
      },
      {
        latencyMultiplier: 2.75,
        latencyBufferMs: 1500,
        minRequiredLeadMs: 4500,
      },
    );
    expect(cfg.latencyMultiplier).toBe(1);
    expect(cfg.latencyBufferMs).toBe(0);
    expect(cfg.minRequiredLeadMs).toBe(1000);
  });
});

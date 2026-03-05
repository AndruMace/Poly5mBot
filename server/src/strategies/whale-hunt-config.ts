export interface WhaleHuntConfig {
  orderBookBandPct: number;
  maxAdverseImbalance: number;
  imbalanceWeight: number;
  latencyMultiplier: number;
  latencyBufferMs: number;
  minRequiredLeadMs: number;
  minLiveSubmittedForSizing: number;
}

export type WhaleHuntConfigOverrides = Partial<WhaleHuntConfig>;

export const DEFAULT_WHALE_HUNT_CONFIG: WhaleHuntConfig = {
  // Microstructure guards (safer than strategy hard defaults).
  orderBookBandPct: 0.05,
  maxAdverseImbalance: 0.12,
  imbalanceWeight: 0.2,
  // Latency guards for near-expiry execution.
  latencyMultiplier: 2.5,
  latencyBufferMs: 1200,
  minRequiredLeadMs: 4000,
  // Require enough live data before win-rate based sizing.
  minLiveSubmittedForSizing: 40,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function normalizeWhaleHuntConfig(input: WhaleHuntConfigOverrides): WhaleHuntConfig {
  const merged = { ...DEFAULT_WHALE_HUNT_CONFIG, ...input };
  return {
    orderBookBandPct: clamp(Number(merged.orderBookBandPct), 0.001, 0.25),
    maxAdverseImbalance: clamp(Number(merged.maxAdverseImbalance), 0, 1),
    imbalanceWeight: clamp(Number(merged.imbalanceWeight), 0, 1),
    latencyMultiplier: clamp(Number(merged.latencyMultiplier), 1, 10),
    latencyBufferMs: clamp(Number(merged.latencyBufferMs), 0, 15_000),
    minRequiredLeadMs: clamp(Number(merged.minRequiredLeadMs), 500, 30_000),
    minLiveSubmittedForSizing: Math.round(clamp(Number(merged.minLiveSubmittedForSizing), 1, 10_000)),
  };
}

export function mergeWhaleHuntConfig(
  base: WhaleHuntConfig,
  perMarket?: WhaleHuntConfigOverrides,
): WhaleHuntConfig {
  const normalizedBase = normalizeWhaleHuntConfig(base);
  if (!perMarket) return normalizedBase;

  // Per-market values are treated as safer defaults. If the global config was
  // explicitly changed away from the global default, keep the global value.
  const merged: WhaleHuntConfigOverrides = { ...normalizedBase };
  const defaultCfg = DEFAULT_WHALE_HUNT_CONFIG;
  for (const [key, value] of Object.entries(perMarket) as Array<[keyof WhaleHuntConfig, number | undefined]>) {
    if (value === undefined) continue;
    if (normalizedBase[key] === defaultCfg[key]) {
      merged[key] = value;
    }
  }
  return normalizeWhaleHuntConfig(merged);
}

export function toWhaleHuntStrategyConfig(cfg: WhaleHuntConfig): Record<string, number> {
  return {
    orderBookBandPct: cfg.orderBookBandPct,
    maxAdverseImbalance: cfg.maxAdverseImbalance,
    imbalanceWeight: cfg.imbalanceWeight,
  };
}

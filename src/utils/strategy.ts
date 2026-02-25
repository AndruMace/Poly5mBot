export const STRATEGY_DISPLAY_NAMES: Record<string, string> = {
  arb: "Arbitrage",
  efficiency: "Market Efficiency",
  "whale-hunt": "Whale Hunt",
  momentum: "Momentum Confirmation",
};

export const STRATEGY_UI_ORDER = [
  "arb",
  "efficiency",
  "whale-hunt",
  "momentum",
] as const;

export function getStrategyDisplayName(name: string): string {
  return STRATEGY_DISPLAY_NAMES[name] ?? name;
}

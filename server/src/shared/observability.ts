export const OBSERVABILITY_CATEGORIES = [
  "trade_lifecycle",
  "signal",
  "risk",
  "engine",
  "operator",
  "incident",
  "activity",
  "api",
] as const;

export const OBSERVABILITY_SOURCES = [
  "trade_store",
  "engine",
  "reconciler",
  "risk_manager",
  "api",
  "incident_store",
  "activity_store",
  "system",
] as const;

export const OBSERVABILITY_ENTITY_TYPES = [
  "trade",
  "signal",
  "strategy",
  "incident",
  "activity",
  "window",
  "system",
] as const;

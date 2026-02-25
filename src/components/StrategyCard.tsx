import { useState, useEffect, useRef } from "react";
import type { StrategyState, RegimeFilter } from "../types/index.js";
import {
  Zap,
  Eye,
  Pause,
  ChevronDown,
  ChevronUp,
  ShieldOff,
  Filter,
  HelpCircle,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";

const STRATEGY_DESCRIPTIONS: Record<string, string> = {
  arb: "Exploits lag between CEX spot prices and the Chainlink oracle estimate. Buys the expected outcome when Binance leads the oracle.",
  efficiency:
    "Hunts for moments when Up + Down ask prices sum to less than $1.00 minus fees, locking in risk-free profit.",
  "whale-hunt":
    "In the final seconds of a window, buys the near-certain winning side at 94-97\u00A2 for a small but consistent yield.",
  "mean-reversion":
    "Uses RSI to confirm strong directional momentum mid-window and bets that the trend will persist through market close.",
};

const CONFIG_LABELS: Record<string, string> = {
  minSpreadPct: "Min Spread %",
  maxOracleAgeSec: "Max Oracle Age (s)",
  confidenceMultiplier: "Confidence Mult",
  tradeSize: "Trade Size ($)",
  minProfitBps: "Min Profit (bps)",
  entryWindowSec: "Entry Window (s)",
  maxDynamicEntryWindowSec: "Max Dynamic Entry (s)",
  minPriceMovePct: "Min Price Move %",
  minEarlyGapPct: "Min Early Gap %",
  probabilityFloor: "Prob Floor",
  regimeWeight: "Regime Weight",
  liquidityWeight: "Liquidity Weight",
  spreadPenaltyWeight: "Spread Penalty Weight",
  maxSharePrice: "Max Share Price",
  minSharePrice: "Min Share Price",
  rsiPeriod: "RSI Period",
  rsiOverbought: "RSI Overbought",
  rsiOversold: "RSI Oversold",
  minWindowElapsedSec: "Min Window Elapsed (s)",
  maxWindowElapsedSec: "Max Window Elapsed (s)",
  maxEntriesPerWindow: "Max Entries / Window",
};

const CONFIG_HELP: Record<
  string,
  { description: string; high: string; medium: string; low: string }
> = {
  minSpreadPct: {
    description:
      "Minimum oracle-vs-exchange divergence needed before arb can fire.",
    high: "0.04",
    medium: "0.015",
    low: "0.008",
  },
  maxOracleAgeSec: {
    description: "Maximum allowed age of oracle approximation data for entry.",
    high: "2",
    medium: "2",
    low: "3",
  },
  confidenceMultiplier: {
    description:
      "Scales expected edge requirement; higher means stricter signal quality.",
    high: "1.6",
    medium: "1.2",
    low: "1.0",
  },
  tradeSize: {
    description: "Dollar budget target per signal before sizing/risk caps.",
    high: "larger sizing bias",
    medium: "balanced sizing bias",
    low: "smaller sizing bias",
  },
  minProfitBps: {
    description: "Minimum expected efficiency edge in basis points after costs.",
    high: "20",
    medium: "8",
    low: "3",
  },
  entryWindowSec: {
    description: "How late in the 5m market whale-hunt is allowed to enter.",
    high: "45",
    medium: "60",
    low: "60",
  },
  maxDynamicEntryWindowSec: {
    description:
      "Earliest second before expiry whale-hunt may enter when early-entry conditions are strong.",
    high: "90",
    medium: "120",
    low: "120",
  },
  minPriceMovePct: {
    description: "Minimum BTC move required before this strategy can trigger.",
    high: "0.08 / 0.06",
    medium: "0.03",
    low: "0.015 / 0.02",
  },
  minEarlyGapPct: {
    description:
      "Minimum move needed to unlock entries earlier than the base entry window.",
    high: "0.20",
    medium: "0.12",
    low: "0.08",
  },
  probabilityFloor: {
    description:
      "Minimum reversal-improbability score required for dynamic early entries.",
    high: "0.85",
    medium: "0.78",
    low: "0.70",
  },
  regimeWeight: {
    description:
      "How strongly trend/consensus conditions influence dynamic window expansion.",
    high: "0.30",
    medium: "0.20",
    low: "0.10",
  },
  liquidityWeight: {
    description:
      "How strongly top-book depth influences dynamic window expansion.",
    high: "0.30",
    medium: "0.20",
    low: "0.10",
  },
  spreadPenaltyWeight: {
    description:
      "Penalty weight for wide spreads when evaluating early-entry quality.",
    high: "0.45",
    medium: "0.30",
    low: "0.15",
  },
  maxSharePrice: {
    description: "Highest contract price allowed for entry to avoid overpaying.",
    high: "0.55-0.97",
    medium: "0.65-0.995",
    low: "0.72-0.995",
  },
  minSharePrice: {
    description: "Lowest contract price allowed (used mainly by whale-hunt).",
    high: "0.90",
    medium: "0.75",
    low: "0.65",
  },
  rsiPeriod: {
    description: "Lookback bars used for RSI calculation in momentum confirmation.",
    high: "7",
    medium: "7",
    low: "7",
  },
  rsiOverbought: {
    description:
      "RSI threshold confirming strong upward momentum — above this, bet UP.",
    high: "70",
    medium: "62",
    low: "58",
  },
  rsiOversold: {
    description:
      "RSI threshold confirming strong downward momentum — below this, bet DOWN.",
    high: "30",
    medium: "38",
    low: "42",
  },
  minWindowElapsedSec: {
    description:
      "Earliest second in market window where this strategy can trade.",
    high: "90",
    medium: "60",
    low: "45",
  },
  maxWindowElapsedSec: {
    description:
      "Latest second in market window where this strategy can still trade.",
    high: "240",
    medium: "270",
    low: "285",
  },
  maxEntriesPerWindow: {
    description:
      "Maximum successful entries this strategy can place in a single 5-minute market window.",
    high: "1-2",
    medium: "2-3",
    low: "3-5",
  },
};

const REGIME_DIMENSIONS: Array<{
  key: keyof RegimeFilter;
  label: string;
  options: string[];
}> = [
  {
    key: "allowedVolatility",
    label: "Volatility",
    options: ["low", "normal", "high", "extreme"],
  },
  {
    key: "allowedTrend",
    label: "Trend",
    options: ["strong_up", "up", "chop", "down", "strong_down"],
  },
  {
    key: "allowedLiquidity",
    label: "Liquidity",
    options: ["thin", "normal", "deep"],
  },
  {
    key: "allowedSpread",
    label: "Spread",
    options: ["tight", "normal", "wide", "blowout"],
  },
];

const OPTION_LABELS: Record<string, string> = {
  strong_up: "strong up",
  strong_down: "strong dn",
};

type PresetLevel = "high" | "medium" | "low";

const PRESET_STORAGE_KEY = "strategy-config-presets:v1";
const PRESET_SELECTION_STORAGE_KEY = "strategy-selected-preset:v1";

const DEFAULT_CONFIG_PRESETS: Record<
  string,
  Record<PresetLevel, Record<string, number>>
> = {
  arb: {
    high: {
      minSpreadPct: 0.04,
      maxOracleAgeSec: 2,
      confidenceMultiplier: 1.6,
      maxSharePrice: 0.55,
      tradeSize: 5,
      maxEntriesPerWindow: 2,
    },
    medium: {
      minSpreadPct: 0.015,
      maxOracleAgeSec: 2,
      confidenceMultiplier: 1.2,
      maxSharePrice: 0.7,
      tradeSize: 5,
      maxEntriesPerWindow: 3,
    },
    low: {
      minSpreadPct: 0.008,
      maxOracleAgeSec: 3,
      confidenceMultiplier: 1.0,
      maxSharePrice: 0.8,
      tradeSize: 5,
      maxEntriesPerWindow: 4,
    },
  },
  efficiency: {
    high: { minProfitBps: 20, tradeSize: 20, maxEntriesPerWindow: 1 },
    medium: { minProfitBps: 8, tradeSize: 20, maxEntriesPerWindow: 2 },
    low: { minProfitBps: 3, tradeSize: 20, maxEntriesPerWindow: 3 },
  },
  "whale-hunt": {
    high: {
      entryWindowSec: 45,
      maxDynamicEntryWindowSec: 90,
      minPriceMovePct: 0.08,
      minEarlyGapPct: 0.2,
      probabilityFloor: 0.85,
      regimeWeight: 0.3,
      liquidityWeight: 0.3,
      spreadPenaltyWeight: 0.45,
      maxSharePrice: 0.97,
      minSharePrice: 0.9,
      tradeSize: 15,
      maxEntriesPerWindow: 1,
    },
    medium: {
      entryWindowSec: 60,
      maxDynamicEntryWindowSec: 120,
      minPriceMovePct: 0.03,
      minEarlyGapPct: 0.12,
      probabilityFloor: 0.78,
      regimeWeight: 0.2,
      liquidityWeight: 0.2,
      spreadPenaltyWeight: 0.3,
      maxSharePrice: 0.995,
      minSharePrice: 0.75,
      tradeSize: 15,
      maxEntriesPerWindow: 2,
    },
    low: {
      entryWindowSec: 60,
      maxDynamicEntryWindowSec: 120,
      minPriceMovePct: 0.015,
      minEarlyGapPct: 0.08,
      probabilityFloor: 0.7,
      regimeWeight: 0.1,
      liquidityWeight: 0.1,
      spreadPenaltyWeight: 0.15,
      maxSharePrice: 0.995,
      minSharePrice: 0.65,
      tradeSize: 15,
      maxEntriesPerWindow: 3,
    },
  },
  "mean-reversion": {
    high: {
      rsiPeriod: 7,
      rsiOverbought: 70,
      rsiOversold: 30,
      minWindowElapsedSec: 90,
      maxWindowElapsedSec: 240,
      minPriceMovePct: 0.06,
      maxSharePrice: 0.55,
      tradeSize: 8,
      maxEntriesPerWindow: 1,
    },
    medium: {
      rsiPeriod: 7,
      rsiOverbought: 62,
      rsiOversold: 38,
      minWindowElapsedSec: 60,
      maxWindowElapsedSec: 270,
      minPriceMovePct: 0.03,
      maxSharePrice: 0.65,
      tradeSize: 8,
      maxEntriesPerWindow: 2,
    },
    low: {
      rsiPeriod: 7,
      rsiOverbought: 58,
      rsiOversold: 42,
      minWindowElapsedSec: 45,
      maxWindowElapsedSec: 285,
      minPriceMovePct: 0.02,
      maxSharePrice: 0.72,
      tradeSize: 8,
      maxEntriesPerWindow: 3,
    },
  },
};

function loadPresetStore(): Record<
  string,
  Record<PresetLevel, Record<string, number>>
> {
  try {
    if (typeof window === "undefined") return {};
    const raw = window.localStorage.getItem(PRESET_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, Record<PresetLevel, Record<string, number>>>;
  } catch {
    return {};
  }
}

function savePresetStore(
  store: Record<string, Record<PresetLevel, Record<string, number>>>,
): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Ignore localStorage failures.
  }
}

function loadPresetSelection(strategyName: string): PresetLevel {
  try {
    if (typeof window === "undefined") return "medium";
    const raw = window.localStorage.getItem(PRESET_SELECTION_STORAGE_KEY);
    if (!raw) return "medium";
    const parsed = JSON.parse(raw) as Record<string, PresetLevel>;
    const value = parsed?.[strategyName];
    return value === "high" || value === "medium" || value === "low"
      ? value
      : "medium";
  } catch {
    return "medium";
  }
}

function savePresetSelection(strategyName: string, level: PresetLevel): void {
  try {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(PRESET_SELECTION_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, PresetLevel>) : {};
    const next = { ...parsed, [strategyName]: level };
    window.localStorage.setItem(PRESET_SELECTION_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore localStorage failures.
  }
}

function buildPresets(
  strategyName: string,
): Record<PresetLevel, Record<string, number>> {
  const defaults = DEFAULT_CONFIG_PRESETS[strategyName] ?? {
    high: {},
    medium: {},
    low: {},
  };
  const store = loadPresetStore();
  const saved = store[strategyName];
  return {
    high: { ...defaults.high, ...(saved?.high ?? {}) },
    medium: { ...defaults.medium, ...(saved?.medium ?? {}) },
    low: { ...defaults.low, ...(saved?.low ?? {}) },
  };
}

interface StrategyCardProps {
  strategy: StrategyState;
  onToggle: () => void;
  onConfigChange: (config: Record<string, number>) => Promise<boolean>;
  onRegimeFilterChange: (filter: RegimeFilter) => Promise<boolean>;
}

function configsMatch(
  current: Record<string, number>,
  expected: Record<string, number>,
): boolean {
  for (const [key, value] of Object.entries(expected)) {
    if (!Number.isFinite(current[key]) || current[key] !== value) return false;
  }
  return true;
}

export function StrategyCard({
  strategy,
  onToggle,
  onConfigChange,
  onRegimeFilterChange,
}: StrategyCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [regimeExpanded, setRegimeExpanded] = useState(false);
  const [localConfig, setLocalConfig] = useState(strategy.config);
  const [configDirty, setConfigDirty] = useState(false);
  const [configPreviewingPreset, setConfigPreviewingPreset] = useState(false);
  const [pendingConfigSync, setPendingConfigSync] = useState<
    Record<string, number> | null
  >(null);
  const [selectedPreset, setSelectedPreset] = useState<PresetLevel>(() =>
    loadPresetSelection(strategy.name),
  );
  const [presets, setPresets] = useState<Record<PresetLevel, Record<string, number>>>(
    () => buildPresets(strategy.name),
  );
  const [localFilter, setLocalFilter] = useState<RegimeFilter>(
    strategy.regimeFilter,
  );
  const [filterDirty, setFilterDirty] = useState(false);
  const [savingFilter, setSavingFilter] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [configSaveState, setConfigSaveState] = useState<
    "idle" | "saved" | "error"
  >("idle");
  const [filterSaveState, setFilterSaveState] = useState<"idle" | "saved" | "error">(
    "idle",
  );
  const [showPausedReason, setShowPausedReason] = useState(false);
  const [optimisticEnabled, setOptimisticEnabled] = useState<boolean | null>(
    null,
  );
  const toggleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (optimisticEnabled !== null && strategy.enabled === optimisticEnabled) {
      setOptimisticEnabled(null);
      if (toggleTimer.current) clearTimeout(toggleTimer.current);
    }
  }, [strategy.enabled, optimisticEnabled]);

  useEffect(() => {
    if (!filterDirty) {
      setLocalFilter(strategy.regimeFilter);
      setFilterSaveState("idle");
    }
  }, [strategy.regimeFilter, filterDirty]);

  useEffect(() => {
    if (pendingConfigSync) {
      if (configsMatch(strategy.config, pendingConfigSync)) {
        setPendingConfigSync(null);
        setLocalConfig(strategy.config);
      }
      return;
    }
    if (!configDirty && !configPreviewingPreset) {
      setLocalConfig(strategy.config);
      setConfigSaveState("idle");
    }
  }, [strategy.config, configDirty, configPreviewingPreset, pendingConfigSync]);

  useEffect(() => {
    setPresets(buildPresets(strategy.name));
    setSelectedPreset(loadPresetSelection(strategy.name));
    setConfigDirty(false);
    setConfigPreviewingPreset(false);
    setPendingConfigSync(null);
  }, [strategy.name]);

  useEffect(() => {
    if (strategy.status !== "idle" || !strategy.enabled) {
      setShowPausedReason(false);
    }
  }, [strategy.status, strategy.enabled]);

  const displayEnabled = optimisticEnabled ?? strategy.enabled;

  function handleToggle() {
    setOptimisticEnabled(!displayEnabled);
    if (toggleTimer.current) clearTimeout(toggleTimer.current);
    toggleTimer.current = setTimeout(() => setOptimisticEnabled(null), 3000);
    onToggle();
  }

  function toggleRegimeOption(
    dimKey: keyof RegimeFilter,
    option: string,
  ) {
    setFilterDirty(true);
    setFilterSaveState("idle");
    setLocalFilter((prev) => {
      const current = (prev[dimKey] as string[] | undefined) ?? [];
      const next = current.includes(option)
        ? current.filter((v) => v !== option)
        : [...current, option];
      return { ...prev, [dimKey]: next.length > 0 ? next : undefined };
    });
  }

  async function handleRegimeSave() {
    setSavingFilter(true);
    setFilterSaveState("idle");
    const ok = await onRegimeFilterChange(localFilter);
    if (ok) {
      setFilterDirty(false);
      setFilterSaveState("saved");
    } else {
      setFilterSaveState("error");
    }
    setSavingFilter(false);
  }

  const StatusIcon =
    strategy.status === "trading"
      ? Zap
      : strategy.status === "watching"
        ? Eye
        : strategy.status === "regime_blocked"
          ? ShieldOff
          : Pause;

  const statusColor =
    strategy.status === "trading"
      ? "text-[var(--accent-green)]"
      : strategy.status === "watching"
        ? "text-[var(--accent-yellow)]"
        : strategy.status === "regime_blocked"
          ? "text-[var(--accent-red)]"
          : "text-[var(--text-secondary)]";

  async function handleConfigSave() {
    const payload = { ...localConfig };
    setSavingConfig(true);
    setConfigSaveState("idle");
    const ok = await onConfigChange(payload);
    if (ok) {
      setLocalConfig(payload);
      setConfigDirty(false);
      setConfigPreviewingPreset(false);
      setPendingConfigSync(payload);
      setConfigSaveState("saved");
    } else {
      setConfigSaveState("error");
    }
    setSavingConfig(false);
  }

  function buildConfigForPreset(level: PresetLevel): Record<string, number> {
    const latestPresets = buildPresets(strategy.name);
    setPresets(latestPresets);
    const preset = latestPresets[level] ?? presets[level];
    const nextConfig: Record<string, number> = { ...localConfig };
    for (const [key, value] of Object.entries(preset)) {
      if (key in localConfig && Number.isFinite(value)) {
        nextConfig[key] = value;
      }
    }
    return nextConfig;
  }

  function applyPresetToConfig(level: PresetLevel, markDirty = true) {
    const nextConfig = buildConfigForPreset(level);
    setLocalConfig(nextConfig);
    setConfigDirty(markDirty);
    setConfigPreviewingPreset(!markDirty);
    setConfigSaveState("idle");
  }

  function handlePresetChange(level: PresetLevel) {
    setSelectedPreset(level);
    savePresetSelection(strategy.name, level);
    applyPresetToConfig(level, false);
  }

  async function handleApplyPreset() {
    const payload = { ...localConfig };
    setLocalConfig(payload);
    setConfigDirty(true);
    setConfigPreviewingPreset(false);
    setSavingConfig(true);
    setConfigSaveState("idle");
    const ok = await onConfigChange(payload);
    if (ok) {
      setConfigDirty(false);
      setPendingConfigSync(payload);
      setConfigSaveState("saved");
    } else {
      setConfigSaveState("error");
    }
    setSavingConfig(false);
  }

  function handleSavePreset() {
    const filtered: Record<string, number> = {};
    for (const [key, value] of Object.entries(localConfig)) {
      if (Number.isFinite(value)) filtered[key] = value;
    }
    const next = {
      ...presets,
      [selectedPreset]: filtered,
    };
    setPresets(next);
    const store = loadPresetStore();
    const updatedStore = {
      ...store,
      [strategy.name]: next,
    };
    savePresetStore(updatedStore);
  }

  return (
    <div
      className={`rounded-xl border p-4 transition-colors ${
        displayEnabled
          ? "border-[var(--accent-blue)]/40 bg-[var(--bg-card)]"
          : "border-[var(--border)] bg-[var(--bg-card)]/50"
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <button
            onClick={handleToggle}
            className={`relative w-10 h-5 rounded-full transition-colors overflow-hidden shrink-0 ${
              displayEnabled
                ? "bg-[var(--accent-blue)]"
                : "bg-[var(--bg-secondary)] border border-[var(--border)]"
            }`}
          >
            <span
              className={`absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition-transform shadow-sm ${
                displayEnabled ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
          <h3 className="font-semibold capitalize">{strategy.name}</h3>
          <StatusIcon size={14} className={statusColor} />
        </div>

        <div className="flex items-center gap-3 text-xs font-mono">
          <span className="text-[var(--accent-green)]">{strategy.wins}W</span>
          <span className="text-[var(--accent-red)]">{strategy.losses}L</span>
          <span
            className={
              strategy.totalPnl >= 0
                ? "text-[var(--accent-green)]"
                : "text-[var(--accent-red)]"
            }
          >
            {strategy.totalPnl >= 0 ? "+" : ""}${strategy.totalPnl.toFixed(2)}
          </span>
        </div>
      </div>

      <p className="text-xs text-[var(--text-secondary)] mb-3">
        {STRATEGY_DESCRIPTIONS[strategy.name] ?? ""}
      </p>

      {strategy.status === "regime_blocked" && strategy.regimeBlockReason && (
        <div className="text-xs bg-[var(--accent-red)]/10 border border-[var(--accent-red)]/20 px-3 py-2 rounded mb-3 text-[var(--accent-red)]">
          <ShieldOff size={10} className="inline mr-1" />
          Blocked by regime: {strategy.regimeBlockReason}
        </div>
      )}

      <div className="mb-3 min-h-5 relative">
        {strategy.enabled && strategy.status === "idle" && strategy.statusReason ? (
          <>
            <button
              onClick={() => setShowPausedReason((v) => !v)}
              className="text-xs text-[var(--accent-blue)] hover:underline"
            >
              {showPausedReason ? "Hide pause reason" : "Why paused?"}
            </button>
            {showPausedReason && (
              <div className="absolute z-10 mt-2 left-0 right-0 text-xs bg-[var(--bg-secondary)] border border-[var(--border)] px-3 py-2 rounded text-[var(--text-secondary)] shadow-lg">
                {strategy.statusReason}
              </div>
            )}
          </>
        ) : (
          <span className="text-xs text-transparent select-none">.</span>
        )}
      </div>

      {strategy.lastSignal && (
        <div className="text-xs bg-[var(--bg-secondary)] px-3 py-2 rounded mb-3">
          <span className="text-[var(--text-secondary)]">Last signal: </span>
          <span
            className={
              strategy.lastSignal.side === "UP"
                ? "text-[var(--accent-green)]"
                : "text-[var(--accent-red)]"
            }
          >
            {strategy.lastSignal.side}
          </span>
          <span className="text-[var(--text-secondary)]"> — </span>
          <span>{strategy.lastSignal.reason}</span>
        </div>
      )}

      <div className="flex items-center gap-4">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-xs text-[var(--accent-blue)] hover:underline"
        >
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          {expanded ? "Hide" : "Show"} Configuration
        </button>

        <button
          onClick={() => setRegimeExpanded(!regimeExpanded)}
          className="flex items-center gap-1 text-xs text-[var(--accent-blue)] hover:underline"
        >
          <Filter size={11} />
          {regimeExpanded ? "Hide" : "Show"} Regime Filters
        </button>
      </div>

      {expanded && (
        <div className="mt-3 space-y-2 border-t border-[var(--border)] pt-3">
          <div className="flex items-center justify-between pb-2 border-b border-[var(--border)]">
            <div className="flex items-center gap-2">
              <label className="text-xs text-[var(--text-secondary)]">
                Preset
              </label>
              <select
                value={selectedPreset}
                onChange={(e) => handlePresetChange(e.target.value as PresetLevel)}
                className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1 text-xs text-[var(--text-primary)]"
              >
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
              <button
                onClick={handleApplyPreset}
                disabled={savingConfig}
                className={`px-2 py-1 text-xs border rounded transition-colors ${
                  savingConfig
                    ? "border-[var(--border)] text-[var(--text-secondary)] opacity-60 cursor-not-allowed"
                    : "border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                {savingConfig ? "Saving..." : "Apply & Save"}
              </button>
              <button
                onClick={handleSavePreset}
                className="px-2 py-1 text-xs border border-[var(--accent-blue)]/40 rounded text-[var(--accent-blue)] hover:bg-[var(--accent-blue)]/10 transition-colors"
              >
                Save Current to Preset
              </button>
            </div>
            <span
              className={`text-[11px] px-2 py-1 rounded border ${
                configDirty
                  ? "text-[var(--accent-yellow)] border-[var(--accent-yellow)]/40 bg-[var(--accent-yellow)]/10"
                  : "text-[var(--accent-green)] border-[var(--accent-green)]/40 bg-[var(--accent-green)]/10"
              }`}
            >
              {configDirty ? "Unsaved changes" : "Saved"}
            </span>
          </div>
          {Object.entries(localConfig).map(([key, value]) => {
            const help = CONFIG_HELP[key];
            return (
              <div key={key} className="flex items-center gap-3">
                <label className="text-xs text-[var(--text-secondary)] w-40 flex items-center gap-1.5">
                  <span>{CONFIG_LABELS[key] ?? key}</span>
                  <span className="relative group">
                    <HelpCircle size={12} className="text-gray-400" />
                    <span className="pointer-events-none absolute z-20 hidden group-hover:block left-4 top-3 w-72 text-[11px] leading-relaxed bg-[#111827] text-gray-100 border border-gray-700 rounded p-2 shadow-xl">
                      {help ? (
                        <>
                          <span className="block">{help.description}</span>
                          <span className="block mt-1 text-gray-300">
                            High: {help.high} | Medium: {help.medium} | Low: {help.low}
                          </span>
                        </>
                      ) : (
                        <span>
                          Adjusts how strict this strategy is. High is strictest,
                          medium is balanced, low is loosest.
                        </span>
                      )}
                    </span>
                  </span>
                </label>
                <input
                  type="number"
                  value={value}
                  step={
                    key.includes("Pct") ||
                    key.includes("Price") ||
                    key.toLowerCase().includes("probability") ||
                    key.includes("Weight")
                      ? 0.01
                      : 1
                  }
                  onChange={(e) => {
                    setConfigDirty(true);
                    setConfigPreviewingPreset(false);
                    setConfigSaveState("idle");
                    setLocalConfig({
                      ...localConfig,
                      [key]: parseFloat(e.target.value) || 0,
                    });
                  }}
                  className="w-24 bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1 text-xs font-mono text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)]"
                />
              </div>
            );
          })}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleConfigSave}
              disabled={savingConfig || !configDirty}
              className={`mt-2 px-3 py-1.5 text-xs rounded transition-colors ${
                savingConfig || !configDirty
                  ? "bg-[var(--bg-secondary)] text-[var(--text-secondary)] border border-[var(--border)] cursor-not-allowed"
                  : "bg-[var(--accent-blue)] text-white hover:bg-[var(--accent-blue)]/80"
              }`}
            >
              {savingConfig ? "Saving..." : "Save Config"}
            </button>
            {configSaveState === "saved" && (
              <span className="mt-2 text-xs text-[var(--accent-green)] flex items-center gap-1">
                <CheckCircle2 size={12} /> Saved
              </span>
            )}
            {configSaveState === "error" && (
              <span className="mt-2 text-xs text-[var(--accent-red)] flex items-center gap-1">
                <AlertTriangle size={12} /> Save failed
              </span>
            )}
          </div>
        </div>
      )}

      {regimeExpanded && (
        <div className="mt-3 space-y-3 border-t border-[var(--border)] pt-3">
          <div className="flex items-center justify-end">
            <span
              className={`text-[11px] px-2 py-1 rounded border ${
                filterDirty
                  ? "text-[var(--accent-yellow)] border-[var(--accent-yellow)]/40 bg-[var(--accent-yellow)]/10"
                  : "text-[var(--accent-green)] border-[var(--accent-green)]/40 bg-[var(--accent-green)]/10"
              }`}
            >
              {filterDirty ? "Unsaved filter changes" : "Filters saved"}
            </span>
          </div>
          {REGIME_DIMENSIONS.map((dim) => {
            const allowed = (localFilter[dim.key] as string[] | undefined) ?? [];
            const isUnset = !localFilter[dim.key];
            return (
              <div key={dim.key}>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs text-[var(--text-secondary)] font-medium">
                    {dim.label}
                  </span>
                  {isUnset && (
                    <span className="text-[10px] text-[var(--text-secondary)] opacity-60">
                      any
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {dim.options.map((opt) => {
                    const active = isUnset || allowed.includes(opt);
                    return (
                      <button
                        key={opt}
                        onClick={() => {
                          if (isUnset) {
                            const allExcept = dim.options.filter(
                              (o) => o !== opt,
                            );
                            setFilterDirty(true);
                            setFilterSaveState("idle");
                            setLocalFilter((prev) => ({
                              ...prev,
                              [dim.key]: allExcept,
                            }));
                          } else {
                            toggleRegimeOption(dim.key, opt);
                          }
                        }}
                        className={`px-2 py-1 text-[11px] rounded border transition-colors ${
                          active
                            ? "bg-[var(--accent-blue)]/15 border-[var(--accent-blue)]/40 text-[var(--accent-blue)]"
                            : "bg-[var(--bg-secondary)] border-[var(--border)] text-[var(--text-secondary)] opacity-50"
                        }`}
                      >
                        {OPTION_LABELS[opt] ?? opt}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleRegimeSave}
              disabled={savingFilter || !filterDirty}
              className={`px-3 py-1.5 text-xs rounded transition-colors ${
                savingFilter || !filterDirty
                  ? "bg-[var(--bg-secondary)] text-[var(--text-secondary)] border border-[var(--border)] cursor-not-allowed"
                  : "bg-[var(--accent-blue)] text-white hover:bg-[var(--accent-blue)]/80"
              }`}
            >
              {savingFilter ? "Saving..." : "Save Filters"}
            </button>
            <button
              onClick={() => {
                setFilterDirty(false);
                setFilterSaveState("idle");
                setLocalFilter({});
                void onRegimeFilterChange({});
              }}
              className="px-3 py-1.5 text-xs border border-[var(--border)] text-[var(--text-secondary)] rounded hover:text-[var(--text-primary)] transition-colors"
            >
              Clear All
            </button>
            {filterSaveState === "saved" && (
              <span className="text-xs text-[var(--accent-green)] flex items-center gap-1">
                <CheckCircle2 size={12} /> Saved
              </span>
            )}
            {filterSaveState === "error" && (
              <span className="text-xs text-[var(--accent-red)] flex items-center gap-1">
                <AlertTriangle size={12} /> Save failed
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

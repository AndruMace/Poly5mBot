import { useEffect, useMemo, useState } from "react";
import { useRxSet, useRxValue } from "@effect-rx/rx-react";
import { X, Eye, Radio, Loader2, Play, Square } from "lucide-react";
import { enabledMarketsRx, modeRx, tradingActiveRx, activeMarketIdRx } from "../../store/index.js";
import { LiveMarket } from "../LiveMarket.js";
import { SpreadPanel } from "../SpreadPanel.js";
import { OrderBook } from "../OrderBook.js";
import { StrategyMini } from "../StrategyMini.js";
import { PnLCard } from "../PnLCard.js";
import { RecentTrades } from "../RecentTrades.js";
import { FeedHealthCard } from "../FeedHealthCard.js";
import { RiskStatusCard } from "../RiskStatusCard.js";
import { ExecutionMetricsCard } from "../ExecutionMetricsCard.js";
import { setMarketMode, toggleMarketTrading } from "../../utils/market-actions.js";

type FocusTab = "execution" | "strategies" | "performance" | "ops";

interface FocusedMarketPanelProps {
  marketId: string;
  onClose: () => void;
}

export function FocusedMarketPanel({ marketId, onClose }: FocusedMarketPanelProps) {
  const enabledMarkets = useRxValue(enabledMarketsRx);
  const activeMarketId = useRxValue(activeMarketIdRx);
  const mode = useRxValue(modeRx);
  const tradingActive = useRxValue(tradingActiveRx);
  const setActiveMarketId = useRxSet(activeMarketIdRx);
  const [tab, setTab] = useState<FocusTab>("execution");
  const [switchingMode, setSwitchingMode] = useState(false);
  const [togglingTrading, setTogglingTrading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const activeDisplayName = useMemo(
    () =>
      enabledMarkets.find((m) => m.id === marketId)?.displayName
      ?? marketId.toUpperCase(),
    [enabledMarkets, marketId],
  );

  useEffect(() => {
    if (marketId && marketId !== activeMarketId) {
      setActiveMarketId(marketId);
    }
  }, [activeMarketId, marketId, setActiveMarketId]);

  if (!marketId) return null;

  const toggleMode = async () => {
    setSwitchingMode(true);
    setActionError(null);
    try {
      const nextMode = mode === "live" ? "shadow" : "live";
      await setMarketMode(marketId, nextMode);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to switch mode");
    } finally {
      setSwitchingMode(false);
    }
  };

  const toggleTrading = async () => {
    setTogglingTrading(true);
    setActionError(null);
    try {
      await toggleMarketTrading(marketId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to toggle trading");
    } finally {
      setTogglingTrading(false);
    }
  };

  return (
    <section
      className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3"
      data-testid="focused-market-panel"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{activeDisplayName}</h3>
          <p className="text-xs text-[var(--text-secondary)]">Focused market detail</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleMode}
            disabled={switchingMode}
            className={`rounded border px-2 py-1 text-xs ${
              mode === "shadow"
                ? "border-[var(--accent-yellow)]/40 text-[var(--accent-yellow)]"
                : "border-[var(--accent-red)]/40 text-[var(--accent-red)]"
            }`}
          >
            {mode === "shadow" ? <Eye size={12} className="mr-1 inline" /> : <Radio size={12} className="mr-1 inline" />}
            {switchingMode ? "..." : mode.toUpperCase()}
          </button>
          <button
            onClick={toggleTrading}
            disabled={togglingTrading}
            className={`rounded border px-2 py-1 text-xs ${
              tradingActive
                ? "border-[var(--accent-red)]/40 text-[var(--accent-red)]"
                : "border-[var(--accent-green)]/40 text-[var(--accent-green)]"
            }`}
          >
            {togglingTrading
              ? <Loader2 size={12} className="mr-1 inline animate-spin" />
              : tradingActive
                ? <Square size={12} className="mr-1 inline" />
                : <Play size={12} className="mr-1 inline" />}
            {tradingActive ? "Stop" : "Start"}
          </button>
          <button
            onClick={onClose}
            className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] p-1"
            aria-label="Close focus panel"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {actionError && (
        <div className="mb-2 rounded border border-[var(--accent-red)]/30 bg-[var(--accent-red)]/10 p-2 text-xs text-[var(--accent-red)]">
          {actionError}
        </div>
      )}

      <div className="mb-3 flex flex-wrap gap-1">
        {[
          { id: "execution", label: "Execution" },
          { id: "strategies", label: "Strategies" },
          { id: "performance", label: "Performance" },
          { id: "ops", label: "Ops" },
        ].map((option) => (
          <button
            key={option.id}
            onClick={() => setTab(option.id as FocusTab)}
            className={`rounded border px-2 py-1 text-xs ${
              tab === option.id
                ? "border-[var(--accent-blue)]/50 bg-[var(--accent-blue)]/15 text-[var(--accent-blue)]"
                : "border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {tab === "execution" && (
          <>
            <LiveMarket />
            <SpreadPanel />
            <OrderBook />
          </>
        )}
        {tab === "strategies" && (
          <>
            <StrategyMini />
            <ExecutionMetricsCard />
          </>
        )}
        {tab === "performance" && (
          <>
            <PnLCard />
            <RecentTrades />
          </>
        )}
        {tab === "ops" && (
          <>
            <FeedHealthCard />
            <RiskStatusCard />
            <ExecutionMetricsCard />
          </>
        )}
      </div>
    </section>
  );
}

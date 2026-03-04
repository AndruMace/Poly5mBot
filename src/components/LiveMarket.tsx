import { useState, useEffect } from "react";
import { useRxValue } from "@effect-rx/rx-react";
import {
  currentMarketRx,
  orderBookRx,
  tradingActiveRx,
  regimeRx,
  activeMarketIdRx,
  enabledMarketsRx,
} from "../store/index.js";
import {
  ExternalLink,
  TrendingUp,
  TrendingDown,
  Clock,
  CircleDot,
  Activity,
} from "lucide-react";

const REGIME_COLORS: Record<string, string> = {
  low: "text-[var(--accent-blue)]",
  normal: "text-[var(--accent-green)]",
  high: "text-[var(--accent-yellow)]",
  extreme: "text-[var(--accent-red)]",
  strong_up: "text-[var(--accent-green)]",
  up: "text-[var(--accent-green)]",
  chop: "text-[var(--text-secondary)]",
  down: "text-[var(--accent-red)]",
  strong_down: "text-[var(--accent-red)]",
  thin: "text-[var(--accent-red)]",
  deep: "text-[var(--accent-green)]",
  tight: "text-[var(--accent-green)]",
  wide: "text-[var(--accent-yellow)]",
  blowout: "text-[var(--accent-red)]",
};

export function LiveMarket() {
  const currentMarket = useRxValue(currentMarketRx);
  const orderBook = useRxValue(orderBookRx);
  const tradingActive = useRxValue(tradingActiveRx);
  const regime = useRxValue(regimeRx);
  const activeMarketId = useRxValue(activeMarketIdRx);
  const enabledMarkets = useRxValue(enabledMarketsRx);
  const activeDisplayName = enabledMarkets.find((m) => m.id === activeMarketId)?.displayName ?? activeMarketId.toUpperCase();
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      if (!currentMarket) {
        setRemaining(0);
        return;
      }
      const left = Math.max(0, currentMarket.endTime - Date.now());
      setRemaining(left);
      
      // Clear timer if market has ended to prevent unnecessary updates
      if (left === 0) {
        clearInterval(timer);
      }
    }, 1000); // Reduced from 100ms to 1000ms (1 second)
    return () => clearInterval(timer);
  }, [currentMarket]);

  const totalSec = Math.ceil(remaining / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;

  const priceToBeat = currentMarket?.priceToBeat ?? 0;
  const ptbDecimals = activeMarketId === "xrp" ? 4 : 3;
  const priceToBeatStatus = currentMarket?.priceToBeatStatus ?? "pending";
  const priceToBeatSource = currentMarket?.priceToBeatSource ?? "unavailable";
  const priceToBeatReason = currentMarket?.priceToBeatReason ?? null;

  const upMid = orderBook.bestBidUp !== null && orderBook.bestAskUp !== null
    ? (orderBook.bestBidUp + orderBook.bestAskUp) / 2
    : null;
  const downMid = orderBook.bestBidDown !== null && orderBook.bestAskDown !== null
    ? (orderBook.bestBidDown + orderBook.bestAskDown) / 2
    : null;

  const upPct = upMid !== null ? Math.round(upMid * 100) : null;
  const downPct = downMid !== null ? Math.round(downMid * 100) : null;

  const progress = currentMarket
    ? 1 - remaining / (currentMarket.endTime - currentMarket.startTime)
    : 0;

  const noMarket = !currentMarket;

  return (
    <div className="bg-[var(--bg-card)] rounded-xl border border-[var(--border)] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
        <div className="flex items-center gap-2">
          <CircleDot
            size={14}
            className={remaining > 0 ? "text-[var(--accent-green)] animate-pulse" : "text-[var(--text-secondary)]"}
          />
          <span className="text-sm font-semibold">
            {currentMarket?.title ?? `${activeDisplayName} Up or Down — 5 Minutes`}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {tradingActive && (
            <span className="text-xs px-2 py-0.5 rounded bg-[var(--accent-green)]/15 text-[var(--accent-green)] font-medium">
              Bot Active
            </span>
          )}
          {currentMarket?.polymarketUrl && (
            <a
              href={currentMarket.polymarketUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs text-[var(--accent-blue)] hover:underline"
            >
              Polymarket <ExternalLink size={10} />
            </a>
          )}
        </div>
      </div>

      <div className="p-4">
        {noMarket ? (
          <div className="text-center py-4">
            <p className="text-sm text-[var(--text-secondary)]">
              Waiting for next 5-minute {activeDisplayName} market window...
            </p>
            <p className="text-xs text-[var(--text-secondary)] mt-1 opacity-60">
              Markets refresh every ~10 seconds
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-4 mb-4">
              <div className="flex flex-col items-center justify-center p-3 rounded-lg bg-[var(--accent-green)]/5 border border-[var(--accent-green)]/20">
                <TrendingUp size={20} className="text-[var(--accent-green)] mb-1" />
                <span className="text-xs text-[var(--text-secondary)] mb-0.5">Up</span>
                <span className="text-2xl font-mono font-bold text-[var(--accent-green)]">
                  {upPct !== null ? `${upPct}¢` : "—"}
                </span>
                {orderBook.bestAskUp !== null && (
                  <span className="text-xs text-[var(--text-secondary)] mt-0.5">
                    ask {(orderBook.bestAskUp * 100).toFixed(0)}¢
                  </span>
                )}
              </div>

              <div className="flex flex-col items-center justify-center p-3">
                <div className="flex items-center gap-1 text-xs text-[var(--text-secondary)] mb-1">
                  <Clock size={12} />
                  <span>Remaining</span>
                </div>
                <span className={`text-3xl font-mono font-bold ${remaining < 30000 ? "text-[var(--accent-red)]" : "text-[var(--text-primary)]"}`}>
                  {min}:{sec.toString().padStart(2, "0")}
                </span>
                <div className="w-full h-1.5 bg-[var(--border)] rounded-full mt-2 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-200 ${remaining < 30000 ? "bg-[var(--accent-red)]" : "bg-[var(--accent-blue)]"}`}
                    style={{ width: `${Math.min(1, Math.max(0, progress)) * 100}%` }}
                  />
                </div>
              </div>

              <div className="flex flex-col items-center justify-center p-3 rounded-lg bg-[var(--accent-red)]/5 border border-[var(--accent-red)]/20">
                <TrendingDown size={20} className="text-[var(--accent-red)] mb-1" />
                <span className="text-xs text-[var(--text-secondary)] mb-0.5">Down</span>
                <span className="text-2xl font-mono font-bold text-[var(--accent-red)]">
                  {downPct !== null ? `${downPct}¢` : "—"}
                </span>
                {orderBook.bestAskDown !== null && (
                  <span className="text-xs text-[var(--text-secondary)] mt-0.5">
                    ask {(orderBook.bestAskDown * 100).toFixed(0)}¢
                  </span>
                )}
              </div>
            </div>

            <div className="bg-[var(--bg-secondary)] rounded-lg px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-[var(--text-secondary)]">Price to Beat</div>
                <div className="text-[10px] text-[var(--text-secondary)] uppercase tracking-wide">
                  {priceToBeatSource === "polymarket_page_json"
                    ? "Polymarket"
                    : priceToBeatSource === "polymarket_page_dom"
                      ? "Polymarket Fallback"
                      : priceToBeatSource === "gamma_metadata"
                        ? "Gamma"
                        : "Unavailable"}
                </div>
              </div>
              <div className="font-mono text-sm font-semibold">
                {priceToBeatStatus === "exact" && priceToBeat > 0
                  ? `$${priceToBeat.toLocaleString(undefined, {
                      minimumFractionDigits: ptbDecimals,
                      maximumFractionDigits: ptbDecimals,
                    })}`
                  : "Price to Beat unavailable (awaiting Polymarket page PTB)"}
              </div>
              {priceToBeatStatus !== "exact" && priceToBeatReason && (
                <div className="text-[10px] text-[var(--text-secondary)] mt-1">
                  Reason: {priceToBeatReason}
                </div>
              )}
            </div>

            <div className="mt-3 bg-[var(--bg-secondary)] rounded-lg px-3 py-2">
              <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] mb-1.5">
                <Activity size={11} />
                Market Regime
              </div>
              <div className="flex items-center gap-4 text-xs font-mono">
                <span>
                  Vol:{" "}
                  <span className={REGIME_COLORS[regime.volatilityRegime] ?? ""}>
                    {regime.volatilityRegime}
                  </span>
                  <span className="text-[var(--text-secondary)] ml-1">
                    ({(regime.volatilityValue ?? 0).toFixed(6)})
                  </span>
                </span>
                <span>
                  Trend:{" "}
                  <span className={REGIME_COLORS[regime.trendRegime] ?? ""}>
                    {regime.trendRegime.replace("_", " ")}
                  </span>
                  <span className="text-[var(--text-secondary)] ml-1">
                    ({(regime.trendStrength ?? 0).toFixed(4)})
                  </span>
                </span>
                <span>
                  Liq:{" "}
                  <span className={REGIME_COLORS[regime.liquidityRegime] ?? ""}>
                    {regime.liquidityRegime}
                  </span>
                  <span className="text-[var(--text-secondary)] ml-1">
                    ({Math.round(regime.liquidityDepth ?? 0)})
                  </span>
                </span>
                <span>
                  Spread:{" "}
                  <span className={REGIME_COLORS[regime.spreadRegime] ?? ""}>
                    {regime.spreadRegime}
                  </span>
                  <span className="text-[var(--text-secondary)] ml-1">
                    ({((regime.spreadValue ?? 0) * 100).toFixed(1)}¢)
                  </span>
                </span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

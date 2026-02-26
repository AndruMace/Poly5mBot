import { useState, useEffect } from "react";
import { useRxValue } from "@effect-rx/rx-react";
import { currentMarketRx, oracleEstimateRx } from "../store/index.js";
import { Clock, TrendingUp, TrendingDown } from "lucide-react";

export function MarketTimer() {
  const currentMarket = useRxValue(currentMarketRx);
  const oracleEstimate = useRxValue(oracleEstimateRx);
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
  const progress = currentMarket
    ? 1 - remaining / (currentMarket.endTime - currentMarket.startTime)
    : 0;

  const priceToBeat = currentMarket?.priceToBeat ?? 0;
  const diff = priceToBeat > 0 ? oracleEstimate - priceToBeat : 0;
  const diffPct = priceToBeat > 0 ? (diff / priceToBeat) * 100 : 0;
  const isUp = diff >= 0;

  const circumference = 2 * Math.PI * 42;
  const dashOffset = circumference * (1 - progress);

  return (
    <div className="bg-[var(--bg-card)] rounded-xl p-4 border border-[var(--border)]">
      <div className="flex items-center gap-2 mb-3 text-sm text-[var(--text-secondary)]">
        <Clock size={14} />
        <span>Market Window</span>
      </div>

      <div className="flex items-center justify-center gap-6">
        <div className="relative w-24 h-24">
          <svg className="w-24 h-24 -rotate-90" viewBox="0 0 96 96">
            <circle
              cx="48" cy="48" r="42"
              fill="none"
              stroke="var(--border)"
              strokeWidth="4"
            />
            <circle
              cx="48" cy="48" r="42"
              fill="none"
              stroke={remaining < 30000 ? "var(--accent-red)" : "var(--accent-blue)"}
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              className="transition-all duration-200"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-mono text-xl font-bold">
              {min}:{sec.toString().padStart(2, "0")}
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div>
            <div className="text-xs text-[var(--text-secondary)]">Price to Beat</div>
            <div className="font-mono text-sm">
              {priceToBeat > 0
                ? `$${priceToBeat.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                : "—"}
            </div>
          </div>
          <div>
            <div className="text-xs text-[var(--text-secondary)]">Current</div>
            <div className={`font-mono text-sm flex items-center gap-1 ${isUp ? "text-[var(--accent-green)]" : "text-[var(--accent-red)]"}`}>
              {oracleEstimate > 0
                ? `$${oracleEstimate.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                : "—"}
              {oracleEstimate > 0 && priceToBeat > 0 && (
                <>
                  {isUp ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                  <span className="text-xs">
                    {diffPct >= 0 ? "+" : ""}{diffPct.toFixed(3)}%
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

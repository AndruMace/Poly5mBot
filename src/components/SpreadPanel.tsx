import { useRxValue } from "@effect-rx/rx-react";
import { feedHealthRx, activeMarketIdRx } from "../store/index.js";

const ARB_THRESHOLD_PCT = 0.04;

const EXCHANGE_COLORS: Record<string, string> = {
  binance: "#F0B90B",
  bybit: "#F7A600",
  coinbase: "#0052FF",
  kraken: "#5741D9",
  bitstamp: "#4A9C2D",
  okx: "#FFFFFF",
};

function fmtAge(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function SpreadPanel() {
  const feedHealth = useRxValue(feedHealthRx);
  const activeMarketId = useRxValue(activeMarketIdRx);
  const priceDecimals = activeMarketId === "xrp" ? 4 : 2;

  const { sources, oracleEstimate } = feedHealth;

  const fmtPrice = (n: number | null) =>
    n != null && n > 0
      ? `$${n.toLocaleString(undefined, { minimumFractionDigits: priceDecimals, maximumFractionDigits: priceDecimals })}`
      : "—";

  // Spread uses only healthy sources
  const healthyPrices = sources
    .filter((s) => s.status === "healthy" && s.price != null && s.price > 0)
    .map((s) => s.price as number);
  const maxPrice = healthyPrices.length ? Math.max(...healthyPrices) : 0;
  const minPrice = healthyPrices.length ? Math.min(...healthyPrices) : 0;
  const maxSpread = maxPrice - minPrice;
  const spreadPct =
    oracleEstimate > 0 && maxSpread > 0
      ? (maxSpread / oracleEstimate) * 100
      : 0;
  const spreadAboveThreshold = spreadPct >= ARB_THRESHOLD_PCT;

  return (
    <div className="bg-[var(--bg-card)] rounded-xl p-4 border border-[var(--border)]">
      <span className="text-sm font-medium text-[var(--text-secondary)] block mb-3">
        Exchange Prices
      </span>

      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="text-[var(--text-secondary)] border-b border-[var(--border)]">
            <th className="text-left pb-1.5 font-normal">Exchange</th>
            <th className="text-right pb-1.5 font-normal">Age</th>
            <th className="text-right pb-1.5 font-normal">Price</th>
            <th className="text-right pb-1.5 font-normal">Δ Oracle</th>
            <th className="text-right pb-1.5 font-normal">Bid</th>
            <th className="text-right pb-1.5 font-normal">Ask</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((src) => {
            const isDown = src.status === "down";
            const isStale = src.status === "stale";
            const isWarmingUp = src.status === "warming_up";
            const rowClass = isDown
              ? "opacity-40"
              : isStale || isWarmingUp
                ? "opacity-60"
                : "";
            const ageClass = isDown
              ? "text-[var(--accent-red)]"
              : isStale
                ? "text-[var(--accent-yellow)]"
                : isWarmingUp
                  ? "text-[var(--accent-blue)]"
                  : "text-[var(--text-secondary)]";

            const delta =
              oracleEstimate > 0 && src.price != null && src.price > 0
                ? src.price - oracleEstimate
                : null;
            const dotColor = EXCHANGE_COLORS[src.name];

            return (
              <tr
                key={src.name}
                className={`border-b border-[var(--border)] last:border-0 ${rowClass}`}
              >
                <td className="py-1.5 capitalize">
                  <span className="flex items-center gap-1.5">
                    {dotColor && (
                      <span
                        className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                        style={{ background: dotColor }}
                      />
                    )}
                    {src.name}
                  </span>
                </td>
                <td className={`py-1.5 text-right ${ageClass}`}>
                  {fmtAge(src.ageMs)}
                </td>
                <td className="py-1.5 text-right">{fmtPrice(src.price)}</td>
                <td
                  className={`py-1.5 text-right ${
                    delta === null
                      ? "text-[var(--text-secondary)]"
                      : delta > 0
                        ? "text-[var(--accent-green)]"
                        : delta < 0
                          ? "text-[var(--accent-red)]"
                          : "text-[var(--text-secondary)]"
                  }`}
                >
                  {delta === null
                    ? "—"
                    : `${delta >= 0 ? "+" : "-"}${fmtPrice(Math.abs(delta))}`}
                </td>
                <td className="py-1.5 text-right text-[var(--text-secondary)]">
                  {fmtPrice(src.bid)}
                </td>
                <td className="py-1.5 text-right text-[var(--text-secondary)]">
                  {fmtPrice(src.ask)}
                </td>
              </tr>
            );
          })}

          {/* Oracle row */}
          {oracleEstimate > 0 && (
            <tr>
              <td className="py-1.5">
                <span className="flex items-center gap-1.5">
                  <span
                    className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                    style={{ background: "#f472b6" }}
                  />
                  oracle
                </span>
              </td>
              <td className="py-1.5 text-right text-[var(--text-secondary)]">—</td>
              <td className="py-1.5 text-right">{fmtPrice(oracleEstimate)}</td>
              <td className="py-1.5 text-right text-[var(--text-secondary)]">—</td>
              <td className="py-1.5 text-right text-[var(--text-secondary)]">—</td>
              <td className="py-1.5 text-right text-[var(--text-secondary)]">—</td>
            </tr>
          )}
        </tbody>
      </table>

      {/* Max spread row — uses healthy sources only */}
      {healthyPrices.length >= 2 && (
        <div
          className={`mt-3 pt-2.5 border-t border-[var(--border)] flex items-center justify-between text-xs font-mono ${
            spreadAboveThreshold
              ? "text-[var(--accent-green)]"
              : "text-[var(--text-secondary)]"
          }`}
        >
          <span>Max spread (healthy)</span>
          <span>
            {fmtPrice(maxSpread)}{" "}
            <span className="opacity-70">({spreadPct.toFixed(3)}%)</span>
            {" "}
            <span className="opacity-50">arb threshold {ARB_THRESHOLD_PCT}%</span>
          </span>
        </div>
      )}
    </div>
  );
}

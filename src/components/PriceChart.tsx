import { useMemo } from "react";
import { useRxValue } from "@effect-rx/rx-react";
import {
  priceHistoryRx,
  pricesRx,
  oracleEstimateRx,
  currentMarketRx,
  activeMarketIdRx,
  enabledMarketsRx,
} from "../store/index.js";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { TrendingUp, TrendingDown } from "lucide-react";

const EXCHANGE_COLORS: Record<string, string> = {
  binance: "#F0B90B",
  bybit: "#F7A600",
  coinbase: "#0052FF",
  kraken: "#5741D9",
  bitstamp: "#4A9C2D",
  okx: "#FFFFFF",
  oracle: "#f472b6",
};

const CHART_EXCHANGES = ["binance", "coinbase", "kraken", "oracle"] as const;

interface ChartPoint {
  time: number;
  label: string;
  [key: string]: number | string | undefined;
}

export function PriceChart() {
  const priceHistory = useRxValue(priceHistoryRx);
  const prices = useRxValue(pricesRx);
  const oracleEstimate = useRxValue(oracleEstimateRx);
  const currentMarket = useRxValue(currentMarketRx);
  const activeMarketId = useRxValue(activeMarketIdRx);
  const enabledMarkets = useRxValue(enabledMarketsRx);
  const activeDisplayName = enabledMarkets.find((m) => m.id === activeMarketId)?.displayName ?? activeMarketId.toUpperCase();
  const priceToBeat = currentMarket?.priceToBeat ?? 0;

  const latestPrice = useMemo(() => {
    let best: number | null = null;
    let bestTs = 0;
    for (const p of Object.values(prices)) {
      if (p.price > 0 && p.timestamp > bestTs) {
        best = p.price;
        bestTs = p.timestamp;
      }
    }
    return best ?? oracleEstimate;
  }, [prices, oracleEstimate]);

  const data = useMemo(() => {
    const buckets = new Map<number, ChartPoint>();
    const bucketSize = 2000;

    for (const p of priceHistory) {
      const key = Math.floor(p.time / bucketSize) * bucketSize;
      if (!buckets.has(key)) {
        buckets.set(key, {
          time: key,
          label: new Date(key).toLocaleTimeString(),
        });
      }
      const bucket = buckets.get(key)!;
      bucket[p.exchange] = p.price;
    }

    return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
  }, [priceHistory]);

  const domain = useMemo((): [number, number] | ["auto", "auto"] => {
    const allPrices = data.flatMap((d) =>
      Object.entries(d)
        .filter(([k]) => k !== "time" && k !== "label")
        .map(([, v]) => v)
        .filter((v): v is number => typeof v === "number"),
    );
    if (allPrices.length === 0) return ["auto", "auto"];
    const min = Math.min(...allPrices);
    const max = Math.max(...allPrices);
    const spread = max - min;
    const pad = Math.max(spread * 0.15, 3);
    return [min - pad, max + pad];
  }, [data]);

  const displayPrice = latestPrice > 0 ? latestPrice : oracleEstimate;
  const diff =
    priceToBeat > 0 && displayPrice > 0 ? displayPrice - priceToBeat : 0;
  const diffPct = priceToBeat > 0 ? (diff / priceToBeat) * 100 : 0;
  const isUp = diff >= 0;

  return (
    <div className="bg-[var(--bg-card)] rounded-xl p-4 border border-[var(--border)]">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-4">
          <span className="text-sm text-[var(--text-secondary)]">
            {activeDisplayName} Price
          </span>
          {displayPrice > 0 && (
            <div className="flex items-center gap-2">
              <span className="font-mono text-lg font-bold">
                $
                {displayPrice.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
              {priceToBeat > 0 && (
                <span
                  className={`flex items-center gap-0.5 text-xs font-mono ${isUp ? "text-[var(--accent-green)]" : "text-[var(--accent-red)]"}`}
                >
                  {isUp ? (
                    <TrendingUp size={12} />
                  ) : (
                    <TrendingDown size={12} />
                  )}
                  {diffPct >= 0 ? "+" : ""}
                  {diffPct.toFixed(3)}%
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex gap-3 flex-wrap justify-end">
          {CHART_EXCHANGES.map((name) => (
            <div key={name} className="flex items-center gap-1.5 text-xs">
              <span
                className="w-2.5 h-0.5 rounded"
                style={{
                  background: EXCHANGE_COLORS[name],
                  ...(name === "oracle"
                    ? { height: 2, borderTop: "1px dashed" }
                    : {}),
                }}
              />
              <span className="capitalize text-[var(--text-secondary)]">
                {name}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="h-56 min-w-0">
        <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={1}>
          <LineChart data={data}>
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: "#6b7280" }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              domain={domain}
              tick={{ fontSize: 10, fill: "#6b7280" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) =>
                `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
              }
              width={80}
            />
            <Tooltip
              contentStyle={{
                background: "var(--bg-secondary)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
              }}
              labelStyle={{ color: "var(--text-secondary)" }}
              formatter={(value: number | string | undefined) => [
                `$${Number(value ?? 0).toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                })}`,
              ]}
            />
            {priceToBeat > 0 && (
              <ReferenceLine
                y={priceToBeat}
                stroke="var(--accent-yellow)"
                strokeDasharray="4 4"
                strokeWidth={1}
                label={{
                  value: "Price to Beat",
                  position: "right",
                  fill: "#f59e0b",
                  fontSize: 10,
                }}
              />
            )}
            <Line
              type="monotone"
              dataKey="binance"
              stroke={EXCHANGE_COLORS.binance}
              dot={false}
              strokeWidth={1}
              isAnimationActive={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="coinbase"
              stroke={EXCHANGE_COLORS.coinbase}
              dot={false}
              strokeWidth={1}
              isAnimationActive={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="kraken"
              stroke={EXCHANGE_COLORS.kraken}
              dot={false}
              strokeWidth={1}
              isAnimationActive={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="oracle"
              stroke={EXCHANGE_COLORS.oracle}
              dot={false}
              strokeWidth={2}
              strokeDasharray="4 2"
              isAnimationActive={false}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

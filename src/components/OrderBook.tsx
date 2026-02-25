import { useRxValue } from "@effect-rx/rx-react";
import { orderBookRx } from "../store/index.js";
import { BookOpen } from "lucide-react";

export function OrderBook() {
  const orderBook = useRxValue(orderBookRx);

  const maxBidSize = Math.max(
    ...orderBook.up.bids.map((b) => b.size),
    ...orderBook.down.bids.map((b) => b.size),
    1,
  );
  const maxAskSize = Math.max(
    ...orderBook.up.asks.map((a) => a.size),
    ...orderBook.down.asks.map((a) => a.size),
    1,
  );

  const sum =
    (orderBook.bestAskUp ?? 0) + (orderBook.bestAskDown ?? 0);
  const hasArb = sum > 0 && sum < 1.0;

  return (
    <div className="bg-[var(--bg-card)] rounded-xl p-4 border border-[var(--border)]">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
          <BookOpen size={14} />
          <span>Order Book</span>
        </div>
        {sum > 0 && (
          <span
            className={`text-xs font-mono px-2 py-0.5 rounded ${
              hasArb
                ? "bg-[var(--accent-green)]/15 text-[var(--accent-green)]"
                : "bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
            }`}
          >
            Sum: ${sum.toFixed(4)}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Side
          label="UP"
          bids={orderBook.up.bids}
          asks={orderBook.up.asks}
          bestBid={orderBook.bestBidUp}
          bestAsk={orderBook.bestAskUp}
          maxBidSize={maxBidSize}
          maxAskSize={maxAskSize}
        />
        <Side
          label="DOWN"
          bids={orderBook.down.bids}
          asks={orderBook.down.asks}
          bestBid={orderBook.bestBidDown}
          bestAsk={orderBook.bestAskDown}
          maxBidSize={maxBidSize}
          maxAskSize={maxAskSize}
        />
      </div>
    </div>
  );
}

function Side({
  label,
  bids,
  asks,
  bestBid,
  bestAsk,
  maxBidSize,
  maxAskSize,
}: {
  label: string;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  bestBid: number | null;
  bestAsk: number | null;
  maxBidSize: number;
  maxAskSize: number;
}) {
  const topBids = bids.slice(0, 5);
  const topAsks = asks.slice(0, 5);

  return (
    <div>
      <div className="text-xs font-semibold mb-2 text-center">
        <span
          className={
            label === "UP"
              ? "text-[var(--accent-green)]"
              : "text-[var(--accent-red)]"
          }
        >
          {label}
        </span>
        <span className="text-[var(--text-secondary)] ml-2">
          {bestBid !== null && bestAsk !== null
            ? `${bestBid.toFixed(2)} / ${bestAsk.toFixed(2)}`
            : "—"}
        </span>
      </div>

      <div className="space-y-0.5">
        {topAsks
          .slice()
          .reverse()
          .map((a, i) => (
            <div key={`a${i}`} className="relative flex justify-between text-xs font-mono px-1 py-0.5">
              <div
                className="absolute inset-0 bg-[var(--accent-red)]/10 rounded-sm"
                style={{ width: `${(a.size / maxAskSize) * 100}%`, right: 0, left: "auto" }}
              />
              <span className="relative text-[var(--accent-red)]">
                {a.price.toFixed(2)}
              </span>
              <span className="relative text-[var(--text-secondary)]">
                {a.size.toFixed(0)}
              </span>
            </div>
          ))}
        <div className="border-t border-[var(--border)] my-1" />
        {topBids.map((b, i) => (
          <div key={`b${i}`} className="relative flex justify-between text-xs font-mono px-1 py-0.5">
            <div
              className="absolute inset-0 bg-[var(--accent-green)]/10 rounded-sm"
              style={{ width: `${(b.size / maxBidSize) * 100}%` }}
            />
            <span className="relative text-[var(--accent-green)]">
              {b.price.toFixed(2)}
            </span>
            <span className="relative text-[var(--text-secondary)]">
              {b.size.toFixed(0)}
            </span>
          </div>
        ))}
        {topBids.length === 0 && topAsks.length === 0 && (
          <div className="text-xs text-[var(--text-secondary)] text-center py-2">
            No data
          </div>
        )}
      </div>
    </div>
  );
}

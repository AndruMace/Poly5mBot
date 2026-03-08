import { describe, expect, it } from "vitest";
import { computeOracleEstimate } from "../../src/feeds/oracle.js";
import type { PricePoint } from "../../src/types.js";

function makePoint(exchange: string, price: number, ageMs: number): PricePoint {
  return {
    exchange,
    price,
    bid: price - 0.5,
    ask: price + 0.5,
    timestamp: Date.now() - ageMs,
  };
}

function makeMap(...pts: PricePoint[]): Map<string, PricePoint> {
  return new Map(pts.map((p) => [p.exchange, p]));
}

describe("computeOracleEstimate", () => {
  it("computes weighted mean for fresh prices with default weights", () => {
    // binance=4, bybit=2, coinbase=2 in defaults
    // (100000*4 + 100000*2 + 100000*2) / (4+2+2) = 100000
    const m = makeMap(
      makePoint("binance", 100000, 100),
      makePoint("bybit", 100000, 100),
      makePoint("coinbase", 100000, 100),
    );
    const { price, sourceCount } = computeOracleEstimate(m);
    expect(price).toBe(100000);
    expect(sourceCount).toBe(3);
  });

  it("uses custom weights when provided", () => {
    // Only 2 prices — outlier check: median=(100000+102000)/2=101000
    // both deviate ~1% > 0.15% → filtered=[]; vals=recent (both)
    // weighted mean: (100000*1 + 102000*3) / 4 = 406000/4 = 101500
    const m = makeMap(
      makePoint("binance", 100000, 100),
      makePoint("bybit", 102000, 100),
    );
    const { price } = computeOracleEstimate(m, { binance: 1.0, bybit: 3.0 });
    expect(price).toBe(101500);
  });

  it("reduces oracle pull toward aging price at 7s (staleFactor=0.6)", () => {
    // Prices close enough to pass outlier filter (all within 0.15% of median)
    // binance=100000, bybit=100010, coinbase=100005; median=100005; max deviation=10/100005≈0.01%
    const weights = { binance: 1.0, bybit: 1.0, coinbase: 1.0 };

    const freshMap = makeMap(
      makePoint("binance", 100000, 100),
      makePoint("bybit", 100010, 100),   // fresh bybit
      makePoint("coinbase", 100005, 100),
    );
    const staleMap = makeMap(
      makePoint("binance", 100000, 100),
      makePoint("bybit", 100010, 7000),  // 7s old → staleFactor = 1 - 2000/5000 = 0.6
      makePoint("coinbase", 100005, 100),
    );

    const { price: freshOracle } = computeOracleEstimate(freshMap, weights);
    const { price: staleOracle } = computeOracleEstimate(staleMap, weights);

    // Bybit (100010) is above others; aging it reduces its pull → oracle should be lower
    expect(staleOracle).toBeLessThan(freshOracle);
  });

  it("excludes prices older than 10s (hard cutoff)", () => {
    const m = makeMap(
      makePoint("binance", 100000, 100),
      makePoint("bybit", 105000, 11000),  // 11s old → excluded
      makePoint("coinbase", 100000, 100),
    );
    const { price, sourceCount } = computeOracleEstimate(m);
    // Only binance and coinbase contribute
    expect(sourceCount).toBe(2);
    expect(price).toBe(100000);
  });

  it("decays bybit contribution monotonically as it ages", () => {
    // Bybit price above others; as it ages, oracle should drift lower monotonically
    const weights = { binance: 1.0, bybit: 1.0, coinbase: 1.0 };
    const basePts = [makePoint("binance", 100000, 100), makePoint("coinbase", 100005, 100)];

    const at5s = computeOracleEstimate(
      makeMap(...basePts, makePoint("bybit", 100010, 5000)),
      weights,
    ).price;
    const at7500 = computeOracleEstimate(
      makeMap(...basePts, makePoint("bybit", 100010, 7500)),
      weights,
    ).price;
    const at9900 = computeOracleEstimate(
      makeMap(...basePts, makePoint("bybit", 100010, 9900)),
      weights,
    ).price;

    // Each successive age should reduce oracle further from bybit's high price
    expect(at5s).toBeGreaterThanOrEqual(at7500);
    expect(at7500).toBeGreaterThanOrEqual(at9900);
  });

  it("returns price 0 and sourceCount 0 when prices map is empty", () => {
    const { price, sourceCount } = computeOracleEstimate(new Map());
    expect(price).toBe(0);
    expect(sourceCount).toBe(0);
  });

  it("returns price 0 and sourceCount 0 when all prices are stale", () => {
    const m = makeMap(makePoint("binance", 100000, 15000));
    const { price, sourceCount } = computeOracleEstimate(m);
    expect(price).toBe(0);
    expect(sourceCount).toBe(0);
  });

  it("preserves sub-cent precision for low-priced assets", () => {
    const m = makeMap(
      makePoint("binance", 2.1234, 100),
      makePoint("bybit", 2.1235, 100),
      makePoint("coinbase", 2.1236, 100),
    );
    const { price, sourceCount } = computeOracleEstimate(m, {
      binance: 1,
      bybit: 1,
      coinbase: 1,
    });
    expect(sourceCount).toBe(3);
    expect(price).toBeCloseTo(2.1235, 4);
  });

  it("outlier rejection still works when staleFactor is present", () => {
    // Bybit at 200000 is a clear outlier vs binance/coinbase/okx near 100000
    // Median ≈ 100003; Bybit deviation >> 0.15% → filtered out
    // filtered = [binance, coinbase, okx] (3 items ≥ 3) → use filtered
    const m = makeMap(
      makePoint("binance", 100000, 100),
      makePoint("bybit", 200000, 100),
      makePoint("coinbase", 100005, 100),
      makePoint("okx", 99995, 100),
    );
    const { price, sourceCount } = computeOracleEstimate(m);
    expect(sourceCount).toBe(3);
    expect(price).toBeGreaterThan(99990);
    expect(price).toBeLessThan(100020);
  });
});

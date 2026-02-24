import { BaseStrategy } from "./base.js";
import { computeRSI, buildCandles } from "../indicators/technical.js";
import type { MarketContext, Signal, PricePoint } from "../types.js";

/**
 * Strategy 4: Mean Reversion & Scalping
 *
 * Uses RSI on 1-minute candles to detect overextended moves.
 * If RSI > overbought and price spiked early in the window, bets on
 * reversion (Down). If RSI < oversold and price dropped, bets Up.
 */
export class MeanReversionStrategy extends BaseStrategy {
  readonly name = "mean-reversion";
  private priceBuffer: PricePoint[] = [];

  constructor() {
    super();
    this.config = {
      rsiPeriod: 7,
      rsiOverbought: 62,
      rsiOversold: 38,
      minWindowElapsedSec: 60,
      maxWindowElapsedSec: 270,
      minPriceMovePct: 0.03,
      maxSharePrice: 0.65,
      tradeSize: 8,
    };
    this.regimeFilter = {
      allowedVolatility: ["low", "normal", "high"],
      allowedTrend: ["chop", "up", "down"],
    };
  }

  addPrice(point: PricePoint): void {
    this.priceBuffer.push(point);
    const cutoff = Date.now() - 15 * 60_000;
    this.priceBuffer = this.priceBuffer.filter((p) => p.timestamp > cutoff);
  }

  evaluate(ctx: MarketContext): Signal | null {
    if (!ctx.currentWindow || !ctx.priceToBeat) return null;

    const elapsedSec = ctx.windowElapsedMs / 1000;
    if (elapsedSec < this.config["minWindowElapsedSec"]!) return null;
    if (elapsedSec > this.config["maxWindowElapsedSec"]!) return null;

    this.status = "watching";

    const candles = buildCandles(this.priceBuffer, 60_000);
    if (candles.length < this.config["rsiPeriod"]! + 1) return null;

    const rsi = computeRSI(candles, this.config["rsiPeriod"]!);
    if (rsi === null) return null;

    const priceMove =
      ((ctx.currentBtcPrice - ctx.priceToBeat) / ctx.priceToBeat) * 100;
    const absMove = Math.abs(priceMove);

    if (absMove < this.config["minPriceMovePct"]!) return null;

    let side: "UP" | "DOWN" | null = null;
    let reason = "";

    if (rsi > this.config["rsiOverbought"]! && priceMove > 0) {
      side = "DOWN";
      reason = `RSI=${rsi.toFixed(1)} overbought, price +${absMove.toFixed(3)}% — expecting reversion`;
    } else if (rsi < this.config["rsiOversold"]! && priceMove < 0) {
      side = "UP";
      reason = `RSI=${rsi.toFixed(1)} oversold, price -${absMove.toFixed(3)}% — expecting reversion`;
    }

    if (!side) return null;

    const confidence = Math.min(
      1,
      Math.abs(rsi - 50) / 30,
    );

    this.status = "trading";
    const signal: Signal = {
      side,
      confidence,
      size: this.config["tradeSize"]!,
      maxPrice: this.config["maxSharePrice"] ?? 0.65,
      strategy: this.name,
      reason,
      timestamp: Date.now(),
    };
    this.lastSignal = signal;
    return signal;
  }
}

import { config } from "../config.js";
import type { Signal, TradeRecord, MarketContext } from "../types.js";

export interface KillSwitchStatus {
  name: string;
  active: boolean;
  reason: string;
}

export class RiskManager {
  private openPositions: TradeRecord[] = [];
  private dailyPnl = 0;
  private dailyReset = this.startOfDay();
  private hourlyPnl = 0;
  private hourlyReset = this.startOfHour();
  private windowLosses = 0;
  private currentWindowId = "";
  private consecutiveLosses = 0;
  private pauseUntil = 0;

  approve(
    signal: Signal,
    ctx?: MarketContext,
    positionSlots = 1,
  ): { approved: boolean; reason: string } {
    this.checkDayRollover();
    this.checkHourRollover();

    if (Date.now() < this.pauseUntil) {
      const remaining = Math.ceil((this.pauseUntil - Date.now()) / 1000);
      return {
        approved: false,
        reason: `Auto-paused for ${remaining}s`,
      };
    }

    if (signal.size > config.risk.maxTradeSize) {
      return {
        approved: false,
        reason: `Trade size $${signal.size} exceeds max $${config.risk.maxTradeSize}`,
      };
    }

    const currentExposure = this.openPositions.reduce(
      (sum, t) => sum + t.size,
      0,
    );
    if (currentExposure + signal.size > config.risk.maxTotalExposure) {
      return {
        approved: false,
        reason: `Would exceed max exposure $${config.risk.maxTotalExposure} (current: $${currentExposure.toFixed(2)})`,
      };
    }

    if (this.openPositions.length + positionSlots > config.risk.maxConcurrentPositions) {
      return {
        approved: false,
        reason: `Max concurrent positions (${config.risk.maxConcurrentPositions}) would be exceeded`,
      };
    }

    if (this.dailyPnl <= -config.risk.maxDailyLoss) {
      return {
        approved: false,
        reason: `Daily loss limit hit ($${this.dailyPnl.toFixed(2)} / -$${config.risk.maxDailyLoss})`,
      };
    }

    if (this.hourlyPnl <= -config.risk.maxHourlyLoss) {
      this.pauseUntil = Date.now() + 3600_000;
      return {
        approved: false,
        reason: `Hourly loss limit hit ($${this.hourlyPnl.toFixed(2)} / -$${config.risk.maxHourlyLoss}), paused 1hr`,
      };
    }

    if (this.windowLosses >= config.risk.maxLossPerWindow) {
      return {
        approved: false,
        reason: `Window loss limit (${config.risk.maxLossPerWindow}) reached`,
      };
    }

    if (this.consecutiveLosses >= config.risk.maxConsecutiveLosses) {
      this.pauseUntil = Date.now() + 300_000;
      return {
        approved: false,
        reason: `${this.consecutiveLosses} consecutive losses, paused 5min`,
      };
    }

    if (Date.now() - signal.timestamp > config.risk.maxSignalAgeMs) {
      return {
        approved: false,
        reason: `Signal too old (${Date.now() - signal.timestamp}ms > ${config.risk.maxSignalAgeMs}ms)`,
      };
    }

    if (ctx) {
      const health = this.checkDataHealth(ctx);
      if (!health.healthy) {
        return { approved: false, reason: health.reason };
      }

      const spreadCheck = this.checkSpread(signal, ctx);
      if (!spreadCheck.ok) {
        return { approved: false, reason: spreadCheck.reason };
      }
    }

    return { approved: true, reason: "OK" };
  }

  checkDataHealth(ctx: MarketContext): { healthy: boolean; reason: string } {
    const priceEntries = Object.values(ctx.prices);
    if (priceEntries.length === 0) {
      return { healthy: false, reason: "No price data available" };
    }
    const now = Date.now();
    let latestTs = 0;
    for (const p of priceEntries) {
      if (p.timestamp > latestTs) latestTs = p.timestamp;
    }
    if (now - latestTs > config.risk.staleDataMs) {
      return {
        healthy: false,
        reason: `Stale price data (${now - latestTs}ms old > ${config.risk.staleDataMs}ms)`,
      };
    }
    return { healthy: true, reason: "OK" };
  }

  private checkSpread(
    signal: Signal,
    ctx: MarketContext,
  ): { ok: boolean; reason: string } {
    const ob = ctx.orderBook;
    const side = signal.side;
    const bestAsk = side === "UP" ? ob.bestAskUp : ob.bestAskDown;
    const bestBid = side === "UP" ? ob.bestBidUp : ob.bestBidDown;
    if (bestAsk !== null && bestBid !== null) {
      const spreadCents = (bestAsk - bestBid) * 100;
      if (spreadCents > config.risk.maxSpreadCents) {
        return {
          ok: false,
          reason: `Spread blowout (${spreadCents.toFixed(0)}¢ > ${config.risk.maxSpreadCents}¢)`,
        };
      }
    }
    return { ok: true, reason: "OK" };
  }

  onTradeOpened(trade: TradeRecord, shadow = false): void {
    if (shadow) return;
    this.openPositions.push(trade);
  }

  onTradeClosed(trade: TradeRecord, shadow = false): void {
    this.openPositions = this.openPositions.filter((t) => t.id !== trade.id);
    if (shadow) return;

    this.dailyPnl += trade.pnl;
    this.hourlyPnl += trade.pnl;

    if (trade.outcome === "loss") {
      this.consecutiveLosses++;
      this.windowLosses++;
    } else if (trade.outcome === "win") {
      this.consecutiveLosses = 0;
    }
  }

  onNewWindow(conditionId: string): void {
    if (conditionId !== this.currentWindowId) {
      this.currentWindowId = conditionId;
      this.windowLosses = 0;
    }
  }

  resolveExpired(now: number): TradeRecord[] {
    const expired = this.openPositions.filter(
      (t) => (t.status === "filled" || t.status === "partial") && now >= t.windowEnd,
    );
    for (const t of expired) {
      this.openPositions = this.openPositions.filter((p) => p.id !== t.id);
    }
    return expired;
  }

  resetPause(): void {
    this.pauseUntil = 0;
    this.consecutiveLosses = 0;
  }

  getOpenPositions(): TradeRecord[] {
    return [...this.openPositions];
  }

  getDailyPnl(): number {
    return this.dailyPnl;
  }

  getHourlyPnl(): number {
    return this.hourlyPnl;
  }

  getWindowLosses(): number {
    return this.windowLosses;
  }

  getConsecutiveLosses(): number {
    return this.consecutiveLosses;
  }

  getPauseRemainingSec(now = Date.now()): number {
    if (now >= this.pauseUntil) return 0;
    return Math.ceil((this.pauseUntil - now) / 1000);
  }

  getOpenExposure(): number {
    return this.openPositions.reduce((sum, t) => sum + t.size, 0);
  }

  getKillSwitchStatus(): KillSwitchStatus[] {
    return [
      {
        name: "Daily Loss",
        active: this.dailyPnl <= -config.risk.maxDailyLoss,
        reason: `$${this.dailyPnl.toFixed(2)} / -$${config.risk.maxDailyLoss}`,
      },
      {
        name: "Hourly Loss",
        active: this.hourlyPnl <= -config.risk.maxHourlyLoss,
        reason: `$${this.hourlyPnl.toFixed(2)} / -$${config.risk.maxHourlyLoss}`,
      },
      {
        name: "Window Losses",
        active: this.windowLosses >= config.risk.maxLossPerWindow,
        reason: `${this.windowLosses} / ${config.risk.maxLossPerWindow}`,
      },
      {
        name: "Consecutive Losses",
        active: this.consecutiveLosses >= config.risk.maxConsecutiveLosses,
        reason: `${this.consecutiveLosses} / ${config.risk.maxConsecutiveLosses}`,
      },
      {
        name: "Auto-Pause",
        active: Date.now() < this.pauseUntil,
        reason:
          Date.now() < this.pauseUntil
            ? `${Math.ceil((this.pauseUntil - Date.now()) / 1000)}s remaining`
            : "Inactive",
      },
    ];
  }

  private checkDayRollover(): void {
    const today = this.startOfDay();
    if (today > this.dailyReset) {
      this.dailyPnl = 0;
      this.dailyReset = today;
    }
  }

  private checkHourRollover(): void {
    const thisHour = this.startOfHour();
    if (thisHour > this.hourlyReset) {
      this.hourlyPnl = 0;
      this.hourlyReset = thisHour;
    }
  }

  private startOfDay(): number {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  private startOfHour(): number {
    const d = new Date();
    d.setMinutes(0, 0, 0);
    return d.getTime();
  }
}

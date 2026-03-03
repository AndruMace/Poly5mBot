import { Effect, Ref } from "effect";
import { AppConfig } from "../config.js";
import type { Signal, TradeRecord, MarketContext, KillSwitchStatus, RiskApproval, RiskSnapshot } from "../types.js";

interface RiskState {
  openPositions: TradeRecord[];
  dailyPnl: number;
  dailyReset: number;
  hourlyPnl: number;
  hourlyReset: number;
  windowLosses: number;
  currentWindowId: string;
  consecutiveLosses: number;
  pauseUntil: number;
  windowSpend: number;
  windowTradeCount: number;
}

function startOfDay(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfHour(): number {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

export class RiskManager extends Effect.Service<RiskManager>()("RiskManager", {
  effect: Effect.gen(function* () {
    const config = yield* AppConfig;
    const stateRef = yield* Ref.make<RiskState>({
      openPositions: [],
      dailyPnl: 0,
      dailyReset: startOfDay(),
      hourlyPnl: 0,
      hourlyReset: startOfHour(),
      windowLosses: 0,
      currentWindowId: "",
      consecutiveLosses: 0,
      pauseUntil: 0,
      windowSpend: 0,
      windowTradeCount: 0,
    });

    const rollover = Ref.update(stateRef, (s) => {
      let updated = s;
      const today = startOfDay();
      if (today > s.dailyReset) {
        updated = { ...updated, dailyPnl: 0, dailyReset: today };
      }
      const thisHour = startOfHour();
      if (thisHour > s.hourlyReset) {
        updated = { ...updated, hourlyPnl: 0, hourlyReset: thisHour };
      }
      return updated;
    });

    const approve = (signal: Signal, ctx?: MarketContext, positionSlots = 1): Effect.Effect<RiskApproval> =>
      Effect.gen(function* () {
        yield* rollover;
        const s = yield* Ref.get(stateRef);

        if (Date.now() < s.pauseUntil) {
          const remaining = Math.ceil((s.pauseUntil - Date.now()) / 1000);
          return { approved: false, reason: `Auto-paused for ${remaining}s` };
        }
        if (signal.size > config.risk.maxTradeSize) {
          return { approved: false, reason: `Trade size $${signal.size} exceeds max $${config.risk.maxTradeSize}` };
        }
        const currentExposure = s.openPositions.reduce((sum, t) => sum + t.size, 0);
        if (currentExposure + signal.size > config.risk.maxTotalExposure) {
          return { approved: false, reason: `Would exceed max exposure $${config.risk.maxTotalExposure} (current: $${currentExposure.toFixed(2)})` };
        }
        if (s.openPositions.length + positionSlots > config.risk.maxConcurrentPositions) {
          return { approved: false, reason: `Max concurrent positions (${config.risk.maxConcurrentPositions}) would be exceeded` };
        }
        if (s.dailyPnl <= -config.risk.maxDailyLoss) {
          return { approved: false, reason: `Daily loss limit hit ($${s.dailyPnl.toFixed(2)} / -$${config.risk.maxDailyLoss})` };
        }
        if (s.hourlyPnl <= -config.risk.maxHourlyLoss) {
          yield* Ref.update(stateRef, (st) => ({ ...st, pauseUntil: Date.now() + 3600_000 }));
          return { approved: false, reason: `Hourly loss limit hit ($${s.hourlyPnl.toFixed(2)} / -$${config.risk.maxHourlyLoss}), paused 1hr` };
        }
        if (s.windowLosses >= config.risk.maxLossPerWindow) {
          return { approved: false, reason: `Window loss limit (${config.risk.maxLossPerWindow}) reached` };
        }
        if (s.windowSpend + signal.size > config.risk.maxWindowSpend) {
          return { approved: false, reason: `Window spend cap ($${s.windowSpend.toFixed(2)} / $${config.risk.maxWindowSpend})` };
        }
        if (s.windowTradeCount >= config.risk.maxWindowTrades) {
          return { approved: false, reason: `Window trade count cap (${s.windowTradeCount} / ${config.risk.maxWindowTrades})` };
        }
        if (s.consecutiveLosses >= config.risk.maxConsecutiveLosses) {
          yield* Ref.update(stateRef, (st) => ({ ...st, pauseUntil: Date.now() + 300_000 }));
          return { approved: false, reason: `${s.consecutiveLosses} consecutive losses, paused 5min` };
        }
        if (Date.now() - signal.timestamp > config.risk.maxSignalAgeMs) {
          return { approved: false, reason: `Signal too old (${Date.now() - signal.timestamp}ms > ${config.risk.maxSignalAgeMs}ms)` };
        }

        if (ctx) {
          const priceEntries = Object.values(ctx.prices);
          if (priceEntries.length === 0) {
            return { approved: false, reason: "No price data available" };
          }
          const now = Date.now();
          let latestTs = 0;
          for (const p of priceEntries) { if (p.timestamp > latestTs) latestTs = p.timestamp; }
          if (now - latestTs > config.risk.staleDataMs) {
            return { approved: false, reason: `Stale price data (${now - latestTs}ms old > ${config.risk.staleDataMs}ms)` };
          }

          const ob = ctx.orderBook;
          const bestAsk = signal.side === "UP" ? ob.bestAskUp : ob.bestAskDown;
          const bestBid = signal.side === "UP" ? ob.bestBidUp : ob.bestBidDown;
          if (bestAsk !== null && bestBid !== null) {
            const spreadCents = (bestAsk - bestBid) * 100;
            if (spreadCents > config.risk.maxSpreadCents) {
              return { approved: false, reason: `Spread blowout (${spreadCents.toFixed(0)}¢ > ${config.risk.maxSpreadCents}¢)` };
            }
          }
        }

        return { approved: true, reason: "OK" };
      });

    const onTradeOpened = (trade: TradeRecord, shadow = false) =>
      shadow ? Effect.void : Ref.update(stateRef, (s) => ({
        ...s,
        openPositions: [...s.openPositions, trade],
        windowSpend: s.windowSpend + trade.size,
        windowTradeCount: s.windowTradeCount + 1,
      }));

    const onTradeClosed = (trade: TradeRecord, shadow = false) =>
      Ref.update(stateRef, (s) => {
        let updated = { ...s, openPositions: s.openPositions.filter((t) => t.id !== trade.id) };
        if (!shadow) {
          updated.dailyPnl += trade.pnl;
          updated.hourlyPnl += trade.pnl;
          if (trade.outcome === "loss") {
            updated.consecutiveLosses++;
            updated.windowLosses++;
          } else if (trade.outcome === "win") {
            updated.consecutiveLosses = 0;
          }
        }
        return updated;
      });

    const onNewWindow = (conditionId: string) =>
      Ref.update(stateRef, (s) =>
        conditionId !== s.currentWindowId
          ? { ...s, currentWindowId: conditionId, windowLosses: 0, windowSpend: 0, windowTradeCount: 0 }
          : s,
      );

    const resolveExpired = (now: number) =>
      Ref.modify(stateRef, (s) => {
        const expired = s.openPositions.filter(
          (t) => (t.status === "filled" || t.status === "partial" || t.status === "submitted") && now >= t.windowEnd,
        );
        return [expired, { ...s, openPositions: s.openPositions.filter((t) => !expired.includes(t)) }] as const;
      });

    const resetPause = Ref.update(stateRef, (s) => ({ ...s, pauseUntil: 0, consecutiveLosses: 0 }));

    const rehydrate = (trades: TradeRecord[], currentWindowId = "") =>
      Ref.update(stateRef, (s) => {
        const now = Date.now();
        const dayCutoff = startOfDay();
        const hourCutoff = startOfHour();
        const liveTrades = trades.filter((t) => !t.shadow);
        const openPositions = liveTrades.filter(
          (t) =>
            (t.status === "filled" || t.status === "partial" || t.status === "submitted") &&
            t.windowEnd > now &&
            t.outcome === null,
        );
        const resolved = liveTrades
          .filter((t) => t.status === "resolved")
          .sort((a, b) => a.timestamp - b.timestamp);

        const dailyPnl = resolved
          .filter((t) => t.timestamp >= dayCutoff)
          .reduce((acc, t) => acc + t.pnl, 0);
        const hourlyPnl = resolved
          .filter((t) => t.timestamp >= hourCutoff)
          .reduce((acc, t) => acc + t.pnl, 0);

        let consecutiveLosses = 0;
        for (let i = resolved.length - 1; i >= 0; i--) {
          const t = resolved[i]!;
          if (t.outcome === "loss") {
            consecutiveLosses += 1;
          } else if (t.outcome === "win") {
            break;
          }
        }

        const windowLosses = resolved.filter(
          (t) => t.conditionId === currentWindowId && t.outcome === "loss",
        ).length;

        const windowSpend = openPositions.reduce((sum, t) => sum + t.size, 0);
        const windowTradeCount = openPositions.length;

        return {
          ...s,
          openPositions,
          dailyPnl,
          dailyReset: dayCutoff,
          hourlyPnl,
          hourlyReset: hourCutoff,
          windowLosses,
          currentWindowId: currentWindowId || s.currentWindowId,
          consecutiveLosses,
          pauseUntil: 0,
          windowSpend,
          windowTradeCount,
        };
      });

    const getSnapshot: Effect.Effect<RiskSnapshot> = Ref.get(stateRef).pipe(
      Effect.map((s) => ({
        openPositions: s.openPositions.length,
        maxConcurrentPositions: config.risk.maxConcurrentPositions,
        openExposure: s.openPositions.reduce((sum, t) => sum + t.size, 0),
        maxTotalExposure: config.risk.maxTotalExposure,
        dailyPnl: s.dailyPnl,
        maxDailyLoss: config.risk.maxDailyLoss,
        hourlyPnl: s.hourlyPnl,
        maxHourlyLoss: config.risk.maxHourlyLoss,
        consecutiveLosses: s.consecutiveLosses,
        maxConsecutiveLosses: config.risk.maxConsecutiveLosses,
        windowLosses: s.windowLosses,
        maxLossPerWindow: config.risk.maxLossPerWindow,
        pauseRemainingSec: Date.now() < s.pauseUntil ? Math.ceil((s.pauseUntil - Date.now()) / 1000) : 0,
        windowSpend: s.windowSpend,
        maxWindowSpend: config.risk.maxWindowSpend,
        windowTradeCount: s.windowTradeCount,
        maxWindowTrades: config.risk.maxWindowTrades,
      })),
    );

    const getKillSwitchStatus: Effect.Effect<KillSwitchStatus[]> = Ref.get(stateRef).pipe(
      Effect.map((s) => [
        { name: "Daily Loss", active: s.dailyPnl <= -config.risk.maxDailyLoss, reason: `$${s.dailyPnl.toFixed(2)} / -$${config.risk.maxDailyLoss}` },
        { name: "Hourly Loss", active: s.hourlyPnl <= -config.risk.maxHourlyLoss, reason: `$${s.hourlyPnl.toFixed(2)} / -$${config.risk.maxHourlyLoss}` },
        { name: "Window Losses", active: s.windowLosses >= config.risk.maxLossPerWindow, reason: `${s.windowLosses} / ${config.risk.maxLossPerWindow}` },
        { name: "Consecutive Losses", active: s.consecutiveLosses >= config.risk.maxConsecutiveLosses, reason: `${s.consecutiveLosses} / ${config.risk.maxConsecutiveLosses}` },
        { name: "Auto-Pause", active: Date.now() < s.pauseUntil, reason: Date.now() < s.pauseUntil ? `${Math.ceil((s.pauseUntil - Date.now()) / 1000)}s remaining` : "Inactive" },
        { name: "Window Spend", active: s.windowSpend >= config.risk.maxWindowSpend, reason: `$${s.windowSpend.toFixed(2)} / $${config.risk.maxWindowSpend}` },
        { name: "Window Trades", active: s.windowTradeCount >= config.risk.maxWindowTrades, reason: `${s.windowTradeCount} / ${config.risk.maxWindowTrades}` },
      ]),
    );

    const getOpenPositions = Ref.get(stateRef).pipe(Effect.map((s) => [...s.openPositions]));

    return {
      approve,
      onTradeOpened,
      onTradeClosed,
      onNewWindow,
      resolveExpired,
      resetPause,
      rehydrate,
      getSnapshot,
      getKillSwitchStatus,
      getOpenPositions,
    } as const;
  }),
}) {}

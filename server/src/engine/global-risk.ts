import { Effect, Ref } from "effect";
import { AppConfig } from "../config.js";
import type { Signal, RiskApproval } from "../types.js";

interface GlobalRiskState {
  dailyPnl: number;
  dailyReset: number;
  hourlyPnl: number;
  hourlyReset: number;
  totalExposure: number;
  totalOpenPositions: number;
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

export class GlobalRiskManager extends Effect.Service<GlobalRiskManager>()("GlobalRiskManager", {
  effect: Effect.gen(function* () {
    const config = yield* AppConfig;
    const stateRef = yield* Ref.make<GlobalRiskState>({
      dailyPnl: 0,
      dailyReset: startOfDay(),
      hourlyPnl: 0,
      hourlyReset: startOfHour(),
      totalExposure: 0,
      totalOpenPositions: 0,
    });

    const rollover = Ref.update(stateRef, (s) => {
      let updated = s;
      const today = startOfDay();
      if (today > s.dailyReset) updated = { ...updated, dailyPnl: 0, dailyReset: today };
      const thisHour = startOfHour();
      if (thisHour > s.hourlyReset) updated = { ...updated, hourlyPnl: 0, hourlyReset: thisHour };
      return updated;
    });

    const approve = (signal: Signal): Effect.Effect<RiskApproval> =>
      Effect.gen(function* () {
        yield* rollover;
        const s = yield* Ref.get(stateRef);

        if (s.totalExposure + signal.size > config.risk.maxTotalExposure) {
          return { approved: false, reason: `Global exposure limit ($${s.totalExposure.toFixed(2)} / $${config.risk.maxTotalExposure})` };
        }
        if (s.dailyPnl <= -config.risk.maxDailyLoss) {
          return { approved: false, reason: `Global daily loss limit ($${s.dailyPnl.toFixed(2)} / -$${config.risk.maxDailyLoss})` };
        }
        if (s.hourlyPnl <= -config.risk.maxHourlyLoss) {
          return { approved: false, reason: `Global hourly loss limit ($${s.hourlyPnl.toFixed(2)} / -$${config.risk.maxHourlyLoss})` };
        }
        return { approved: true, reason: "OK" };
      });

    const onTradeOpened = (size: number) =>
      Ref.update(stateRef, (s) => ({
        ...s,
        totalExposure: s.totalExposure + size,
        totalOpenPositions: s.totalOpenPositions + 1,
      }));

    const onTradeClosed = (size: number, pnl: number) =>
      Ref.update(stateRef, (s) => ({
        ...s,
        totalExposure: Math.max(0, s.totalExposure - size),
        totalOpenPositions: Math.max(0, s.totalOpenPositions - 1),
        dailyPnl: s.dailyPnl + pnl,
        hourlyPnl: s.hourlyPnl + pnl,
      }));

    const getState = Ref.get(stateRef);

    return { approve, onTradeOpened, onTradeClosed, getState } as const;
  }),
}) {}

import { Effect } from "effect";
import type { TradeRecord } from "../types.js";

type IncidentKind =
  | "unmatched_account_fill"
  | "oversize_account_fill"
  | "efficiency_partial_incident"
  | "reconciler_error";

interface ReconcilerDeps {
  maxTradeSize: number;
  listRecentOrders: (
    sinceMs: number,
    limit: number,
  ) => Effect.Effect<
    Array<{
      side: string | null;
      mappedStatus: string | null;
      filledShares?: number | null;
      avgPrice?: number | null;
      orderId?: string | null;
      updatedAtMs?: number | null;
      rawStatus?: string | null;
      reason?: string | null;
    }>,
    never,
    never
  >;
  listLiveTrades: (
    args: { mode: "live"; sinceMs: number; limit: number },
  ) => Effect.Effect<{ items: TradeRecord[] }, never, never>;
  listActivity: (
    args: { limit: number; sinceSec: number },
  ) => Effect.Effect<
    {
      items: Array<{
        id: string;
        action: string;
        hash: string;
        marketName: string;
        tokenName: string;
        timestamp: number;
        usdcAmount: number;
      }>;
    },
    never,
    never
  >;
  obs: (input: any) => Effect.Effect<void, never, never>;
  haltTradingWithIncident: (incident: {
    kind: IncidentKind;
    message: string;
    fingerprint: string;
    details: Record<string, unknown>;
  }) => Effect.Effect<void, never, never>;
}

export function makeAccountReconciler(deps: ReconcilerDeps) {
  return Effect.gen(function* () {
    const now = Date.now();
    const sinceSec = Math.floor((now - 5 * 60_000) / 1000);
    const sinceMs = sinceSec * 1000;
    const venueOrders = yield* deps.listRecentOrders(sinceMs, 300);
    const liveTrades = yield* deps.listLiveTrades({ mode: "live", sinceMs, limit: 1000 });

    for (const order of venueOrders) {
      if (order.side !== "BUY") continue;
      if (order.mappedStatus !== "filled" && order.mappedStatus !== "partial") continue;
      const filledNotional = (order.filledShares ?? 0) * (order.avgPrice ?? 0);
      if (filledNotional <= 0) continue;

      const matchingTrade = liveTrades.items.some((t) => {
        if (t.shadow) return false;
        if (t.clobOrderId && order.orderId) return t.clobOrderId === order.orderId;
        const closeInTime = order.updatedAtMs ? Math.abs(t.timestamp - order.updatedAtMs) <= 120_000 : true;
        const closeInSize = Math.abs(t.size - filledNotional) <= 0.2;
        return closeInTime && closeInSize;
      });

      if (filledNotional > deps.maxTradeSize + 1e-6) {
        yield* deps.obs({
          category: "risk",
          source: "reconciler",
          action: "oversize_fill_detected",
          entityType: "trade",
          entityId: order.orderId ?? null,
          status: "rejected",
          mode: "live",
          payload: {
            source: "clob",
            filledNotional,
            maxTradeSize: deps.maxTradeSize,
          },
        });
        yield* deps.haltTradingWithIncident({
          kind: "oversize_account_fill",
          message: `Observed venue BUY fill $${filledNotional.toFixed(4)} above maxTradeSize $${deps.maxTradeSize.toFixed(4)}.`,
          fingerprint: `venue-oversize:${order.orderId}:${filledNotional.toFixed(4)}`,
          details: {
            source: "clob",
            orderId: order.orderId,
            status: order.rawStatus,
            updatedAtMs: order.updatedAtMs,
            avgPrice: order.avgPrice,
            filledShares: order.filledShares,
            filledNotional,
          },
        });
        continue;
      }

      if (!matchingTrade) {
        yield* deps.obs({
          category: "risk",
          source: "reconciler",
          action: "unmatched_fill_detected",
          entityType: "trade",
          entityId: order.orderId ?? null,
          status: "anomaly",
          mode: "live",
          payload: {
            source: "clob",
            filledNotional,
            updatedAtMs: order.updatedAtMs,
          },
        });
        yield* deps.haltTradingWithIncident({
          kind: "unmatched_account_fill",
          message: "Observed venue BUY fill that does not match any tracked live trade in reconciliation window.",
          fingerprint: `venue-unmatched:${order.orderId}:${order.updatedAtMs ?? "na"}`,
          details: {
            source: "clob",
            orderId: order.orderId,
            status: order.rawStatus,
            updatedAtMs: order.updatedAtMs,
            avgPrice: order.avgPrice,
            filledShares: order.filledShares,
            filledNotional,
          },
        });
      }
    }

    const activities = yield* deps.listActivity({ limit: 500, sinceSec });
    if (activities.items.length === 0) return;

    for (const a of activities.items) {
      if (a.action !== "Buy") continue;
      const matching = liveTrades.items.some((t) => {
        const closeInTime = Math.abs(t.timestamp - a.timestamp * 1000) <= 120_000;
        const closeInSize = Math.abs(t.size - a.usdcAmount) <= 0.15;
        return !t.shadow && closeInTime && closeInSize;
      });

      if (a.usdcAmount > deps.maxTradeSize + 1e-6) {
        yield* deps.obs({
          category: "risk",
          source: "reconciler",
          action: "oversize_activity_detected",
          entityType: "activity",
          entityId: a.id,
          status: "rejected",
          mode: "live",
          payload: {
            hash: a.hash,
            usdcAmount: a.usdcAmount,
            maxTradeSize: deps.maxTradeSize,
          },
        });
        yield* deps.haltTradingWithIncident({
          kind: "oversize_account_fill",
          message: `Observed account BUY $${a.usdcAmount.toFixed(4)} above maxTradeSize $${deps.maxTradeSize.toFixed(4)}.`,
          fingerprint: `oversize:${a.hash}:${a.timestamp}:${a.usdcAmount}`,
          details: {
            action: a.action,
            hash: a.hash,
            marketName: a.marketName,
            tokenName: a.tokenName,
            timestamp: a.timestamp,
            usdcAmount: a.usdcAmount,
          },
        });
        continue;
      }

      if (!matching) {
        yield* deps.obs({
          category: "risk",
          source: "reconciler",
          action: "unmatched_activity_detected",
          entityType: "activity",
          entityId: a.id,
          status: "anomaly",
          mode: "live",
          payload: {
            hash: a.hash,
            usdcAmount: a.usdcAmount,
            timestamp: a.timestamp,
          },
        });
        yield* deps.haltTradingWithIncident({
          kind: "unmatched_account_fill",
          message: "Observed account BUY that does not match any tracked live trade in reconciliation window.",
          fingerprint: `unmatched:${a.hash}:${a.timestamp}:${a.usdcAmount}`,
          details: {
            action: a.action,
            hash: a.hash,
            marketName: a.marketName,
            tokenName: a.tokenName,
            timestamp: a.timestamp,
            usdcAmount: a.usdcAmount,
          },
        });
      }
    }
  });
}

import { Effect, Ref } from "effect";
import type { MarketWindow, PriceToBeatSource, PriceToBeatStatus, Side } from "../types.js";
import { PolymarketError } from "../errors.js";
import { fetchPriceToBeatFromPolymarketPage } from "./price-to-beat.js";
import { fetchWithTimeout } from "./fetch.js";

const FIVE_MIN_S = 300;
const FIVE_MIN_MS = FIVE_MIN_S * 1000;
const GAMMA_API = "https://gamma-api.polymarket.com";
const GAMMA_FETCH_TIMEOUT_MS = 2_500;
const PTB_PAGE_FETCH_TIMEOUT_MS = 3_000;
const SETTLEMENT_FETCH_TIMEOUT_MS = 2_500;
const PTB_RETRY_SCHEDULE_MS = [3_000, 6_000, 12_000, 20_000] as const;
const PTB_RETRY_JITTER_RANGE_MS = 750;

interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  markets: GammaMarket[];
}

interface GammaMarket {
  id: string;
  conditionId: string;
  slug: string;
  question: string;
  outcomes: string;
  clobTokenIds: string;
  endDate: string;
  description?: string;
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  outcomePrices?: string | number[];
  outcome_prices?: string | number[];
  winningOutcome?: string | number;
  winner?: string | number;
}

interface SettlementResult {
  resolved: boolean;
  winnerSide: Side | null;
}

interface PtbRetryState {
  attempts: number;
  lastAttemptAt: number;
}

function extractPriceToBeat(
  title: string | undefined,
  description: string | undefined,
): number | null {
  for (const text of [title, description]) {
    if (!text) continue;
    const m = /price\s*(?:to\s*beat|:)\s*\$?([\d,]+(?:\.\d+)?)/i.exec(text);
    if (m) {
      const val = parseFloat(m[1]!.replace(/,/g, ""));
      if (val > 0 && isFinite(val)) return val;
    }
  }
  return null;
}

function parseGammaMarket(m: GammaMarket, evt: GammaEvent): MarketWindow {
  let outcomes: string[] = [];
  let tokenIds: string[] = [];

  try { outcomes = JSON.parse(m.outcomes); } catch { outcomes = []; }
  try { tokenIds = JSON.parse(m.clobTokenIds); } catch { tokenIds = []; }

  let upTokenId = "";
  let downTokenId = "";

  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i]!.toLowerCase();
    if (o === "up" || o === "yes") upTokenId = tokenIds[i] ?? "";
    if (o === "down" || o === "no") downTokenId = tokenIds[i] ?? "";
  }

  const endTime = new Date(m.endDate).getTime();
  const startTime = endTime - FIVE_MIN_MS;
  const priceToBeat = extractPriceToBeat(evt.title, m.description);
  const hasMetadataPtb = priceToBeat !== null;
  const priceToBeatStatus: PriceToBeatStatus = hasMetadataPtb ? "exact" : "pending";
  const priceToBeatSource: PriceToBeatSource = hasMetadataPtb ? "gamma_metadata" : "unavailable";

  return {
    conditionId: m.conditionId,
    slug: m.slug,
    title: evt.title,
    polymarketUrl: `https://polymarket.com/event/${m.slug}`,
    upTokenId,
    downTokenId,
    startTime,
    endTime,
    priceToBeat,
    priceToBeatStatus,
    priceToBeatSource,
    priceToBeatObservedAt: hasMetadataPtb ? Date.now() : undefined,
    priceToBeatReason: hasMetadataPtb ? undefined : "missing_in_gamma_metadata",
    resolved: m.closed,
  };
}

async function resolveWindowPriceToBeat(
  window: MarketWindow,
  cache: Map<string, MarketWindow>,
): Promise<MarketWindow> {
  if (window.priceToBeat !== null) return window;

  const cached = cache.get(window.conditionId);
  if (cached && cached.priceToBeat !== null) {
    return {
      ...window,
      priceToBeat: cached.priceToBeat,
      priceToBeatStatus: "exact",
      priceToBeatSource: cached.priceToBeatSource ?? "polymarket_page_json",
      priceToBeatObservedAt: cached.priceToBeatObservedAt,
      priceToBeatReason: cached.priceToBeatReason,
    };
  }

  const lookup = await fetchPriceToBeatFromPolymarketPage(
    window.slug,
    window.startTime,
    PTB_PAGE_FETCH_TIMEOUT_MS,
  );
  if (lookup.priceToBeat !== null) {
    const resolved: MarketWindow = {
      ...window,
      priceToBeat: lookup.priceToBeat,
      priceToBeatStatus: "exact",
      priceToBeatSource: lookup.source,
      priceToBeatObservedAt: lookup.observedAt,
      priceToBeatReason: undefined,
    };
    cache.set(window.conditionId, resolved);
    return resolved;
  }

  const unresolved: MarketWindow = {
    ...window,
    priceToBeatStatus: "unavailable",
    priceToBeatSource: "unavailable",
    priceToBeatObservedAt: lookup.observedAt,
    priceToBeatReason: lookup.reason ?? "unresolved",
  };
  cache.set(window.conditionId, unresolved);
  return unresolved;
}

function jitterFromKey(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return hash % (PTB_RETRY_JITTER_RANGE_MS + 1);
}

function getPtbRetryCooldownMs(conditionId: string, attempts: number): number {
  const stepIdx = Math.min(attempts - 1, PTB_RETRY_SCHEDULE_MS.length - 1);
  const base = PTB_RETRY_SCHEDULE_MS[stepIdx] ?? PTB_RETRY_SCHEDULE_MS[PTB_RETRY_SCHEDULE_MS.length - 1];
  return base + jitterFromKey(conditionId);
}

function parseArrayField<T = string>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed as T[];
    } catch {
      return [];
    }
  }
  return [];
}

function sideFromOutcomeLabel(label: unknown): Side | null {
  if (typeof label !== "string") return null;
  const normalized = label.toLowerCase();
  if (normalized === "up" || normalized === "yes") return "UP";
  if (normalized === "down" || normalized === "no") return "DOWN";
  return null;
}

export function inferSettlementWinnerFromMarket(market: GammaMarket): SettlementResult {
  if (!market.closed) return { resolved: false, winnerSide: null };
  const outcomes = parseArrayField<string>(market.outcomes);
  const pricesRaw = parseArrayField<number | string>(
    market.outcomePrices ?? market.outcome_prices ?? [],
  );
  const prices = pricesRaw.map((v) => Number(v)).filter((n) => Number.isFinite(n));

  if (prices.length > 0 && outcomes.length === prices.length) {
    let maxIdx = -1;
    let max = -1;
    let second = -1;
    for (let i = 0; i < prices.length; i++) {
      const p = prices[i]!;
      if (p > max) {
        second = max;
        max = p;
        maxIdx = i;
      } else if (p > second) {
        second = p;
      }
    }
    if (maxIdx >= 0 && max >= 0.99 && max - second > 0.2) {
      return { resolved: true, winnerSide: sideFromOutcomeLabel(outcomes[maxIdx]) };
    }
  }

  const winnerHint = market.winningOutcome ?? market.winner;
  if (typeof winnerHint === "number" && Number.isInteger(winnerHint)) {
    const idx = winnerHint;
    if (idx >= 0 && idx < outcomes.length) {
      return { resolved: true, winnerSide: sideFromOutcomeLabel(outcomes[idx]) };
    }
  }
  if (typeof winnerHint === "string") {
    return { resolved: true, winnerSide: sideFromOutcomeLabel(winnerHint) };
  }

  return { resolved: true, winnerSide: null };
}

export function formatWindowTitle(window: MarketWindow): string {
  return formatWindowTitleForAsset("BTC Up or Down")(window);
}

export function formatWindowTitleForAsset(prefix: string) {
  return (window: MarketWindow): string => {
    const start = new Date(window.startTime);
    const end = new Date(window.endTime);
    const fmt = (d: Date) =>
      d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    const date = start.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return `${prefix} — ${date}, ${fmt(start)}–${fmt(end)} ET`;
  };
}

export interface MarketPollerInstance {
  readonly fetchCurrentWindow: Effect.Effect<MarketWindow | null, never, never>;
  readonly fetchSettlementByCondition: (conditionId: string) => Effect.Effect<SettlementResult | null, never, never>;
  readonly formatWindowTitle: (window: MarketWindow) => string;
}

export function createMarketPoller(slugPrefix: string, windowTitlePrefix: string): Effect.Effect<MarketPollerInstance> {
  return Effect.gen(function* () {
    const cacheRef = yield* Ref.make<{ window: MarketWindow | null; lastFetch: number }>({
      window: null,
      lastFetch: 0,
    });
    const ptbCache = new Map<string, MarketWindow>();
    const ptbRetryState = new Map<string, PtbRetryState>();

    const fetchCurrentWindow = Effect.gen(function* () {
      const now = Date.now();
      const cache = yield* Ref.get(cacheRef);

      if (cache.window && now - cache.lastFetch < CACHE_TTL && cache.window.endTime > now) {
        if (cache.window.priceToBeat !== null) return cache.window;

        // PTB still unresolved — check ptbCache for a success that arrived since last poll
        const ptbHit = ptbCache.get(cache.window.conditionId);
        if (ptbHit && ptbHit.priceToBeat !== null) {
          const merged: MarketWindow = {
            ...cache.window,
            priceToBeat: ptbHit.priceToBeat,
            priceToBeatStatus: "exact",
            priceToBeatSource: ptbHit.priceToBeatSource ?? "polymarket_page_json",
            priceToBeatObservedAt: ptbHit.priceToBeatObservedAt,
            priceToBeatReason: undefined,
          };
          yield* Ref.set(cacheRef, { window: merged, lastFetch: cache.lastFetch });
          ptbRetryState.delete(cache.window.conditionId);
          return merged;
        }

        const retryState = ptbRetryState.get(cache.window.conditionId);
        const retryDelay = retryState
          ? getPtbRetryCooldownMs(cache.window.conditionId, retryState.attempts)
          : 0;
        if (retryState && now - retryState.lastAttemptAt < retryDelay) {
          return cache.window;
        }

        // Attempt PTB resolution without re-fetching Gamma
        const lookupStart = Date.now();
        const resolved = yield* Effect.tryPromise({
          try: () => resolveWindowPriceToBeat(cache.window!, ptbCache),
          catch: () => null,
        }).pipe(Effect.catchAll(() => Effect.succeed(null)));
        const lookupMs = Date.now() - lookupStart;
        if (resolved && resolved.priceToBeat !== null) {
          yield* Ref.set(cacheRef, { window: resolved, lastFetch: cache.lastFetch });
          ptbRetryState.delete(cache.window.conditionId);
          yield* Effect.log(
            `[Markets:${slugPrefix}] PTB resolved in ${lookupMs}ms (source=${resolved.priceToBeatSource ?? "unknown"})`,
          );
          return resolved;
        }
        const nextAttempts = (retryState?.attempts ?? 0) + 1;
        ptbRetryState.set(cache.window.conditionId, { attempts: nextAttempts, lastAttemptAt: now });
        yield* Effect.log(
          `[Markets:${slugPrefix}] PTB unresolved after ${lookupMs}ms (attempt=${nextAttempts}, reason=${resolved?.priceToBeatReason ?? "unknown"})`,
        );
        return resolved ?? cache.window;
      }

      const nowSec = Math.floor(now / 1000);
      const currentStart = Math.floor(nowSec / FIVE_MIN_S) * FIVE_MIN_S;
      const slugs = [
        `${slugPrefix}-${currentStart}`,
        `${slugPrefix}-${currentStart + FIVE_MIN_S}`,
      ];

      for (const slug of slugs) {
        const result = yield* Effect.tryPromise({
          try: async () => {
            const url = `${GAMMA_API}/events?slug=${slug}`;
            const res = await fetchWithTimeout(url, undefined, GAMMA_FETCH_TIMEOUT_MS);
            if (!res.ok) return null;
            const events = (await res.json()) as GammaEvent[];
            if (!events || events.length === 0) return null;
            const evt = events[0]!;
            if (evt.closed || !evt.markets || evt.markets.length === 0) return null;
            const mkt = evt.markets[0]!;
            const parsed = parseGammaMarket(mkt, evt);
            const market = await resolveWindowPriceToBeat(parsed, ptbCache);
            return { market, slug, title: evt.title };
          },
          catch: (err) => new PolymarketError({ message: `Error fetching ${slug}: ${err}`, cause: err }),
        }).pipe(Effect.catchAll(() => Effect.succeed(null)));

        if (result && result.market.endTime > now) {
          const isNew = cache.window?.conditionId !== result.market.conditionId;
          yield* Ref.set(cacheRef, { window: result.market, lastFetch: now });
          if (isNew) {
            yield* Effect.log(`[Markets:${slugPrefix}] Found: ${result.title} (${result.slug})`);
          }
          return result.market;
        }
      }

      yield* Ref.update(cacheRef, (c) => {
        const updated = { ...c, lastFetch: now };
        if (c.window && c.window.endTime <= now) {
          return { ...updated, window: null };
        }
        return updated;
      });
      const final = yield* Ref.get(cacheRef);
      return final.window;
    });

    const fmtTitle = formatWindowTitleForAsset(windowTitlePrefix);

    return {
      fetchCurrentWindow,
      fetchSettlementByCondition: fetchSettlementByConditionImpl,
      formatWindowTitle: fmtTitle,
    } as const;
  });
}

function fetchSettlementByConditionImpl(conditionId: string) {
  return Effect.gen(function* () {
    const cid = conditionId.toLowerCase();
    const endpoints = [
      `${GAMMA_API}/markets?conditionId=${cid}`,
      `${GAMMA_API}/markets?condition_id=${cid}`,
      `${GAMMA_API}/markets?condition_ids=${cid}`,
    ];

    for (const url of endpoints) {
      const candidate = yield* Effect.tryPromise({
        try: async () => {
          const res = await fetchWithTimeout(url, undefined, SETTLEMENT_FETCH_TIMEOUT_MS);
          if (!res.ok) return null;
          const body = (await res.json()) as unknown;
          const markets = Array.isArray(body) ? body : [];
          const match = (markets as GammaMarket[]).find(
            (m) => (m.conditionId ?? "").toLowerCase() === cid,
          );
          return match ?? null;
        },
        catch: () => null,
      }).pipe(Effect.catchAll(() => Effect.succeed(null)));

      if (!candidate) continue;
      return inferSettlementWinnerFromMarket(candidate);
    }
    return null;
  });
}

const CACHE_TTL = 8_000;

export class MarketService extends Effect.Service<MarketService>()("MarketService", {
  effect: Effect.gen(function* () {
    const cacheRef = yield* Ref.make<{ window: MarketWindow | null; lastFetch: number }>({
      window: null,
      lastFetch: 0,
    });
    const ptbCache = new Map<string, MarketWindow>();
    const ptbRetryState = new Map<string, PtbRetryState>();

    const fetchCurrentBtc5mWindow = Effect.gen(function* () {
      const now = Date.now();
      const cache = yield* Ref.get(cacheRef);

      if (cache.window && now - cache.lastFetch < CACHE_TTL && cache.window.endTime > now) {
        if (cache.window.priceToBeat !== null) return cache.window;

        // PTB still unresolved — check ptbCache for a success that arrived since last poll
        const ptbHit = ptbCache.get(cache.window.conditionId);
        if (ptbHit && ptbHit.priceToBeat !== null) {
          const merged: MarketWindow = {
            ...cache.window,
            priceToBeat: ptbHit.priceToBeat,
            priceToBeatStatus: "exact",
            priceToBeatSource: ptbHit.priceToBeatSource ?? "polymarket_page_json",
            priceToBeatObservedAt: ptbHit.priceToBeatObservedAt,
            priceToBeatReason: undefined,
          };
          yield* Ref.set(cacheRef, { window: merged, lastFetch: cache.lastFetch });
          ptbRetryState.delete(cache.window.conditionId);
          return merged;
        }

        const retryState = ptbRetryState.get(cache.window.conditionId);
        const retryDelay = retryState
          ? getPtbRetryCooldownMs(cache.window.conditionId, retryState.attempts)
          : 0;
        if (retryState && now - retryState.lastAttemptAt < retryDelay) {
          return cache.window;
        }

        // Attempt PTB resolution without re-fetching Gamma
        const lookupStart = Date.now();
        const resolved = yield* Effect.tryPromise({
          try: () => resolveWindowPriceToBeat(cache.window!, ptbCache),
          catch: () => null,
        }).pipe(Effect.catchAll(() => Effect.succeed(null)));
        const lookupMs = Date.now() - lookupStart;
        if (resolved && resolved.priceToBeat !== null) {
          yield* Ref.set(cacheRef, { window: resolved, lastFetch: cache.lastFetch });
          ptbRetryState.delete(cache.window.conditionId);
          yield* Effect.log(
            `[Markets] PTB resolved in ${lookupMs}ms (source=${resolved.priceToBeatSource ?? "unknown"})`,
          );
          return resolved;
        }
        const nextAttempts = (retryState?.attempts ?? 0) + 1;
        ptbRetryState.set(cache.window.conditionId, { attempts: nextAttempts, lastAttemptAt: now });
        yield* Effect.log(
          `[Markets] PTB unresolved after ${lookupMs}ms (attempt=${nextAttempts}, reason=${resolved?.priceToBeatReason ?? "unknown"})`,
        );
        return resolved ?? cache.window;
      }

      const nowSec = Math.floor(now / 1000);
      const currentStart = Math.floor(nowSec / FIVE_MIN_S) * FIVE_MIN_S;
      const slugs = [
        `btc-updown-5m-${currentStart}`,
        `btc-updown-5m-${currentStart + FIVE_MIN_S}`,
      ];

      for (const slug of slugs) {
        const result = yield* Effect.tryPromise({
          try: async () => {
            const url = `${GAMMA_API}/events?slug=${slug}`;
            const res = await fetchWithTimeout(url, undefined, GAMMA_FETCH_TIMEOUT_MS);
            if (!res.ok) return null;
            const events = (await res.json()) as GammaEvent[];
            if (!events || events.length === 0) return null;
            const evt = events[0]!;
            if (evt.closed || !evt.markets || evt.markets.length === 0) return null;
            const mkt = evt.markets[0]!;
            const parsed = parseGammaMarket(mkt, evt);
            const market = await resolveWindowPriceToBeat(parsed, ptbCache);
            return { market, slug, title: evt.title };
          },
          catch: (err) => new PolymarketError({ message: `Error fetching ${slug}: ${err}`, cause: err }),
        }).pipe(Effect.catchAll(() => Effect.succeed(null)));

        if (result && result.market.endTime > now) {
          const isNew = cache.window?.conditionId !== result.market.conditionId;
          yield* Ref.set(cacheRef, { window: result.market, lastFetch: now });
          if (isNew) {
            yield* Effect.log(`[Markets] Found: ${result.title} (${result.slug})`);
          }
          return result.market;
        }
      }

      yield* Ref.update(cacheRef, (c) => {
        const updated = { ...c, lastFetch: now };
        if (c.window && c.window.endTime <= now) {
          return { ...updated, window: null };
        }
        return updated;
      });
      const final = yield* Ref.get(cacheRef);
      return final.window;
    });

    return { fetchCurrentBtc5mWindow, fetchSettlementByCondition: fetchSettlementByConditionImpl, formatWindowTitle } as const;
  }),
}) {}

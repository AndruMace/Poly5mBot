import type { MarketWindow } from "../types.js";

const FIVE_MIN_S = 300;
const FIVE_MIN_MS = FIVE_MIN_S * 1000;
const GAMMA_API = "https://gamma-api.polymarket.com";

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
}

let cachedWindow: MarketWindow | null = null;
let lastFetch = 0;
const CACHE_TTL = 8_000;

export async function fetchCurrentBtc5mWindow(): Promise<MarketWindow | null> {
  const now = Date.now();

  if (
    cachedWindow &&
    now - lastFetch < CACHE_TTL &&
    cachedWindow.endTime > now
  ) {
    return cachedWindow;
  }

  const nowSec = Math.floor(now / 1000);
  const currentStart = Math.floor(nowSec / FIVE_MIN_S) * FIVE_MIN_S;

  const slugs = [
    `btc-updown-5m-${currentStart}`,
    `btc-updown-5m-${currentStart + FIVE_MIN_S}`,
  ];

  for (const slug of slugs) {
    try {
      const url = `${GAMMA_API}/events?slug=${slug}`;
      const res = await fetch(url);
      if (!res.ok) continue;

      const events = (await res.json()) as GammaEvent[];
      if (!events || events.length === 0) continue;

      const evt = events[0]!;
      if (evt.closed || !evt.markets || evt.markets.length === 0) continue;

      const mkt = evt.markets[0]!;
      const window = parseGammaMarket(mkt, evt);

      if (window.endTime > now) {
        const isNew = cachedWindow?.conditionId !== window.conditionId;
        cachedWindow = window;
        lastFetch = now;
        if (isNew) {
          console.log(`[Markets] Found: ${evt.title} (${slug})`);
        }
        return cachedWindow;
      }
    } catch (err) {
      console.error(`[Markets] Error fetching ${slug}:`, err);
    }
  }

  lastFetch = now;
  if (cachedWindow && cachedWindow.endTime <= now) {
    console.log("[Markets] Cached window expired, clearing");
    cachedWindow = null;
  }
  return cachedWindow;
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
    resolved: m.closed,
  };
}

export function formatWindowTitle(window: MarketWindow): string {
  const start = new Date(window.startTime);
  const end = new Date(window.endTime);
  const fmt = (d: Date) =>
    d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  const date = start.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  return `BTC Up or Down — ${date}, ${fmt(start)}–${fmt(end)} ET`;
}

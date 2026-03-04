import type { PriceToBeatSource } from "../types.js";

export interface PriceToBeatLookupResult {
  readonly priceToBeat: number | null;
  readonly source: PriceToBeatSource;
  readonly observedAt?: number;
  readonly reason?: string;
}

function parseIsoToMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms;
}

function toPositiveNumber(raw: string | number | undefined): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function collectSlugScopes(html: string, slug: string): ReadonlyArray<string> {
  const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const slugRe = new RegExp(`"slug"\\s*:\\s*"${escapedSlug}"`, "ig");
  const anySlugRe = /"slug"\s*:\s*"[^"]+"/ig;
  const allSlugIndices: number[] = [];
  let anyMatch: RegExpExecArray | null;
  while ((anyMatch = anySlugRe.exec(html)) !== null) {
    allSlugIndices.push(anyMatch.index);
  }
  const scopes: string[] = [];
  const maxScopeLen = 120000;

  let m: RegExpExecArray | null;
  while ((m = slugRe.exec(html)) !== null) {
    const start = m.index;
    const nextSlugIndex = allSlugIndices.find((idx) => idx > start) ?? -1;
    const endBySlug = nextSlugIndex > start ? nextSlugIndex : html.length;
    const end = Math.min(endBySlug, start + maxScopeLen);
    scopes.push(html.slice(start, end));
  }

  return scopes;
}

function findWindowOpenPriceByStartTime(scopes: ReadonlyArray<string>, windowStartMs: number): number | null {
  const re =
    /"startTime"\s*:\s*"([^"]+)"\s*,\s*"endTime"\s*:\s*"([^"]+)"\s*,\s*"openPrice"\s*:\s*([0-9]+(?:\.[0-9]+)?)/g;
  for (const scope of scopes) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(scope)) !== null) {
      const startMs = parseIsoToMs(m[1]);
      if (startMs === null) continue;
      if (Math.abs(startMs - windowStartMs) <= 1000) {
        return toPositiveNumber(m[3]);
      }
    }
  }
  return null;
}

function findCurrentWindowOpenPrice(scopes: ReadonlyArray<string>): number | null {
  const re = /"openPrice"\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*"closePrice"\s*:\s*null/ig;
  for (const scope of scopes) {
    re.lastIndex = 0;
    const m = re.exec(scope);
    if (m?.[1]) return toPositiveNumber(m[1]);
  }
  return null;
}

function findSlugEventMetadataPriceToBeat(scopes: ReadonlyArray<string>): number | null {
  const n = String.raw`([0-9]+(?:\.[0-9]+)?)`;
  const eventMetadataPrice = new RegExp(
    `"eventMetadata"\\s*:\\s*\\{[\\s\\S]{0,5000}?"priceToBeat"\\s*:\\s*${n}`,
    "i",
  );
  for (const scope of scopes) {
    const m = eventMetadataPrice.exec(scope);
    if (m?.[1]) return toPositiveNumber(m[1]);
  }
  return null;
}

function findDomPriceToBeat(html: string): number | null {
  const domMatch = /price\s*to\s*beat[\s\S]{0,180}?\$\s*([\d,]+(?:\.\d+)?)/i.exec(html);
  if (!domMatch?.[1]) return null;
  return toPositiveNumber(domMatch[1].replace(/,/g, ""));
}

export async function fetchPriceToBeatFromPolymarketPage(
  slug: string,
  windowStartMs?: number,
): Promise<PriceToBeatLookupResult> {
  if (!slug) {
    return {
      priceToBeat: null,
      source: "unavailable",
      reason: "missing_slug",
    };
  }

  try {
    const res = await fetch(`https://polymarket.com/event/${slug}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });
    if (!res.ok) {
      return {
        priceToBeat: null,
        source: "unavailable",
        reason: `event_page_http_${res.status}`,
      };
    }
    const html = await res.text();
    const observedAt = Date.now();
    const slugScopes = collectSlugScopes(html, slug);

    if (typeof windowStartMs === "number" && Number.isFinite(windowStartMs) && windowStartMs > 0) {
      const startBoundPtb = findWindowOpenPriceByStartTime(slugScopes, windowStartMs);
      if (startBoundPtb !== null) {
        return {
          priceToBeat: startBoundPtb,
          source: "polymarket_page_json",
          observedAt,
        };
      }
    }

    // Preferred: current live market payload carries openPrice with closePrice=null.
    const liveOpenPrice = findCurrentWindowOpenPrice(slugScopes);
    if (liveOpenPrice !== null) {
      return {
        priceToBeat: liveOpenPrice,
        source: "polymarket_page_json",
        observedAt,
      };
    }

    // Fallback: slug-scoped eventMetadata extraction.
    const jsonPtb = findSlugEventMetadataPriceToBeat(slugScopes);
    if (jsonPtb !== null) {
      return {
        priceToBeat: jsonPtb,
        source: "polymarket_page_json",
        observedAt,
      };
    }

    // Global fallback: the crypto-prices query in __NEXT_DATA__ stores
    // openPrice/closePrice outside slug scopes. Search the full HTML.
    const globalOpenPrice = findCurrentWindowOpenPrice([html]);
    if (globalOpenPrice !== null) {
      return {
        priceToBeat: globalOpenPrice,
        source: "polymarket_page_json",
        observedAt,
      };
    }

    const domPtb = findDomPriceToBeat(html);
    if (domPtb !== null) {
      return {
        priceToBeat: domPtb,
        source: "polymarket_page_dom",
        observedAt,
      };
    }

    return {
      priceToBeat: null,
      source: "unavailable",
      observedAt,
      reason: "ptb_not_found_in_page",
    };
  } catch (err) {
    return {
      priceToBeat: null,
      source: "unavailable",
      reason: `event_page_fetch_failed:${String(err)}`,
    };
  }
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPriceToBeatFromPolymarketPage } from "../../src/polymarket/price-to-beat.js";

describe("polymarket price-to-beat resolver", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("extracts PTB from embedded page JSON for matching slug", async () => {
    const html = `
      <html><body>
      <script>
        {"slug":"btc-updown-5m-123","eventMetadata":{"priceToBeat":68322.0947176869}}
      </script>
      </body></html>
    `;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => html,
    }) as unknown as typeof fetch;

    const result = await fetchPriceToBeatFromPolymarketPage("btc-updown-5m-123");
    expect(result.priceToBeat).toBeCloseTo(68322.0947, 4);
    expect(result.source).toBe("polymarket_page_json");
  });

  it("prefers slug-scoped openPrice when closePrice is null", async () => {
    const html = `
      <html><body><script>
      {"slug":"btc-updown-5m-other","openPrice":69999.11,"closePrice":null}
      {"slug":"btc-updown-5m-123","eventMetadata":{"priceToBeat":68322.0947176869}}
      {"openPrice":68555.53433966506,"closePrice":null}
      </script></body></html>
    `;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => html,
    }) as unknown as typeof fetch;

    const result = await fetchPriceToBeatFromPolymarketPage("btc-updown-5m-123");
    expect(result.priceToBeat).toBeCloseTo(68555.5343, 4);
    expect(result.source).toBe("polymarket_page_json");
  });

  it("uses slug-scoped window startTime match when multiple openPrice values exist", async () => {
    const html = `
      <html><body><script>
      {"slug":"btc-updown-5m-other","startTime":"2026-03-03T23:20:00.000Z","endTime":"2026-03-03T23:25:00.000Z","openPrice":70111.11,"closePrice":null}
      {"slug":"btc-updown-5m-123","startTime":"2026-03-03T23:20:00.000Z","endTime":"2026-03-03T23:25:00.000Z","openPrice":68555.53433966506,"closePrice":68525.53116241914}
      </script></body></html>
    `;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => html,
    }) as unknown as typeof fetch;

    const startMs = Date.parse("2026-03-03T23:20:00.000Z");
    const result = await fetchPriceToBeatFromPolymarketPage("btc-updown-5m-123", startMs);
    expect(result.priceToBeat).toBeCloseTo(68555.5343, 4);
    expect(result.source).toBe("polymarket_page_json");
  });

  it("does not use unrelated market PTB from same payload", async () => {
    const html = `
      <html><body><script>
      {"slug":"btc-updown-5m-other","eventMetadata":{"priceToBeat":69999.11}}
      ${"x".repeat(7000)}
      {"slug":"btc-updown-5m-123","eventMetadata":{"priceToBeat":68322.0947176869}}
      </script></body></html>
    `;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => html,
    }) as unknown as typeof fetch;

    const result = await fetchPriceToBeatFromPolymarketPage("btc-updown-5m-123");
    expect(result.priceToBeat).toBeCloseTo(68322.0947, 4);
    expect(result.source).toBe("polymarket_page_json");
  });

  it("falls back to DOM text extraction when JSON field is unavailable", async () => {
    const html = `
      <html><body>
        <div>Price to Beat: $68,321.75</div>
      </body></html>
    `;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => html,
    }) as unknown as typeof fetch;

    const result = await fetchPriceToBeatFromPolymarketPage("btc-updown-5m-456");
    expect(result.priceToBeat).toBe(68321.75);
    expect(result.source).toBe("polymarket_page_dom");
  });

  it("returns unavailable when page parsing fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "<html><body>no ptb here</body></html>",
    }) as unknown as typeof fetch;

    const result = await fetchPriceToBeatFromPolymarketPage("btc-updown-5m-789");
    expect(result.priceToBeat).toBe(null);
    expect(result.source).toBe("unavailable");
    expect(result.reason).toBe("ptb_not_found_in_page");
  });

  it("returns unavailable when page fetch times out", async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener("abort", () => {
            const err = new Error("Aborted");
            (err as any).name = "AbortError";
            reject(err);
          });
        }),
    ) as unknown as typeof fetch;

    const result = await fetchPriceToBeatFromPolymarketPage("btc-updown-5m-timeout", undefined, 10);
    expect(result.priceToBeat).toBe(null);
    expect(result.source).toBe("unavailable");
    expect(result.reason).toContain("fetch_timeout_10ms");
  });
});

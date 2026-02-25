import { describe, it, expect } from "vitest";

const runLive = process.env.CI_LIVE_INTEGRATION === "true";
const timeout = Number(process.env.LIVE_TEST_TIMEOUT_MS ?? 15000);

const suite = runLive ? describe : describe.skip;

suite("Live provider smoke (read-only)", () => {
  it(
    "reaches Polymarket gamma BTC windows endpoint",
    async () => {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeout);
      try {
        const nowSec = Math.floor(Date.now() / 1000);
        const currentStart = Math.floor(nowSec / 300) * 300;
        const slug = `btc-updown-5m-${currentStart}`;
        const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`, {
          signal: controller.signal,
        });
        expect(res.ok).toBe(true);
        const json = await res.json();
        expect(Array.isArray(json)).toBe(true);
      } finally {
        clearTimeout(t);
      }
    },
    timeout + 2000,
  );

  it(
    "reaches Binance public REST ticker as exchange liveness smoke",
    async () => {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", {
          signal: controller.signal,
        });
        expect(res.ok).toBe(true);
        const json = (await res.json()) as { symbol?: string; price?: string };
        expect(json.symbol).toBe("BTCUSDT");
        expect(Number(json.price)).toBeGreaterThan(0);
      } finally {
        clearTimeout(t);
      }
    },
    timeout + 2000,
  );
});

import { Duration, Effect, Stream } from "effect";
import WebSocket from "ws";
import type { PricePoint } from "../types.js";

export interface FeedConfig {
  readonly name: string;
  readonly url: string | (() => string);
  readonly onOpen?: (ws: WebSocket) => void;
  readonly parseMessage: (raw: string, latest: PricePoint | null) => PricePoint | PricePoint[] | null;
  readonly pingIntervalMs?: number;
  readonly pingPayload?: string;
}

const INITIAL_BACKOFF_MS = 3_000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 1.5;

function connectOnce(config: FeedConfig): Stream.Stream<PricePoint, Error> {
  return Stream.async<PricePoint, Error>((emit) => {
    let latest: PricePoint | null = null;
    const url = typeof config.url === "function" ? config.url() : config.url;
    const ws = new WebSocket(url);
    let pingTimer: ReturnType<typeof setInterval> | null = null;

    ws.on("open", () => {
      config.onOpen?.(ws);
      if (config.pingIntervalMs) {
        const payload = config.pingPayload ?? JSON.stringify({ op: "ping" });
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(payload);
        }, config.pingIntervalMs);
      }
    });

    ws.on("message", (raw: WebSocket.Data) => {
      try {
        const text = raw.toString();
        if (text === "pong") return;
        const result = config.parseMessage(text, latest);
        if (!result) return;
        const points = Array.isArray(result) ? result : [result];
        for (const p of points) {
          latest = p;
          emit.single(p);
        }
      } catch {
        /* ignore parse errors */
      }
    });

    ws.on("close", () => {
      if (pingTimer) clearInterval(pingTimer);
      emit.fail(new Error(`${config.name} disconnected`));
    });

    ws.on("error", () => {
      if (pingTimer) clearInterval(pingTimer);
      ws.close();
    });

    return Effect.sync(() => {
      if (pingTimer) clearInterval(pingTimer);
      ws.close();
    });
  });
}

/**
 * Sentinel PricePoint emitted on WebSocket disconnect.
 * Feed managers detect this to trigger reconnect grace periods.
 */
export function isDisconnectSentinel(p: PricePoint): boolean {
  return p.price <= 0 && p.timestamp <= 0;
}

export function makeFeedStream(config: FeedConfig): Stream.Stream<PricePoint, never, never> {
  let backoffMs = INITIAL_BACKOFF_MS;

  const disconnectSentinel: PricePoint = { exchange: config.name, price: 0, timestamp: 0 };

  const go: Stream.Stream<PricePoint, never, never> = connectOnce(config).pipe(
    Stream.tap(() => Effect.sync(() => { backoffMs = INITIAL_BACKOFF_MS; })),
    Stream.catchAll(() => {
      const delay = backoffMs;
      backoffMs = Math.min(backoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
      const reconnect = Stream.fromEffect(
        Effect.log(`[Feed:${config.name}] disconnected, reconnecting in ${(delay / 1000).toFixed(1)}s`).pipe(
          Effect.andThen(Effect.sleep(Duration.millis(delay))),
        ),
      ).pipe(Stream.flatMap(() => go));
      return Stream.concat(Stream.make(disconnectSentinel), reconnect);
    }),
  );
  return go;
}

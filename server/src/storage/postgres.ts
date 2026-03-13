import { Effect, Ref } from "effect";
import { Pool } from "pg";
import { AppConfig } from "../config.js";

const TRANSIENT_PG_ERROR_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ENETUNREACH",
  "ECONNREFUSED",
  "08000",
  "08001",
  "08004",
  "08006",
  "08007",
  "08P01",
  "57P01",
  "57P02",
  "57P03",
]);

function toError(err: unknown, fallback: string): Error {
  if (err instanceof Error) return err;
  if (typeof err === "string" && err.trim().length > 0) return new Error(err);
  if (err && typeof err === "object") {
    const maybe = err as { message?: unknown; code?: unknown };
    const message = typeof maybe.message === "string" ? maybe.message : fallback;
    const code = typeof maybe.code === "string" ? maybe.code : null;
    return new Error(code ? `[${code}] ${message}` : message);
  }
  return new Error(fallback);
}

function isTransientConnectionError(err: unknown): boolean {
  const candidate = err as { code?: unknown; message?: unknown } | null;
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  if (code && TRANSIENT_PG_ERROR_CODES.has(code)) return true;
  const msg = typeof candidate?.message === "string" ? candidate.message.toLowerCase() : "";
  return (
    msg.includes("connection terminated unexpectedly")
    || msg.includes("terminating connection")
    || msg.includes("connection reset")
    || msg.includes("socket hang up")
    || msg.includes("client has encountered a connection error")
  );
}

export class PostgresStorage extends Effect.Service<PostgresStorage>()("PostgresStorage", {
  effect: Effect.gen(function* () {
    const config = yield* AppConfig;
    const poolRef = yield* Ref.make<Pool | null>(null);

    const getPool = Effect.gen(function* () {
      const existing = yield* Ref.get(poolRef);
      if (existing) return existing;
      if (!config.storage.databaseUrl || config.storage.databaseUrl.trim().length === 0) {
        return yield* Effect.fail(new Error("DATABASE_URL is required when using postgres storage backend"));
      }
      const pool = new Pool({
        connectionString: config.storage.databaseUrl,
        max: 10,
        // Keep startup responsive if Postgres is unreachable.
        connectionTimeoutMillis: 2500,
        query_timeout: 5000,
        statement_timeout: 5000,
      });
      pool.on("error", (err) => {
        const safeErr = toError(err, "Unknown postgres pool error");
        // Prevent unhandled EventEmitter errors from crashing the process.
        console.error(`[PostgresStorage] Pool client error: ${safeErr.message}`);
      });
      yield* Ref.set(poolRef, pool);
      return pool;
    });

    const resetPool = Effect.gen(function* () {
      const existing = yield* Ref.get(poolRef);
      if (!existing) return;
      yield* Ref.set(poolRef, null);
      yield* Effect.tryPromise({
        try: () => existing.end(),
        catch: () => undefined,
      });
    });

    const runQuery = <T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values: unknown[] = [],
    ) =>
      Effect.gen(function* () {
        const pool = yield* getPool;
        try {
          const result = yield* Effect.tryPromise({
            try: () => pool.query(text, values),
            catch: (err) => toError(err, "Postgres query failed"),
          });
          return result.rows as T[];
        } catch (err) {
          if (!isTransientConnectionError(err)) return yield* Effect.fail(toError(err, "Postgres query failed"));
          yield* resetPool;
          const retryPool = yield* getPool;
          const retryResult = yield* Effect.tryPromise({
            try: () => retryPool.query(text, values),
            catch: (retryErr) => toError(retryErr, "Postgres query retry failed"),
          });
          return retryResult.rows as T[];
        }
      });

    const runExecute = (text: string, values: unknown[] = []) =>
      Effect.gen(function* () {
        const pool = yield* getPool;
        try {
          yield* Effect.tryPromise({
            try: () => pool.query(text, values),
            catch: (err) => toError(err, "Postgres execute failed"),
          });
        } catch (err) {
          if (!isTransientConnectionError(err)) return yield* Effect.fail(toError(err, "Postgres execute failed"));
          yield* resetPool;
          const retryPool = yield* getPool;
          yield* Effect.tryPromise({
            try: () => retryPool.query(text, values),
            catch: (retryErr) => toError(retryErr, "Postgres execute retry failed"),
          });
        }
      });

    const query = <T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values: unknown[] = [],
    ) => runQuery<T>(text, values);

    const execute = (text: string, values: unknown[] = []) => runExecute(text, values);

    const health = Effect.gen(function* () {
      if (config.storage.backend === "file") {
        return { enabled: false, ok: true };
      }
      const rows = yield* query<{ ok: number }>("select 1 as ok");
      return { enabled: true, ok: rows[0]?.ok === 1 };
    }).pipe(
      Effect.catchAll(() => Effect.succeed({ enabled: true, ok: false })),
    );

    return { query, execute, health } as const;
  }),
}) {}

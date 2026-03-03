import { Effect, Ref } from "effect";
import { Pool } from "pg";
import { AppConfig } from "../config.js";

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
      yield* Ref.set(poolRef, pool);
      return pool;
    });

    const query = <T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values: unknown[] = [],
    ) =>
      Effect.gen(function* () {
        const pool = yield* getPool;
        const result = yield* Effect.tryPromise({
          try: () => pool.query(text, values),
          catch: (err) => new Error(String(err)),
        });
        return result.rows as T[];
      });

    const execute = (text: string, values: unknown[] = []) =>
      Effect.gen(function* () {
        const pool = yield* getPool;
        yield* Effect.tryPromise({
          try: () => pool.query(text, values),
          catch: (err) => new Error(String(err)),
        });
      });

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

import { Effect } from "effect";

export type StrategyStateSchema = "market_scoped";

type StorageBackend = "file" | "postgres" | "dual";

interface PostgresLike {
  query: <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ) => Effect.Effect<T[], any, never>;
}

interface InspectStrategyStateSchemaInput {
  readonly backend: StorageBackend;
  readonly marketId: string;
  readonly logPrefix: string;
  readonly postgres?: PostgresLike;
}

export function inspectStrategyStateSchema(
  input: InspectStrategyStateSchemaInput,
): Effect.Effect<StrategyStateSchema | null> {
  const usePostgresStorage =
    !!input.postgres && (input.backend === "postgres" || input.backend === "dual");
  return Effect.gen(function* () {
    if (!usePostgresStorage) return null;
    const rows = yield* input.postgres!.query<{ has_market_id: boolean }>(
      `select exists(
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'strategy_state'
          and column_name = 'market_id'
      ) as has_market_id`,
    );
    const hasMarketId = rows[0]?.has_market_id === true;
    if (!hasMarketId) {
      yield* Effect.logWarning(
        `${input.logPrefix} strategy_state.market_id missing for ${input.marketId}; postgres strategy state disabled`,
      );
      return null;
    }
    return "market_scoped";
  }).pipe(
    Effect.catchAll((err) => {
      if (input.backend === "postgres") {
        return Effect.logError(
          `${input.logPrefix} Failed to inspect strategy_state schema for ${input.marketId}: ${String(err)}`,
        ).pipe(Effect.as(null));
      }
      return Effect.logWarning(
        `${input.logPrefix} Failed to inspect strategy_state schema for ${input.marketId}; falling back to file strategy state: ${String(err)}`,
      ).pipe(Effect.as(null));
    }),
  );
}

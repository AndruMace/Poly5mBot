import { Effect, Ref, Option } from "effect";
import { FileSystem } from "@effect/platform";
import crypto from "crypto";
import { AppConfig } from "../config.js";
import { PostgresStorage } from "../storage/postgres.js";
import { EventBus } from "../engine/event-bus.js";
import type {
  ObservabilityEvent,
  ObservabilityCategory,
  ObservabilitySource,
  ObservabilityEntityType,
  TradingMode,
} from "../types.js";

const DATA_DIR = "data";
const OBS_FILE = "data/observability-events.jsonl";

export interface ObservabilityEventInput {
  category: ObservabilityCategory;
  source: ObservabilitySource;
  action: string;
  entityType: ObservabilityEntityType;
  entityId?: string | null;
  status?: string | null;
  strategy?: string | null;
  mode?: TradingMode | null;
  payload?: Record<string, unknown>;
  searchText?: string;
  timestamp?: number;
}

export interface ObservabilityListQuery {
  limit?: number;
  cursor?: string;
  sinceMs?: number;
  untilMs?: number;
  category?: ObservabilityCategory;
  source?: ObservabilitySource;
  strategy?: string;
  mode?: TradingMode;
  status?: string;
  entityType?: ObservabilityEntityType;
  entityId?: string;
  q?: string;
}

export interface ObservabilityListResult {
  items: ObservabilityEvent[];
  nextCursor: string | null;
  hasMore: boolean;
}

function uid(): string {
  return `obs-${crypto.randomBytes(8).toString("hex")}`;
}

function encodeCursor(e: ObservabilityEvent): string {
  return Buffer.from(
    JSON.stringify({ ts: e.timestamp, id: e.eventId }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(cursor: string): { ts: number; id: string } | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { ts: unknown; id: unknown };
    if (typeof parsed.ts === "number" && typeof parsed.id === "string") {
      return { ts: parsed.ts, id: parsed.id };
    }
  } catch {
    /* ignore invalid cursor */
  }
  return null;
}

function sortDesc(a: ObservabilityEvent, b: ObservabilityEvent): number {
  if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
  return b.eventId.localeCompare(a.eventId);
}

function normalizeSearchText(
  action: string,
  strategy: string | null,
  status: string | null,
  entityId: string | null,
  payload: Record<string, unknown>,
  given?: string,
): string {
  if (given && given.trim().length > 0) return given.trim().toLowerCase();
  return [
    action,
    strategy ?? "",
    status ?? "",
    entityId ?? "",
    JSON.stringify(payload ?? {}),
  ]
    .join(" ")
    .toLowerCase();
}

export class ObservabilityStore extends Effect.Service<ObservabilityStore>()("ObservabilityStore", {
  scoped: Effect.gen(function* () {
    const configOpt = yield* Effect.serviceOption(AppConfig);
    const postgresOpt = yield* Effect.serviceOption(PostgresStorage);
    const busOpt = yield* Effect.serviceOption(EventBus);
    const backend = Option.match(configOpt, {
      onNone: () => "file" as const,
      onSome: (cfg) => cfg.storage.backend,
    });
    const postgres = Option.getOrUndefined(postgresOpt);
    const eventBus = Option.getOrUndefined(busOpt);
    const fs = yield* FileSystem.FileSystem;
    const useFile = backend === "file" || backend === "dual";
    const usePostgres = !!postgres && (backend === "postgres" || backend === "dual");
    const ref = yield* Ref.make(new Map<string, ObservabilityEvent>());

    const replay = Effect.gen(function* () {
      if (useFile) {
        const exists = yield* fs.exists(OBS_FILE);
        if (exists) {
          const content = yield* fs.readFileString(OBS_FILE);
          const lines = content.split("\n").filter(Boolean);
          yield* Ref.update(ref, (m) => {
            const next = new Map(m);
            for (const line of lines) {
              try {
                const event = JSON.parse(line) as ObservabilityEvent;
                if (event?.eventId) next.set(event.eventId, event);
              } catch {
                /* ignore */
              }
            }
            return next;
          });
        }
      }
      if (usePostgres) {
        const rows = yield* postgres!.query<{
          event_id: string;
          event_ts: number;
          category: ObservabilityCategory;
          source: ObservabilitySource;
          action: string;
          entity_type: ObservabilityEntityType;
          entity_id: string | null;
          status: string | null;
          strategy: string | null;
          mode: TradingMode | null;
          search_text: string;
          payload: Record<string, unknown>;
        }>(
          `select event_id, event_ts, category, source, action, entity_type, entity_id, status, strategy, mode, search_text, payload
           from observability_events
           order by event_ts desc`,
        ).pipe(Effect.catchAll(() => Effect.succeed([])));
        yield* Ref.update(ref, (m) => {
          const next = new Map(m);
          for (const row of rows) {
            next.set(String(row.event_id), {
              eventId: String(row.event_id),
              timestamp: Number(row.event_ts ?? 0),
              category: row.category,
              source: row.source,
              action: String(row.action ?? ""),
              entityType: row.entity_type,
              entityId: row.entity_id ?? null,
              status: row.status ?? null,
              strategy: row.strategy ?? null,
              mode: row.mode ?? null,
              searchText: String(row.search_text ?? ""),
              payload: row.payload ?? {},
            });
          }
          return next;
        });
      }
    }).pipe(Effect.catchAll(() => Effect.void));
    yield* replay;

    const append = (input: ObservabilityEventInput) =>
      Effect.gen(function* () {
        const payload = input.payload ?? {};
        const event: ObservabilityEvent = {
          eventId: uid(),
          timestamp: input.timestamp ?? Date.now(),
          category: input.category,
          source: input.source,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId ?? null,
          status: input.status ?? null,
          strategy: input.strategy ?? null,
          mode: input.mode ?? null,
          searchText: normalizeSearchText(
            input.action,
            input.strategy ?? null,
            input.status ?? null,
            input.entityId ?? null,
            payload,
            input.searchText,
          ),
          payload,
        };
        yield* Ref.update(ref, (m) => {
          const next = new Map(m);
          next.set(event.eventId, event);
          return next;
        });

        if (useFile) {
          yield* fs.makeDirectory(DATA_DIR, { recursive: true }).pipe(
            Effect.catchAll(() => Effect.void),
          );
          yield* fs.writeFileString(OBS_FILE, JSON.stringify(event) + "\n", { flag: "a" }).pipe(
            Effect.catchAll(() => Effect.void),
          );
        }

        if (usePostgres) {
          yield* postgres!.execute(
            `insert into observability_events
              (event_id, event_ts, category, source, action, entity_type, entity_id, status, strategy, mode, search_text, payload)
             values
              ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
             on conflict (event_id) do nothing`,
            [
              event.eventId,
              event.timestamp,
              event.category,
              event.source,
              event.action,
              event.entityType,
              event.entityId,
              event.status,
              event.strategy,
              event.mode,
              event.searchText,
              JSON.stringify(event.payload ?? {}),
            ],
          ).pipe(Effect.catchAll(() => Effect.void));
        }

        if (eventBus) {
          yield* eventBus.publish({ _tag: "Observability", data: event }).pipe(
            Effect.catchAll(() => Effect.void),
          );
        }

        return event;
      });

    const list = (query: ObservabilityListQuery = {}) =>
      Ref.get(ref).pipe(
        Effect.map((map) => {
          const limit = Math.max(1, Math.min(query.limit ?? 200, 2000));
          let rows = [...map.values()];
          if (typeof query.sinceMs === "number") rows = rows.filter((r) => r.timestamp >= query.sinceMs!);
          if (typeof query.untilMs === "number") rows = rows.filter((r) => r.timestamp <= query.untilMs!);
          if (query.category) rows = rows.filter((r) => r.category === query.category);
          if (query.source) rows = rows.filter((r) => r.source === query.source);
          if (query.strategy) rows = rows.filter((r) => r.strategy === query.strategy);
          if (query.mode) rows = rows.filter((r) => r.mode === query.mode);
          if (query.status) rows = rows.filter((r) => r.status === query.status);
          if (query.entityType) rows = rows.filter((r) => r.entityType === query.entityType);
          if (query.entityId) rows = rows.filter((r) => r.entityId === query.entityId);
          if (query.q && query.q.trim().length > 0) {
            const q = query.q.toLowerCase();
            rows = rows.filter((r) => r.searchText.includes(q));
          }
          rows.sort(sortDesc);
          const decoded = query.cursor ? decodeCursor(query.cursor) : null;
          if (decoded) {
            rows = rows.filter(
              (r) =>
                r.timestamp < decoded.ts ||
                (r.timestamp === decoded.ts && r.eventId.localeCompare(decoded.id) < 0),
            );
          }
          const items = rows.slice(0, limit);
          const hasMore = rows.length > limit;
          const nextCursor = hasMore && items.length > 0 ? encodeCursor(items[items.length - 1]!) : null;
          return { items, hasMore, nextCursor } satisfies ObservabilityListResult;
        }),
      );

    const metrics = (query: Omit<ObservabilityListQuery, "cursor" | "limit"> = {}) =>
      list({ ...query, limit: 50000 }).pipe(
        Effect.map((result) => {
          const byCategory = new Map<ObservabilityCategory, number>();
          const byStatus = new Map<string, number>();
          for (const e of result.items) {
            byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + 1);
            byStatus.set(e.status ?? "unknown", (byStatus.get(e.status ?? "unknown") ?? 0) + 1);
          }
          return {
            total: result.items.length,
            byCategory: [...byCategory.entries()]
              .map(([category, count]) => ({ category, count }))
              .sort((a, b) => b.count - a.count),
            byStatus: [...byStatus.entries()]
              .map(([status, count]) => ({ status, count }))
              .sort((a, b) => b.count - a.count),
          } as const;
        }),
      );

    const latest = (limit = 200) =>
      list({ limit }).pipe(Effect.map((r) => r.items));

    return { append, list, metrics, latest } as const;
  }),
}) {}

import { Effect, Ref, Option } from "effect";
import { FileSystem } from "@effect/platform";
import crypto from "crypto";
import type { CriticalIncident } from "../types.js";
import { AppConfig } from "../config.js";
import { PostgresStorage } from "../storage/postgres.js";

const DATA_DIR = "data";
const INCIDENTS_FILE = "data/incidents.jsonl";

type IncidentPatch = {
  id: string;
  resolvedAt: number | null;
};

interface IncidentListQuery {
  limit?: number;
  activeOnly?: boolean;
}

function uid(): string {
  return `inc-${crypto.randomBytes(8).toString("hex")}`;
}

function sortDesc(a: CriticalIncident, b: CriticalIncident): number {
  if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
  return b.id.localeCompare(a.id);
}

export class CriticalIncidentStore extends Effect.Service<CriticalIncidentStore>()("CriticalIncidentStore", {
  scoped: Effect.gen(function* () {
    const configOpt = yield* Effect.serviceOption(AppConfig);
    const postgresOpt = yield* Effect.serviceOption(PostgresStorage);
    const backend = Option.match(configOpt, {
      onNone: () => "file" as const,
      onSome: (cfg) => cfg.storage.backend,
    });
    const postgres = Option.getOrUndefined(postgresOpt);
    const fs = yield* FileSystem.FileSystem;
    const useFile = backend === "file" || backend === "dual";
    const usePostgres = !!postgres && (backend === "postgres" || backend === "dual");
    const ref = yield* Ref.make(new Map<string, CriticalIncident>());

    const replay = Effect.gen(function* () {
      if (useFile) {
        const exists = yield* fs.exists(INCIDENTS_FILE);
        if (exists) {
          const content = yield* fs.readFileString(INCIDENTS_FILE);
          const lines = content.split("\n").filter(Boolean);
          yield* Ref.update(ref, (current) => {
            const next = new Map(current);
            for (const line of lines) {
              try {
                const parsed = JSON.parse(line) as
                  | { kind: "create"; incident: CriticalIncident }
                  | { kind: "resolve"; patch: IncidentPatch };
                if (parsed.kind === "create") {
                  next.set(parsed.incident.id, parsed.incident);
                } else if (parsed.kind === "resolve") {
                  const existing = next.get(parsed.patch.id);
                  if (existing) {
                    next.set(parsed.patch.id, { ...existing, resolvedAt: parsed.patch.resolvedAt });
                  }
                }
              } catch {
                /* ignore corrupt lines */
              }
            }
            return next;
          });
        }
      }
      if (usePostgres) {
        const rows = yield* postgres!.query<{
          id: string;
          kind: CriticalIncident["kind"];
          severity: "critical";
          message: string;
          fingerprint: string;
          details: Record<string, unknown>;
          created_at_ms: number;
          resolved_at_ms: number | null;
        }>(
          `select id, kind, severity, message, fingerprint, details, created_at_ms, resolved_at_ms
             from critical_incidents
             order by created_at_ms desc`,
        ).pipe(Effect.catchAll(() => Effect.succeed([])));
        yield* Ref.update(ref, (current) => {
          const next = new Map(current);
          for (const row of rows) {
            next.set(String(row.id), {
              id: String(row.id),
              kind: row.kind,
              severity: "critical",
              message: String(row.message),
              fingerprint: String(row.fingerprint),
              details: row.details ?? {},
              createdAt: Number(row.created_at_ms ?? 0),
              resolvedAt: row.resolved_at_ms === null ? null : Number(row.resolved_at_ms),
            });
          }
          return next;
        });
      }
    }).pipe(Effect.catchAll(() => Effect.void));
    yield* replay;

    const appendLine = (line: string) =>
      Effect.gen(function* () {
        if (useFile) {
          yield* fs.makeDirectory(DATA_DIR, { recursive: true }).pipe(Effect.catchAll(() => Effect.void));
          yield* fs.writeFileString(INCIDENTS_FILE, line + "\n", { flag: "a" }).pipe(Effect.catchAll(() => Effect.void));
        }
      });

    const create = (input: Omit<CriticalIncident, "id" | "createdAt" | "resolvedAt">) =>
      Effect.gen(function* () {
        const existing = yield* Ref.get(ref);
        for (const incident of existing.values()) {
          if (incident.fingerprint === input.fingerprint && incident.resolvedAt === null) {
            return incident;
          }
        }
        const incident: CriticalIncident = {
          id: uid(),
          kind: input.kind,
          severity: "critical",
          message: input.message,
          fingerprint: input.fingerprint,
          details: input.details,
          createdAt: Date.now(),
          resolvedAt: null,
        };
        yield* Ref.update(ref, (m) => {
          const next = new Map(m);
          next.set(incident.id, incident);
          return next;
        });
        yield* appendLine(JSON.stringify({ kind: "create", incident }));
        if (usePostgres) {
          yield* postgres!.execute(
            `insert into critical_incidents
              (id, kind, severity, message, fingerprint, details, created_at_ms, resolved_at_ms)
             values
              ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
             on conflict (id) do update set
              kind=excluded.kind,
              severity=excluded.severity,
              message=excluded.message,
              fingerprint=excluded.fingerprint,
              details=excluded.details,
              created_at_ms=excluded.created_at_ms,
              resolved_at_ms=excluded.resolved_at_ms`,
            [
              incident.id,
              incident.kind,
              incident.severity,
              incident.message,
              incident.fingerprint,
              JSON.stringify(incident.details ?? {}),
              incident.createdAt,
              incident.resolvedAt,
            ],
          ).pipe(Effect.catchAll(() => Effect.void));
        }
        return incident;
      });

    const resolve = (id: string) =>
      Effect.gen(function* () {
        const now = Date.now();
        const updated = yield* Ref.modify(ref, (m) => {
          const next = new Map(m);
          const existing = next.get(id);
          if (!existing) return [null as CriticalIncident | null, m] as const;
          const patched = { ...existing, resolvedAt: now };
          next.set(id, patched);
          return [patched, next] as const;
        });
        if (updated) {
          yield* appendLine(JSON.stringify({ kind: "resolve", patch: { id, resolvedAt: now } satisfies IncidentPatch }));
          if (usePostgres) {
            yield* postgres!.execute(
              "update critical_incidents set resolved_at_ms = $1 where id = $2",
              [now, id],
            ).pipe(Effect.catchAll(() => Effect.void));
          }
        }
        return updated;
      });

    const list = (query: IncidentListQuery = {}) =>
      Ref.get(ref).pipe(
        Effect.map((m) => {
          const limit = Math.max(1, Math.min(query.limit ?? 50, 500));
          let rows = [...m.values()];
          if (query.activeOnly) rows = rows.filter((r) => r.resolvedAt === null);
          rows.sort(sortDesc);
          return rows.slice(0, limit);
        }),
      );

    return { create, resolve, list } as const;
  }),
}) {}

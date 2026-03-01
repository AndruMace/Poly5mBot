import { Effect, Option } from "effect";
import { FileSystem } from "@effect/platform";
import { PersistenceError } from "./errors.js";
import { AppConfig } from "./config.js";
import { PostgresStorage } from "./storage/postgres.js";
import type { NotesPayload } from "./types.js";

const NOTES_DIR = "data";
const NOTES_FILE = "data/notes.json";
const MAX_NOTES_LENGTH = 100_000;

function sanitizeText(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.slice(0, MAX_NOTES_LENGTH);
}

const EMPTY_NOTES: NotesPayload = { text: "", updatedAt: 0 };

export class NotesStore extends Effect.Service<NotesStore>()("NotesStore", {
  effect: Effect.gen(function* () {
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

    const load = Effect.gen(function* () {
      if (usePostgres) {
        const rows = yield* postgres!.query<{ text_body: string; updated_at_ms: number }>(
          "select text_body, updated_at_ms from notes where id = 'default' limit 1",
        ).pipe(Effect.catchAll(() => Effect.succeed([])));
        if (rows.length > 0) {
          return {
            text: sanitizeText(rows[0]!.text_body),
            updatedAt: Number(rows[0]!.updated_at_ms ?? 0),
          } satisfies NotesPayload;
        }
      }
      if (useFile) {
        const exists = yield* fs.exists(NOTES_FILE);
        if (!exists) return EMPTY_NOTES;
        const raw = yield* fs.readFileString(NOTES_FILE);
        const parsed = JSON.parse(raw) as Partial<NotesPayload>;
        return {
          text: sanitizeText(parsed.text),
          updatedAt: typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0,
        };
      }
      return EMPTY_NOTES;
    }).pipe(
      Effect.catchAll(() => Effect.succeed(EMPTY_NOTES)),
    );

    const save = (text: string) =>
      Effect.gen(function* () {
        const payload: NotesPayload = {
          text: sanitizeText(text),
          updatedAt: Date.now(),
        };
        if (useFile) {
          yield* fs.makeDirectory(NOTES_DIR, { recursive: true }).pipe(
            Effect.catchAll(() => Effect.void),
          );
          yield* fs.writeFileString(NOTES_FILE, JSON.stringify(payload, null, 2));
        }
        if (usePostgres) {
          yield* postgres!.execute(
            `insert into notes (id, text_body, updated_at_ms)
             values ('default', $1, $2)
             on conflict (id) do update set text_body = excluded.text_body, updated_at_ms = excluded.updated_at_ms`,
            [payload.text, payload.updatedAt],
          );
        }
        return payload;
      }).pipe(
        Effect.catchAll((err) =>
          Effect.fail(new PersistenceError({ path: NOTES_FILE, message: String(err) })),
        ),
      );

    return { load, save } as const;
  }),
}) {}

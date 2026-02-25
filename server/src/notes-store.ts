import { Effect } from "effect";
import { FileSystem } from "@effect/platform";
import { PersistenceError } from "./errors.js";
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
    const fs = yield* FileSystem.FileSystem;

    const load = Effect.gen(function* () {
      const exists = yield* fs.exists(NOTES_FILE);
      if (!exists) return EMPTY_NOTES;
      const raw = yield* fs.readFileString(NOTES_FILE);
      const parsed = JSON.parse(raw) as Partial<NotesPayload>;
      return {
        text: sanitizeText(parsed.text),
        updatedAt: typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0,
      };
    }).pipe(
      Effect.catchAll(() => Effect.succeed(EMPTY_NOTES)),
    );

    const save = (text: string) =>
      Effect.gen(function* () {
        const payload: NotesPayload = {
          text: sanitizeText(text),
          updatedAt: Date.now(),
        };
        yield* fs.makeDirectory(NOTES_DIR, { recursive: true }).pipe(
          Effect.catchAll(() => Effect.void),
        );
        yield* fs.writeFileString(NOTES_FILE, JSON.stringify(payload, null, 2));
        return payload;
      }).pipe(
        Effect.catchAll((err) =>
          Effect.fail(new PersistenceError({ path: NOTES_FILE, message: String(err) })),
        ),
      );

    return { load, save } as const;
  }),
}) {}

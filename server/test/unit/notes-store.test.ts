import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { FileSystem } from "@effect/platform";
import { NotesStore } from "../../src/notes-store.js";
import { CoreTestLayer } from "../helpers.js";

describe("NotesStore", () => {
  it("loads defaults and saves content", () => {
    const files = new Map<string, string>();
    const fsLayer = Layer.succeed(FileSystem.FileSystem, {
      exists: (path: string) => Effect.succeed(files.has(path)),
      readFileString: (path: string) =>
        files.has(path)
          ? Effect.succeed(files.get(path)!)
          : Effect.fail(new Error(`missing ${path}`)),
      writeFileString: (path: string, content: string) =>
        Effect.sync(() => {
          files.set(path, content);
        }),
      makeDirectory: (_path: string, _options?: unknown) => Effect.void,
    } as any);

    const layer = NotesStore.Default.pipe(
      Layer.provideMerge(fsLayer),
      Layer.provideMerge(CoreTestLayer),
    );

    return Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* NotesStore;
        const initial = yield* store.load;
        expect(typeof initial.text).toBe("string");

        const saved = yield* store.save("hello tests");
        expect(saved.text).toBe("hello tests");
        expect(saved.updatedAt).toBeGreaterThan(0);

        const loaded = yield* store.load;
        expect(loaded.text).toBe("hello tests");
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
  });
});

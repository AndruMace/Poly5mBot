import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

export interface NotesPayload {
  text: string;
  updatedAt: number;
}

const NOTES_PATH = resolve(process.cwd(), "data", "notes.json");
const MAX_NOTES_LENGTH = 100_000;

const EMPTY_NOTES: NotesPayload = {
  text: "",
  updatedAt: 0,
};

function sanitizeText(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.slice(0, MAX_NOTES_LENGTH);
}

export function loadNotes(): NotesPayload {
  try {
    if (!existsSync(NOTES_PATH)) return EMPTY_NOTES;
    const raw = readFileSync(NOTES_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<NotesPayload>;
    return {
      text: sanitizeText(parsed.text),
      updatedAt:
        typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt)
          ? parsed.updatedAt
          : 0,
    };
  } catch {
    return EMPTY_NOTES;
  }
}

export function saveNotes(text: string): NotesPayload {
  const payload: NotesPayload = {
    text: sanitizeText(text),
    updatedAt: Date.now(),
  };

  mkdirSync(resolve(process.cwd(), "data"), { recursive: true });
  writeFileSync(NOTES_PATH, JSON.stringify(payload, null, 2), "utf-8");
  return payload;
}


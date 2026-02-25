import { useEffect, useMemo, useState } from "react";
import { ChevronUp, ChevronDown, NotebookPen, Save } from "lucide-react";

interface NotesResponse {
  text: string;
  updatedAt: number;
}

function formatSavedAt(updatedAt: number): string {
  if (!updatedAt) return "Not saved yet";
  return `Saved ${new Date(updatedAt).toLocaleTimeString()}`;
}

export function NotesDrawer() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [updatedAt, setUpdatedAt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = useMemo(() => text !== savedText, [text, savedText]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/notes");
        if (!res.ok) throw new Error(`Failed to load notes (${res.status})`);
        const data = (await res.json()) as NotesResponse;
        if (cancelled) return;
        const loaded = typeof data.text === "string" ? data.text : "";
        setText(loaded);
        setSavedText(loaded);
        setUpdatedAt(
          typeof data.updatedAt === "number" && Number.isFinite(data.updatedAt)
            ? data.updatedAt
            : 0,
        );
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message ?? "Failed to load notes");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveNow(): Promise<void> {
    if (saving || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/notes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        throw new Error(`Failed to save notes (${res.status})`);
      }
      const data = (await res.json()) as NotesResponse;
      const next = typeof data.text === "string" ? data.text : text;
      setText(next);
      setSavedText(next);
      setUpdatedAt(
        typeof data.updatedAt === "number" && Number.isFinite(data.updatedAt)
          ? data.updatedAt
          : Date.now(),
      );
    } catch (err: any) {
      setError(err?.message ?? "Failed to save notes");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className={`fixed bottom-0 right-4 z-40 ${
        open ? "w-[min(720px,calc(100vw-1.5rem))]" : "w-auto"
      }`}
    >
      <div className="rounded-t-xl border-[0.5px] border-[var(--border)]/70 bg-[var(--bg-card)] shadow-lg">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`flex w-full items-center justify-between gap-3 px-3 text-sm transition-all ${
            open
              ? "py-2"
              : "py-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          }`}
        >
          <span className="flex items-center gap-2">
            <NotebookPen size={14} className="text-[var(--accent-blue)]" />
            <span>Notes</span>
            {dirty && (
              <span className="rounded bg-[var(--accent-yellow)]/15 px-1.5 py-0.5 text-[10px] text-[var(--accent-yellow)]">
                Unsaved
              </span>
            )}
          </span>
          {open ? <ChevronDown size={14} /> : <ChevronUp size={12} />}
        </button>

        {open && (
          <div className="border-t-[0.5px] border-[var(--border)]/70 p-3">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Write notes here..."
              className="h-60 w-full resize-none rounded-md border-[0.5px] border-[var(--border)]/70 bg-[var(--bg-secondary)] p-2 text-sm outline-none focus:border-[var(--accent-blue)]"
              disabled={loading}
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <div className="text-xs text-[var(--text-secondary)]">
                {loading ? "Loading..." : formatSavedAt(updatedAt)}
                {error && (
                  <span className="ml-2 text-[var(--accent-red)]">{error}</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => void saveNow()}
                disabled={saving || loading || !dirty}
                className={`inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  saving || loading || !dirty
                    ? "cursor-not-allowed bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
                    : "bg-[var(--accent-blue)] text-white hover:opacity-90"
                }`}
              >
                <Save size={12} />
                {saving ? "Saving..." : "Save Notes"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


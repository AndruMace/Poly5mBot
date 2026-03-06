import { Effect, Ref, Option } from "effect";
import { FileSystem } from "@effect/platform";
import { AppConfig } from "../config.js";
import { PostgresStorage } from "../storage/postgres.js";
import { ObservabilityStore } from "../observability/store.js";

export type AccountActivityAction = "Buy" | "Sell" | "Redeem" | "Deposit";

export interface AccountActivityRecord {
  id: string;
  marketName: string;
  action: AccountActivityAction;
  usdcAmount: number;
  tokenAmount: number;
  tokenName: string;
  timestamp: number; // epoch seconds (Polymarket export convention)
  hash: string;
  source: "imported_csv";
  importedAt: number; // epoch ms
}

export interface ActivityListQuery {
  limit?: number;
  cursor?: string;
  sinceSec?: number;
}

export interface ActivityListResult {
  items: AccountActivityRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ActivityFreshness {
  latestActivityTimestampSec: number | null;
  latestImportedAtMs: number | null;
  ageSinceLatestActivitySec: number | null;
  ageSinceLatestImportSec: number | null;
  stale: boolean;
  staleThresholdSec: number;
}

const DATA_DIR = "data";
const ACTIVITY_FILE = "data/account-activity.jsonl";

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

function stripBomAndQuotes(header: string): string {
  return header.replace(/^\uFEFF/, "").replace(/^"+|"+$/g, "");
}

function csvToActivities(csvText: string): AccountActivityRecord[] {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]!).map(stripBomAndQuotes);
  const idx = (name: string) => headers.findIndex((h) => h === name);

  const marketIdx = idx("marketName");
  const actionIdx = idx("action");
  const usdcIdx = idx("usdcAmount");
  const tokenAmtIdx = idx("tokenAmount");
  const tokenNameIdx = idx("tokenName");
  const tsIdx = idx("timestamp");
  const hashIdx = idx("hash");

  if (
    marketIdx < 0 ||
    actionIdx < 0 ||
    usdcIdx < 0 ||
    tokenAmtIdx < 0 ||
    tokenNameIdx < 0 ||
    tsIdx < 0 ||
    hashIdx < 0
  ) {
    return [];
  }

  const now = Date.now();
  const out: AccountActivityRecord[] = [];
  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    const action = cols[actionIdx] as AccountActivityAction | undefined;
    if (action !== "Buy" && action !== "Sell" && action !== "Redeem" && action !== "Deposit") continue;
    const marketName = cols[marketIdx] ?? "";
    const usdcAmount = Number(cols[usdcIdx] ?? 0);
    const tokenAmount = Number(cols[tokenAmtIdx] ?? 0);
    const tokenName = cols[tokenNameIdx] ?? "";
    const timestamp = Number(cols[tsIdx] ?? 0);
    const hash = cols[hashIdx] ?? "";
    if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
    const recordKey = `${hash}|${action}|${timestamp}|${tokenName}|${marketName}|${usdcAmount}|${tokenAmount}`;
    out.push({
      id: recordKey,
      marketName,
      action,
      usdcAmount: Number.isFinite(usdcAmount) ? usdcAmount : 0,
      tokenAmount: Number.isFinite(tokenAmount) ? tokenAmount : 0,
      tokenName,
      timestamp,
      hash,
      source: "imported_csv",
      importedAt: now,
    });
  }
  return out;
}

function encodeCursor(t: AccountActivityRecord): string {
  return Buffer.from(JSON.stringify({ ts: t.timestamp, id: t.id }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { ts: number; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      ts: unknown;
      id: unknown;
    };
    if (typeof parsed.ts === "number" && typeof parsed.id === "string") {
      return { ts: parsed.ts, id: parsed.id };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function sortDesc(a: AccountActivityRecord, b: AccountActivityRecord): number {
  if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
  return b.id.localeCompare(a.id);
}

export class AccountActivityStore extends Effect.Service<AccountActivityStore>()("AccountActivityStore", {
  scoped: Effect.gen(function* () {
    const configOpt = yield* Effect.serviceOption(AppConfig);
    const postgresOpt = yield* Effect.serviceOption(PostgresStorage);
    const observabilityOpt = yield* Effect.serviceOption(ObservabilityStore);
    const backend = Option.match(configOpt, {
      onNone: () => "file" as const,
      onSome: (cfg) => cfg.storage.backend,
    });
    const postgres = Option.getOrUndefined(postgresOpt);
    const observability = Option.getOrUndefined(observabilityOpt);
    const fs = yield* FileSystem.FileSystem;
    const useFile = backend === "file" || backend === "dual";
    const usePostgres = !!postgres && (backend === "postgres" || backend === "dual");
    const ref = yield* Ref.make(new Map<string, AccountActivityRecord>());

    const replay = Effect.gen(function* () {
      if (useFile) {
        const exists = yield* fs.exists(ACTIVITY_FILE);
        if (exists) {
          const content = yield* fs.readFileString(ACTIVITY_FILE);
          const lines = content.split("\n").filter(Boolean);
          yield* Ref.update(ref, (m) => {
            const next = new Map(m);
            for (const line of lines) {
              try {
                const rec = JSON.parse(line) as AccountActivityRecord;
                if (rec && typeof rec.id === "string" && rec.id.length > 0) {
                  next.set(rec.id, rec);
                }
              } catch {
                /* ignore corrupt line */
              }
            }
            return next;
          });
        }
      }
      if (usePostgres) {
        const rows = yield* postgres!.query<{
          id: string;
          market_name: string;
          action: AccountActivityAction;
          usdc_amount: number;
          token_amount: number;
          token_name: string;
          timestamp_sec: number;
          tx_hash: string;
          source: "imported_csv";
          imported_at_ms: number;
        }>(
          `select id, market_name, action, usdc_amount, token_amount, token_name, timestamp_sec, tx_hash, source, imported_at_ms
             from account_activity
             order by timestamp_sec desc`,
        ).pipe(Effect.catchAll(() => Effect.succeed([])));
        yield* Ref.update(ref, (m) => {
          const next = new Map(m);
          for (const row of rows) {
            next.set(String(row.id), {
              id: String(row.id),
              marketName: String(row.market_name),
              action: row.action,
              usdcAmount: Number(row.usdc_amount ?? 0),
              tokenAmount: Number(row.token_amount ?? 0),
              tokenName: String(row.token_name ?? ""),
              timestamp: Number(row.timestamp_sec ?? 0),
              hash: String(row.tx_hash ?? ""),
              source: "imported_csv",
              importedAt: Number(row.imported_at_ms ?? 0),
            });
          }
          return next;
        });
      }
    }).pipe(Effect.catchAll(() => Effect.void));

    yield* replay;

    const importCsv = (csvText: string) =>
      Effect.gen(function* () {
        const parsed = csvToActivities(csvText);
        if (parsed.length === 0) return { imported: 0, skipped: 0 };
        const known = yield* Ref.get(ref);
        const toWrite: AccountActivityRecord[] = [];
        let skipped = 0;
        for (const rec of parsed) {
          if (known.has(rec.id)) {
            skipped += 1;
            continue;
          }
          toWrite.push(rec);
        }
        if (toWrite.length > 0) {
          yield* Ref.update(ref, (m) => {
            const next = new Map(m);
            for (const rec of toWrite) next.set(rec.id, rec);
            return next;
          });
          if (useFile) {
            yield* fs.makeDirectory(DATA_DIR, { recursive: true }).pipe(Effect.catchAll(() => Effect.void));
            const data = toWrite.map((r) => JSON.stringify(r)).join("\n") + "\n";
            yield* fs.writeFileString(ACTIVITY_FILE, data, { flag: "a" }).pipe(Effect.catchAll(() => Effect.void));
          }
          if (usePostgres) {
            yield* Effect.forEach(toWrite, (r) =>
              postgres!.execute(
                `insert into account_activity
                  (id, market_name, action, usdc_amount, token_amount, token_name, timestamp_sec, tx_hash, source, imported_at_ms, payload)
                 values
                  ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
                 on conflict (id) do nothing`,
                [
                  r.id,
                  r.marketName,
                  r.action,
                  r.usdcAmount,
                  r.tokenAmount,
                  r.tokenName,
                  r.timestamp,
                  r.hash,
                  r.source,
                  r.importedAt,
                  JSON.stringify(r),
                ],
              ).pipe(Effect.catchAll(() => Effect.void)),
              { discard: true },
            );
          }
          if (observability) {
            yield* Effect.forEach(
              toWrite,
              (r) =>
                observability.append({
                  category: "activity",
                  source: "activity_store",
                  action: "activity_imported",
                  entityType: "activity",
                  entityId: r.id,
                  status: r.action,
                  mode: null,
                  payload: {
                    marketName: r.marketName,
                    action: r.action,
                    usdcAmount: r.usdcAmount,
                    tokenAmount: r.tokenAmount,
                    tokenName: r.tokenName,
                    timestamp: r.timestamp,
                    hash: r.hash,
                  },
                }).pipe(Effect.catchAll(() => Effect.void)),
              { discard: true },
            );
          }
        }
        if (observability) {
          yield* observability.append({
            category: "activity",
            source: "activity_store",
            action: "activity_import_summary",
            entityType: "system",
            entityId: null,
            status: null,
            mode: null,
            payload: {
              imported: toWrite.length,
              skipped,
              parsed: parsed.length,
            },
          }).pipe(Effect.catchAll(() => Effect.void));
        }
        return { imported: toWrite.length, skipped };
      });

    const list = (query: ActivityListQuery = {}) =>
      Ref.get(ref).pipe(
        Effect.map((map) => {
          const limit = Math.max(1, Math.min(query.limit ?? 100, 1000));
          let rows = [...map.values()];
          if (typeof query.sinceSec === "number" && Number.isFinite(query.sinceSec)) {
            rows = rows.filter((r) => r.timestamp >= query.sinceSec!);
          }
          rows.sort(sortDesc);
          const decoded = query.cursor ? decodeCursor(query.cursor) : null;
          if (decoded) {
            rows = rows.filter(
              (r) =>
                r.timestamp < decoded.ts ||
                (r.timestamp === decoded.ts && r.id.localeCompare(decoded.id) < 0),
            );
          }
          const items = rows.slice(0, limit);
          const hasMore = rows.length > limit;
          const nextCursor = hasMore && items.length > 0 ? encodeCursor(items[items.length - 1]!) : null;
          return { items, hasMore, nextCursor } satisfies ActivityListResult;
        }),
      );

    const getFreshness = (staleThresholdSec = 600) =>
      Ref.get(ref).pipe(
        Effect.map((map) => {
          const rows = [...map.values()];
          if (rows.length === 0) {
            return {
              latestActivityTimestampSec: null,
              latestImportedAtMs: null,
              ageSinceLatestActivitySec: null,
              ageSinceLatestImportSec: null,
              stale: true,
              staleThresholdSec,
            } satisfies ActivityFreshness;
          }
          const latestActivityTimestampSec = rows.reduce((max, r) => Math.max(max, r.timestamp), 0);
          const latestImportedAtMs = rows.reduce((max, r) => Math.max(max, r.importedAt), 0);
          const nowSec = Math.floor(Date.now() / 1000);
          const nowMs = Date.now();
          const ageSinceLatestActivitySec = Math.max(0, nowSec - latestActivityTimestampSec);
          const ageSinceLatestImportSec = Math.floor(Math.max(0, nowMs - latestImportedAtMs) / 1000);
          return {
            latestActivityTimestampSec,
            latestImportedAtMs,
            ageSinceLatestActivitySec,
            ageSinceLatestImportSec,
            stale: ageSinceLatestImportSec > staleThresholdSec,
            staleThresholdSec,
          } satisfies ActivityFreshness;
        }),
      );

    return {
      importCsv,
      list,
      getFreshness,
    } as const;
  }),
}) {}

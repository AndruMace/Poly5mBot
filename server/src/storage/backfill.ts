import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Pool } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");
const dataDir = path.resolve(repoRoot, "server/data");
dotenv.config({ path: path.resolve(repoRoot, ".env") });

type TradeEventLine = {
  id: string;
  tradeId: string;
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
};

type IncidentCreateLine = {
  kind: "create";
  incident: {
    id: string;
    kind: string;
    severity: string;
    message: string;
    fingerprint: string;
    details: Record<string, unknown>;
    createdAt: number;
    resolvedAt: number | null;
  };
};

type IncidentResolveLine = {
  kind: "resolve";
  patch: { id: string; resolvedAt: number | null };
};

async function readLines(filePath: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw.split("\n").map((x) => x.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const liveEvents = await readLines(path.join(dataDir, "events.jsonl"));
    const shadowEvents = await readLines(path.join(dataDir, "shadow-events.jsonl"));
    for (const [stream, lines] of [
      ["live", liveEvents] as const,
      ["shadow", shadowEvents] as const,
    ]) {
      for (const line of lines) {
        let e: TradeEventLine | null = null;
        try {
          e = JSON.parse(line) as TradeEventLine;
        } catch {
          continue;
        }
        await pool.query(
          `insert into trade_events (id, trade_id, stream, event_type, event_ts, data)
           values ($1,$2,$3,$4,$5,$6::jsonb)
           on conflict (id) do nothing`,
          [e.id, e.tradeId, stream, e.type, e.timestamp, JSON.stringify(e.data ?? {})],
        );
      }
    }

    const activityLines = await readLines(path.join(dataDir, "account-activity.jsonl"));
    for (const line of activityLines) {
      let a: any = null;
      try {
        a = JSON.parse(line);
      } catch {
        continue;
      }
      await pool.query(
        `insert into account_activity
          (id, market_name, action, usdc_amount, token_amount, token_name, timestamp_sec, tx_hash, source, imported_at_ms, payload)
         values
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
         on conflict (id) do nothing`,
        [
          a.id,
          a.marketName ?? "",
          a.action ?? "Buy",
          Number(a.usdcAmount ?? 0),
          Number(a.tokenAmount ?? 0),
          a.tokenName ?? "",
          Number(a.timestamp ?? 0),
          a.hash ?? "",
          a.source ?? "imported_csv",
          Number(a.importedAt ?? Date.now()),
          JSON.stringify(a ?? {}),
        ],
      );
    }

    const incidentLines = await readLines(path.join(dataDir, "incidents.jsonl"));
    const incidentMap = new Map<string, IncidentCreateLine["incident"]>();
    for (const line of incidentLines) {
      let parsed: IncidentCreateLine | IncidentResolveLine | null = null;
      try {
        parsed = JSON.parse(line) as IncidentCreateLine | IncidentResolveLine;
      } catch {
        continue;
      }
      if (parsed.kind === "create") {
        incidentMap.set(parsed.incident.id, parsed.incident);
      } else if (parsed.kind === "resolve") {
        const existing = incidentMap.get(parsed.patch.id);
        if (existing) {
          existing.resolvedAt = parsed.patch.resolvedAt;
        }
      }
    }
    for (const incident of incidentMap.values()) {
      await pool.query(
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
      );
    }

    try {
      const raw = await fs.readFile(path.join(dataDir, "notes.json"), "utf8");
      const notes = JSON.parse(raw) as { text?: string; updatedAt?: number };
      await pool.query(
        `insert into notes (id, text_body, updated_at_ms)
         values ('default', $1, $2)
         on conflict (id) do update set text_body = excluded.text_body, updated_at_ms = excluded.updated_at_ms`,
        [String(notes.text ?? ""), Number(notes.updatedAt ?? 0)],
      );
    } catch {
      /* no notes file */
    }

    try {
      const raw = await fs.readFile(path.join(dataDir, "strategy-state.json"), "utf8");
      const state = JSON.parse(raw) as Record<string, unknown>;
      const marketIdRows = await pool.query<{ has_market_id: boolean }>(
        `select exists(
          select 1
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'strategy_state'
            and column_name = 'market_id'
        ) as has_market_id`,
      );
      const hasMarketId = marketIdRows.rows[0]?.has_market_id === true;
      for (const [strategyName, payload] of Object.entries(state)) {
        if (hasMarketId) {
          await pool.query(
            `insert into strategy_state (market_id, strategy_name, payload, updated_at_ms)
             values ($1, $2, $3::jsonb, $4)
             on conflict (market_id, strategy_name) do update set payload = excluded.payload, updated_at_ms = excluded.updated_at_ms`,
            ["btc", strategyName, JSON.stringify(payload ?? {}), Date.now()],
          );
        } else {
          await pool.query(
            `insert into strategy_state (strategy_name, payload, updated_at_ms)
             values ($1, $2::jsonb, $3)
             on conflict (strategy_name) do update set payload = excluded.payload, updated_at_ms = excluded.updated_at_ms`,
            [strategyName, JSON.stringify(payload ?? {}), Date.now()],
          );
        }
      }
    } catch {
      /* no strategy state file */
    }

    console.log("Backfill complete.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});

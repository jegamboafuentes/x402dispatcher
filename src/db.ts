import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  getDataDir,
  getGcsBucket,
  getGcsObject,
  getLegacyCashflowJsonPath,
  getLegacyStatsJsonPath,
  getSqlitePath,
} from "./paths.js";

type GcsFile = {
  download: (opts: { destination: string }) => Promise<unknown>;
  exists: () => Promise<[boolean]>;
  save: (
    data: Buffer,
    opts: {
      resumable: boolean;
      metadata: { contentType: string };
      preconditionOpts?: { ifGenerationMatch: number };
    },
  ) => Promise<unknown>;
  getMetadata: () => Promise<[{ generation?: string | number }]>;
};

let db: DatabaseSync | undefined;
let persistChain: Promise<void> = Promise.resolve();
let gcsGeneration: number | undefined;
let restored = false;

async function gcsFile(): Promise<GcsFile | undefined> {
  const name = getGcsBucket();
  if (!name) return undefined;
  const { Storage } = await import("@google-cloud/storage");
  return new Storage().bucket(name).file(getGcsObject()) as unknown as GcsFile;
}

function openDb(): DatabaseSync {
  fs.mkdirSync(getDataDir(), { recursive: true });
  const database = new DatabaseSync(getSqlitePath());
  database.exec("PRAGMA journal_mode = DELETE");
  database.exec("PRAGMA synchronous = FULL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS cashflow (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      direction TEXT NOT NULL,
      amount_usd REAL NOT NULL,
      amount_atomic TEXT,
      network TEXT NOT NULL,
      tool TEXT,
      task TEXT,
      from_addr TEXT,
      to_addr TEXT,
      tx_hash TEXT,
      explorer_url TEXT,
      upstream_url TEXT,
      correlation_id TEXT,
      status TEXT NOT NULL,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cashflow_at ON cashflow(at);
    CREATE TABLE IF NOT EXISTS api_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      ok INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      at TEXT NOT NULL,
      task TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_outcomes_url ON api_outcomes(url);
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return database;
}

function migrateJsonIfNeeded(database: DatabaseSync): void {
  const count = database.prepare("SELECT COUNT(*) AS n FROM cashflow").get() as { n: number };
  const jsonPath = getLegacyCashflowJsonPath();
  if (count.n === 0 && fs.existsSync(jsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as {
        entries?: Array<Record<string, unknown>>;
      };
      const insert = database.prepare(`
        INSERT OR IGNORE INTO cashflow (
          id, at, direction, amount_usd, amount_atomic, network, tool, task,
          from_addr, to_addr, tx_hash, explorer_url, upstream_url, correlation_id, status, note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const e of parsed.entries ?? []) {
        insert.run(
          String(e.id ?? ""),
          String(e.at ?? ""),
          String(e.direction ?? ""),
          Number(e.amount_usd ?? 0),
          e.amount_atomic == null ? null : String(e.amount_atomic),
          String(e.network ?? ""),
          e.tool == null ? null : String(e.tool),
          e.task == null ? null : String(e.task),
          e.from == null ? null : String(e.from),
          e.to == null ? null : String(e.to),
          e.tx_hash == null ? null : String(e.tx_hash),
          e.explorer_url == null ? null : String(e.explorer_url),
          e.upstream_url == null ? null : String(e.upstream_url),
          e.correlation_id == null ? null : String(e.correlation_id),
          String(e.status ?? "success"),
          e.note == null ? null : String(e.note),
        );
      }
      console.error(`Migrated ${parsed.entries?.length ?? 0} cashflow JSON rows into SQLite`);
    } catch (error) {
      console.error("Cashflow JSON migration skipped:", error instanceof Error ? error.message : error);
    }
  }

  const outcomes = database.prepare("SELECT COUNT(*) AS n FROM api_outcomes").get() as { n: number };
  const statsPath = getLegacyStatsJsonPath();
  if (outcomes.n === 0 && fs.existsSync(statsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(statsPath, "utf8")) as {
        apis?: Record<string, { url?: string; outcomes?: Array<Record<string, unknown>> }>;
      };
      const insert = database.prepare(
        "INSERT INTO api_outcomes (url, ok, latency_ms, at, task, error) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const entry of Object.values(parsed.apis ?? {})) {
        const url = String(entry.url ?? "");
        for (const o of entry.outcomes ?? []) {
          insert.run(
            url,
            o.ok ? 1 : 0,
            Number(o.latency_ms ?? 0),
            String(o.at ?? new Date().toISOString()),
            o.task == null ? null : String(o.task),
            o.error == null ? null : String(o.error),
          );
        }
      }
      console.error("Migrated api-stats JSON into SQLite");
    } catch (error) {
      console.error("Stats JSON migration skipped:", error instanceof Error ? error.message : error);
    }
  }
}

export async function restoreLedger(): Promise<void> {
  if (restored) return;
  restored = true;
  fs.mkdirSync(getDataDir(), { recursive: true });
  const file = await gcsFile();
  const sqlitePath = getSqlitePath();
  if (file) {
    try {
      const [exists] = await file.exists();
      if (exists) {
        await file.download({ destination: sqlitePath });
        const [meta] = await file.getMetadata();
        gcsGeneration = meta.generation == null ? undefined : Number(meta.generation);
        console.error(`Restored SQLite ledger from gs://${getGcsBucket()}/${getGcsObject()}`);
      } else {
        console.error(`No GCS ledger yet at gs://${getGcsBucket()}/${getGcsObject()} (first boot)`);
      }
    } catch (error) {
      console.error(
        "GCS ledger restore failed; starting with local SQLite:",
        error instanceof Error ? error.message : error,
      );
    }
  }
  db = openDb();
  migrateJsonIfNeeded(db);
}

export function getDb(): DatabaseSync {
  if (!db) {
    db = openDb();
    migrateJsonIfNeeded(db);
  }
  return db;
}

export function touchMeta(): void {
  getDb()
    .prepare(
      "INSERT INTO meta(key, value) VALUES('updated_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(new Date().toISOString());
}

export function getLedgerUpdatedAt(): string {
  const row = getDb().prepare("SELECT value FROM meta WHERE key='updated_at'").get() as
    | { value: string }
    | undefined;
  return row?.value ?? new Date().toISOString();
}

async function uploadLedger(): Promise<void> {
  const file = await gcsFile();
  if (!file) return;
  const sqlitePath = getSqlitePath();
  if (!fs.existsSync(sqlitePath)) return;
  const body = fs.readFileSync(sqlitePath);
  try {
    await file.save(body, {
      resumable: false,
      metadata: { contentType: "application/vnd.sqlite3" },
      preconditionOpts:
        gcsGeneration !== undefined ? { ifGenerationMatch: gcsGeneration } : { ifGenerationMatch: 0 },
    });
    const [meta] = await file.getMetadata();
    gcsGeneration = meta.generation == null ? undefined : Number(meta.generation);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!/precondition|412|condition/i.test(msg)) {
      throw error;
    }
    await file.download({ destination: sqlitePath });
    const [meta] = await file.getMetadata();
    gcsGeneration = meta.generation == null ? undefined : Number(meta.generation);
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      db = undefined;
    }
    db = openDb();
    throw new Error("GCS generation conflict; ledger reloaded — retry persist");
  }
}

export async function persistLedger(): Promise<void> {
  persistChain = persistChain.then(async () => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        await uploadLedger();
        return;
      } catch (error) {
        if (attempt === 4) {
          console.error("GCS ledger persist failed:", error instanceof Error ? error.message : error);
          return;
        }
      }
    }
  });
  await persistChain;
}

export function getLedgerStatus() {
  return {
    driver: "sqlite" as const,
    path: getSqlitePath(),
    gcs_bucket: getGcsBucket() ?? null,
    gcs_object: getGcsBucket() ? getGcsObject() : null,
    durable: Boolean(getGcsBucket()),
  };
}

import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function getDataDir(): string {
  return process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
}

export function getSqlitePath(): string {
  return path.join(getDataDir(), "ledger.sqlite");
}

export function getLegacyCashflowJsonPath(): string {
  return path.join(getDataDir(), "cashflow.json");
}

export function getLegacyStatsJsonPath(): string {
  return path.join(getDataDir(), "api-stats.json");
}

export function getGcsBucket(): string | undefined {
  const raw = process.env.GCS_DATA_BUCKET?.trim();
  return raw ? raw : undefined;
}

export function getGcsObject(): string {
  return process.env.GCS_DATA_OBJECT?.trim() || "ledger.sqlite";
}

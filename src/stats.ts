import {
  getVerifiedMinSamples,
  getVerifiedMinSuccessRate,
} from "./config.js";
import { getDb, persistLedger, touchMeta } from "./db.js";
import { getSqlitePath } from "./paths.js";

export type ApiOutcome = {
  ok: boolean;
  latency_ms: number;
  at: string;
  task?: string;
  error?: string;
};

export type ApiStats = {
  url: string;
  calls: number;
  successes: number;
  failures: number;
  success_rate: number;
  avg_latency_ms: number;
  p50_latency_ms: number;
  last_called_at?: string;
  last_error?: string;
  recent: ApiOutcome[];
};

const MAX_RECENT = 50;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

export function summarizeUrl(url: string, outcomes: ApiOutcome[]): ApiStats {
  const calls = outcomes.length;
  const successes = outcomes.filter((o) => o.ok).length;
  const failures = calls - successes;
  const latencies = outcomes.map((o) => o.latency_ms).sort((a, b) => a - b);
  const avg =
    latencies.length === 0 ? 0 : latencies.reduce((sum, n) => sum + n, 0) / latencies.length;
  const last = outcomes[outcomes.length - 1];

  return {
    url,
    calls,
    successes,
    failures,
    success_rate: calls === 0 ? 0 : successes / calls,
    avg_latency_ms: Math.round(avg),
    p50_latency_ms: Math.round(percentile(latencies, 0.5)),
    last_called_at: last?.at,
    last_error: [...outcomes].reverse().find((o) => !o.ok)?.error,
    recent: outcomes.slice(-10),
  };
}

function outcomesForUrl(url: string): ApiOutcome[] {
  const rows = getDb()
    .prepare(
      "SELECT ok, latency_ms, at, task, error FROM api_outcomes WHERE url = ? ORDER BY id ASC",
    )
    .all(url) as Array<{
    ok: number;
    latency_ms: number;
    at: string;
    task: string | null;
    error: string | null;
  }>;
  return rows.map((row) => ({
    ok: Boolean(row.ok),
    latency_ms: row.latency_ms,
    at: row.at,
    task: row.task ?? undefined,
    error: row.error ?? undefined,
  }));
}

export async function recordOutcome(input: {
  url: string;
  ok: boolean;
  latencyMs: number;
  task?: string;
  error?: string;
}): Promise<ApiStats> {
  const database = getDb();
  database
    .prepare("INSERT INTO api_outcomes (url, ok, latency_ms, at, task, error) VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      input.url,
      input.ok ? 1 : 0,
      Math.max(0, Math.round(input.latencyMs)),
      new Date().toISOString(),
      input.task ?? null,
      input.error ?? null,
    );
  database
    .prepare(
      `DELETE FROM api_outcomes WHERE url = ? AND id NOT IN (
         SELECT id FROM api_outcomes WHERE url = ? ORDER BY id DESC LIMIT ?
       )`,
    )
    .run(input.url, input.url, MAX_RECENT);
  touchMeta();
  await persistLedger();
  return summarizeUrl(input.url, outcomesForUrl(input.url));
}

export function getStatsForUrl(url: string): ApiStats | undefined {
  const outcomes = outcomesForUrl(url);
  if (outcomes.length === 0) return undefined;
  return summarizeUrl(url, outcomes);
}

export function listAllStats(): ApiStats[] {
  const urls = getDb().prepare("SELECT DISTINCT url FROM api_outcomes").all() as Array<{ url: string }>;
  return urls
    .map((row) => summarizeUrl(row.url, outcomesForUrl(row.url)))
    .sort((a, b) => b.calls - a.calls || b.success_rate - a.success_rate);
}

export function isVerified(stats: ApiStats | undefined): boolean {
  if (!stats) return false;
  return stats.calls >= getVerifiedMinSamples() && stats.success_rate >= getVerifiedMinSuccessRate();
}

export function listVerifiedStats(): ApiStats[] {
  return listAllStats().filter((stats) => isVerified(stats));
}

export function routeScore(input: {
  totalPriceUsd: number;
  stats?: ApiStats;
  bazaarVolume?: number;
}): number {
  const pricePenalty = input.totalPriceUsd * 1000;
  const stats = input.stats;

  if (!stats || stats.calls === 0) {
    return 10 - pricePenalty + Math.min(input.bazaarVolume ?? 0, 50) * 0.01;
  }

  const reliability = stats.success_rate * 100;
  const latencyPenalty = Math.min(stats.p50_latency_ms, 20_000) / 200;
  const volumeBonus = Math.min(stats.calls, 20) * 0.5;
  return reliability + volumeBonus - latencyPenalty - pricePenalty;
}

export function getStatsPath(): string {
  return getSqlitePath();
}

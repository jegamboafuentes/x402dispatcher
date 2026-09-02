import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getVerifiedMinSamples,
  getVerifiedMinSuccessRate,
} from "./config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, "data");
const STATS_PATH = path.join(DATA_DIR, "api-stats.json");

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

type StatsFile = {
  version: 1;
  updated_at: string;
  apis: Record<
    string,
    {
      url: string;
      outcomes: ApiOutcome[];
    }
  >;
};

const MAX_RECENT = 50;

function emptyFile(): StatsFile {
  return { version: 1, updated_at: new Date().toISOString(), apis: {} };
}

function readFile(): StatsFile {
  try {
    if (!fs.existsSync(STATS_PATH)) {
      return emptyFile();
    }
    const raw = fs.readFileSync(STATS_PATH, "utf8");
    const parsed = JSON.parse(raw) as StatsFile;
    if (!parsed.apis) {
      return emptyFile();
    }
    return parsed;
  } catch {
    return emptyFile();
  }
}

function writeFile(file: StatsFile): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  file.updated_at = new Date().toISOString();
  fs.writeFileSync(STATS_PATH, JSON.stringify(file, null, 2), "utf8");
}

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
    latencies.length === 0
      ? 0
      : latencies.reduce((sum, n) => sum + n, 0) / latencies.length;
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

export function recordOutcome(input: {
  url: string;
  ok: boolean;
  latencyMs: number;
  task?: string;
  error?: string;
}): ApiStats {
  const file = readFile();
  const entry = file.apis[input.url] ?? { url: input.url, outcomes: [] };
  entry.outcomes.push({
    ok: input.ok,
    latency_ms: Math.max(0, Math.round(input.latencyMs)),
    at: new Date().toISOString(),
    task: input.task,
    error: input.error,
  });
  if (entry.outcomes.length > MAX_RECENT) {
    entry.outcomes = entry.outcomes.slice(-MAX_RECENT);
  }
  file.apis[input.url] = entry;
  writeFile(file);
  return summarizeUrl(input.url, entry.outcomes);
}

export function getStatsForUrl(url: string): ApiStats | undefined {
  const file = readFile();
  const entry = file.apis[url];
  if (!entry) return undefined;
  return summarizeUrl(url, entry.outcomes);
}

export function listAllStats(): ApiStats[] {
  const file = readFile();
  return Object.values(file.apis)
    .map((entry) => summarizeUrl(entry.url, entry.outcomes))
    .sort((a, b) => b.calls - a.calls || b.success_rate - a.success_rate);
}

export function isVerified(stats: ApiStats | undefined): boolean {
  if (!stats) return false;
  return (
    stats.calls >= getVerifiedMinSamples() &&
    stats.success_rate >= getVerifiedMinSuccessRate()
  );
}

export function listVerifiedStats(): ApiStats[] {
  return listAllStats().filter((stats) => isVerified(stats));
}

/**
 * Higher is better. Balances reliability, speed, and price.
 * Unscored / cold APIs get a low but usable economy score from price alone.
 */
export function routeScore(input: {
  totalPriceUsd: number;
  stats?: ApiStats;
  bazaarVolume?: number;
}): number {
  const pricePenalty = input.totalPriceUsd * 1000; // $0.001 → 1
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
  return STATS_PATH;
}

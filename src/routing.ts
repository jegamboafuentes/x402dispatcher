import {
  getMarkupBps,
  getMaxPriceUsd,
  getNetworkLabel,
  getVerifiedMinSamples,
  getVerifiedMinSuccessRate,
} from "./config.js";
import { discoverApis, summarizeApi, type DiscoveredApi } from "./discovery.js";
import { callDiscoveredApi, estimateTotalUsd, type ProxyCallArgs } from "./payment.js";
import {
  getStatsForUrl,
  isVerified,
  recordOutcome,
  routeScore,
  type ApiStats,
} from "./stats.js";

export type RouteTier = "economy" | "verified";

export type RouteCandidate = {
  rank: number;
  tool_name: string;
  url: string;
  method: string;
  description: string;
  upstream_price_usd: number;
  markup_bps: number;
  total_price_usd: number;
  network: string;
  pay_to: string;
  tier: RouteTier;
  verified: boolean;
  route_score: number;
  success_rate?: number;
  calls?: number;
  avg_latency_ms?: number;
  p50_latency_ms?: number;
  quality_score?: number;
  example_query?: Record<string, unknown>;
  example_body?: Record<string, unknown>;
  api: DiscoveredApi;
};

function bazaarVolume(api: DiscoveredApi): number {
  return api.resource.quality?.l30DaysTotalCalls ?? 0;
}

function toCandidate(api: DiscoveredApi, tier: RouteTier): RouteCandidate {
  const total = estimateTotalUsd(api.upstreamPriceUsd);
  const stats = getStatsForUrl(api.url);
  const verified = isVerified(stats);
  const score = routeScore({
    totalPriceUsd: total,
    stats,
    bazaarVolume: bazaarVolume(api),
  });

  return {
    rank: 0,
    tool_name: api.toolName,
    url: api.url,
    method: api.method,
    description: api.description,
    upstream_price_usd: api.upstreamPriceUsd,
    markup_bps: getMarkupBps(),
    total_price_usd: total,
    network: api.network,
    pay_to: api.payTo,
    tier,
    verified,
    route_score: Number(score.toFixed(4)),
    success_rate: stats?.success_rate,
    calls: stats?.calls,
    avg_latency_ms: stats?.avg_latency_ms,
    p50_latency_ms: stats?.p50_latency_ms,
    quality_score: bazaarVolume(api) || undefined,
    example_query: api.exampleQuery,
    example_body: api.exampleBody,
    api,
  };
}

function withoutApi(candidate: RouteCandidate): Omit<RouteCandidate, "api"> {
  const { api: _api, ...rest } = candidate;
  return rest;
}

function sortCandidates(candidates: RouteCandidate[], tier: RouteTier): RouteCandidate[] {
  const sorted = [...candidates].sort((a, b) => {
    if (tier === "economy") {
      if (a.total_price_usd !== b.total_price_usd) {
        return a.total_price_usd - b.total_price_usd;
      }
      return b.route_score - a.route_score;
    }
    if (a.route_score !== b.route_score) {
      return b.route_score - a.route_score;
    }
    return a.total_price_usd - b.total_price_usd;
  });

  return sorted.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

export async function buildRouteCandidates(options: {
  task: string;
  maxPriceUsd?: number;
  limit?: number;
  tier?: RouteTier;
}): Promise<RouteCandidate[]> {
  const task = options.task.trim();
  if (!task) {
    throw new Error("task is required");
  }

  const tier = options.tier ?? "economy";
  const budget = options.maxPriceUsd ?? getMaxPriceUsd();
  if (!(budget >= 0) || !Number.isFinite(budget)) {
    throw new Error("max_price_usd must be a non-negative number");
  }

  const limit = options.limit ?? 10;
  const apis = await discoverApis({ query: task, limit: Math.min(Math.max(limit * 2, 10), 20) });

  let candidates = apis
    .map((api) => toCandidate(api, tier))
    .filter((candidate) => candidate.total_price_usd <= budget);

  if (tier === "verified") {
    candidates = candidates.filter((candidate) => candidate.verified);
  }

  return sortCandidates(candidates, tier).slice(0, limit);
}

export async function routeAndCall(options: {
  task: string;
  maxPriceUsd?: number;
  maxAttempts?: number;
  tier?: RouteTier;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
}): Promise<{
  task: string;
  tier: RouteTier;
  chosen: Omit<RouteCandidate, "api">;
  attempts: Array<{
    rank: number;
    url: string;
    ok: boolean;
    latency_ms?: number;
    error?: string;
    stats?: ApiStats;
  }>;
  alternatives: Array<Omit<RouteCandidate, "api">>;
  payment: unknown;
  data: unknown;
}> {
  const tier = options.tier ?? "economy";
  const maxAttempts = Math.min(Math.max(options.maxAttempts ?? 3, 1), 5);
  const candidates = await buildRouteCandidates({
    task: options.task,
    maxPriceUsd: options.maxPriceUsd,
    limit: Math.max(maxAttempts, 5),
    tier,
  });

  if (candidates.length === 0) {
    const hint =
      tier === "verified"
        ? ` No verified APIs yet (need ≥${getVerifiedMinSamples()} calls and ≥${getVerifiedMinSuccessRate() * 100}% success). Run economy routes first or lower VERIFIED_MIN_SAMPLES.`
        : "";
    throw new Error(
      `No ${getNetworkLabel()} x402 APIs found for "${options.task}" under $${options.maxPriceUsd ?? getMaxPriceUsd()} (tier=${tier}).${hint}`,
    );
  }

  const attempts: Array<{
    rank: number;
    url: string;
    ok: boolean;
    latency_ms?: number;
    error?: string;
    stats?: ApiStats;
  }> = [];
  const toTry = candidates.slice(0, maxAttempts);

  for (const candidate of toTry) {
    const callArgs: ProxyCallArgs = {
      query: options.query ?? candidate.api.exampleQuery,
      body: options.body ?? candidate.api.exampleBody,
    };
    const started = Date.now();

    try {
      const result = await callDiscoveredApi(candidate.api, callArgs);
      const latencyMs = Date.now() - started;
      const stats = recordOutcome({
        url: candidate.url,
        ok: true,
        latencyMs,
        task: options.task,
      });
      attempts.push({
        rank: candidate.rank,
        url: candidate.url,
        ok: true,
        latency_ms: latencyMs,
        stats,
      });
      return {
        task: options.task.trim(),
        tier,
        chosen: withoutApi({
          ...candidate,
          verified: isVerified(stats),
          success_rate: stats.success_rate,
          calls: stats.calls,
          avg_latency_ms: stats.avg_latency_ms,
          p50_latency_ms: stats.p50_latency_ms,
          route_score: routeScore({
            totalPriceUsd: candidate.total_price_usd,
            stats,
            bazaarVolume: bazaarVolume(candidate.api),
          }),
        }),
        attempts,
        alternatives: candidates
          .filter((c) => c.url !== candidate.url)
          .map(withoutApi),
        payment: result.payment,
        data: result.data,
      };
    } catch (error) {
      const latencyMs = Date.now() - started;
      const message = error instanceof Error ? error.message : String(error);
      const stats = recordOutcome({
        url: candidate.url,
        ok: false,
        latencyMs,
        task: options.task,
        error: message,
      });
      attempts.push({
        rank: candidate.rank,
        url: candidate.url,
        ok: false,
        latency_ms: latencyMs,
        error: message,
        stats,
      });
    }
  }

  throw new Error(
    `All ${attempts.length} route attempts failed for "${options.task}" (tier=${tier}): ${attempts
      .map((a) => `#${a.rank} ${a.url} → ${a.error}`)
      .join(" | ")}`,
  );
}

export { summarizeApi };

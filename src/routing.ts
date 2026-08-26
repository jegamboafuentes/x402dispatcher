import { getMarkupBps, getMaxPriceUsd } from "./config.js";
import { discoverApis, summarizeApi, type DiscoveredApi } from "./discovery.js";
import { callDiscoveredApi, estimateTotalUsd, type ProxyCallArgs } from "./payment.js";

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
  quality_score?: number;
  example_query?: Record<string, unknown>;
  example_body?: Record<string, unknown>;
  api: DiscoveredApi;
};

export type RouteQuote = {
  task: string;
  max_price_usd: number;
  markup_bps: number;
  candidate_count: number;
  cheapest?: Omit<RouteCandidate, "api">;
  candidates: Array<Omit<RouteCandidate, "api">>;
};

function qualityScore(api: DiscoveredApi): number {
  const quality = api.resource.quality;
  return quality?.l30DaysTotalCalls ?? 0;
}

function toCandidate(api: DiscoveredApi, rank: number): RouteCandidate {
  const total = estimateTotalUsd(api.upstreamPriceUsd);
  return {
    rank,
    tool_name: api.toolName,
    url: api.url,
    method: api.method,
    description: api.description,
    upstream_price_usd: api.upstreamPriceUsd,
    markup_bps: getMarkupBps(),
    total_price_usd: total,
    network: api.network,
    pay_to: api.payTo,
    quality_score: qualityScore(api) || undefined,
    example_query: api.exampleQuery,
    example_body: api.exampleBody,
    api,
  };
}

function withoutApi(candidate: RouteCandidate): Omit<RouteCandidate, "api"> {
  const { api: _api, ...rest } = candidate;
  return rest;
}

export async function buildRouteCandidates(options: {
  task: string;
  maxPriceUsd?: number;
  limit?: number;
}): Promise<RouteCandidate[]> {
  const task = options.task.trim();
  if (!task) {
    throw new Error("task is required");
  }

  const budget = options.maxPriceUsd ?? getMaxPriceUsd();
  if (!(budget >= 0) || !Number.isFinite(budget)) {
    throw new Error("max_price_usd must be a non-negative number");
  }

  const limit = options.limit ?? 10;
  const apis = await discoverApis({ query: task, limit: Math.min(Math.max(limit * 2, 10), 20) });

  const candidates = apis
    .map((api, index) => toCandidate(api, index + 1))
    .filter((candidate) => candidate.total_price_usd <= budget)
    .sort((a, b) => {
      if (a.total_price_usd !== b.total_price_usd) {
        return a.total_price_usd - b.total_price_usd;
      }
      return (b.quality_score ?? 0) - (a.quality_score ?? 0);
    })
    .slice(0, limit)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));

  return candidates;
}

export async function quoteRoute(options: {
  task: string;
  maxPriceUsd?: number;
  limit?: number;
}): Promise<RouteQuote> {
  const candidates = await buildRouteCandidates(options);
  const publicCandidates = candidates.map(withoutApi);

  return {
    task: options.task.trim(),
    max_price_usd: options.maxPriceUsd ?? getMaxPriceUsd(),
    markup_bps: getMarkupBps(),
    candidate_count: publicCandidates.length,
    cheapest: publicCandidates[0],
    candidates: publicCandidates,
  };
}

export async function routeAndCall(options: {
  task: string;
  maxPriceUsd?: number;
  maxAttempts?: number;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
}): Promise<{
  task: string;
  chosen: Omit<RouteCandidate, "api">;
  attempts: Array<{ rank: number; url: string; ok: boolean; error?: string }>;
  alternatives: Array<Omit<RouteCandidate, "api">>;
  payment: unknown;
  data: unknown;
}> {
  const maxAttempts = Math.min(Math.max(options.maxAttempts ?? 3, 1), 5);
  const candidates = await buildRouteCandidates({
    task: options.task,
    maxPriceUsd: options.maxPriceUsd,
    limit: Math.max(maxAttempts, 5),
  });

  if (candidates.length === 0) {
    throw new Error(
      `No Base Sepolia x402 APIs found for "${options.task}" under $${options.maxPriceUsd ?? getMaxPriceUsd()} (incl. markup).`,
    );
  }

  const attempts: Array<{ rank: number; url: string; ok: boolean; error?: string }> = [];
  const toTry = candidates.slice(0, maxAttempts);

  for (const candidate of toTry) {
    const callArgs: ProxyCallArgs = {
      query: options.query ?? candidate.api.exampleQuery,
      body: options.body ?? candidate.api.exampleBody,
    };

    try {
      const result = await callDiscoveredApi(candidate.api, callArgs);
      attempts.push({ rank: candidate.rank, url: candidate.url, ok: true });
      return {
        task: options.task.trim(),
        chosen: withoutApi(candidate),
        attempts,
        alternatives: candidates.slice(1).map(withoutApi),
        payment: result.payment,
        data: result.data,
      };
    } catch (error) {
      attempts.push({
        rank: candidate.rank,
        url: candidate.url,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw new Error(
    `All ${attempts.length} route attempts failed for "${options.task}": ${attempts
      .map((a) => `#${a.rank} ${a.url} → ${a.error}`)
      .join(" | ")}`,
  );
}

export function cacheCandidates(
  catalog: Map<string, DiscoveredApi>,
  candidates: RouteCandidate[],
): void {
  for (const candidate of candidates) {
    catalog.set(candidate.api.toolName, candidate.api);
    catalog.set(candidate.api.url, candidate.api);
  }
}

export { summarizeApi };

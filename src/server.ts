import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  formatUsdPrice,
  getDiscoveryLimit,
  getInboundPriceUsd,
  getMarkupBps,
  getMaxPriceUsd,
  getNetworkCaip2,
  getNetworkLabel,
  getNetworkName,
  getVerifiedMinSamples,
  getVerifiedMinSuccessRate,
  getX402Environment,
  isInboundPaywallEnabled,
} from "./config.js";
import {
  discoverApis,
  summarizeApi,
  type DiscoveredApi,
} from "./discovery.js";
import {
  createInboundPaidTool,
  getInboundPaywallPublicStatus,
  getMerchantPayToAddress,
} from "./inbound.js";
import {
  callDiscoveredApi,
  estimateTotalUsd,
  getPayerAddress,
  settleSimulatedMbtaPayment,
} from "./payment.js";
import { buildRouteCandidates, routeAndCall, type RouteTier } from "./routing.js";
import {
  getStatsForUrl,
  getStatsPath,
  listAllStats,
  listVerifiedStats,
  recordOutcome,
} from "./stats.js";

export const APP_VERSION = "6.0.0";

const tierSchema = z
  .enum(["economy", "verified"])
  .optional()
  .describe(
    'Routing tier: "economy" = cheapest first (V3); "verified" = reliability-scored APIs with enough successful history (V4)',
  );

/** Shared discovery cache warmed once per process (Cloud Run instance / stdio process). */
let warmedApis: DiscoveredApi[] = [];

export function getWarmedApis(): DiscoveredApi[] {
  return warmedApis;
}

export async function warmDiscovery(): Promise<number> {
  try {
    warmedApis = await discoverApis({ limit: getDiscoveryLimit() });
    return warmedApis.length;
  } catch (error) {
    console.error(
      `Warning: Bazaar discovery failed at startup (${error instanceof Error ? error.message : error}). quote_route / search_bazaar still available.`,
    );
    warmedApis = [];
    return 0;
  }
}

export async function logStartupBanner(mode: "stdio" | "http"): Promise<void> {
  console.error(
    `x402dispatcher V6 starting (${mode}) X402_ENV=${getX402Environment()} network=${getNetworkLabel()} (${getNetworkCaip2()}) INBOUND_PAYWALL=${isInboundPaywallEnabled()} INBOUND_PRICE_USD=${getInboundPriceUsd()} MAX_PRICE_USD=${getMaxPriceUsd()} MARKUP_BPS=${getMarkupBps()} DISCOVERY_LIMIT=${getDiscoveryLimit()}`,
  );
  console.error(`Stats store: ${getStatsPath()}`);
  try {
    const payer = await getPayerAddress();
    console.error(`Treasury payer: ${payer}`);
  } catch (error) {
    console.error(
      `Warning: could not resolve payer address yet (${error instanceof Error ? error.message : error})`,
    );
  }
  if (isInboundPaywallEnabled()) {
    try {
      const payTo = await getMerchantPayToAddress();
      console.error(`Inbound paywall ON — agents pay Merchant ${payTo} ${formatUsdPrice(getInboundPriceUsd())} before paid tools`);
    } catch (error) {
      console.error(
        `Warning: could not resolve Merchant payTo (${error instanceof Error ? error.message : error})`,
      );
    }
  } else {
    console.error("Inbound paywall OFF — paid tools run without caller payment (operator Treasury only)");
  }
}

function toolError(toolName: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `${toolName} failed: ${message}` }],
  };
}

function toolOk(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

async function fetchMbtaPredictions(stopId: string): Promise<unknown> {
  const url = `https://api-v3.mbta.com/predictions?filter[stop]=${encodeURIComponent(stopId)}`;
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.api+json" },
  });
  if (!response.ok) {
    throw new Error(`MBTA API error ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function callWithStats(
  api: DiscoveredApi,
  args: { query?: Record<string, unknown>; body?: Record<string, unknown> },
  task?: string,
) {
  const started = Date.now();
  try {
    const result = await callDiscoveredApi(api, args);
    const stats = recordOutcome({
      url: api.url,
      ok: true,
      latencyMs: Date.now() - started,
      task,
    });
    return { ...result, stats };
  } catch (error) {
    recordOutcome({
      url: api.url,
      ok: false,
      latencyMs: Date.now() - started,
      task,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Build a fresh MCP server instance with all tools registered.
 * Safe to call per HTTP request (stateless Cloud Run) or once for stdio.
 */
export async function createMcpServer(): Promise<McpServer> {
  const catalog = new Map<string, DiscoveredApi>();
  const networkLabel = getNetworkLabel();
  const inboundPrice = getInboundPriceUsd();
  const paywallOn = isInboundPaywallEnabled();
  const server = new McpServer({
    name: "x402dispatcher",
    version: APP_VERSION,
  });

  const paidDefault = await createInboundPaidTool({
    priceUsd: inboundPrice,
    description: `x402dispatcher paid tool — ${formatUsdPrice(inboundPrice)} USDC inbound to Merchant`,
  });
  const paidMbta = await createInboundPaidTool({
    priceUsd: Math.min(0.01, getMaxPriceUsd()),
    toolNameHint: "get_mbta_predictions",
    description: "MBTA demo — inbound payment then treasury settle",
  });

  function rememberApis(apis: DiscoveredApi[]) {
    for (const api of apis) {
      catalog.set(api.toolName, api);
      catalog.set(api.url, api);
      const existing = warmedApis.find((item) => item.url === api.url);
      if (!existing) {
        warmedApis.push(api);
      }
    }
  }

  for (const api of warmedApis) {
    catalog.set(api.toolName, api);
    catalog.set(api.url, api);

    const totalUsd = estimateTotalUsd(api.upstreamPriceUsd);
    const toolPrice = Math.min(totalUsd, getMaxPriceUsd());
    const paidTool = await createInboundPaidTool({
      priceUsd: toolPrice,
      toolNameHint: api.toolName,
      description: `Proxy ${api.url} — inbound ${formatUsdPrice(toolPrice)}`,
    });

    server.registerTool(
      api.toolName,
      {
        title: api.toolName,
        description: [
          paywallOn
            ? `[PAID inbound ${formatUsdPrice(toolPrice)} → then proxy $${totalUsd.toFixed(4)}]`
            : `[x402dispatcher · $${totalUsd.toFixed(4)} incl. markup]`,
          api.description,
          `Upstream: ${api.url}`,
          `Method: ${api.method}`,
          api.exampleQuery
            ? `Example query: ${JSON.stringify(api.exampleQuery)}`
            : undefined,
        ]
          .filter(Boolean)
          .join(" "),
        inputSchema: {
          query: z
            .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
            .optional()
            .describe("Optional query string parameters for the upstream HTTP request"),
          body: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Optional JSON body for non-GET requests"),
        },
      },
      paidTool(async ({ query, body }) => {
        try {
          const result = await callWithStats(api, { query, body }, api.toolName);
          return toolOk(result);
        } catch (error) {
          return toolError(api.toolName, error);
        }
      }),
    );
  }

  server.registerTool(
    "quote_route",
    {
      title: "Quote Route",
      description:
        "FREE. Search the x402 Bazaar for APIs matching a task and rank them. tier=economy sorts by price; tier=verified keeps only reliable APIs and ranks by success/latency/price score. Does not pay.",
      inputSchema: {
        task: z
          .string()
          .min(1)
          .describe('Natural-language task, for example "weather in Boston" or "token balance"'),
        tier: tierSchema,
        max_price_usd: z
          .number()
          .nonnegative()
          .optional()
          .describe("Optional per-call budget (clamped to MAX_PRICE_USD)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Max ranked candidates to return (default 10)"),
      },
    },
    async ({ task, tier, max_price_usd, limit }) => {
      try {
        const selectedTier: RouteTier = tier ?? "economy";
        const budget = Math.min(max_price_usd ?? getMaxPriceUsd(), getMaxPriceUsd());
        const candidates = await buildRouteCandidates({
          task,
          maxPriceUsd: budget,
          limit: limit ?? 10,
          tier: selectedTier,
        });
        rememberApis(candidates.map((c) => c.api));
        const publicCandidates = candidates.map(({ api: _api, ...rest }) => rest);
        return toolOk({
          task: task.trim(),
          tier: selectedTier,
          max_price_usd: budget,
          markup_bps: getMarkupBps(),
          inbound_paywall: await getInboundPaywallPublicStatus(),
          verified_policy: {
            min_samples: getVerifiedMinSamples(),
            min_success_rate: getVerifiedMinSuccessRate(),
          },
          candidate_count: publicCandidates.length,
          best: publicCandidates[0],
          cheapest: publicCandidates[0],
          candidates: publicCandidates,
        });
      } catch (error) {
        return toolError("quote_route", error);
      }
    },
  );

  server.registerTool(
    "route_and_call",
    {
      title: "Route and Call",
      description: [
        paywallOn
          ? `PAID inbound ${formatUsdPrice(inboundPrice)} USDC to Merchant, then`
          : "",
        `route a task to a ${networkLabel} x402 API, pay upstream from Treasury, and return data.`,
        "economy = cheapest; verified = reliability-scored. Failover on errors.",
      ]
        .filter(Boolean)
        .join(" "),
      inputSchema: {
        task: z
          .string()
          .min(1)
          .describe('Natural-language task, for example "current weather for Boston"'),
        tier: tierSchema,
        max_price_usd: z
          .number()
          .nonnegative()
          .optional()
          .describe("Optional budget for this route (clamped to MAX_PRICE_USD)"),
        max_attempts: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("How many candidates to try on failure (default 3)"),
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Optional query overrides; defaults to the listing example query"),
        body: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional JSON body overrides"),
      },
    },
    paidDefault(async ({ task, tier, max_price_usd, max_attempts, query, body }) => {
      try {
        const budget = Math.min(max_price_usd ?? getMaxPriceUsd(), getMaxPriceUsd());
        const result = await routeAndCall({
          task,
          tier: tier ?? "economy",
          maxPriceUsd: budget,
          maxAttempts: max_attempts ?? 3,
          query,
          body,
        });
        return toolOk({
          inbound_paywall: await getInboundPaywallPublicStatus(),
          ...result,
        });
      } catch (error) {
        return toolError("route_and_call", error);
      }
    }),
  );

  server.registerTool(
    "get_api_stats",
    {
      title: "Get API Stats",
      description:
        "FREE. Show success rate and latency stats collected from x402dispatcher paid calls. Omit url to list all.",
      inputSchema: {
        url: z
          .string()
          .url()
          .optional()
          .describe("Optional upstream resource URL to inspect"),
      },
    },
    async ({ url }) => {
      try {
        if (url) {
          const stats = getStatsForUrl(url);
          if (!stats) {
            return toolOk({ url, found: false, message: "No local stats for this URL yet" });
          }
          return toolOk({
            found: true,
            stats_path: getStatsPath(),
            verified_policy: {
              min_samples: getVerifiedMinSamples(),
              min_success_rate: getVerifiedMinSuccessRate(),
            },
            stats,
          });
        }
        return toolOk({
          stats_path: getStatsPath(),
          verified_policy: {
            min_samples: getVerifiedMinSamples(),
            min_success_rate: getVerifiedMinSuccessRate(),
          },
          count: listAllStats().length,
          apis: listAllStats(),
        });
      } catch (error) {
        return toolError("get_api_stats", error);
      }
    },
  );

  server.registerTool(
    "list_verified_apis",
    {
      title: "List Verified APIs",
      description:
        "FREE. List upstream APIs that currently qualify for the Verified routing tier based on success/latency history.",
    },
    async () => {
      const verified = listVerifiedStats();
      return toolOk({
        count: verified.length,
        verified_policy: {
          min_samples: getVerifiedMinSamples(),
          min_success_rate: getVerifiedMinSuccessRate(),
        },
        stats_path: getStatsPath(),
        apis: verified,
      });
    },
  );

  server.registerTool(
    "search_bazaar",
    {
      title: "Search x402 Bazaar",
      description: `FREE. Search the public Coinbase x402 Bazaar catalog for ${networkLabel} paid APIs at or below MAX_PRICE_USD, then cache matches for call_x402_api.`,
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("Semantic or text search query, for example weather or token balance"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Max results to return (default 10)"),
      },
    },
    async ({ query, limit }) => {
      try {
        const apis = await discoverApis({ query, limit: limit ?? 10 });
        rememberApis(apis);
        return toolOk({
          query,
          count: apis.length,
          max_price_usd: getMaxPriceUsd(),
          markup_bps: getMarkupBps(),
          results: apis.map((api) => ({
            ...summarizeApi(api),
            total_price_usd: estimateTotalUsd(api.upstreamPriceUsd),
            stats: getStatsForUrl(api.url),
          })),
        });
      } catch (error) {
        return toolError("search_bazaar", error);
      }
    },
  );

  server.registerTool(
    "list_discovered_apis",
    {
      title: "List Discovered APIs",
      description: `FREE. List x402dispatcher APIs currently registered from Bazaar discovery (${networkLabel}, within MAX_PRICE_USD).`,
    },
    async () => {
      const unique = [...new Map([...catalog.values()].map((api) => [api.url, api])).values()];
      return toolOk({
        version: APP_VERSION,
        count: unique.length,
        max_price_usd: getMaxPriceUsd(),
        markup_bps: getMarkupBps(),
        inbound_paywall: await getInboundPaywallPublicStatus(),
        apis: unique.map((api) => ({
          ...summarizeApi(api),
          total_price_usd: estimateTotalUsd(api.upstreamPriceUsd),
          stats: getStatsForUrl(api.url),
        })),
      });
    },
  );

  server.registerTool(
    "call_x402_api",
    {
      title: "Call x402 API",
      description: [
        paywallOn ? `PAID inbound ${formatUsdPrice(inboundPrice)} USDC, then` : "",
        "pay for and call a discovered Bazaar HTTP resource through the x402dispatcher treasury.",
        "Pass tool_name from list_discovered_apis / search_bazaar, or a full resource URL.",
      ]
        .filter(Boolean)
        .join(" "),
      inputSchema: {
        tool_name_or_url: z
          .string()
          .min(1)
          .describe("Registered tool_name or full upstream resource URL"),
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Optional query parameters"),
        body: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional JSON body"),
      },
    },
    paidDefault(async ({ tool_name_or_url, query, body }) => {
      try {
        let api = catalog.get(tool_name_or_url);
        if (!api) {
          const refreshed = await discoverApis({
            query: tool_name_or_url,
            limit: 5,
          });
          api =
            refreshed.find((item) => item.url === tool_name_or_url) ??
            refreshed.find((item) => item.toolName === tool_name_or_url) ??
            refreshed[0];
          if (api) {
            rememberApis([api]);
          }
        }
        if (!api) {
          throw new Error(
            `Unknown API "${tool_name_or_url}". Run search_bazaar, quote_route, or list_discovered_apis first.`,
          );
        }
        const result = await callWithStats(api, { query, body }, tool_name_or_url);
        return toolOk({
          inbound_paywall: await getInboundPaywallPublicStatus(),
          ...result,
        });
      } catch (error) {
        return toolError("call_x402_api", error);
      }
    }),
  );

  server.registerTool(
    "get_mbta_predictions",
    {
      title: "Get MBTA Predictions",
      description: [
        paywallOn ? "PAID inbound $0.01, then" : "",
        `V1 demo: settle $0.01 USDC ${networkLabel} via treasury, then return live MBTA predictions.`,
      ]
        .filter(Boolean)
        .join(" "),
      inputSchema: {
        stop_id: z
          .string()
          .min(1)
          .describe("MBTA stop ID, for example place-pktrm or 70065"),
      },
    },
    paidMbta(async ({ stop_id }) => {
      try {
        const payment = await settleSimulatedMbtaPayment();
        const predictions = await fetchMbtaPredictions(stop_id);
        return toolOk({
          inbound_paywall: await getInboundPaywallPublicStatus(),
          payment,
          predictions,
        });
      } catch (error) {
        return toolError("get_mbta_predictions", error);
      }
    }),
  );

  server.registerTool(
    "get_paywall_status",
    {
      title: "Get Paywall Status",
      description:
        "FREE. Show whether inbound x402 paywall is enabled, inbound price, network, and Merchant payTo address.",
    },
    async () => toolOk(await getInboundPaywallPublicStatus()),
  );

  return server;
}

export async function buildAgentJson(baseUrl: string) {
  const origin = baseUrl.replace(/\/$/, "");
  const inbound = await getInboundPaywallPublicStatus();
  return {
    schema_version: "0.1.0",
    name: "x402dispatcher",
    version: APP_VERSION,
    description:
      "x402 Bazaar dispatcher for AI agents: discover paid APIs, charge inbound USDC (V6), route by economy or verified tier, settle upstream via Coinbase CDP, and return data.",
    homepage: origin,
    mcp: {
      transport: "streamable-http",
      url: `${origin}/mcp`,
    },
    endpoints: {
      health: `${origin}/health`,
      agent_json: `${origin}/.well-known/agent.json`,
      mcp: `${origin}/mcp`,
    },
    networks: [getNetworkCaip2()],
    payment: {
      asset: "USDC",
      network: getNetworkName(),
      max_price_usd: getMaxPriceUsd(),
      markup_bps: getMarkupBps(),
      inbound_paywall: inbound,
    },
    capabilities: [
      "search_bazaar",
      "list_discovered_apis",
      "quote_route",
      "route_and_call",
      "call_x402_api",
      "get_api_stats",
      "list_verified_apis",
      "get_mbta_predictions",
      "get_paywall_status",
    ],
    free_tools: [
      "quote_route",
      "search_bazaar",
      "list_discovered_apis",
      "get_api_stats",
      "list_verified_apis",
      "get_paywall_status",
    ],
    paid_tools: ["route_and_call", "call_x402_api", "get_mbta_predictions", "dynamic bazaar tools"],
    tiers: ["economy", "verified"],
  };
}

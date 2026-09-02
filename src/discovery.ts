import {
  listX402DiscoveryResources,
  searchX402Resources,
  type X402DiscoveryResource,
  type X402PaymentRequirements,
} from "@coinbase/cdp-sdk";
import {
  atomicToUsd,
  getDiscoveryLimit,
  getMaxPriceUsd,
  getNetworkName,
  matchesConfiguredNetwork,
} from "./config.js";

export type BazaarHttpInput = {
  type?: string;
  method?: string;
  queryParams?: Record<string, unknown>;
  body?: Record<string, unknown>;
  pathParams?: Record<string, unknown>;
  headers?: Record<string, unknown>;
};

export type DiscoveredApi = {
  id: string;
  toolName: string;
  resource: X402DiscoveryResource;
  url: string;
  method: string;
  description: string;
  upstreamAmountAtomic: bigint;
  upstreamPriceUsd: number;
  payTo: string;
  network: string;
  exampleQuery?: Record<string, unknown>;
  exampleBody?: Record<string, unknown>;
};

function getExactAccept(
  resource: X402DiscoveryResource,
): X402PaymentRequirements | undefined {
  return resource.accepts?.find(
    (accept) => accept.scheme === "exact" && matchesConfiguredNetwork(String(accept.network)),
  );
}

function getBazaarInput(resource: X402DiscoveryResource): BazaarHttpInput | undefined {
  const bazaar = resource.extensions?.bazaar as
    | { info?: { input?: BazaarHttpInput }; input?: BazaarHttpInput }
    | undefined;
  return bazaar?.info?.input ?? bazaar?.input;
}

function sanitizeToolName(url: string, index: number): string {
  let host = "api";
  let path = "resource";
  try {
    const parsed = new URL(url);
    host = parsed.hostname.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "");
    path = parsed.pathname
      .split("/")
      .filter(Boolean)
      .join("_")
      .replace(/[^a-zA-Z0-9_]+/g, "_")
      .replace(/^_|_$/g, "");
  } catch {
    // keep defaults
  }

  const base = `x402_${host}${path ? `_${path}` : ""}`.slice(0, 48).toLowerCase();
  return `${base}_${index}`.replace(/_+/g, "_");
}

export function toDiscoveredApi(
  resource: X402DiscoveryResource,
  index: number,
): DiscoveredApi | null {
  if (resource.type !== "http") {
    return null;
  }

  const accept = getExactAccept(resource);
  if (!accept?.amount || !accept.payTo) {
    return null;
  }

  const upstreamAmountAtomic = BigInt(accept.amount);
  const upstreamPriceUsd = atomicToUsd(upstreamAmountAtomic);
  if (upstreamPriceUsd <= 0 || upstreamPriceUsd > getMaxPriceUsd()) {
    return null;
  }

  const input = getBazaarInput(resource);
  const method = (input?.method ?? "GET").toUpperCase();

  return {
    id: resource.resource,
    toolName: sanitizeToolName(resource.resource, index),
    resource,
    url: resource.resource,
    method,
    description:
      resource.description?.trim() ||
      `Paid x402 API at ${resource.resource} ($${upstreamPriceUsd.toFixed(4)} USDC upstream).`,
    upstreamAmountAtomic,
    upstreamPriceUsd,
    payTo: accept.payTo,
    network: String(accept.network),
    exampleQuery: input?.queryParams,
    exampleBody: input?.body,
  };
}

export async function discoverApis(options?: {
  query?: string;
  limit?: number;
}): Promise<DiscoveredApi[]> {
  const limit = options?.limit ?? getDiscoveryLimit();
  const maxUsdPrice = String(getMaxPriceUsd());

  let resources: X402DiscoveryResource[] = [];

  if (options?.query?.trim()) {
    const result = await searchX402Resources({
      query: options.query.trim(),
      network: getNetworkName(),
      maxUsdPrice,
      limit: Math.min(limit, 20),
    });
    resources = result.resources ?? [];
  } else {
    const network = getNetworkName();
    const searches = await Promise.all([
      searchX402Resources({
        query: "api data weather token",
        network,
        maxUsdPrice,
        limit: 20,
      }),
      searchX402Resources({
        query: "price forecast info",
        network,
        maxUsdPrice,
        limit: 20,
      }),
      listX402DiscoveryResources({
        type: "http",
        limit: Math.min(limit * 2, 100),
        offset: 0,
      }),
    ]);

    resources = [
      ...(searches[0].resources ?? []),
      ...(searches[1].resources ?? []),
      ...((searches[2].items ?? []).filter((item) =>
        item.accepts?.some(
          (accept) => accept.scheme === "exact" && matchesConfiguredNetwork(String(accept.network)),
        ),
      )),
    ];
  }

  const discovered: DiscoveredApi[] = [];
  const seen = new Set<string>();

  for (const resource of resources) {
    if (seen.has(resource.resource)) {
      continue;
    }
    const api = toDiscoveredApi(resource, discovered.length);
    if (!api) {
      continue;
    }
    seen.add(resource.resource);
    discovered.push(api);
    if (discovered.length >= limit) {
      break;
    }
  }

  return discovered;
}

export function summarizeApi(api: DiscoveredApi) {
  return {
    tool_name: api.toolName,
    url: api.url,
    method: api.method,
    description: api.description,
    upstream_price_usd: api.upstreamPriceUsd,
    network: api.network,
    pay_to: api.payTo,
    example_query: api.exampleQuery,
    example_body: api.exampleBody,
  };
}

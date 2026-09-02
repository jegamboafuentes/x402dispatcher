import dotenv from "dotenv";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  APP_VERSION,
  buildAgentJson,
  createMcpServer,
  getWarmedApis,
  logStartupBanner,
  warmDiscovery,
} from "./server.js";
import {
  getInboundPriceUsd,
  getMaxPriceUsd,
  getMarkupBps,
  getNetworkCaip2,
  getNetworkLabel,
  getX402Environment,
  isInboundPaywallEnabled,
} from "./config.js";
import { getInboundPaywallPublicStatus } from "./inbound.js";
import { getStatsPath } from "./stats.js";

dotenv.config({ quiet: true });

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";

function resolvePublicBaseUrl(req?: { protocol?: string; get?: (h: string) => string | undefined }): string {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  }
  if (req?.get) {
    const host = req.get("x-forwarded-host") ?? req.get("host");
    const proto = req.get("x-forwarded-proto") ?? req.protocol ?? "https";
    if (host) {
      return `${proto}://${host}`;
    }
  }
  return `http://localhost:${PORT}`;
}

async function handleMcp(req: import("express").Request, res: import("express").Response) {
  const server = await createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}

async function main() {
  await logStartupBanner("http");
  const count = await warmDiscovery();
  console.error(`Discovered and cached ${count} ${getNetworkLabel()} x402 APIs`);

  const app = createMcpExpressApp({ host: HOST });

  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Authorization, PAYMENT-SIGNATURE, Payment-Signature",
    );
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Mcp-Session-Id, Mcp-Protocol-Version, PAYMENT-REQUIRED, PAYMENT-RESPONSE",
    );
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get("/health", async (_req, res) => {
    res.json({
      ok: true,
      service: "x402dispatcher",
      version: APP_VERSION,
      x402_env: getX402Environment(),
      network: getNetworkCaip2(),
      network_label: getNetworkLabel(),
      warmed_apis: getWarmedApis().length,
      max_price_usd: getMaxPriceUsd(),
      markup_bps: getMarkupBps(),
      inbound_paywall: await getInboundPaywallPublicStatus(),
      stats_path: getStatsPath(),
    });
  });

  app.get(["/agent.json", "/.well-known/agent.json"], async (req, res) => {
    const agent = await buildAgentJson(resolvePublicBaseUrl(req));
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json(agent);
  });

  app.get("/", async (req, res) => {
    res.json({
      service: "x402dispatcher",
      version: APP_VERSION,
      message: "x402 Bazaar dispatcher MCP server (V6 inbound paywall)",
      links: {
        health: "/health",
        agent: "/.well-known/agent.json",
        mcp: "/mcp",
      },
      public_base_url: resolvePublicBaseUrl(req),
      inbound_paywall: {
        enabled: isInboundPaywallEnabled(),
        inbound_price_usd: getInboundPriceUsd(),
      },
    });
  });

  app.all("/mcp", (req, res) => {
    void handleMcp(req, res);
  });

  app.listen(PORT, HOST, () => {
    console.error(`x402dispatcher HTTP MCP listening on http://${HOST}:${PORT} (V6)`);
    console.error(`Health: http://${HOST}:${PORT}/health`);
    console.error(`Agent:  http://${HOST}:${PORT}/.well-known/agent.json`);
    console.error(`MCP:    http://${HOST}:${PORT}/mcp`);
  });
}

main().catch((error) => {
  console.error("Failed to start HTTP MCP server:", error);
  process.exit(1);
});

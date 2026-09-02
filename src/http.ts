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
import { getMaxPriceUsd, getMarkupBps } from "./config.js";
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
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    // Stateless mode: Cloud Run safe across instances / cold starts.
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
  console.error(`Discovered and cached ${count} Base Sepolia x402 APIs`);

  const app = createMcpExpressApp({ host: HOST });

  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Authorization",
    );
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Mcp-Session-Id, Mcp-Protocol-Version",
    );
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "x402dispatcher",
      version: APP_VERSION,
      warmed_apis: getWarmedApis().length,
      max_price_usd: getMaxPriceUsd(),
      markup_bps: getMarkupBps(),
      stats_path: getStatsPath(),
    });
  });

  app.get(["/agent.json", "/.well-known/agent.json"], (req, res) => {
    const agent = buildAgentJson(resolvePublicBaseUrl(req));
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json(agent);
  });

  app.get("/", (req, res) => {
    res.json({
      service: "x402dispatcher",
      version: APP_VERSION,
      message: "x402 Bazaar dispatcher MCP server",
      links: {
        health: "/health",
        agent: "/.well-known/agent.json",
        mcp: "/mcp",
      },
      public_base_url: resolvePublicBaseUrl(req),
    });
  });

  app.all("/mcp", (req, res) => {
    void handleMcp(req, res);
  });

  app.listen(PORT, HOST, () => {
    console.error(`x402dispatcher HTTP MCP listening on http://${HOST}:${PORT} (V5)`);
    console.error(`Health: http://${HOST}:${PORT}/health`);
    console.error(`Agent:  http://${HOST}:${PORT}/.well-known/agent.json`);
    console.error(`MCP:    http://${HOST}:${PORT}/mcp`);
  });
}

main().catch((error) => {
  console.error("Failed to start HTTP MCP server:", error);
  process.exit(1);
});

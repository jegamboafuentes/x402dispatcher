import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
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
import { getCashflowPath, getPnL, listCashflow } from "./cashflow.js";
import { getStatsPath } from "./stats.js";
import { getWalletsSnapshot } from "./wallets.js";
import { getLedgerStatus, restoreLedger } from "./db.js";

dotenv.config({ quiet: true });

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONSOLE_DIR = path.join(ROOT, "public", "console");
const IMAGES_DIR = path.join(ROOT, "public", "images");
const CONSOLE_HTML_PATH = path.join(CONSOLE_DIR, "index.html");

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

function renderConsoleHtml(origin: string): string {
  const html = fs.readFileSync(CONSOLE_HTML_PATH, "utf8");
  return html.replaceAll("__ORIGIN__", origin.replace(/\/$/, ""));
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
  await restoreLedger();
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
      cashflow_path: getCashflowPath(),
      pnl: getPnL(),
      stats_path: getStatsPath(),
      ledger: getLedgerStatus(),
      console: "/",
    });
  });

  app.get("/v1/cashflow", (req, res) => {
    const limit = Number(req.query.limit ?? 25);
    const direction = req.query.direction;
    const dir =
      direction === "in" || direction === "out" || direction === "markup"
        ? direction
        : undefined;
    res.json({
      cashflow_path: getCashflowPath(),
      entries: listCashflow({
        limit: Number.isFinite(limit) ? limit : 25,
        direction: dir,
      }),
      pnl: getPnL(),
    });
  });

  app.get("/v1/pnl", (req, res) => {
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    res.json(getPnL({ since }));
  });

  app.get("/v1/wallets", async (_req, res) => {
    try {
      const wallets = await getWalletsSnapshot();
      res.json(wallets);
    } catch (error) {
      console.error("/v1/wallets failed:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to load wallet balances",
      });
    }
  });

  app.get(["/agent.json", "/.well-known/agent.json"], async (req, res) => {
    const agent = await buildAgentJson(resolvePublicBaseUrl(req));
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json(agent);
  });

  app.get("/.well-known/glama.json", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=60");
    res.type("application/json").json({
      $schema: "https://glama.ai/mcp/schemas/connector.json",
      claim: "glama_claim_-bXvgN6D7GAbuWz8hHbPxiY1vyOW6MZ7",
    });
  });

  app.get("/robots.txt", (req, res) => {
    const origin = resolvePublicBaseUrl(req);
    res
      .type("text/plain")
      .send(
        [
          "User-agent: *",
          "Allow: /",
          "Allow: /llms.txt",
          "Allow: /.well-known/agent.json",
          "Allow: /.well-known/glama.json",
          "Allow: /health",
          "Disallow: /mcp",
          `Sitemap: ${origin}/sitemap.xml`,
          "",
        ].join("\n"),
      );
  });

  app.get("/llms.txt", (_req, res) => {
    res.type("text/plain").sendFile(path.join(ROOT, "public", "llms.txt"));
  });

  app.get("/sitemap.xml", (req, res) => {
    const origin = resolvePublicBaseUrl(req);
    const now = new Date().toISOString();
    res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${origin}/</loc>
    <lastmod>${now}</lastmod>
    <changefreq>hourly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${origin}/llms.txt</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${origin}/health</loc>
    <lastmod>${now}</lastmod>
    <changefreq>hourly</changefreq>
    <priority>0.4</priority>
  </url>
  <url>
    <loc>${origin}/.well-known/agent.json</loc>
    <lastmod>${now}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>${origin}/.well-known/glama.json</loc>
    <lastmod>${now}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.3</priority>
  </url>
</urlset>
`);
  });

  app.get("/", (req, res) => {
    const origin = resolvePublicBaseUrl(req);
    res.type("html").send(renderConsoleHtml(origin));
  });

  app.use("/console", express.static(CONSOLE_DIR, { index: false, maxAge: "5m" }));
  app.use("/images", express.static(IMAGES_DIR, { maxAge: "7d", fallthrough: false }));

  app.get("/api", async (req, res) => {
    res.json({
      service: "x402dispatcher",
      version: APP_VERSION,
      message: "x402 Bazaar dispatcher MCP server (V10 durable SQLite ledger)",
      links: {
        console: "/",
        health: "/health",
        agent: "/.well-known/agent.json",
        glama: "/.well-known/glama.json",
        mcp: "/mcp",
        cashflow: "/v1/cashflow",
        pnl: "/v1/pnl",
        wallets: "/v1/wallets",
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
    console.error(`x402dispatcher HTTP MCP listening on http://${HOST}:${PORT} (V10)`);
    console.error(`Console: http://${HOST}:${PORT}/`);
    console.error(`Health:  http://${HOST}:${PORT}/health`);
    console.error(`Agent:   http://${HOST}:${PORT}/.well-known/agent.json`);
    console.error(`MCP:     http://${HOST}:${PORT}/mcp`);
  });
}

main().catch((error) => {
  console.error("Failed to start HTTP MCP server:", error);
  process.exit(1);
});

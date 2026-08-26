import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text ?? "" : JSON.stringify(part)))
    .join("\n");
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX, "src/index.ts"],
    cwd: ROOT,
    stderr: "pipe",
  });

  transport.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  const client = new Client({ name: "x402dispatcher-v3-test", version: "3.0.0" });
  await client.connect(transport);

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  console.log(`Tool count: ${names.length}`);
  for (const required of ["quote_route", "route_and_call", "search_bazaar", "call_x402_api"]) {
    if (!names.includes(required)) {
      throw new Error(`Missing tool: ${required}`);
    }
  }

  const quoteResult = await client.callTool({
    name: "quote_route",
    arguments: { task: "weather", limit: 5 },
  });
  if (quoteResult.isError) {
    throw new Error(`quote_route failed: ${textOf(quoteResult)}`);
  }

  const quote = JSON.parse(textOf(quoteResult)) as {
    candidate_count: number;
    cheapest?: { url: string; total_price_usd: number; rank: number };
    candidates: Array<{ url: string; total_price_usd: number }>;
  };
  console.log(`quote_route candidates: ${quote.candidate_count}`);
  if (!quote.cheapest || quote.candidate_count < 1) {
    throw new Error("quote_route returned no candidates");
  }

  const prices = quote.candidates.map((c) => c.total_price_usd);
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] < prices[i - 1] - 1e-12) {
      throw new Error(`Candidates not sorted by price: ${prices.join(", ")}`);
    }
  }
  console.log(
    `cheapest: $${quote.cheapest.total_price_usd} → ${quote.cheapest.url}`,
  );

  const routeResult = await client.callTool({
    name: "route_and_call",
    arguments: {
      task: "weather",
      max_attempts: 3,
      query: { location: "Boston" },
    },
  });
  if (routeResult.isError) {
    throw new Error(`route_and_call failed: ${textOf(routeResult)}`);
  }

  const routed = JSON.parse(textOf(routeResult)) as {
    chosen: { url: string; total_price_usd: number };
    attempts: Array<{ ok: boolean; url: string }>;
    payment?: { model?: string; total_price_usd?: number };
    data?: unknown;
  };

  console.log(`chosen: ${routed.chosen.url} @ $${routed.chosen.total_price_usd}`);
  console.log(
    `attempts: ${routed.attempts.map((a) => `${a.ok ? "ok" : "fail"}:${a.url}`).join(" | ")}`,
  );

  if (routed.chosen.url !== quote.cheapest.url) {
    console.log(
      `Note: chosen URL differs from quote cheapest (failover or catalog churn). quote=${quote.cheapest.url}`,
    );
  }
  if (!routed.payment || routed.data === undefined) {
    throw new Error("route_and_call missing payment or data");
  }

  console.log("V3 SMOKE TEST PASSED");
  await client.close();
}

main().catch((error) => {
  console.error("V3 SMOKE TEST FAILED");
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});

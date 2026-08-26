import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const STATS_PATH = path.join(ROOT, "data", "api-stats.json");

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text ?? "" : JSON.stringify(part)))
    .join("\n");
}

async function main() {
  // Fresh stats for a deterministic verified-tier bootstrap in this test run.
  if (fs.existsSync(STATS_PATH)) {
    fs.unlinkSync(STATS_PATH);
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  env.VERIFIED_MIN_SAMPLES = "2";
  env.VERIFIED_MIN_SUCCESS_RATE = "0.8";

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX, "src/index.ts"],
    cwd: ROOT,
    stderr: "pipe",
    env,
  });

  transport.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  const client = new Client({ name: "x402dispatcher-v4-test", version: "4.0.0" });
  await client.connect(transport);

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  for (const required of [
    "quote_route",
    "route_and_call",
    "get_api_stats",
    "list_verified_apis",
  ]) {
    if (!names.includes(required)) {
      throw new Error(`Missing tool: ${required}`);
    }
  }
  console.log(`Tool count: ${names.length}`);

  const emptyVerified = await client.callTool({ name: "list_verified_apis", arguments: {} });
  if (emptyVerified.isError) {
    throw new Error(`list_verified_apis failed: ${textOf(emptyVerified)}`);
  }
  const emptyPayload = JSON.parse(textOf(emptyVerified)) as { count: number };
  console.log(`verified before seed: ${emptyPayload.count}`);

  for (let i = 0; i < 2; i++) {
    const routed = await client.callTool({
      name: "route_and_call",
      arguments: {
        task: "weather",
        tier: "economy",
        max_attempts: 3,
        query: { location: "Boston" },
      },
    });
    if (routed.isError) {
      throw new Error(`seed route_and_call #${i + 1} failed: ${textOf(routed)}`);
    }
    const payload = JSON.parse(textOf(routed)) as {
      chosen: { url: string };
      attempts: Array<{ ok: boolean; latency_ms?: number }>;
    };
    console.log(
      `seed #${i + 1}: ${payload.chosen.url} latency=${payload.attempts[0]?.latency_ms ?? "?"}ms`,
    );
  }

  const statsResult = await client.callTool({ name: "get_api_stats", arguments: {} });
  if (statsResult.isError) {
    throw new Error(`get_api_stats failed: ${textOf(statsResult)}`);
  }
  const statsPayload = JSON.parse(textOf(statsResult)) as {
    count: number;
    apis: Array<{ url: string; calls: number; success_rate: number }>;
  };
  console.log(`tracked APIs: ${statsPayload.count}`);
  if (statsPayload.count < 1) {
    throw new Error("expected local stats after seeded calls");
  }

  const verified = await client.callTool({ name: "list_verified_apis", arguments: {} });
  if (verified.isError) {
    throw new Error(`list_verified_apis failed: ${textOf(verified)}`);
  }
  const verifiedPayload = JSON.parse(textOf(verified)) as {
    count: number;
    apis: Array<{ url: string }>;
  };
  console.log(`verified after seed: ${verifiedPayload.count}`);
  if (verifiedPayload.count < 1) {
    throw new Error("expected at least one verified API after two successful calls");
  }

  const quoteVerified = await client.callTool({
    name: "quote_route",
    arguments: { task: "weather", tier: "verified", limit: 5 },
  });
  if (quoteVerified.isError) {
    throw new Error(`quote_route verified failed: ${textOf(quoteVerified)}`);
  }
  const quote = JSON.parse(textOf(quoteVerified)) as {
    candidate_count: number;
    best?: { url: string; verified?: boolean; route_score?: number };
  };
  console.log(
    `verified quote candidates=${quote.candidate_count} best=${quote.best?.url} score=${quote.best?.route_score}`,
  );
  if (!quote.best?.verified) {
    throw new Error("verified quote best candidate should be verified=true");
  }

  const routedVerified = await client.callTool({
    name: "route_and_call",
    arguments: {
      task: "weather",
      tier: "verified",
      query: { location: "Boston" },
    },
  });
  if (routedVerified.isError) {
    throw new Error(`route_and_call verified failed: ${textOf(routedVerified)}`);
  }
  const verifiedRoute = JSON.parse(textOf(routedVerified)) as {
    tier: string;
    chosen: { url: string; verified?: boolean };
    data?: unknown;
  };
  if (verifiedRoute.tier !== "verified" || !verifiedRoute.data) {
    throw new Error("verified route_and_call missing tier/data");
  }
  console.log(`verified route chose ${verifiedRoute.chosen.url}`);

  console.log("V4 SMOKE TEST PASSED");
  await client.close();
}

main().catch((error) => {
  console.error("V4 SMOKE TEST FAILED");
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});

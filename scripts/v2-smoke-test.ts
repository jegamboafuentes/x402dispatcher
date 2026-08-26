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

  const client = new Client({ name: "x402dispatcher-v2-test", version: "2.0.0" });
  await client.connect(transport);

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  console.log(`Tool count: ${names.length}`);
  console.log(
    `Core tools present: ${["search_bazaar", "list_discovered_apis", "call_x402_api", "get_mbta_predictions"]
      .map((name) => `${name}=${names.includes(name)}`)
      .join(", ")}`,
  );

  const search = await client.callTool({
    name: "search_bazaar",
    arguments: { query: "weather", limit: 3 },
  });
  if (search.isError) {
    throw new Error(`search_bazaar failed: ${textOf(search)}`);
  }
  const searchPayload = JSON.parse(textOf(search)) as {
    count: number;
    results: Array<{ tool_name: string; url: string; example_query?: Record<string, unknown> }>;
  };
  console.log(`search_bazaar results: ${searchPayload.count}`);
  if (!searchPayload.results?.length) {
    throw new Error("No weather results from search_bazaar");
  }

  const target = searchPayload.results[0];
  console.log(`Calling ${target.tool_name} via call_x402_api...`);
  const paid = await client.callTool({
    name: "call_x402_api",
    arguments: {
      tool_name_or_url: target.tool_name,
      query: target.example_query ?? { location: "Boston" },
    },
  });
  if (paid.isError) {
    throw new Error(`call_x402_api failed: ${textOf(paid)}`);
  }

  const paidPayload = JSON.parse(textOf(paid)) as {
    payment?: { upstream_price_usd?: number; total_price_usd?: number; model?: string };
    data?: unknown;
  };
  console.log(
    `Payment model=${paidPayload.payment?.model} upstream=$${paidPayload.payment?.upstream_price_usd} total=$${paidPayload.payment?.total_price_usd}`,
  );
  console.log(`Data keys: ${paidPayload.data && typeof paidPayload.data === "object" ? Object.keys(paidPayload.data as object).join(",") : typeof paidPayload.data}`);
  console.log("V2 SMOKE TEST PASSED");

  await client.close();
}

main().catch((error) => {
  console.error("V2 SMOKE TEST FAILED");
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

const CORE_TOOLS = [
  "search_bazaar",
  "list_discovered_apis",
  "quote_route",
  "route_and_call",
  "call_x402_api",
  "get_paywall_status",
];

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

  const client = new Client({ name: "x402dispatcher-mcp-test", version: "1.0.0" });
  await client.connect(transport);

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  console.log(`Tools (${names.length}): ${names.join(", ") || "(none)"}`);

  for (const name of CORE_TOOLS) {
    if (!names.includes(name)) {
      throw new Error(`Expected core tool missing: ${name}`);
    }
  }
  if (names.includes("get_mbta_predictions")) {
    throw new Error("get_mbta_predictions should not be registered");
  }

  const status = await client.callTool({ name: "get_paywall_status", arguments: {} });
  if (status.isError) {
    throw new Error(JSON.stringify(status.content, null, 2));
  }

  console.log("MCP TEST PASSED");
  await client.close();
}

main().catch((error) => {
  console.error("MCP TEST FAILED");
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});

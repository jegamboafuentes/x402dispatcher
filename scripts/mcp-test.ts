import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const STOP_ID = "place-pktrm";

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

  const client = new Client({ name: "proxy402-mcp-test", version: "1.0.0" });
  await client.connect(transport);

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  console.log(`Tools: ${names.join(", ") || "(none)"}`);

  if (!names.includes("get_mbta_predictions")) {
    throw new Error("get_mbta_predictions is not registered");
  }

  console.log(`Calling get_mbta_predictions stop_id=${STOP_ID}...`);
  const result = await client.callTool({
    name: "get_mbta_predictions",
    arguments: { stop_id: STOP_ID },
  });

  if (result.isError) {
    throw new Error(JSON.stringify(result.content, null, 2));
  }

  const text = result.content
    .map((part) => (part.type === "text" ? part.text : JSON.stringify(part)))
    .join("\n");
  const parsed = JSON.parse(text) as {
    payment?: { transactionHash?: string; explorerUrl?: string; amount_usd?: number };
    predictions?: { data?: unknown[] };
  };

  console.log(`Payment: ${parsed.payment?.explorerUrl ?? parsed.payment?.transactionHash}`);
  console.log(`MBTA records: ${parsed.predictions?.data?.length ?? 0}`);
  console.log("MCP TEST PASSED");

  await client.close();
}

main().catch((error) => {
  console.error("MCP TEST FAILED");
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});

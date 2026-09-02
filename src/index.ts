import dotenv from "dotenv";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createMcpServer,
  logStartupBanner,
  warmDiscovery,
} from "./server.js";

dotenv.config({ quiet: true });

async function main() {
  await logStartupBanner("stdio");
  const count = await warmDiscovery();
  console.error(`Discovered and registered ${count} Base Sepolia x402 APIs`);

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("x402dispatcher MCP server running on stdio (V5)");
}

main().catch((error) => {
  console.error("Failed to start MCP server:", error);
  process.exit(1);
});

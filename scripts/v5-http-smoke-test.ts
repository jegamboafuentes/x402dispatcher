import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = (process.env.PUBLIC_BASE_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text ?? "" : JSON.stringify(part)))
    .join("\n");
}

async function main() {
  console.log(`V5 HTTP smoke against ${BASE}`);

  const health = await fetch(`${BASE}/health`);
  if (!health.ok) {
    throw new Error(`/health failed: ${health.status}`);
  }
  const healthJson = (await health.json()) as { ok?: boolean; version?: string };
  console.log(`health ok version=${healthJson.version}`);

  const agent = await fetch(`${BASE}/.well-known/agent.json`);
  if (!agent.ok) {
    throw new Error(`/agent.json failed: ${agent.status}`);
  }
  const agentJson = (await agent.json()) as { name?: string; mcp?: { url?: string } };
  if (agentJson.name !== "x402dispatcher" || !agentJson.mcp?.url) {
    throw new Error("agent.json missing name/mcp.url");
  }
  console.log(`agent.json mcp=${agentJson.mcp.url}`);

  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
  const client = new Client({ name: "x402dispatcher-v5-http-test", version: "5.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  console.log(`tools: ${names.length}`);
  for (const required of ["quote_route", "route_and_call", "search_bazaar"]) {
    if (!names.includes(required)) {
      throw new Error(`Missing tool ${required}`);
    }
  }

  const quote = await client.callTool({
    name: "quote_route",
    arguments: { task: "weather", limit: 3 },
  });
  if (quote.isError) {
    throw new Error(`quote_route failed: ${textOf(quote)}`);
  }
  const payload = JSON.parse(textOf(quote)) as { candidate_count?: number };
  console.log(`quote_route candidates=${payload.candidate_count ?? 0}`);

  console.log("V5 HTTP SMOKE TEST PASSED");
  await client.close();
}

main().catch((error) => {
  console.error("V5 HTTP SMOKE TEST FAILED");
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});

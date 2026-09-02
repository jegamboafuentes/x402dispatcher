/**
 * V6 inbound paywall smoke test.
 *
 * Uses a CDP "Buyer" wallet + wrapMCPClientWithPayment to pay Merchant,
 * then exercises route_and_call against local or Cloud Run MCP.
 *
 * Local (Sepolia):
 *   $env:X402_ENV='development'; npm run start:http
 *   $env:X402_ENV='development'; $env:PUBLIC_BASE_URL='http://127.0.0.1:8080'; npm run test:v6
 *
 * Production (Base mainnet — real USDC):
 *   $env:X402_ENV='production'; $env:PUBLIC_BASE_URL='https://YOUR.run.app'; npm run test:v6
 *
 * Fund the Buyer address printed on first run with USDC on the active network.
 */
import dotenv from "dotenv";
import { CdpClient } from "@coinbase/cdp-sdk";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { wrapMCPClientWithPayment } from "@x402/mcp";
import {
  getCdpX402Environment,
  getMaxPriceUsd,
  getNetworkCaip2,
  getUsdcAddress,
  getX402Environment,
  isInboundPaywallEnabled,
  maxPriceAtomic,
} from "../src/config.js";

dotenv.config({ quiet: true });

const BASE = (process.env.PUBLIC_BASE_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const BUYER_ACCOUNT_NAME = process.env.BUYER_ACCOUNT_NAME ?? "Buyer";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text ?? "" : JSON.stringify(part)))
    .join("\n");
}

async function main() {
  console.log(`V6 inbound smoke against ${BASE}`);
  console.log(
    `X402_ENV=${getX402Environment()} network=${getNetworkCaip2()} INBOUND_PAYWALL=${isInboundPaywallEnabled()}`,
  );

  const health = await fetch(`${BASE}/health`);
  if (!health.ok) {
    throw new Error(`/health failed: ${health.status}`);
  }
  const healthJson = (await health.json()) as {
    version?: string;
    inbound_paywall?: { enabled?: boolean; pay_to?: string; inbound_price_usd?: number };
  };
  console.log(
    `health version=${healthJson.version} inbound=${JSON.stringify(healthJson.inbound_paywall)}`,
  );

  if (!healthJson.inbound_paywall?.enabled) {
    throw new Error(
      "Inbound paywall is disabled on the server. Set INBOUND_PAYWALL=true and restart before running test:v6.",
    );
  }

  // Free tool must work without a paying client.
  const freeTransport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
  const freeClient = new Client({ name: "x402dispatcher-v6-free", version: "6.0.0" });
  await freeClient.connect(freeTransport);
  const quote = await freeClient.callTool({
    name: "quote_route",
    arguments: { task: "weather", limit: 2 },
  });
  if (quote.isError) {
    throw new Error(`Free quote_route failed: ${textOf(quote)}`);
  }
  console.log("free quote_route OK");
  await freeClient.close();

  // Paying client (CDP Buyer wallet).
  const cdp = new CdpClient();
  const buyer = await cdp.evm.getOrCreateAccount({ name: BUYER_ACCOUNT_NAME });
  console.log(`Buyer wallet (${BUYER_ACCOUNT_NAME}): ${buyer.address}`);
  console.log(`Fund this address with USDC on ${getNetworkCaip2()} before paid calls.`);

  if (getX402Environment() === "development") {
    try {
      console.log("Requesting Base Sepolia USDC faucet for Buyer...");
      const faucet = await cdp.evm.requestFaucet({
        address: buyer.address,
        network: "base-sepolia",
        token: "usdc",
      });
      console.log(`Faucet tx: ${faucet.transactionHash}`);
      // Give facilitator a moment to see balance.
      await new Promise((r) => setTimeout(r, 8000));
    } catch (error) {
      console.warn(
        `Faucet skipped/failed (${error instanceof Error ? error.message : error}). Ensure Buyer has Sepolia USDC.`,
      );
    }
  }

  const paymentClient = new CdpX402Client({
    environment: getCdpX402Environment(),
    walletConfig: {
      type: "eoa",
      accountName: BUYER_ACCOUNT_NAME,
    },
    spendControls: {
      maxAmountPerPayment: {
        atomic: maxPriceAtomic(),
        asset: getUsdcAddress(),
      },
      allowedNetworks: [getNetworkCaip2()],
    },
    builderCode: "x402dispatcher_v6_buyer",
  });

  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
  const rawClient = new Client({ name: "x402dispatcher-v6-buyer", version: "6.0.0" });
  const paidClient = wrapMCPClientWithPayment(rawClient, paymentClient, {
    autoPayment: true,
    onPaymentRequested: async ({ paymentRequired }) => {
      const accept = paymentRequired.accepts?.[0];
      console.log(
        `Auto-approving inbound payment amount=${accept?.amount} network=${accept?.network} payTo=${accept?.payTo}`,
      );
      return true;
    },
  });
  await paidClient.connect(transport);

  const paid = await paidClient.callTool("route_and_call", {
    task: "weather Revere Beach",
    tier: "economy",
    query: { location: "Revere Beach" },
    max_attempts: 2,
  });

  if (paid.isError) {
    throw new Error(`Paid route_and_call failed: ${JSON.stringify(paid.content).slice(0, 1500)}`);
  }

  console.log(`paymentMade=${paid.paymentMade}`);
  if (paid.paymentResponse) {
    console.log(`inbound settlement: ${JSON.stringify(paid.paymentResponse)}`);
  }

  const body = paid.content
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n");
  const parsed = JSON.parse(body) as { chosen?: { url?: string }; attempts?: unknown[] };
  if (!parsed.chosen?.url) {
    throw new Error(`Unexpected paid result: ${body.slice(0, 800)}`);
  }
  console.log(`chosen=${parsed.chosen.url}`);
  console.log(`MAX_PRICE_USD=${getMaxPriceUsd()}`);
  console.log("V6 INBOUND SMOKE TEST PASSED");
  await paidClient.close();
}

main().catch((error) => {
  console.error("V6 INBOUND SMOKE TEST FAILED");
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});

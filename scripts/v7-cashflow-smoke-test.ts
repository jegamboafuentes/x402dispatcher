/**
 * V7 cashflow ledger smoke test.
 *
 * Runs a paid route (via V6 buyer client), then checks /v1/cashflow and /v1/pnl
 * for inbound + outbound entries.
 *
 * Local Sepolia:
 *   $env:X402_ENV='development'; $env:INBOUND_PAYWALL='true'; npm run start:http
 *   $env:X402_ENV='development'; $env:PUBLIC_BASE_URL='http://127.0.0.1:8080'; npm run test:v7
 */
import dotenv from "dotenv";
import { CdpClient } from "@coinbase/cdp-sdk";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { wrapMCPClientWithPayment } from "@x402/mcp";
import {
  getCdpX402Environment,
  getNetworkCaip2,
  getUsdcAddress,
  getX402Environment,
  isInboundPaywallEnabled,
  maxPriceAtomic,
} from "../src/config.js";

dotenv.config({ quiet: true });

const BASE = (process.env.PUBLIC_BASE_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const BUYER_ACCOUNT_NAME = process.env.BUYER_ACCOUNT_NAME ?? "Buyer";

async function main() {
  console.log(`V7 cashflow smoke against ${BASE}`);
  console.log(
    `X402_ENV=${getX402Environment()} network=${getNetworkCaip2()} INBOUND_PAYWALL=${isInboundPaywallEnabled()}`,
  );

  const health = await fetch(`${BASE}/health`);
  if (!health.ok) {
    throw new Error(`/health failed: ${health.status}`);
  }
  const healthJson = (await health.json()) as {
    version?: string;
    pnl?: { revenue_usd?: number; cogs_usd?: number };
  };
  console.log(`health version=${healthJson.version}`);

  const beforePnl = (await (await fetch(`${BASE}/v1/pnl`)).json()) as {
    revenue_usd: number;
    cogs_usd: number;
    entry_count: number;
  };
  console.log(
    `pnl before: revenue=${beforePnl.revenue_usd} cogs=${beforePnl.cogs_usd} entries=${beforePnl.entry_count}`,
  );

  if (!isInboundPaywallEnabled()) {
    throw new Error("Set INBOUND_PAYWALL=true for V7 smoke (needs a paid call to write ledger).");
  }

  const cdp = new CdpClient();
  const buyer = await cdp.evm.getOrCreateAccount({ name: BUYER_ACCOUNT_NAME });
  console.log(`Buyer: ${buyer.address}`);

  if (getX402Environment() === "development") {
    try {
      const faucet = await cdp.evm.requestFaucet({
        address: buyer.address,
        network: "base-sepolia",
        token: "usdc",
      });
      console.log(`Faucet: ${faucet.transactionHash}`);
      await new Promise((r) => setTimeout(r, 8000));
    } catch (error) {
      console.warn(`Faucet skipped: ${error instanceof Error ? error.message : error}`);
    }
  }

  const paymentClient = new CdpX402Client({
    environment: getCdpX402Environment(),
    walletConfig: { type: "eoa", accountName: BUYER_ACCOUNT_NAME },
    spendControls: {
      maxAmountPerPayment: {
        atomic: maxPriceAtomic(),
        asset: getUsdcAddress(),
      },
      allowedNetworks: [getNetworkCaip2()],
    },
    builderCode: "x402dispatcher_v7_buyer",
  });

  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
  const rawClient = new Client({ name: "x402dispatcher-v7", version: "7.0.0" });
  const paidClient = wrapMCPClientWithPayment(rawClient, paymentClient, {
    autoPayment: true,
    onPaymentRequested: async () => true,
  });
  await paidClient.connect(transport);

  const paid = await paidClient.callTool("route_and_call", {
    task: "weather",
    tier: "economy",
    query: { location: "Boston" },
    max_attempts: 2,
  });
  if (paid.isError) {
    throw new Error(`route_and_call failed: ${JSON.stringify(paid.content).slice(0, 1200)}`);
  }
  console.log(`paid call ok paymentMade=${paid.paymentMade}`);

  // Give the server a moment to flush ledger writes.
  await new Promise((r) => setTimeout(r, 500));

  const cashflow = (await (await fetch(`${BASE}/v1/cashflow?limit=10`)).json()) as {
    entries: Array<{ direction: string; amount_usd: number; status: string }>;
    pnl: { revenue_usd: number; cogs_usd: number; gross_profit_usd: number; entry_count: number };
  };

  const recentIn = cashflow.entries.filter((e) => e.direction === "in" && e.status === "success");
  const recentOut = cashflow.entries.filter((e) => e.direction === "out" && e.status === "success");
  if (recentIn.length < 1) {
    throw new Error(`Expected inbound ledger entry, got: ${JSON.stringify(cashflow.entries)}`);
  }
  if (recentOut.length < 1) {
    throw new Error(`Expected outbound ledger entry, got: ${JSON.stringify(cashflow.entries)}`);
  }

  const afterPnl = cashflow.pnl;
  if (afterPnl.entry_count < beforePnl.entry_count + 2) {
    throw new Error(
      `Expected entry_count to grow by >=2 (before=${beforePnl.entry_count}, after=${afterPnl.entry_count})`,
    );
  }
  if (afterPnl.revenue_usd < beforePnl.revenue_usd) {
    throw new Error("revenue_usd did not increase after paid inbound call");
  }

  // MCP operator tools
  const ledgerTool = await paidClient.callTool("get_pnl", {});
  if (ledgerTool.isError) {
    throw new Error(`get_pnl tool failed: ${JSON.stringify(ledgerTool.content)}`);
  }
  console.log(
    `pnl after: revenue=${afterPnl.revenue_usd} cogs=${afterPnl.cogs_usd} profit=${afterPnl.gross_profit_usd}`,
  );
  console.log("V7 CASHFLOW SMOKE TEST PASSED");
  await paidClient.close();
}

main().catch((error) => {
  console.error("V7 CASHFLOW SMOKE TEST FAILED");
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});

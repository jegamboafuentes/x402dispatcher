import dotenv from "dotenv";
import { CdpClient } from "@coinbase/cdp-sdk";
import { createPublicClient, http, parseUnits } from "viem";
import { baseSepolia } from "viem/chains";

dotenv.config();

const SERVICE_PRICE_USD = 0.01;
const USDC_DECIMALS = 6;
const NETWORK = "base-sepolia" as const;
const STOP_ID = "place-pktrm";

function describeEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) return `${name}: MISSING`;
  if (value === "") return `${name}: EMPTY`;

  const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
  const looksPem = value.includes("BEGIN") && value.includes("PRIVATE KEY");
  const looksUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const hasWhitespaceEdges = value !== value.trim();
  const hasCR = value.includes("\r");
  return `${name}: length=${value.length} quoted=${quoted} pem=${looksPem} uuid=${looksUuid} edgeWhitespace=${hasWhitespaceEdges} cr=${hasCR}`;
}

function dumpError(error: unknown, depth = 0): void {
  if (!error || depth > 4) return;
  if (error instanceof Error) {
    console.error(`${"  ".repeat(depth)}${error.name}: ${error.message}`);
    const anyErr = error as Error & {
      cause?: unknown;
      code?: string;
      status?: number;
      response?: { status?: number; data?: unknown };
    };
    if (anyErr.code) console.error(`${"  ".repeat(depth)}code=${anyErr.code}`);
    if (anyErr.status) console.error(`${"  ".repeat(depth)}status=${anyErr.status}`);
    if (anyErr.response?.status) {
      console.error(`${"  ".repeat(depth)}httpStatus=${anyErr.response.status}`);
    }
    dumpError(anyErr.cause, depth + 1);
    return;
  }
  console.error(`${"  ".repeat(depth)}${String(error)}`);
}

function getMaxPriceUsd(): number {
  const raw = process.env.MAX_PRICE_USD;
  if (raw === undefined || raw === "") {
    return SERVICE_PRICE_USD;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("MAX_PRICE_USD must be a non-negative number");
  }
  return parsed;
}

async function main() {
  console.log(`Node ${process.version}`);

  for (const name of ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET", "MAX_PRICE_USD"]) {
    console.log(describeEnv(name));
  }
  if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET || !process.env.CDP_WALLET_SECRET) {
    throw new Error("Missing one or more required CDP env vars");
  }

  const maxPriceUsd = getMaxPriceUsd();
  console.log(`MAX_PRICE_USD=${maxPriceUsd}`);
  if (SERVICE_PRICE_USD > maxPriceUsd) {
    throw new Error(
      `Payment of $${SERVICE_PRICE_USD} exceeds MAX_PRICE_USD ($${maxPriceUsd}). Transaction aborted.`,
    );
  }

  const cdp = new CdpClient();
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(),
  });

  const treasury = await cdp.evm.getOrCreateAccount({ name: "Treasury" });
  const merchant = await cdp.evm.getOrCreateAccount({ name: "Merchant" });
  console.log(`Treasury: ${treasury.address}`);
  console.log(`Merchant: ${merchant.address}`);

  const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

  async function readUsdcBalance(): Promise<bigint> {
    const { balances } = await treasury.listTokenBalances({ network: NETWORK });
    for (const row of balances) {
      const contract = row.token.contractAddress.toLowerCase();
      const symbol = row.token.symbol;
      console.log(
        `  token ${symbol ?? "unknown"} ${row.token.contractAddress} = ${row.amount.amount.toString()}`,
      );
      if (symbol === "USDC" || contract === BASE_SEPOLIA_USDC.toLowerCase()) {
        return row.amount.amount;
      }
    }
    return 0n;
  }

  async function confirmFaucet(token: "eth" | "usdc"): Promise<void> {
    const faucet = await cdp.evm.requestFaucet({
      address: treasury.address,
      network: NETWORK,
      token,
    });
    console.log(
      `${token.toUpperCase()} faucet: https://sepolia.basescan.org/tx/${faucet.transactionHash}`,
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash: faucet.transactionHash });
    if (receipt.status !== "success") {
      throw new Error(`${token.toUpperCase()} faucet transaction reverted: ${faucet.transactionHash}`);
    }
  }

  console.log("Treasury balances:");
  let usdcBalance = await readUsdcBalance();
  console.log(`Treasury USDC (atomic): ${usdcBalance.toString()}`);

  const amount = parseUnits(SERVICE_PRICE_USD.toFixed(2), USDC_DECIMALS);
  if (usdcBalance < amount) {
    console.log("Treasury USDC is low; requesting Base Sepolia faucet funds...");
    await confirmFaucet("eth");
    await confirmFaucet("usdc");
    console.log("Treasury balances after faucet:");
    usdcBalance = await readUsdcBalance();
    console.log(`Treasury USDC (atomic): ${usdcBalance.toString()}`);
    if (usdcBalance < amount) {
      throw new Error(
        `Faucet confirmed but treasury still has ${usdcBalance.toString()} USDC atomic units; need ${amount.toString()}`,
      );
    }
  }

  console.log(`Sending ${SERVICE_PRICE_USD} USDC on ${NETWORK}...`);
  const { transactionHash } = await treasury.transfer({
    to: merchant,
    amount,
    token: "usdc",
    network: NETWORK,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
  if (receipt.status !== "success") {
    throw new Error(`USDC payment reverted. tx: ${transactionHash}`);
  }
  console.log(`Payment confirmed: https://sepolia.basescan.org/tx/${transactionHash}`);

  const url = `https://api-v3.mbta.com/predictions?filter[stop]=${encodeURIComponent(STOP_ID)}`;
  const response = await fetch(url, { headers: { Accept: "application/vnd.api+json" } });
  if (!response.ok) {
    throw new Error(`MBTA API error ${response.status}: ${await response.text()}`);
  }
  const predictions = (await response.json()) as { data?: unknown[] };
  console.log(`MBTA predictions for ${STOP_ID}: ${predictions.data?.length ?? 0} records`);
  console.log("SMOKE TEST PASSED");
}

main().catch((error) => {
  console.error("SMOKE TEST FAILED");
  dumpError(error);
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});

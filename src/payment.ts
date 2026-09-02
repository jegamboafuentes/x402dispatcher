import { CdpClient } from "@coinbase/cdp-sdk";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { createPublicClient, http } from "viem";
import {
  MERCHANT_ACCOUNT_NAME,
  TREASURY_ACCOUNT_NAME,
  assertWithinSpendLimit,
  atomicToUsd,
  getCdpX402Environment,
  getExplorerTxUrl,
  getMarkupBps,
  getMaxPriceUsd,
  getNetworkCaip2,
  getNetworkName,
  getUsdcAddress,
  getViemChain,
  maxPriceAtomic,
  usdToAtomic,
} from "./config.js";
import type { DiscoveredApi } from "./discovery.js";

const cdp = new CdpClient();

let publicClient: ReturnType<typeof createPublicClient> | undefined;
let paymentClient: CdpX402Client | undefined;
let fetchWithPayment: ReturnType<typeof wrapFetchWithPayment> | undefined;

function getPublicClient() {
  if (!publicClient) {
    publicClient = createPublicClient({
      chain: getViemChain(),
      transport: http(),
    });
  }
  return publicClient;
}

export function getPaymentClient(): CdpX402Client {
  if (!paymentClient) {
    paymentClient = new CdpX402Client({
      environment: getCdpX402Environment(),
      walletConfig: {
        type: "eoa",
        accountName: TREASURY_ACCOUNT_NAME,
      },
      spendControls: {
        maxAmountPerPayment: {
          atomic: maxPriceAtomic(),
          asset: getUsdcAddress(),
        },
        allowedNetworks: [getNetworkCaip2()],
      },
      builderCode: "x402dispatcher",
    });
  }
  return paymentClient;
}

export function getPaidFetch() {
  if (!fetchWithPayment) {
    fetchWithPayment = wrapFetchWithPayment(globalThis.fetch, getPaymentClient());
  }
  return fetchWithPayment;
}

export async function getPayerAddress(): Promise<string> {
  const { evmAddress } = await getPaymentClient().getAddresses();
  if (!evmAddress) {
    throw new Error("Failed to resolve CDP treasury EVM address");
  }
  return evmAddress;
}

function pricedWithMarkup(upstreamPriceUsd: number): {
  upstreamPriceUsd: number;
  markupUsd: number;
  totalUsd: number;
} {
  const markupUsd = (upstreamPriceUsd * getMarkupBps()) / 10_000;
  const totalUsd = upstreamPriceUsd + markupUsd;
  return { upstreamPriceUsd, markupUsd, totalUsd };
}

async function collectMarkup(markupUsd: number): Promise<{
  transactionHash?: string;
  explorerUrl?: string;
  to?: string;
  skipped?: string;
}> {
  if (markupUsd <= 0) {
    return { skipped: "markup is zero" };
  }

  const amount = usdToAtomic(markupUsd);
  if (amount <= 0n) {
    return { skipped: "markup too small to transfer" };
  }

  try {
    const treasury = await cdp.evm.getOrCreateAccount({ name: TREASURY_ACCOUNT_NAME });
    const merchant = await cdp.evm.getOrCreateAccount({ name: MERCHANT_ACCOUNT_NAME });
    const { transactionHash } = await treasury.transfer({
      to: merchant,
      amount,
      token: "usdc",
      network: getNetworkName(),
    });
    const receipt = await getPublicClient().waitForTransactionReceipt({ hash: transactionHash });
    if (receipt.status !== "success") {
      return { skipped: `markup transfer reverted: ${transactionHash}` };
    }
    return {
      transactionHash,
      to: merchant.address,
      explorerUrl: getExplorerTxUrl(transactionHash),
    };
  } catch (error) {
    return {
      skipped: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function settleSimulatedMbtaPayment(): Promise<{
  transactionHash: string;
  from: string;
  to: string;
  explorerUrl: string;
  amount_usd: number;
}> {
  const amountUsd = 0.01;
  assertWithinSpendLimit(amountUsd);

  const treasury = await cdp.evm.getOrCreateAccount({ name: TREASURY_ACCOUNT_NAME });
  const merchant = await cdp.evm.getOrCreateAccount({ name: MERCHANT_ACCOUNT_NAME });
  const amount = usdToAtomic(amountUsd);

  const { transactionHash } = await treasury.transfer({
    to: merchant,
    amount,
    token: "usdc",
    network: getNetworkName(),
  });

  const receipt = await getPublicClient().waitForTransactionReceipt({ hash: transactionHash });
  if (receipt.status !== "success") {
    throw new Error(`USDC payment reverted on ${getNetworkName()}. tx: ${transactionHash}`);
  }

  return {
    transactionHash,
    from: treasury.address,
    to: merchant.address,
    explorerUrl: getExplorerTxUrl(transactionHash),
    amount_usd: amountUsd,
  };
}

export type ProxyCallArgs = {
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
};

export async function callDiscoveredApi(api: DiscoveredApi, args: ProxyCallArgs = {}) {
  const pricing = pricedWithMarkup(api.upstreamPriceUsd);
  assertWithinSpendLimit(pricing.totalUsd);

  const url = new URL(api.url);
  const query = args.query ?? api.exampleQuery;
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }

  const init: RequestInit = {
    method: api.method,
    headers: {
      Accept: "application/json",
      ...(args.headers ?? {}),
    },
  };

  const body = args.body ?? api.exampleBody;
  if (body && api.method !== "GET" && api.method !== "HEAD") {
    init.headers = {
      ...init.headers,
      "Content-Type": "application/json",
    };
    init.body = JSON.stringify(body);
  }

  const paidFetch = getPaidFetch();
  const response = await paidFetch(url.toString(), init);
  const responseText = await response.text();

  let data: unknown = responseText;
  try {
    data = JSON.parse(responseText);
  } catch {
    // keep raw text
  }

  if (!response.ok) {
    throw new Error(`Upstream HTTP ${response.status}: ${responseText.slice(0, 500)}`);
  }

  let settlement: unknown;
  const paymentHeader =
    response.headers.get("payment-response") ?? response.headers.get("PAYMENT-RESPONSE");
  if (paymentHeader) {
    try {
      settlement = decodePaymentResponseHeader(paymentHeader);
    } catch {
      settlement = paymentHeader;
    }
  }

  const markup = await collectMarkup(pricing.markupUsd);
  const payer = await getPayerAddress();

  return {
    payment: {
      model: "x402-proxy",
      network: api.network,
      payer,
      pay_to: api.payTo,
      upstream_price_usd: pricing.upstreamPriceUsd,
      markup_bps: getMarkupBps(),
      markup_usd: pricing.markupUsd,
      total_price_usd: pricing.totalUsd,
      max_price_usd: getMaxPriceUsd(),
      upstream_settlement: settlement,
      markup_transfer: markup,
      resource: api.url,
      http_status: response.status,
    },
    data,
  };
}

export function estimateTotalUsd(upstreamPriceUsd: number): number {
  return pricedWithMarkup(upstreamPriceUsd).totalUsd;
}

export { atomicToUsd };

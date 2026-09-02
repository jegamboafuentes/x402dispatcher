import { createPublicClient, erc20Abi, formatEther, http } from "viem";
import {
  USDC_DECIMALS,
  getExplorerAddressUrl,
  getNetworkCaip2,
  getNetworkLabel,
  getUsdcAddress,
  getViemChain,
  getX402Environment,
} from "./config.js";
import { getMerchantPayToAddress } from "./inbound.js";
import { getPayerAddress } from "./payment.js";

let publicClient: ReturnType<typeof createPublicClient> | undefined;

function getPublicClient() {
  if (!publicClient) {
    publicClient = createPublicClient({
      chain: getViemChain(),
      transport: http(),
    });
  }
  return publicClient;
}

export type WalletBalances = {
  role: "treasury" | "merchant";
  address: string;
  explorer_url: string;
  usdc: number;
  eth: number;
  usdc_atomic: string;
  eth_wei: string;
};

export type WalletsSnapshot = {
  network: string;
  network_label: string;
  x402_env: string;
  treasury: WalletBalances;
  merchant: WalletBalances;
  updated_at: string;
};

async function readBalances(
  role: "treasury" | "merchant",
  address: string,
): Promise<WalletBalances> {
  const client = getPublicClient();
  const addr = address as `0x${string}`;
  const [ethWei, usdcAtomic] = await Promise.all([
    client.getBalance({ address: addr }),
    client.readContract({
      address: getUsdcAddress(),
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [addr],
    }),
  ]);

  return {
    role,
    address,
    explorer_url: getExplorerAddressUrl(address),
    usdc: Number(usdcAtomic) / 10 ** USDC_DECIMALS,
    eth: Number(formatEther(ethWei)),
    usdc_atomic: usdcAtomic.toString(),
    eth_wei: ethWei.toString(),
  };
}

export async function getWalletsSnapshot(): Promise<WalletsSnapshot> {
  const [treasuryAddress, merchantAddress] = await Promise.all([
    getPayerAddress(),
    getMerchantPayToAddress(),
  ]);

  const [treasury, merchant] = await Promise.all([
    readBalances("treasury", treasuryAddress),
    readBalances("merchant", merchantAddress),
  ]);

  return {
    network: getNetworkCaip2(),
    network_label: getNetworkLabel(),
    x402_env: getX402Environment(),
    treasury,
    merchant,
    updated_at: new Date().toISOString(),
  };
}

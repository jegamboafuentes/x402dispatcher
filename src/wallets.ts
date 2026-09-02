import { createPublicClient, erc20Abi, formatEther, http } from "viem";
import {
  USDC_DECIMALS,
  getExplorerAddressUrl,
  getNetworkCaip2,
  getNetworkLabel,
  getNetworkName,
  getUsdcAddress,
  getViemChain,
  getX402Environment,
} from "./config.js";
import { getMerchantPayToAddress } from "./inbound.js";
import { getPayerAddress } from "./payment.js";

const CACHE_TTL_MS = Number(process.env.WALLETS_CACHE_TTL_MS ?? 30_000);
const MAX_ATTEMPTS = 3;

let publicClient: ReturnType<typeof createPublicClient> | undefined;
let cache:
  | {
      expiresAt: number;
      value: WalletsSnapshot;
    }
  | undefined;
let inFlight: Promise<WalletsSnapshot> | undefined;

function rpcUrl(): string | undefined {
  const fromEnv = process.env.BASE_RPC_URL?.trim() || process.env.RPC_URL?.trim();
  return fromEnv || undefined;
}

function getPublicClient() {
  if (!publicClient) {
    publicClient = createPublicClient({
      chain: getViemChain(),
      transport: http(rpcUrl()),
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
  cached?: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimited(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /rate limit|429|too many requests|over rate limit/i.test(msg);
}

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

async function fetchFreshSnapshot(): Promise<WalletsSnapshot> {
  const [treasuryAddress, merchantAddress] = await Promise.all([
    getPayerAddress(),
    getMerchantPayToAddress(),
  ]);

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      // Sequential reads cut peak RPC burst vs 4 parallel calls.
      const treasury = await readBalances("treasury", treasuryAddress);
      const merchant = await readBalances("merchant", merchantAddress);
      return {
        network: getNetworkCaip2(),
        network_label: getNetworkLabel(),
        x402_env: getX402Environment(),
        treasury,
        merchant,
        updated_at: new Date().toISOString(),
      };
    } catch (error) {
      lastError = error;
      if (!isRateLimited(error) || attempt === MAX_ATTEMPTS) {
        throw error;
      }
      await sleep(250 * attempt * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function getWalletsSnapshot(): Promise<WalletsSnapshot> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return { ...cache.value, cached: true };
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    try {
      const value = await fetchFreshSnapshot();
      cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
      return value;
    } catch (error) {
      if (cache?.value) {
        console.error(
          `/v1/wallets RPC failed on ${getNetworkName()}; serving cached snapshot:`,
          error instanceof Error ? error.message : error,
        );
        return { ...cache.value, cached: true };
      }
      throw error;
    } finally {
      inFlight = undefined;
    }
  })();

  return inFlight;
}

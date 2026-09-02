import { parseUnits } from "viem";
import { base, baseSepolia } from "viem/chains";
import type { Chain } from "viem";

export const USDC_DECIMALS = 6;
export const TREASURY_ACCOUNT_NAME = "Treasury";
export const MERCHANT_ACCOUNT_NAME = "Merchant";

const NETWORK_PROFILES = {
  development: {
    cdpEnvironment: "development" as const,
    caip2: "eip155:84532",
    networkName: "base-sepolia",
    networkLabel: "Base Sepolia",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const,
    chain: baseSepolia,
    explorerBase: "https://sepolia.basescan.org",
  },
  production: {
    cdpEnvironment: "production" as const,
    caip2: "eip155:8453",
    networkName: "base",
    networkLabel: "Base",
    usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const,
    chain: base,
    explorerBase: "https://basescan.org",
  },
};

export type X402Environment = keyof typeof NETWORK_PROFILES;

export function getX402Environment(): X402Environment {
  const raw = (process.env.X402_ENV ?? "development").trim().toLowerCase();
  if (raw === "production" || raw === "prod") {
    return "production";
  }
  if (raw === "development" || raw === "dev") {
    return "development";
  }
  throw new Error('X402_ENV must be "development" or "production"');
}

function profile() {
  return NETWORK_PROFILES[getX402Environment()];
}

export function getCdpX402Environment(): "development" | "production" {
  return profile().cdpEnvironment;
}

export function getNetworkCaip2(): string {
  return profile().caip2;
}

export function getNetworkName(): string {
  return profile().networkName;
}

export function getNetworkLabel(): string {
  return profile().networkLabel;
}

export function getUsdcAddress(): `0x${string}` {
  return profile().usdc;
}

export function getViemChain(): Chain {
  return profile().chain;
}

export function getExplorerTxUrl(transactionHash: string): string {
  return `${profile().explorerBase}/tx/${transactionHash}`;
}

/** Match Bazaar / x402 payment requirement network fields for the active profile. */
export function matchesConfiguredNetwork(network: string): boolean {
  const p = profile();
  const value = String(network);
  if (value === p.caip2 || value === p.networkName) {
    return true;
  }
  if (getX402Environment() === "production") {
    return value === "base-mainnet" || value.endsWith(":8453");
  }
  return value === "base-sepolia" || value.endsWith(":84532");
}

export function getMaxPriceUsd(): number {
  const raw = process.env.MAX_PRICE_USD;
  if (raw === undefined || raw === "") {
    return 0.01;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("MAX_PRICE_USD must be a non-negative number");
  }

  return parsed;
}

/** Basis points added on top of upstream price (1000 = 10%). */
export function getMarkupBps(): number {
  const raw = process.env.MARKUP_BPS;
  if (raw === undefined || raw === "") {
    return 1000;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("MARKUP_BPS must be a non-negative number");
  }

  return parsed;
}

export function getDiscoveryLimit(): number {
  const raw = process.env.DISCOVERY_LIMIT;
  if (raw === undefined || raw === "") {
    return 40;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("DISCOVERY_LIMIT must be an integer between 1 and 100");
  }

  return parsed;
}

export function getVerifiedMinSamples(): number {
  const raw = process.env.VERIFIED_MIN_SAMPLES;
  if (raw === undefined || raw === "") {
    return 2;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("VERIFIED_MIN_SAMPLES must be an integer >= 1");
  }
  return parsed;
}

/** Minimum success rate (0–1) for the verified tier. */
export function getVerifiedMinSuccessRate(): number {
  const raw = process.env.VERIFIED_MIN_SUCCESS_RATE;
  if (raw === undefined || raw === "") {
    return 0.8;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error("VERIFIED_MIN_SUCCESS_RATE must be between 0 and 1");
  }
  return parsed;
}

export function assertWithinSpendLimit(priceUsd: number): void {
  const maxPriceUsd = getMaxPriceUsd();
  if (priceUsd > maxPriceUsd) {
    throw new Error(
      `Payment of $${priceUsd.toFixed(6)} exceeds MAX_PRICE_USD ($${maxPriceUsd}). Transaction aborted.`,
    );
  }
}

export function maxPriceAtomic(): bigint {
  return parseUnits(getMaxPriceUsd().toFixed(6), USDC_DECIMALS);
}

export function atomicToUsd(amount: bigint | string): number {
  const atomic = typeof amount === "bigint" ? amount : BigInt(amount);
  return Number(atomic) / 10 ** USDC_DECIMALS;
}

export function usdToAtomic(usd: number): bigint {
  return parseUnits(usd.toFixed(6), USDC_DECIMALS);
}

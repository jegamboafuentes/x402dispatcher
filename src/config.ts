import { parseUnits } from "viem";

export const USDC_DECIMALS = 6;
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
export const NETWORK_CAIP2 = "eip155:84532" as const;
export const NETWORK_NAME = "base-sepolia" as const;
export const TREASURY_ACCOUNT_NAME = "Treasury";
export const MERCHANT_ACCOUNT_NAME = "Merchant";

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

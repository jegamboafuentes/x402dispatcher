import { CdpClient } from "@coinbase/cdp-sdk";
import { createCdpFacilitatorClient } from "@coinbase/cdp-sdk/x402";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  createPaymentWrapper,
  x402ResourceServer,
  type PaymentWrappedHandler,
  type MCPToolCallback,
} from "@x402/mcp";
import {
  MERCHANT_ACCOUNT_NAME,
  formatUsdPrice,
  getExplorerTxUrl,
  getInboundPriceUsd,
  getNetworkCaip2,
  isInboundPaywallEnabled,
} from "./config.js";
import { amountAtomicToUsd, recordCashflow } from "./cashflow.js";

const cdp = new CdpClient();

let resourceServerPromise: Promise<x402ResourceServer> | undefined;
let merchantAddressPromise: Promise<string> | undefined;

export async function getMerchantPayToAddress(): Promise<string> {
  if (!merchantAddressPromise) {
    merchantAddressPromise = (async () => {
      const override = process.env.X402_PAY_TO?.trim();
      if (override) {
        return override;
      }
      const merchant = await cdp.evm.getOrCreateAccount({ name: MERCHANT_ACCOUNT_NAME });
      return merchant.address;
    })();
  }
  return merchantAddressPromise;
}

export async function getInboundResourceServer(): Promise<x402ResourceServer> {
  if (!resourceServerPromise) {
    resourceServerPromise = (async () => {
      const resourceServer = new x402ResourceServer(createCdpFacilitatorClient());
      resourceServer.register(getNetworkCaip2(), new ExactEvmScheme());
      await resourceServer.initialize();
      return resourceServer;
    })();
  }
  return resourceServerPromise;
}

export type PaidToolFactory = <TArgs extends Record<string, unknown>>(
  handler: PaymentWrappedHandler<TArgs>,
) => MCPToolCallback<TArgs> | PaymentWrappedHandler<TArgs>;

/**
 * Build a payment wrapper for a fixed USD price paid to Merchant.
 * When INBOUND_PAYWALL is off, returns a no-op wrapper (handler runs unpaid).
 */
export async function createInboundPaidTool(options: {
  priceUsd?: number;
  description?: string;
  toolNameHint?: string;
}): Promise<PaidToolFactory> {
  if (!isInboundPaywallEnabled()) {
    return ((handler) => handler) as PaidToolFactory;
  }

  const priceUsd = options.priceUsd ?? getInboundPriceUsd();
  const payTo = await getMerchantPayToAddress();
  const resourceServer = await getInboundResourceServer();
  const accepts = await resourceServer.buildPaymentRequirements({
    scheme: "exact",
    network: getNetworkCaip2(),
    payTo,
    price: formatUsdPrice(priceUsd),
  });

  return createPaymentWrapper(resourceServer, {
    accepts,
    resource: {
      description:
        options.description ??
        `x402dispatcher inbound payment (${formatUsdPrice(priceUsd)} USDC to Merchant)`,
      mimeType: "application/json",
      url: options.toolNameHint
        ? `mcp://x402dispatcher/tool/${options.toolNameHint}`
        : undefined,
    },
    hooks: {
      onAfterSettlement: async ({ settlement, toolName, paymentRequirements }) => {
        console.error(
          `Inbound x402 settled for ${toolName}: tx=${settlement.transaction ?? "n/a"} success=${settlement.success}`,
        );
        const amountUsd =
          amountAtomicToUsd(paymentRequirements.amount) ?? getInboundPriceUsd();
        await recordCashflow({
          direction: "in",
          amount_usd: amountUsd,
          amount_atomic: paymentRequirements.amount
            ? String(paymentRequirements.amount)
            : undefined,
          tool: toolName,
          from: settlement.payer,
          to: paymentRequirements.payTo,
          tx_hash: settlement.transaction,
          explorer_url: settlement.transaction
            ? getExplorerTxUrl(settlement.transaction)
            : undefined,
          status: settlement.success ? "success" : "failed",
          note: settlement.success ? "inbound x402 to Merchant" : "inbound settlement failed",
        });
      },
    },
  }) as PaidToolFactory;
}

export async function getInboundPaywallPublicStatus() {
  const enabled = isInboundPaywallEnabled();
  return {
    enabled,
    inbound_price_usd: getInboundPriceUsd(),
    network: getNetworkCaip2(),
    pay_to: enabled ? await getMerchantPayToAddress() : null,
  };
}

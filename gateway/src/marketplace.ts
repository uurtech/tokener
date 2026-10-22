/**
 * AWS Marketplace container-product metering. A paid container product must call
 * RegisterUsage once when each task starts; Marketplace then bills the buyer hourly
 * for as long as the task runs and refuses tasks in accounts that are not subscribed.
 * Disabled unless MARKETPLACE_PRODUCT_CODE is set (local runs, dev deployments).
 */
import { MarketplaceMeteringClient, RegisterUsageCommand } from "@aws-sdk/client-marketplace-metering";

export interface MeteringClientLike {
  registerUsage(productCode: string, publicKeyVersion: number, nonce: string): Promise<{ signature?: string }>;
}

export function sdkMeteringClient(region: string): MeteringClientLike {
  const client = new MarketplaceMeteringClient({ region });
  return {
    async registerUsage(productCode, publicKeyVersion, nonce) {
      const r = await client.send(new RegisterUsageCommand({ ProductCode: productCode, PublicKeyVersion: publicKeyVersion, Nonce: nonce }));
      return { signature: r.Signature };
    },
  };
}

export interface MarketplaceSettings {
  productCode?: string;
  publicKeyVersion: number;
}

export function marketplaceSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): MarketplaceSettings {
  const v = Number.parseInt(env.MARKETPLACE_PUBLIC_KEY_VERSION ?? "1", 10);
  return { productCode: env.MARKETPLACE_PRODUCT_CODE?.trim() || undefined, publicKeyVersion: Number.isFinite(v) && v > 0 ? v : 1 };
}

/** Errors that mean "stop the container": the buyer is not entitled to run this product. */
const FATAL = new Set(["CustomerNotEntitledException", "InvalidProductCodeException", "InvalidPublicKeyVersionException", "InvalidRegionException", "PlatformNotSupportedException", "DisabledApiException"]);

export type MarketplaceStatus = { state: "disabled" } | { state: "registered"; at: string } | { state: "failed"; error: string; fatal: boolean };

/**
 * Register this task with Marketplace. Transient failures (throttling, network) are retried with
 * backoff; entitlement failures are reported as fatal so the caller can exit. Never throws.
 */
export async function registerWithMarketplace(
  client: MeteringClientLike,
  settings: MarketplaceSettings,
  opts: { attempts?: number; baseDelayMs?: number; nonce?: string; sleep?: (ms: number) => Promise<void> } = {},
): Promise<MarketplaceStatus> {
  if (!settings.productCode) return { state: "disabled" };
  const attempts = opts.attempts ?? 5;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const nonce = opts.nonce ?? crypto.randomUUID();
  let lastError = "unknown";
  for (let i = 0; i < attempts; i++) {
    try {
      await client.registerUsage(settings.productCode, settings.publicKeyVersion, nonce);
      return { state: "registered", at: new Date().toISOString() };
    } catch (e) {
      const name = (e as Error).name;
      lastError = `${name}: ${(e as Error).message}`;
      if (FATAL.has(name)) return { state: "failed", error: lastError, fatal: true };
      if (i < attempts - 1) await sleep((opts.baseDelayMs ?? 1000) * 2 ** i);
    }
  }
  return { state: "failed", error: lastError, fatal: false };
}

import { describe, it, expect } from "vitest";
import { marketplaceSettingsFromEnv, registerWithMarketplace, type MeteringClientLike } from "../src/marketplace.js";

const failing = (names: string[]): MeteringClientLike & { calls: number } => {
  const c = {
    calls: 0,
    async registerUsage() {
      const name = names[c.calls++];
      if (!name) return { signature: "sig" };
      throw Object.assign(new Error(`boom ${name}`), { name });
    },
  };
  return c;
};
const noSleep = async () => {};

describe("marketplace", () => {
  it("reads settings from env", () => {
    expect(marketplaceSettingsFromEnv({})).toEqual({ productCode: undefined, publicKeyVersion: 1 });
    expect(marketplaceSettingsFromEnv({ MARKETPLACE_PRODUCT_CODE: " abc ", MARKETPLACE_PUBLIC_KEY_VERSION: "2" })).toEqual({ productCode: "abc", publicKeyVersion: 2 });
    expect(marketplaceSettingsFromEnv({ MARKETPLACE_PRODUCT_CODE: "abc", MARKETPLACE_PUBLIC_KEY_VERSION: "x" }).publicKeyVersion).toBe(1);
  });
  it("is disabled without a product code", async () => {
    const c = failing([]);
    expect(await registerWithMarketplace(c, { publicKeyVersion: 1 })).toEqual({ state: "disabled" });
    expect(c.calls).toBe(0);
  });
  it("registers, retrying transient errors", async () => {
    const c = failing(["ThrottlingException", "InternalServiceErrorException"]);
    const r = await registerWithMarketplace(c, { productCode: "p", publicKeyVersion: 1 }, { sleep: noSleep });
    expect(r.state).toBe("registered");
    expect(c.calls).toBe(3);
  });
  it("stops immediately on entitlement errors and marks them fatal", async () => {
    const c = failing(["CustomerNotEntitledException"]);
    const r = await registerWithMarketplace(c, { productCode: "p", publicKeyVersion: 1 }, { sleep: noSleep });
    expect(r).toMatchObject({ state: "failed", fatal: true });
    expect(c.calls).toBe(1);
  });
  it("gives up after the attempt budget without marking fatal", async () => {
    const c = failing(["ThrottlingException", "ThrottlingException", "ThrottlingException"]);
    const r = await registerWithMarketplace(c, { productCode: "p", publicKeyVersion: 1 }, { attempts: 3, sleep: noSleep });
    expect(r).toMatchObject({ state: "failed", fatal: false });
    expect(c.calls).toBe(3);
  });
});

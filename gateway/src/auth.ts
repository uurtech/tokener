/**
 * Developer credential handling. Tokens are never stored: the store holds
 * sha256(token). Lookups are cached briefly so a busy session does not hit the
 * store on every turn.
 */
import { createHash, randomBytes } from "node:crypto";
import type { DeveloperRecord, KeyStore } from "./store/types.js";

export type Developer = DeveloperRecord;

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateToken(): string {
  return `cgw_${randomBytes(24).toString("hex")}`;
}

/** Accept `Authorization: Bearer x` or `x-api-key: x`. */
export function extractToken(headers: Record<string, string | string[] | undefined>): string | undefined {
  const auth = headers["authorization"];
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  const key = headers["x-api-key"];
  if (typeof key === "string" && key.trim()) return key.trim();
  return undefined;
}

interface CacheEntry {
  dev: Developer | null;
  expires: number;
}

export class DeveloperAuth {
  private cache = new Map<string, CacheEntry>();
  private readonly staticKeys = new Map<string, Developer>();

  /**
   * @param staticKeysJson Optional `{"<token>": "<developerId>"}` map for smoke tests.
   */
  constructor(
    private readonly keys: KeyStore,
    private readonly ttlMs: number,
    staticKeysJson?: string,
  ) {
    if (staticKeysJson) {
      const map = JSON.parse(staticKeysJson) as Record<string, string>;
      for (const [token, developerId] of Object.entries(map)) {
        const keyHash = hashToken(token);
        this.staticKeys.set(keyHash, { developerId, keyHash, enabled: true });
      }
    }
  }

  async lookup(token: string): Promise<Developer | null> {
    const keyHash = hashToken(token);
    const stat = this.staticKeys.get(keyHash);
    if (stat) return stat;
    const now = Date.now();
    const hit = this.cache.get(keyHash);
    if (hit && hit.expires > now) return hit.dev;
    const dev = await this.keys.lookupByHash(keyHash);
    this.cache.set(keyHash, { dev, expires: now + this.ttlMs });
    return dev;
  }

  /** Call after admin changes so revocations and budget edits apply immediately. */
  invalidate(): void {
    this.cache.clear();
  }
}

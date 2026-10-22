import type { Config } from "../config.js";
import { DynamoStore } from "./dynamo.js";
import { SqliteStore } from "./sqlite.js";
import type { Store } from "./types.js";

export type StoreKind = "sqlite" | "dynamo";

export function createStore(cfg: Config): Store {
  const kind = (process.env.STORE as StoreKind | undefined) ?? (process.env.SQLITE_PATH ? "sqlite" : "dynamo");
  if (kind === "sqlite") return new SqliteStore(process.env.SQLITE_PATH ?? "./data/gateway.db");
  return new DynamoStore(cfg.awsRegion, cfg.keysTable, cfg.usageTable);
}

export * from "./types.js";

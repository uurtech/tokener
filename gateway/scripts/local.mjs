// Local runner: SQLite store, admin UI, real Bedrock through your AWS credentials.
// Usage: npm run local        (env: AWS_REGION / AWS_PROFILE as usual; ADMIN_TOKEN optional)
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// Optional gateway/.env (never committed): AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN,
// AWS_REGION, ADMIN_TOKEN, policy env vars. Shell env always wins over the file.
const envFile = path.join(root, ".env");
const before = { ...process.env };
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
  for (const k of Object.keys(before)) process.env[k] = before[k]; // shell overrides file
  if (process.env.AWS_ACCESS_KEY_ID) delete process.env.AWS_PROFILE; // static keys beat a stale profile
}
const dist = path.join(root, "dist", "server.js");
const adminToken = process.env.ADMIN_TOKEN || randomBytes(12).toString("hex");
const port = process.env.PORT || "8080";
const env = {
  ...process.env,
  PORT: port,
  STORE: "sqlite",
  SQLITE_PATH: process.env.SQLITE_PATH || path.join(root, "data", "gateway.db"),
  ADMIN_TOKEN: adminToken,
  AWS_REGION: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
};
// Prefer the compiled build, but fall back to tsx when src/ is newer than dist/ so a forgotten
// `npm run build` never silently runs stale code.
const newest = (dir) => {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return t;
};
const distFresh = existsSync(dist) && newest(path.join(root, "dist")) >= newest(path.join(root, "src"));
const cmd = distFresh ? ["node", [dist]] : ["npx", ["tsx", path.join(root, "src", "server.ts")]];
const runner = distFresh ? "dist/ (compiled)" : existsSync(dist) ? "src/ via tsx (dist/ is older than src/; run `npm run build`)" : "src/ via tsx (no dist/)";
console.log(`
  tokener (local)
  ---------------
  Gateway URL : http://localhost:${port}
  Admin UI    : http://localhost:${port}/admin/#token=${adminToken}   (one-click login)
  Admin token : ${adminToken}${process.env.ADMIN_TOKEN ? "" : "   (random; set ADMIN_TOKEN to keep it stable)"}
  Store       : ${env.SQLITE_PATH}
  Upstream    : ${process.env.UPSTREAM_BASE_URL || `https://bedrock-mantle.${env.AWS_REGION}.api.aws/anthropic`}
  AWS creds   : ${process.env.AWS_BEARER_TOKEN_BEDROCK ? `Bedrock API key ${process.env.AWS_BEARER_TOKEN_BEDROCK.slice(0, 8)}…${existsSync(envFile) && !before.AWS_BEARER_TOKEN_BEDROCK ? " (.env)" : " (shell)"}` : process.env.AWS_ACCESS_KEY_ID ? `static keys ${process.env.AWS_ACCESS_KEY_ID.slice(0, 4)}…${process.env.AWS_ACCESS_KEY_ID.slice(-4)}${existsSync(envFile) ? " (.env)" : " (shell)"}` : process.env.AWS_PROFILE ? `profile ${process.env.AWS_PROFILE}` : "default chain (env / ~/.aws / SSO)"}
  Running     : ${runner}

  1. Open the admin UI, create a developer, copy the settings snippet.
  2. Put it in ~/.claude/settings.json (or export the env vars) and start claude.
`);
const child = spawn(cmd[0], cmd[1], { env, stdio: "inherit" });
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill(s));
child.on("exit", (c) => process.exit(c ?? 0));

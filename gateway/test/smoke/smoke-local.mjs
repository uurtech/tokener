// End-to-end smoke test: mock Bedrock upstream <- gateway <- "Claude Code" (fetch).
// Run: node test/smoke/smoke-local.mjs   (needs AWS credentials only for SigV4 signing)
import http from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { EventStreamCodec } from "@smithy/core/event-streams";
import { toUtf8, fromUtf8 } from "@smithy/util-utf8";
const codec = new EventStreamCodec(toUtf8, fromUtf8);
const esChunk = (obj) => codec.encode({
  headers: { ":message-type": { type: "string", value: "event" }, ":event-type": { type: "string", value: "chunk" }, ":content-type": { type: "string", value: "application/json" } },
  body: fromUtf8(JSON.stringify({ bytes: Buffer.from(JSON.stringify(obj)).toString("base64") })),
});
const runtimeEvents = [
  { type: "message_start", message: { id: "msg_rt", type: "message", role: "assistant", model: "us.anthropic.claude-opus-5-5", content: [], usage: { input_tokens: 300, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "selam" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 42 } },
  { type: "message_stop", "amazon-bedrock-invocationMetrics": { inputTokenCount: 300, outputTokenCount: 42 } },
];

const UP_PORT = Number(process.env.SMOKE_UP_PORT ?? 19499), GW_PORT = Number(process.env.SMOKE_GW_PORT ?? 18480); // uncommon ports: 18080 is popular with other local tools
const received = [];

const sse = [
  `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"anthropic.claude-opus-5-5","content":[],"usage":{"input_tokens":1200,"cache_read_input_tokens":54000,"cache_creation_input_tokens":5000,"output_tokens":1}}}\n\n`,
  `event: ping\ndata: {"type":"ping"}\n\n`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"merhaba"}}\n\n`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":812}}\n\n`,
  `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
];

const upstream = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const json = body ? JSON.parse(body) : {};
  received.push({ url: req.url, headers: req.headers, body: json });
  // --- classic Bedrock Runtime API mock: /model/{id}/invoke | invoke-with-response-stream | count-tokens
  const rt = /^\/model\/([^/]+)\/(invoke|invoke-with-response-stream|count-tokens)$/.exec(req.url ?? "");
  if (rt) {
    const modelId = decodeURIComponent(rt[1]);
    if (!req.headers.authorization?.startsWith("AWS4-HMAC-SHA256")) { res.writeHead(403); return res.end("{}"); }
    if (modelId.includes("broken")) {
      res.writeHead(400, { "content-type": "application/json", "x-amzn-errortype": "ValidationException", "x-amzn-requestid": "rt-err" });
      return res.end(JSON.stringify({ message: "The provided model identifier is invalid." }));
    }
    if (rt[2] === "count-tokens") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ inputTokens: 12 })); }
    if (rt[2] === "invoke-with-response-stream") {
      res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream", "x-amzn-requestid": "rt-stream" });
      for (const e of runtimeEvents) { res.write(esChunk(e)); await sleep(10); }
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/json", "x-amzn-requestid": "rt-json" });
    return res.end(JSON.stringify({ id: "msg_rt2", type: "message", role: "assistant", model: modelId, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }));
  }
  if (!req.headers.authorization?.startsWith("AWS4-HMAC-SHA256")) {
    res.writeHead(403, { "content-type": "application/json" });
    return res.end(JSON.stringify({ message: "not signed" }));
  }
  if (json.model === "anthropic.claude-broken") {
    res.writeHead(400, { "content-type": "application/json", "x-should-retry": "false" });
    return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "model not served" } }));
  }
  if (json.stream) {
    res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_mock" });
    for (const e of sse) { res.write(e); await sleep(20); }
    return res.end();
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "msg_2", type: "message", role: "assistant", model: json.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }));
});
await new Promise((r) => upstream.listen(UP_PORT, "127.0.0.1", r));

const { AWS_BEARER_TOKEN_BEDROCK: _ignoredKey, ...inheritedEnv } = process.env; // smoke always exercises SigV4
const gw = spawn("npx", ["tsx", "src/server.ts"], {
  env: {
    ...inheritedEnv,
    PORT: String(GW_PORT),
    AWS_REGION: process.env.AWS_REGION ?? "us-east-1",
    UPSTREAM_BASE_URL: `http://127.0.0.1:${UP_PORT}/anthropic`,
    BEDROCK_RUNTIME_ENDPOINT: `http://127.0.0.1:${UP_PORT}`,
    STATIC_KEYS_JSON: JSON.stringify({ cgw_test_token: "alice" }),
    STORE: "sqlite", SQLITE_PATH: ":memory:", ADMIN_TOKEN: "adm", EMF_ENABLED: "1", MODEL_CATALOG_ENABLED: "0",
    ROUTE_SUBAGENT_MODEL: "anthropic.claude-sonnet-5-5",
    ROUTE_AUXILIARY_MODEL: "anthropic.claude-haiku-4-5",
    EFFORT_MODE: "fill", DEFAULT_EFFORT: "high",
    OPERATOR_PROMPT: "Keep tool output short.",
    TOOL_RESULT_MAX_CHARS: "500",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let gwOut = "";
gw.stdout.on("data", (d) => (gwOut += d));
gw.stderr.on("data", (d) => (gwOut += d));

const base = `http://127.0.0.1:${GW_PORT}`;
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
  await sleep(100);
}

const failures = [];
const check = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name} ${extra}`); if (!cond) failures.push(name); };

// 1. no credential -> 401
let r = await fetch(`${base}/v1/messages`, { method: "POST", body: "{}" });
check("401 without token", r.status === 401);

// 2. streaming main request, full Anthropic-format body with Bedrock-incompatible fields
const body = {
  model: "claude-opus-5-5[1m]", max_tokens: 1000, stream: true,
  thinking: { type: "adaptive" },
  context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
  output_config: { format: { type: "json_schema", schema: {} } },
  system: [{ type: "text", text: "x-anthropic-attribution" }, { type: "text", text: "You are Claude Code", cache_control: { type: "ephemeral" } }],
  tools: [{ name: "Bash", input_schema: { type: "object" }, strict: true }, { type: "advisor_20260301", name: "advisor" }],
  messages: [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "L".repeat(5000) }] },
  ],
};
r = await fetch(`${base}/v1/messages?beta=true`, {
  method: "POST",
  headers: {
    authorization: "Bearer cgw_test_token", "content-type": "application/json", "anthropic-version": "2023-06-01",
    "anthropic-beta": "interleaved-thinking-2025-05-14,context-management-2025-06-27,context-1m-2025-08-07,structured-outputs-2025-11-13",
    "x-claude-code-request-class": "main", "x-claude-code-session-id": "sess-1",
  },
  body: JSON.stringify(body),
});
const text = await r.text();
check("stream 200", r.status === 200, `status=${r.status}`);
check("content-type event-stream", (r.headers.get("content-type") ?? "").includes("text/event-stream"));
check("SSE bytes identical to upstream", text === sse.join(""));
check("request-id forwarded", r.headers.get("request-id") === "req_mock");
check("x-gateway-model header", r.headers.get("x-gateway-model") === "anthropic.claude-opus-5-5", r.headers.get("x-gateway-model"));
const up = received.at(-1);
check("upstream path /anthropic/v1/messages?beta=true", up.url === "/anthropic/v1/messages?beta=true", up.url);
check("model mapped + [1m] stripped", up.body.model === "anthropic.claude-opus-5-5");
check("context_management removed", up.body.context_management === undefined);
check("output_config.format removed, effort filled", JSON.stringify(up.body.output_config) === JSON.stringify({ effort: "high" }), JSON.stringify(up.body.output_config));
check("strict + advisor removed", up.body.tools.length === 1 && up.body.tools[0].strict === undefined);
check("thinking adaptive kept", up.body.thinking?.type === "adaptive");
check("betas filtered", up.headers["anthropic-beta"] === "interleaved-thinking-2025-05-14,context-1m-2025-08-07", up.headers["anthropic-beta"]);
check("anthropic-version forwarded", up.headers["anthropic-version"] === "2023-06-01");
check("operator prompt appended last, attribution still first", up.body.system[0].text === "x-anthropic-attribution" && up.body.system.at(-1).text === "Keep tool output short.");
check("cache_control preserved", up.body.system[1].cache_control?.type === "ephemeral");
check("tool_result truncated", up.body.messages[2].content[0].content.includes("gateway truncated"));
check("client headers not leaked upstream", up.headers["x-claude-code-session-id"] === undefined && up.headers["authorization"].startsWith("AWS4-HMAC-SHA256"));

// 3. subagent routing + non-stream
r = await fetch(`${base}/v1/messages`, {
  method: "POST",
  headers: { "x-api-key": "cgw_test_token", "content-type": "application/json", "x-claude-code-request-class": "subagent" },
  body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
});
const j = await r.json();
check("non-stream 200 JSON", r.status === 200 && j.type === "message");
check("subagent routed to sonnet", received.at(-1).body.model === "anthropic.claude-sonnet-5-5", received.at(-1).body.model);

// 4. upstream error body forwarded verbatim
r = await fetch(`${base}/v1/messages`, {
  method: "POST",
  headers: { authorization: "Bearer cgw_test_token", "content-type": "application/json" },
  body: JSON.stringify({ model: "anthropic.claude-broken", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
});
check("400 forwarded with body + x-should-retry", r.status === 400 && r.headers.get("x-should-retry") === "false" && (await r.text()).includes("model not served"));

// 5. models + hello
r = await fetch(`${base}/v1/models?limit=1000`, { headers: { authorization: "Bearer cgw_test_token" } });
const models = await r.json();
check("/v1/models lists aliases (Anthropic shape)", r.status === 200 && models.data.some((m) => m.id === "claude-opus-5-5" && m.type === "model") && models.has_more === false && models.first_id);
r = await fetch(`${base}/api/hello`, { method: "HEAD" });
check("HEAD /api/hello 200", r.status === 200);
r = await fetch(`${base}/anthropic/v1/models`, { headers: { authorization: "Bearer cgw_test_token" } });
check("/anthropic prefix accepted", r.status === 200);

// 6. admin API: create developer via UI API, use the token, read overview/requests, update policy live
r = await fetch(`${base}/admin/api/overview`); check("admin requires token", r.status === 401);
const A = { authorization: "Bearer adm", "content-type": "application/json" };
r = await fetch(`${base}/admin/api/developers`, { method: "POST", headers: A, body: JSON.stringify({ developerId: "zeynep", team: "qa", dailyBudgetUsd: 5 }) });
const created = await r.json();
check("admin creates developer + token", r.status === 201 && /^cgw_/.test(created.token));
r = await fetch(`${base}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${created.token}`, "content-type": "application/json", "x-claude-code-request-class": "auxiliary" }, body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) });
check("new token works, auxiliary routed to haiku", r.status === 200 && received.at(-1).body.model === "anthropic.claude-haiku-4-5");
await sleep(150);
r = await fetch(`${base}/admin/api/overview`, { headers: A }); const ov = await r.json();
check("overview aggregates requests", ov.totals.requests >= 4 && ov.byDeveloper.some((d) => d.key === "zeynep"), `requests=${ov.totals.requests}`);
r = await fetch(`${base}/admin/api/requests?limit=5`, { headers: A }); const rq = await r.json();
check("requests log newest first with notes", rq.length >= 4 && rq[0].developerId === "zeynep" && rq[0].notes.join(" ").includes("route:auxiliary"));
r = await fetch(`${base}/admin/api/policy`, { headers: A }); const pol = await r.json();
r = await fetch(`${base}/admin/api/policy`, { method: "PUT", headers: A, body: JSON.stringify({ ...pol, routeAuxiliaryModel: "", effortMode: "override", defaultEffort: "low" }) });
check("policy update accepted", r.status === 200);
r = await fetch(`${base}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${created.token}`, "content-type": "application/json", "x-claude-code-request-class": "auxiliary" }, body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 10, output_config: { effort: "xhigh" }, messages: [{ role: "user", content: "hi" }] }) });
check("policy applied live (no aux routing, effort overridden)", received.at(-1).body.model === "anthropic.claude-opus-5-5" && received.at(-1).body.output_config.effort === "low");
r = await fetch(`${base}/admin/api/policy`, { method: "PUT", headers: A, body: JSON.stringify({ ...pol, effortMode: "turbo" }) });
check("invalid policy rejected", r.status === 400);
// 6b. switch the upstream API to classic Bedrock Runtime from the admin API, verify translation both ways
r = await fetch(`${base}/admin/api/policy`, { method: "PUT", headers: A, body: JSON.stringify({ ...pol, upstreamMode: "runtime", bedrockProfilePrefix: "us" }) });
check("policy accepts upstreamMode=runtime", r.status === 200 && (await r.json()).upstreamMode === "runtime");
r = await fetch(`${base}/health`); check("health reports runtime API", (await r.json()).api === "runtime");
const RT = { authorization: "Bearer cgw_test_token", "content-type": "application/json", "anthropic-beta": "interleaved-thinking-2025-05-14,context-management-2025-06-27", "x-claude-code-request-class": "main", "x-claude-code-session-id": "sess-rt" };
r = await fetch(`${base}/v1/messages`, { method: "POST", headers: RT, body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 10, metadata: { user_id: "u1" }, context_management: {}, messages: [{ role: "user", content: "hi" }] }) });
const rtJson = await r.json();
let rtUp = received.at(-1);
check("runtime non-stream 200 via InvokeModel", r.status === 200 && rtJson.type === "message" && rtUp.url === "/model/us.anthropic.claude-opus-5-5/invoke", `${r.status} ${rtUp.url}`);
check("runtime body translated (anthropic_version, betas array, no model/stream/metadata/context_management)",
  rtUp.body.anthropic_version === "bedrock-2023-05-31" && JSON.stringify(rtUp.body.anthropic_beta) === JSON.stringify(["interleaved-thinking-2025-05-14"]) && rtUp.body.model === undefined && rtUp.body.stream === undefined && rtUp.body.metadata === undefined && rtUp.body.context_management === undefined, JSON.stringify(rtUp.body).slice(0, 200));
check("runtime headers: x-gateway-api + profile-prefixed model + request id", r.headers.get("x-gateway-api") === "runtime" && r.headers.get("x-gateway-model") === "us.anthropic.claude-opus-5-5" && r.headers.get("x-amzn-requestid") === "rt-json");
r = await fetch(`${base}/v1/messages`, { method: "POST", headers: RT, body: JSON.stringify({ model: "global.anthropic.claude-opus-5-5", max_tokens: 10, stream: true, messages: [{ role: "user", content: "hi" }] }) });
const rtSse = await r.text();
rtUp = received.at(-1);
const rtEvents = rtSse.split("\n\n").filter(Boolean);
check("runtime stream: event stream converted to SSE", r.status === 200 && (r.headers.get("content-type") ?? "").includes("text/event-stream") && rtEvents.length === 6 && rtEvents[0].startsWith("event: message_start\ndata: ") && rtEvents.at(-1).startsWith("event: message_stop"), `events=${rtEvents.length}`);
check("runtime stream: prefixed id kept, streaming URL used", rtUp.url === "/model/global.anthropic.claude-opus-5-5/invoke-with-response-stream", rtUp.url);
check("runtime stream: payloads are the original Anthropic events", rtEvents.length > 2 && JSON.parse(rtEvents[2].split("\ndata: ")[1] ?? "{}").delta?.text === "selam");
r = await fetch(`${base}/v1/messages`, { method: "POST", headers: RT, body: JSON.stringify({ model: "anthropic.claude-broken", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) });
const rtErr = await r.json();
check("runtime ValidationException -> 400 invalid_request_error", r.status === 400 && rtErr.error?.type === "invalid_request_error" && /model identifier/.test(rtErr.error.message) && r.headers.get("x-amzn-errortype") === "ValidationException", `${r.status} ${JSON.stringify(rtErr)}`);
r = await fetch(`${base}/v1/messages/count_tokens`, { method: "POST", headers: RT, body: JSON.stringify({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }) });
check("runtime count_tokens -> input_tokens", r.status === 200 && (await r.json()).input_tokens === 12);
await sleep(150);
r = await fetch(`${base}/admin/api/requests?limit=3`, { headers: A }); const rtLog = await r.json();
const rtStreamRec = rtLog.find((x) => x.sessionId === "sess-rt" && x.stream);
check("runtime stream usage recorded from converted SSE", !!rtStreamRec && rtStreamRec.usage.inputTokens === 300 && rtStreamRec.usage.cacheReadTokens === 9000 && rtStreamRec.usage.outputTokens === 42 && rtStreamRec.costUsd > 0 && rtStreamRec.model === "global.anthropic.claude-opus-5-5", JSON.stringify(rtStreamRec?.usage));
r = await fetch(`${base}/admin/api/policy`, { method: "PUT", headers: A, body: JSON.stringify({ ...pol, upstreamMode: "mantle" }) });
r = await fetch(`${base}/health`); check("switched back to mantle", (await r.json()).api === "mantle");

// 6c. per-developer API override + model allowlist (policy is back on mantle here)
r = await fetch(`${base}/admin/api/developers`, { method: "POST", headers: A, body: JSON.stringify({ developerId: "pinned", dailyBudgetUsd: 0, upstreamMode: "runtime", allowedModels: ["anthropic.claude-haiku-4-5", "claude-sonnet-5-5"] }) });
const pinned = await r.json();
check("developer created with API override + allowlist", r.status === 201);
r = await fetch(`${base}/admin/api/developers`, { headers: A });
const pinnedRow = (await r.json()).find((d) => d.developerId === "pinned");
check("developer list shows override + allowlist", pinnedRow?.upstreamMode === "runtime" && JSON.stringify(pinnedRow?.allowedModels) === JSON.stringify(["anthropic.claude-haiku-4-5", "claude-sonnet-5-5"]));
const P = { authorization: `Bearer ${pinned.token}`, "content-type": "application/json" };
r = await fetch(`${base}/v1/messages`, { method: "POST", headers: P, body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) });
check("allowed alias (dated variant) passes and uses the developer's runtime API", r.status === 200 && r.headers.get("x-gateway-api") === "runtime" && received.at(-1).url.startsWith("/model/us.anthropic.claude-haiku-4-5/invoke"), `${r.status} ${r.headers.get("x-gateway-api")} ${received.at(-1).url}`);
r = await fetch(`${base}/v1/messages`, { method: "POST", headers: P, body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) });
const denied = await r.json();
check("model outside allowlist -> 403 permission_error", r.status === 403 && denied.error?.type === "permission_error" && /not allowed/.test(denied.error.message), `${r.status}`);
r = await fetch(`${base}/v1/messages`, { method: "POST", headers: { ...P, "x-claude-code-request-class": "subagent" }, body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) });
check("operator routing is exempt from the allowlist", r.status === 200);
r = await fetch(`${base}/v1/models`, { headers: P }); const pinnedModels = await r.json();
check("/v1/models filtered to the allowlist", pinnedModels.data.length === 3 && pinnedModels.data.every((m) => /haiku-4-5|sonnet-5-5/.test(m.id)), pinnedModels.data.map((m) => m.id).join(","));
r = await fetch(`${base}/admin/api/developers/pinned`, { method: "PATCH", headers: A, body: JSON.stringify({ allowedModels: [], upstreamMode: null }) });
check("clearing allowlist + override", r.status === 200);
r = await fetch(`${base}/v1/messages`, { method: "POST", headers: P, body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) });
check("after clearing: any model, policy API (mantle)", r.status === 200 && r.headers.get("x-gateway-api") === "mantle");
r = await fetch(`${base}/admin/api/developers/pinned`, { method: "PATCH", headers: A, body: JSON.stringify({ upstreamMode: "turbo" }) });
check("invalid API override rejected", r.status === 400);

// 6d. new admin surfaces: trend, audit, pricing, preview, diagnostics, rotate
r = await fetch(`${base}/admin/api/trend?days=7`, { headers: A }); const trend = await r.json();
check("trend returns 7 days with today populated", r.status === 200 && trend.points.length === 7 && trend.points.at(-1).requests >= 4 && typeof trend.points.at(-1).savedUsd === "number", `len=${trend.points?.length}`);
r = await fetch(`${base}/admin/api/requests?class=subagent&limit=50`, { headers: A }); const subs = await r.json();
check("requests filter by class", subs.length >= 1 && subs.every((x) => x.requestClass === "subagent"));
r = await fetch(`${base}/admin/api/requests?session=sess-1`, { headers: A }); const sess = await r.json();
check("requests filter by session", sess.length >= 1 && sess.every((x) => x.sessionId === "sess-1"));
r = await fetch(`${base}/admin/api/requests?errors=1`, { headers: A }); const errs = await r.json();
check("requests errors-only filter", errs.length >= 1 && errs.every((x) => x.status >= 400 || x.errorType));
const routed = (await (await fetch(`${base}/admin/api/requests?class=auxiliary&limit=50`, { headers: A })).json()).find((x) => x.model.includes("haiku"));
check("savings recorded for routed requests", !!routed && routed.savedUsd > 0, JSON.stringify(routed?.savedUsd));
r = await fetch(`${base}/admin/api/pricing`, { method: "PUT", headers: A, body: JSON.stringify({ "anthropic.claude-mystery-9": { input: 1, output: 2, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 } }) });
const pr = await r.json();
check("pricing override saved and normalised", r.status === 200 && pr.overrides["claude-mystery-9"]?.output === 2 && pr.effective["claude-mystery-9"]);
r = await fetch(`${base}/admin/api/pricing`, { method: "PUT", headers: A, body: JSON.stringify({ "claude-mystery-9": { input: -1 } }) });
check("invalid pricing rejected", r.status === 400);
r = await fetch(`${base}/admin/api/pricing`, { method: "PUT", headers: A, body: JSON.stringify({ "claude-mystery-9": null }) });
check("pricing override removed", r.status === 200 && !(await r.json()).overrides["claude-mystery-9"]);
r = await fetch(`${base}/admin/api/policy/preview`, { method: "POST", headers: A, body: JSON.stringify({ ...pol, routeSubagentModel: "anthropic.claude-sonnet-5-5", effortMode: "fill", defaultEffort: "medium", toolResultMaxChars: 1000 }) });
const pv = await r.json();
const pvSub = pv.classes?.find((c) => c.requestClass === "subagent");
check("policy preview shows routing/effort/truncation without saving", r.status === 200 && pvSub?.servedModel === "anthropic.claude-sonnet-5-5" && pvSub?.effort === "medium" && pvSub?.toolResultChars < 2000 && pv.classes.find((c) => c.requestClass === "main").servedModel === "anthropic.claude-opus-5-5", JSON.stringify(pvSub));
r = await fetch(`${base}/admin/api/policy`, { headers: A }); check("preview did not change the saved policy", (await r.json()).effortMode === pol.effortMode);
r = await fetch(`${base}/admin/api/diagnostics`, { method: "POST", headers: A }); const dg = await r.json();
check("diagnostics run store/catalog/bedrock checks", r.status === 200 && dg.checks.store.ok && dg.checks.bedrock.ok && dg.checks.catalog.detail === "disabled", JSON.stringify(dg.checks.bedrock));
r = await fetch(`${base}/admin/api/developers/zeynep/rotate`, { method: "POST", headers: A }); const rot = await r.json();
check("token rotation issues a new token and revokes the old", r.status === 200 && /^cgw_/.test(rot.token) && rot.revoked >= 1);
r = await fetch(`${base}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${created.token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) });
check("old token rejected after rotation", r.status === 401);
r = await fetch(`${base}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${rot.token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) });
check("rotated token works with the same settings", r.status === 200 && r.headers.get("x-gateway-developer") === "zeynep");
created.token = rot.token;
r = await fetch(`${base}/admin/api/audit?limit=50`, { headers: A }); const au = await r.json();
check("audit log records admin actions", au.length >= 5 && au.some((e) => e.action === "developer.rotate" && e.target === "zeynep") && au.some((e) => e.action === "policy.update") && au.some((e) => e.action === "pricing.update"), au.map((e) => e.action).join(","));
r = await fetch(`${base}/admin/api/config`, { headers: A }); const cfgj = await r.json();
check("config exposes version/uptime/auth/marketplace/catalog", /^\d+\.\d+\.\d+$/.test(cfgj.version) && typeof cfgj.uptimeSec === "number" && cfgj.authMode === "sigv4" && cfgj.marketplace === "disabled" && cfgj.catalog.enabled === false);

// 7. daily token limit: create a developer with a tiny cap, switch to block, second request gets 429
r = await fetch(`${base}/admin/api/developers`, { method: "POST", headers: A, body: JSON.stringify({ developerId: "tokencap", dailyBudgetUsd: 0, dailyTokenLimit: 100 }) });
const capped = await r.json();
check("developer created with token limit", r.status === 201);
r = await fetch(`${base}/admin/api/developers`, { headers: A });
const devRow = (await r.json()).find((d) => d.developerId === "tokencap");
check("developers list exposes token limit + tokens today", devRow?.dailyTokenLimit === 100 && devRow?.todayTokens === 0 && devRow?.dailyBudgetUsd === 0);
r = await fetch(`${base}/admin/api/policy`, { method: "PUT", headers: A, body: JSON.stringify({ ...pol, budgetAction: "block" }) });
const H = { authorization: `Bearer ${capped.token}`, "content-type": "application/json" };
r = await fetch(`${base}/v1/messages`, { method: "POST", headers: H, body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) });
check("first request under token cap passes", r.status === 200 && r.headers.get("x-gateway-budget-tokens") === "0/100" && r.headers.get("x-gateway-budget") === "none", r.headers.get("x-gateway-budget-tokens"));
await sleep(150); // usage is recorded asynchronously (15 tokens from the mock's non-stream reply)
r = await fetch(`${base}/v1/messages`, { method: "POST", headers: H, body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) });
check("second request still under cap, no warning yet", r.status === 200 && r.headers.get("x-gateway-budget-status") === null, r.headers.get("x-gateway-budget-status"));
r = await fetch(`${base}/admin/api/developers/tokencap`, { method: "PATCH", headers: A, body: JSON.stringify({ dailyTokenLimit: 30 }) });
check("token limit editable via PATCH", r.status === 200);
r = await fetch(`${base}/v1/messages`, { method: "POST", headers: H, body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) });
const blocked = await r.json();
check("token cap exceeded -> 429 with token message", r.status === 429 && r.headers.get("x-gateway-budget-status") === "exceeded:tokens" && /token limit exceeded \(30 of 30 tokens\)/.test(blocked.error?.message ?? ""), `status=${r.status} ${blocked.error?.message}`);
r = await fetch(`${base}/admin/api/developers/tokencap`, { method: "PATCH", headers: A, body: JSON.stringify({ dailyTokenLimit: 36 }) });
r = await fetch(`${base}/v1/messages`, { method: "POST", headers: H, body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) });
check("80% of token cap -> warning header, request allowed", r.status === 200 && r.headers.get("x-gateway-budget-status") === "warning:tokens", r.headers.get("x-gateway-budget-status"));
r = await fetch(`${base}/admin/api/developers/tokencap`, { method: "PATCH", headers: A, body: JSON.stringify({ dailyTokenLimit: -5 }) });
check("negative limit rejected with 400", r.status === 400);
r = await fetch(`${base}/admin/api/policy`, { method: "PUT", headers: A, body: JSON.stringify({ ...pol, budgetAction: "warn" }) });

r = await fetch(`${base}/admin/api/developers/zeynep/revoke`, { method: "POST", headers: A });
r = await fetch(`${base}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${created.token}`, "content-type": "application/json" }, body: "{}" });
check("revoked token rejected immediately", r.status === 401);
r = await fetch(`${base}/admin/api/models`, { headers: A }); const cat = await r.json();
check("admin /models reports disabled catalog gracefully", r.status === 200 && cat.disabled === true && Array.isArray(cat.models) && cat.models.length === 0);
r = await fetch(`${base}/admin/`); check("admin UI served", r.status === 200 && (await r.text()).includes("tokener"));
r = await fetch(`${base}/admin/app.js`); check("admin JS served", r.status === 200 && (r.headers.get("content-type") ?? "").includes("javascript"));

await sleep(300);
const emf = gwOut.split("\n").filter((l) => l.includes('"EstimatedCostUsd"'));
check("EMF metric lines emitted", emf.length >= 2, `count=${emf.length}`);
if (emf[0]) {
  const m = JSON.parse(emf[0]);
  check("EMF has token counts + cost", m.InputTokens === 1200 && m.CacheReadTokens === 54000 && m.OutputTokens === 812 && m.EstimatedCostUsd > 0.05 && m.EstimatedCostUsd < 0.06, `cost=${m.EstimatedCostUsd}`);
  check("EMF carries session + class", m.SessionId === "sess-1" && m.RequestClass === "main");
}

gw.kill("SIGTERM");
upstream.close();
if (failures.length) { console.log("\nGateway log tail:\n" + gwOut.split("\n").slice(-15).join("\n")); process.exit(1); }
console.log("\nALL SMOKE CHECKS PASSED");

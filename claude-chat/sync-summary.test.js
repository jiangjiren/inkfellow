import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateSyncSummary, handleSyncSummary } from "./sync-summary.js";

const profile = { id: "api", provider: "custom", apiKey: "test-secret", baseUrl: "http://localhost", haikuModel: "~fast-model" };
const profiles = { activeProfileId: "subscription", profiles: [{ id: "subscription", provider: "codex" }, profile] };

test("uses configured fast API model, bounds diff, extracts text and cleans summary", async () => {
  const result = await generateSyncSummary("x".repeat(20000), profiles, { createClient(options) {
    assert.equal(options.authToken, "test-secret");
    assert.equal(options.maxRetries, 0);
    assert.equal(options.timeout, 20000);
    return { messages: { async create(body) {
      assert.equal(body.model, "fast-model");
      assert.equal(body.messages[0].content.length, 16000);
      return { content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "「补充阅读感悟\n和年度计划」" }] };
    } } };
  } });
  assert.deepEqual(result, { isAi: true, message: "补充阅读感悟 和年度计划" });
});

test("missing account, provider errors, empty and truncated output explicitly fall back", async () => {
  assert.equal((await generateSyncSummary("diff", { profiles: [] })).isAi, false);
  for (const response of [{ content: [] }, { content: [{ type: "text", text: "partial" }], stop_reason: "max_tokens" }]) {
    assert.equal((await generateSyncSummary("diff", profiles, { createClient: () => ({ messages: { create: async () => response } }) })).isAi, false);
  }
  const result = await generateSyncSummary("diff", profiles, { createClient: () => ({ messages: { create() { throw { status: 401, message: "test-secret" }; } } }) });
  assert.deepEqual(result, { isAi: false, reason: "AI 账号鉴权失败" });
});

test("authenticated HTTP endpoint calls real SDK against mock provider and validates inputs", async t => {
  let calls = 0;
  const upstream = createServer((req, res) => {
    assert.equal(req.url, "/v1/messages");
    assert.equal(req.headers.authorization, "Bearer test-secret");
    let raw = "";
    req.on("data", chunk => raw += chunk);
    req.on("end", () => {
      calls++;
      assert.equal(JSON.parse(raw).model, "fast-model");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ content: [{ type: "text", text: "补充了年度阅读计划" }], stop_reason: "end_turn" }));
    });
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const server = createServer((req, res) => handleSyncSummary(req, res, {
    token: "desktop-token", suppliedToken: new URL(req.url, "http://localhost").searchParams.get("token"),
    profiles: () => ({ profiles: [{ ...profile, baseUrl: `http://127.0.0.1:${upstream.address().port}` }] }),
  }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/sync-summary`;
  assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 403);
  for (const [body, status] of [["invalid", 400], ["{}", 400], [JSON.stringify({ diff: "x".repeat(100001) }), 413]]) {
    assert.equal((await fetch(`${url}?token=desktop-token`, { method: "POST", body })).status, status);
  }
  const response = await fetch(`${url}?token=desktop-token`, { method: "POST", body: JSON.stringify({ diff: "+年度阅读计划" }) });
  assert.deepEqual(await response.json(), { isAi: true, message: "补充了年度阅读计划" });
  assert.equal(calls, 1);
});

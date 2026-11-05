import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { generateSyncSummary } from "./sync-summary.js";

/* SDK 没收到 baseURL 和请求头配置时会去读这两个环境变量。跑测试的 shell 里要是
   设着（比如在第三方账号的 Claude Code 会话里跑），断言测的就是那台机器的环境了。 */
const SDK_ENV_KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS"];
const savedEnv = {};
before(() => {
  for (const key of SDK_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
after(() => {
  for (const key of SDK_ENV_KEYS) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
  }
});

test("Anthropic SDK sends the current API version and configured official credential", async () => {
  await checkRequest({ provider: "anthropic", expectedVersion: "2026-10-21" });
});

test("compatible providers keep the earlier API version and their own bearer credential", async () => {
  for (const provider of ["deepseek", "openrouter", "custom"]) {
    await checkRequest({ provider, expectedVersion: "2023-06-01" });
  }
});

async function checkRequest({ provider, expectedVersion }) {
  const profile = {
    id: "test-profile",
    provider,
    apiKey: "configured-test-key",
    baseUrl: "https://compatible.example",
    haikuModel: "~fast-model[1m]",
  };
  let request;
  const result = await generateSyncSummary("a small change", {
    activeProfileId: profile.id,
    profiles: [profile],
  }, {
    createClient: options => new Anthropic({
      ...options,
      fetch: async (url, init) => {
        request = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) };
        return new Response(JSON.stringify({
          id: "msg-test", type: "message", role: "assistant", model: "fast-model",
          content: [{ type: "text", text: "更新了笔记" }], stop_reason: "end_turn", usage: {},
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    }),
  });
  assert.deepEqual(result, { isAi: true, message: "更新了笔记" });
  assert.equal(request.headers.get("anthropic-version"), expectedVersion);
  assert.equal(request.headers.get("authorization"), "Bearer configured-test-key");
  assert.equal(request.headers.get("x-api-key"), null);
  assert.equal(request.body.model, "fast-model");
  assert.equal(request.body.messages[0].content, "a small change");
  for (const key of ["temperature", "top_p", "top_k"]) assert.equal(key in request.body, false);
  assert.equal(new URL(request.url).origin, provider === "anthropic" ? "https://api.anthropic.com" : profile.baseUrl);
}

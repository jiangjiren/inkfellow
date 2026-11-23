import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { agentProviderCompatibilityEnv } from "./agent-provider-compat.js";

test("gateway compatibility is scoped to third-party providers", () => {
  for (const provider of ["deepseek", "openrouter", "minimax", "custom"]) {
    assert.deepEqual(agentProviderCompatibilityEnv({ provider }), {
      ENABLE_TOOL_SEARCH: "false",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    });
  }
  for (const provider of ["claude", "anthropic", "codex", undefined]) {
    assert.deepEqual(agentProviderCompatibilityEnv({ provider }), {});
  }
  assert.deepEqual(agentProviderCompatibilityEnv(null), {});
});

function streamMessage(res, content, stopReason, id) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  emit("message_start", { message: {
    id, type: "message", role: "assistant", model: "deepseek-flash",
    content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 0 },
  } });
  content.forEach((block, index) => {
    if (block.type === "tool_use") {
      emit("content_block_start", { index, content_block: { ...block, input: {} } });
      emit("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    } else {
      emit("content_block_start", { index, content_block: { type: "text", text: "" } });
      emit("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
    }
    emit("content_block_stop", { index });
  });
  emit("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 10 } });
  emit("message_stop", {});
  res.end();
}

function wireTypes(value, types = new Set()) {
  if (!value || typeof value !== "object") return types;
  if (typeof value.type === "string") types.add(value.type);
  for (const item of Object.values(value)) wireTypes(item, types);
  return types;
}

for (const legacySession of [false, true]) {
test(`real SDK gateway tools and resume are compatible (legacy session: ${legacySession})`, { timeout: 60_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), "inkfellow-gateway-compat-"));
  const requests = [];
  let toolCalls = 0;
  let legacyMode = legacySession;
  const server = createServer(async (req, res) => {
    if (!req.url.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const types = wireTypes(body.messages);
    // Mirror the provider's strict schema instead of silently accepting new types.
    const unsupported = ["tool_definition", "tool_addition", "tool_removal", "tool_reference"];
    if (!legacyMode && (unsupported.some(type => types.has(type)) || body.tools?.some(tool => tool.defer_loading))) {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "unknown variant tool_definition, expected tool_reference" } }));
      return;
    }
    if (legacyMode && requests.length === 1) {
      streamMessage(res, [{ type: "tool_use", id: "toolu_compat_search", name: "ToolSearch",
        input: { query: "select:mcp__compat__echo", max_results: 1 } }], "tool_use", "msg_compat_search");
      return;
    }
    const callTool = requests.length === (legacySession ? 2 : 1);
    streamMessage(res, callTool
      ? [{ type: "tool_use", id: "toolu_compat_echo", name: "mcp__compat__echo", input: { text: "round-trip" } }]
      : [{ type: "text", text: "compatible reply" }], callTool ? "tool_use" : "end_turn", `msg_compat_${requests.length}`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: baseURL,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "offline-test-token",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    CLAUDE_CONFIG_DIR: join(scratch, "config"),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    ENABLE_TOOL_SEARCH: "true", // A parent process must not override compatibility.
    ...agentProviderCompatibilityEnv({ provider: "deepseek" }),
  };
  const makeMcp = () => createSdkMcpServer({
    name: "compat", version: "1.0.0",
    tools: [tool("echo", "Echo test text", { text: z.string() }, async ({ text }) => {
      toolCalls += 1;
      return { content: [{ type: "text", text }] };
    })],
  });
  const run = async (prompt, resume) => {
    let stderr = "";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    const generator = query({ prompt, options: {
      cwd: scratch, env: legacyMode ? { ...env, ENABLE_TOOL_SEARCH: "true", CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "0" } : env,
      model: "deepseek-flash", settingSources: [],
      mcpServers: { compat: makeMcp() }, allowedTools: ["mcp__compat__echo"],
      maxTurns: 4, resume, abortController: controller,
      stderr: chunk => { stderr += chunk; },
    } });
    let result;
    try {
      for await (const event of generator) if (event.type === "result") result = event;
      assert.ok(result && !result.is_error, `${JSON.stringify(result)}\n${stderr}`);
      assert.match(result.result, /compatible reply/);
      return result.session_id;
    } finally {
      clearTimeout(timer);
      generator.close();
    }
  };
  try {
    const sessionId = await run("Call the echo tool then reply.");
    assert.equal(toolCalls, 1, "ordinary MCP tool execution must remain available");
    const initialRequests = legacySession ? 3 : 2;
    assert.equal(requests.length, initialRequests, "the tool response must reach the next inference request");
    if (legacySession) {
      assert.ok(wireTypes(requests[1].messages).has("tool_reference"), "seed an actual pre-fix tool-search session");
    } else {
      assert.ok(requests[0].tools.some(tool => tool.name === "mcp__compat__echo" && tool.input_schema));
    }
    assert.ok(JSON.stringify(requests.at(-1).messages).includes("round-trip"));
    legacyMode = false;
    await run("Continue the previous conversation.", sessionId);
    assert.equal(requests.length, initialRequests + 1);
    assert.ok(JSON.stringify(requests.at(-1).messages).includes("round-trip"), "resume must preserve previous tool context");
    for (const body of requests.slice(legacySession ? initialRequests : 0)) {
      const types = wireTypes(body.messages);
      for (const type of ["tool_definition", "tool_addition", "tool_removal", "tool_reference"]) {
        assert.equal(types.has(type), false, type);
      }
      assert.equal(body.tools.some(tool => tool.defer_loading), false);
    }
    t.diagnostic(`SDK verified ${requests.length} requests, tool execution and persisted resume`);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  }
});
}

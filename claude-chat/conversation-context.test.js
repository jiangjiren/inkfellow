import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { prepareConversationContext } from "./conversation-context.js";
import * as eventLog from "./core/event-log.js";

const conversation = {
  sessionBinding: { sessionId: "thread-a", sessionProvider: "codex", profileId: "account-a", model: "model-a" },
  messages: [
    { role: "user", text: "记住暗号", contextText: "记住暗号：蓝鲸；引用笔记：下周发布" },
    { role: "assistant", text: "已记住蓝鲸和下周发布。" },
  ],
};
const request = { provider: "codex", profileId: "account-a", model: "model-a", prompt: "暗号是什么？" };

test("same model resumes only the conversation's own native session", () => {
  assert.deepEqual(prepareConversationContext(conversation, request), {
    sessionId: "thread-a", sessionProvider: "codex", prompt: request.prompt,
  });
  assert.equal(prepareConversationContext(null, request).sessionId, null);
});

for (const change of [{ model: "model-b" }, { provider: "claude" }, { provider: "antigravity" }, { profileId: "account-b" }]) {
  test(`backend switch transfers both sides and referenced note context: ${JSON.stringify(change)}`, () => {
    const result = prepareConversationContext(conversation, { ...request, ...change });
    assert.equal(result.sessionId, null);
    assert.match(result.prompt, /蓝鲸/);
    assert.match(result.prompt, /引用笔记：下周发布/);
    assert.match(result.prompt, /已记住蓝鲸和下周发布/);
    assert.ok(result.prompt.endsWith(request.prompt));
  });
}

test("switching back transfers intervening turns instead of resuming an old provider session", () => {
  const switched = { ...conversation, sessionBinding: { sessionId: "claude-b", sessionProvider: "claude", profileId: "claude", model: "sonnet" }, messages: [...conversation.messages, { role: "user", text: "改为后天发布" }] };
  const result = prepareConversationContext(switched, request);
  assert.equal(result.sessionId, null);
  assert.match(result.prompt, /改为后天发布/);
});

test("event projection retains native binding and prompt context; stale browser PUT cannot replace either", () => {
  const dir = mkdtempSync(join(tmpdir(), "ink-context-"));
  try {
    eventLog.configure({ dataDir: dir });
    eventLog.ensureConversation("conv-test");
    eventLog.updateMeta("conv-test", { sessionBinding: conversation.sessionBinding });
    eventLog.appendEvent("conv-test", "user", { id: "user-1", text: "记住暗号", contextText: "暗号是蓝鲸" });
    const server = readFileSync(new URL("server.js", import.meta.url), "utf8");
    const ctx = vm.createContext({ eventLog, normalizeHistoryId: id => id });
    vm.runInContext(server.slice(server.indexOf("function historyMessagesScore("), server.indexOf("// 投影相关的 normalizeAssistantHistoryBlocks")), ctx);
    vm.runInContext('upsertHistoryConversation({id:"conv-test",sessionId:"wrong",model:"wrong",messages:[{id:"user-1",role:"user",text:"corrupted"}]})', ctx);
    const projected = eventLog.project("conv-test");
    assert.deepEqual(projected.sessionBinding, conversation.sessionBinding);
    assert.equal(projected.messages[0].text, "记住暗号");
    assert.equal(projected.messages[0].contextText, "暗号是蓝鲸");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

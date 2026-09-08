import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
const source = name => html.match(new RegExp(`(?:async )?function ${name}\\([^]*?^}`, "m"))[0];
function fixture() {
  const c = vm.createContext({
    currentConvId: "a", currentSessionId: "old", currentSessionProvider: "claude",
    resetLandingConvId: null, resetRequested: false, pendingRequestDraft: null,
    activeRequestId: null, requestRetryTimer: null, errorCompletionTimer: null,
    assistantTxt: "", assistantBlocks: [], assistantRawMessages: [], assistantEvents: [],
    messagesEl: { innerHTML: "User and assistant", scrollTop: 123 },
    messageLog: [{ role: "user", text: "hello" }],
    steeringQueue: [], steeringRemovalPending: new Set(), steeringEditingId: null,
    calls: [], lastWsEventAt: 0, clearTimeout() {}, clearAskUserQuestion() {},
    resetAssistantState() { c.assistantTxt = ""; c.assistantBlocks = []; },
    setGenerating() {}, removeTyping() {}, renderSteeringTray() {},
    cacheCurrentConversationView() { c.calls.push("cache"); },
    saveCurrentConversation() { c.calls.push("save"); },
    handleSteeringEvent() { return false; }, noteBackgroundEvent() {},
    wsSend(msg) { c.calls.push(msg); }, genId() { return "fragment"; },
    cloneJson: value => JSON.parse(JSON.stringify(value)),
  });
  vm.runInContext(["markResetLanding", "resetProviderSession", "handleEvent"].map(source).join("\n"), c);
  return c;
}

test("厂商重置保留消息、滚动位置和对话身份，并清除旧 session", () => {
  const c = fixture();
  c.resetProviderSession();
  assert.equal(c.calls[0].preserveMessages, true);
  assert.equal(c.calls[0].conversationId, "a");
  c.handleEvent({ type: "reset_complete", preserveMessages: true, conversationId: "a" });
  assert.equal(c.messagesEl.innerHTML, "User and assistant");
  assert.equal(c.messagesEl.scrollTop, 123);
  assert.equal(c.messageLog.length, 1);
  assert.equal(c.currentConvId, "a");
  assert.equal(c.currentSessionId, null);
  assert.equal(c.currentSessionProvider, null);
  assert.ok(c.calls.includes("cache") && c.calls.includes("save"));
});

test("切换厂商保留未完成的回答片段", () => {
  const c = fixture();
  c.assistantTxt = "partial answer";
  c.assistantBlocks = [{ type: "text", text: "partial answer" }];
  c.handleEvent({ type: "reset_complete", preserveMessages: true, conversationId: "a" });
  assert.equal(c.messageLog[1].text, "partial answer");
  assert.equal(c.messageLog[1].status, "stopped");
});

test("普通清空仍清除消息", () => {
  const c = fixture();
  c.handleEvent({ type: "reset_complete" });
  assert.equal(c.messagesEl.innerHTML, "");
  assert.equal(c.messageLog.length, 0);
});

test("厂商重置的延迟响应不能清空后来打开的对话", () => {
  const c = fixture();
  c.resetProviderSession();
  c.currentConvId = "b";
  c.handleEvent({ type: "reset_complete", preserveMessages: true, conversationId: "a" });
  assert.equal(c.messagesEl.innerHTML, "User and assistant");
  assert.equal(c.messageLog.length, 1);
  assert.equal(c.calls.length, 1);
});

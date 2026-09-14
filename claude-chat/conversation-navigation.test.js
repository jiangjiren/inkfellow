import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const html = readFileSync(new URL("public/index.html", import.meta.url), "utf8");
const source = html.slice(html.indexOf("async function loadConversation("), html.indexOf("async function openHistoryPanel("));
function harness() {
  const pending = new Map();
  const rendered = [], alerts = [], sent = [];
  const noop = () => {};
  const ctx = vm.createContext({
    rememberConvModelPrefs: noop, saveCurrentConversation: async () => {}, clearAskUserQuestion: noop,
    clearMentionFiles: noop, resetAssistantState: noop, setGenerating: noop, renderQueuedFollowUps: noop,
    resetCursor: noop, applyConvModelPrefs: noop, alignProfileToSessionProvider: noop,
    sendHello: noop, closeHistoryPanel: noop, scrollBottom: noop,
    renderConversationMessages: conv => rendered.push(conv.id), alert: text => alerts.push(text),
    fetch: url => new Promise(resolve => pending.set(url, resolve)),
    ws: { readyState: 1, send: payload => sent.push(payload) }, WebSocket: { OPEN: 1 },
    messagesEl: { innerHTML: "" }, beginConversationDraft() { vm.runInContext('conversationLoadVersion++;currentConvId="draft"', ctx); },
  });
  vm.runInContext(`let conversationLoadVersion=0,currentConvId="original",currentRunId=null,activeRequestId=null,currentConversationMeta=null,editingQueuedId=null,currentSessionId=null,currentSessionModel=null,currentSessionProvider=null,messageLog=[];const _profileData={profiles:[]};${source}`, ctx);
  return { pending, rendered, alerts, sent, run: code => vm.runInContext(code, ctx) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test("slow history response cannot overwrite a newer selection", async () => {
  const h = harness();
  const a = h.run('loadConversation({id:"aaaa"})'); await tick();
  const b = h.run('loadConversation({id:"bbbb"})'); await tick();
  h.pending.get("api/history/bbbb")({ ok: true, json: async () => ({ id: "bbbb", messages: [] }) }); await b;
  h.pending.get("api/history/aaaa")({ ok: true, json: async () => ({ id: "aaaa", messages: [] }) }); await a;
  assert.deepEqual(h.rendered, ["bbbb"]);
  assert.deepEqual(h.sent, []);
});
test("failed history fetch keeps the existing conversation", async () => {
  const h = harness(); const p = h.run('loadConversation({id:"aaaa"})'); await tick();
  h.pending.get("api/history/aaaa")({ ok: false }); await p;
  assert.deepEqual(h.rendered, []); assert.equal(h.alerts.length, 1);
  assert.equal(h.run("currentConvId"), "original");
});
test("new conversation invalidates a pending history response", async () => {
  const h = harness(); const p = h.run('loadConversation({id:"aaaa"})'); await tick();
  await h.run("startNewConversation()");
  h.pending.get("api/history/aaaa")({ ok: true, json: async () => ({ id: "aaaa", messages: [] }) }); await p;
  assert.deepEqual(h.rendered, []); assert.equal(h.run("currentConvId"), "draft");
});

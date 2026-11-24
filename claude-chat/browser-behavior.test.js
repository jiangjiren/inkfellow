import test from "node:test";
import vm from "node:vm";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
const html = readFileSync(new URL("public/index.html", import.meta.url), "utf8");

function browser() {
  const dom = new JSDOM(html, { url: "http://localhost/chat/", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  const evaluate = code => vm.runInContext(code, dom.getInternalVMContext());
  const sent = [];
  w.HTMLElement.prototype.scrollTo = function() {};
  w.HTMLElement.prototype.scrollIntoView = function() {};
  w.HTMLDialogElement.prototype.showModal = function() { this.open = true; };
  w.HTMLDialogElement.prototype.close = function() { this.open = false; };
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.CSS = { escape: String };
  w.fetch = async url => ({ ok: true, json: async () => url === "api/fellow/tickets" ? { tickets: [] } : ({
    activeProfileId: "p_claude", profiles: [{ id: "p_claude", provider: "claude", name: "Claude" }],
  }) });
  w.WebSocket = class {
    static OPEN = 1; static CONNECTING = 0; static CLOSED = 3; static CLOSING = 2;
    constructor() { this.readyState = 1; }
    send(payload) { sent.push(JSON.parse(payload)); }
    close() { this.readyState = 3; }
  };
  for (const name of ["marked.min.js", "pending-queue.js", "account-status.js"]) evaluate(readFileSync(new URL(`public/${name}`, import.meta.url), "utf8"));
  evaluate(readFileSync(new URL("node_modules/dompurify/dist/purify.min.js", import.meta.url), "utf8"));
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) if (match[1].trim()) evaluate(match[1]);
  evaluate(readFileSync(new URL("public/fellow.js", import.meta.url), "utf8"));
  evaluate(readFileSync(new URL("public/chat-workspace.js", import.meta.url), "utf8"));
  return { dom, w, sent, run: code => evaluate(code), close: async () => { await new Promise(resolve => setImmediate(resolve)); w.close(); } };
}

test("ordinary tabs switch without stopping work and completion notices reopen the owning conversation", async () => {
  const h = browser();
  try {
    const doc = h.w.document;
    const tick = () => new Promise(resolve => setImmediate(resolve));
    await tick();
    h.w.fetch = async url => ({ ok: true, json: async () => url.startsWith("api/history/")
      ? { id: url.split("/").at(-1), title: "对话甲", messages: [] } : { tickets: [] } });
    h.run('ws = new WebSocket(); currentConvId = "chat_a"; trackChatTab(currentConvId, "对话甲", true); promptEl.value = "甲的草稿"');
    h.run('handleEvent({type:"chat_activity",conversationId:"chat_a",title:"对话甲",status:"running"})');
    await h.run("startNewConversation()");
    assert.notEqual(h.run("currentConvId"), "chat_a");
    assert.ok(!h.sent.some(frame => frame.reset || frame.stop));
    assert.equal(doc.querySelector('[role="tab"][data-chat-tab-id="chat_a"]').dataset.running, "true");
    h.run('handleEvent({type:"chat_activity",conversationId:"chat_a",title:"对话甲",status:"complete",requestId:"first"})');
    doc.getElementById("chat-notices-open").click();
    doc.querySelector("#chat-notice-list button").click();
    await tick();
    assert.equal(h.run("currentConvId"), "chat_a");
    assert.equal(h.run("promptEl.value"), "甲的草稿");
    assert.equal(doc.getElementById("chat-unread").hidden, true);
  } finally { await h.close(); }
});

test("Fellow board opens an isolated worker and preserves unrelated row focus on live updates", async () => {
  const h = browser();
  try {
    const doc = h.w.document;
    const tick = () => new Promise(resolve => setImmediate(resolve));
    await tick();
    const a = { id: "tk_a", title: "稿件甲", workerConversationId: "wrk_tk_a", status: "running", revision: 1, updatedAt: "2026-01-01" };
    const b = { id: "tk_b", title: "稿件乙", workerConversationId: "wrk_tk_b", status: "queued", revision: 1, updatedAt: "2026-01-01" };
    const requests = [];
    h.w.fetch = async (url, init) => {
      requests.push({ url, init });
      return { ok: true, json: async () => url === "api/fellow/tickets" ? { tickets: [a, b] } :
        url === "api/history/strategist" ? { id: "strategist", messages: [] } :
        url === "api/history/wrk_tk_b" ? { id: "wrk_tk_b", title: b.title, messages: [] } : { ok: true, delivery: "queued" } };
    };
    doc.getElementById("fellow-open").click();
    await tick();
    assert.equal(h.run("currentConvId"), "strategist");
    doc.getElementById("fellow-board-open").click();
    await tick();
    const board = doc.getElementById("fellow-board");
    assert.ok(board.open);
    const enter = doc.querySelector('[data-ticket-id="tk_b"] [data-fellow-action="open"]');
    enter.focus();
    h.run(`handleEvent({type:"ticket_updated",ticket:${JSON.stringify({ ...a, revision: 2, lastStepLabel: "当前步骤" })}})`);
    assert.equal(doc.activeElement, enter);
    enter.click();
    await tick();
    assert.equal(h.run("currentConvId"), "wrk_tk_b");
    assert.equal(board.open, false);
    h.run('promptEl.value = "补充要求"; send()');
    await tick();
    assert.ok(requests.some(({ url, init }) => url === "api/fellow/tickets/tk_b/message"
      && JSON.parse(init.body).instruction === "补充要求"));
    doc.getElementById("fellow-back").click();
    assert.ok(board.open);
  } finally { await h.close(); }
});

test("full chat page starts and sanitizes model HTML while retaining Markdown", async () => {
  const h = browser();
  try {
    const output = h.run('renderMarkdown("**safe** <img src=x onerror=alert(1)><script>alert(1)</script><a href=javascript:alert(1)>bad</a><style>body{display:none}</style>")');
    const el = h.w.document.createElement("div"); el.innerHTML = output;
    assert.equal(el.querySelector("strong").textContent, "safe");
    assert.equal(el.querySelector("script,style,[onerror],[href^='javascript:']"), null);
  } finally { await h.close(); }
});

test("thinking depth menu uses desktop levels and sends the selected effort", async () => {
  const h = browser();
  try {
    const ultra = h.w.document.querySelector('.effort-option[data-effort="ultra"]');
    assert.equal(ultra.hidden, true);
    for (const [effort, label] of [["low", "低"], ["medium", "中"], ["high", "高"], ["xhigh", "超高"], ["max", "最高"]]) {
      const option = h.w.document.querySelector(`.effort-option[data-effort="${effort}"]`);
      option.dispatchEvent(new h.w.MouseEvent("mousedown", { bubbles: true }));
      assert.equal(h.run("selectedEffort"), effort);
      assert.equal(h.w.document.getElementById("effort-label-inline").textContent, label);
      assert.equal(option.getAttribute("aria-selected"), "true");
    }
    h.run('ws = new WebSocket(); promptEl.value = "测试思考深度"; send()');
    assert.equal(h.sent.at(-1).effort, "max");
  } finally { await h.close(); }
});

test("Ultra is offered only on supported Codex models and falls back when switching to Luna", async () => {
  const h = browser();
  try {
    h.run('_profileData={activeProfileId:"p_codex",profiles:[{id:"p_codex",provider:"codex",sonnetModel:"gpt-6.1-sol"}]};renderModelOptions(getActiveProfile())');
    const ultra = h.w.document.querySelector('.effort-option[data-effort="ultra"]');
    assert.equal(ultra.hidden, false);
    ultra.dispatchEvent(new h.w.MouseEvent("mousedown", { bubbles: true }));
    assert.equal(h.w.document.getElementById("effort-label-inline").textContent, "Ultra");
    h.run('ws = new WebSocket(); promptEl.value = "测试 Ultra"; send()');
    assert.equal(h.sent.at(-1).effort, "ultra");
    h.run('selectedModel="gpt-6-luna";updateEffortDisplay()');
    assert.equal(ultra.hidden, true);
    assert.equal(h.w.document.getElementById("effort-label-inline").textContent, "最高");
    assert.equal(h.run("effectiveEffort()"), "max");
  } finally { await h.close(); }
});

test("Codex refresh uses the account catalog and preserves selections that remain available", async () => {
  const h = browser();
  try {
    await new Promise(resolve => setImmediate(resolve));
    h.run('_profileData={activeProfileId:"p_codex",profiles:[{id:"p_codex",provider:"codex",sonnetModel:"gpt-6.1-sol"}]};selectConversationProfile("p_codex")');
    const existing = { model: "gpt-6-sol", label: "GPT-6 Sol", efforts: ["medium", "ultra"], defaultEffort: "medium" };
    const added = { model: "gpt-6.2-sol", label: "GPT-6.2 Sol", efforts: ["low"], defaultEffort: "low" };
    let catalog = { defaultModel: added.model, models: [added, existing] };
    h.w.fetch = async url => {
      assert.equal(url, "api/codex/models");
      return { ok: true, json: async () => catalog };
    };
    await h.run("refreshCodexModels()");
    const button = model => h.w.document.querySelector(`.model-option[data-model="${model}"]`);
    const ultra = h.w.document.querySelector('.effort-option[data-effort="ultra"]');
    assert.equal(button(added.model).getAttribute("aria-selected"), "true");
    assert.equal(h.run("effectiveEffort()"), "low");
    assert.equal(ultra.hidden, true);

    button(existing.model).dispatchEvent(new h.w.MouseEvent("mousedown", { bubbles: true }));
    assert.equal(ultra.hidden, false);
    catalog = { ...catalog, models: [...catalog.models, { ...added, model: "next-model" }] };
    await h.run("refreshCodexModels()");
    assert.ok(button("next-model"));
    assert.equal(button(existing.model).getAttribute("aria-selected"), "true");

    catalog = { defaultModel: added.model, models: [added] };
    await h.run("refreshCodexModels()");
    assert.equal(button(existing.model), null);
    assert.equal(button(added.model).getAttribute("aria-selected"), "true");
  } finally { await h.close(); }
});

test("stopping a stream preserves visible text in messageLog", async () => {
  const h = browser();
  try {
    h.run('currentConvId="stream-conv";currentRunId="run-1";setGenerating(true)');
    for (const event of [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "保留半截回复" } },
    ]) h.run(`handleEvent(${JSON.stringify({ type: "stream_event", event, runId: "run-1", conversationId: "stream-conv" })})`);
    h.run('handleEvent({type:"stopped",turnId:"turn-1",runId:"run-1",conversationId:"stream-conv"})');
    assert.equal(h.run('messageLog[0].text'), "保留半截回复");
    assert.equal(h.run('messageLog[0].status'), "stopped");
    assert.equal(h.run('isGenerating'), false);
  } finally { await h.close(); }
});

test("Hydrogen exposes xhigh and sends it without downgrading to high", async () => {
  const h = browser();
  try {
    h.run('_profileData={activeProfileId:"p_antigravity",profiles:[{id:"p_antigravity",provider:"antigravity"}]};_agyStatus={ready:true,efforts:{"gemini-4-hydrogen":["low","medium","high","xhigh"],"gemini-4-argon":["low","medium","high"]}};renderModelOptions(getActiveProfile())');
    const xhigh = h.w.document.querySelector('.effort-option[data-effort="xhigh"]');
    assert.equal(xhigh.hidden, false);
    xhigh.dispatchEvent(new h.w.MouseEvent("mousedown", { bubbles: true }));
    assert.equal(h.run("effectiveEffort()"), "xhigh");
    assert.equal(h.w.document.getElementById("effort-label-inline").textContent, "超高");
    h.run('ws = new WebSocket(); promptEl.value = "测试 Hydrogen"; send()');
    assert.equal(h.sent.at(-1).model, "gemini-4-hydrogen");
    assert.equal(h.sent.at(-1).effort, "xhigh");
    h.run('selectedModel="gemini-4-argon";updateEffortDisplay()');
    assert.equal(xhigh.hidden, true);
    assert.equal(h.run("effectiveEffort()"), "high");
  } finally { await h.close(); }
});

test("stale hello responses cannot rebuild a newer screen", async () => {
  const h = browser();
  try {
    h.run('currentConvId="sync-conv";sendHello();sendHello()');
    const requests = h.sent.filter(m => m.type === "hello");
    h.run(`handleSyncEvent(${JSON.stringify({ type: "sync", conversationId: "sync-conv", helloId: requests[0].helloId, reset: true, snapshot: { id: "sync-conv", messages: [{ role: "user", text: "stale" }] } })})`);
    assert.equal(h.run('messageLog.length'), 0);
    assert.equal(h.run('isSyncPending'), true);
  } finally { await h.close(); }
});

test("rejected immediate sends are retained in the pending queue", async () => {
  const h = browser();
  try {
    h.run('currentConvId="queue-conv";activeRequestId="req-1";currentRunId="run-1";trackUnackedRequest({userMessageId:"req-1",conversationId:"queue-conv",prompt:"keep me",displayText:"keep me"})');
    h.run('handleEvent({type:"request_ack",userMessageId:"req-1",state:"queued",conversationId:"queue-conv"})');
    assert.equal(h.run('queuedFollowUps.get("req-1").prompt'), "keep me");
  } finally { await h.close(); }
});

test("a full snapshot restores the active streaming block for subsequent deltas", async () => {
  const h = browser();
  try {
    h.run('currentConvId="snapshot-conv";applySyncSnapshot({id:"snapshot-conv",messages:[{id:"turn-1",role:"assistant",status:"running",text:"前半",blocks:[{type:"text",text:"前半"}],streamState:[{index:0,blockIndex:0}]}]},"snapshot-conv")');
    h.run('handleEvent({type:"stream_event",event:{type:"content_block_delta",index:0,delta:{type:"text_delta",text:"后半"}}})');
    assert.equal(h.run('assistantTxt'), "前半后半");
    h.run('handleEvent({type:"stopped",turnId:"turn-1"})');
    assert.equal(h.run('messageLog.length'), 1);
    assert.equal(h.run('messageLog[0].text'), "前半后半");
  } finally { await h.close(); }
});

test("immediate follow-up separates the previous answer from the next user message", async () => {
  const h = browser();
  try {
    h.run('currentConvId="steer-conv";messageLog=[{id:"u-first",role:"user",text:"first"}];handleEvent({type:"assistant",turnId:"t-first",message:{content:[{type:"text",text:"previous answer"}]}});showQueuedUserMessage({userMessageId:"u-next",displayText:"next"})');
    h.run('handleEvent({type:"request_ack",state:"steering",userMessageId:"u-next",turnId:"t-next"})');
    h.run('handleEvent({type:"assistant",turnId:"t-next",message:{content:[{type:"text",text:"next answer"}]}});handleEvent({type:"result",subtype:"success",turnId:"t-next"})');
    assert.deepEqual(JSON.parse(h.run('JSON.stringify(messageLog.map(m=>[m.role,m.text]))')), [["user","first"],["assistant","previous answer"],["user","next"],["assistant","next answer"]]);
  } finally { await h.close(); }
});

test("a queued acknowledgement received after switching conversations preserves the message", async () => {
  const h = browser();
  try {
    h.run('currentConvId="new-view";trackUnackedRequest({userMessageId:"offscreen-request",conversationId:"old-view",prompt:"retained",displayText:"retained"})');
    h.run('handleEvent({type:"request_ack",userMessageId:"offscreen-request",conversationId:"old-view",state:"queued"})');
    assert.equal(h.run('queuedFollowUps.get("offscreen-request").prompt'), "retained");
    assert.equal(h.run('unackedRequests.has("offscreen-request")'), false);
  } finally { await h.close(); }
});

test("a late reset acknowledgement does not erase a newly sent request", async () => {
  const h = browser();
  try {
    h.run('currentConvId="fresh";activeRequestId="fresh-request";trackUnackedRequest({userMessageId:"fresh-request",conversationId:"fresh",prompt:"hello"});handleEvent({type:"reset_complete"})');
    assert.equal(h.run('unackedRequests.has("fresh-request")'), true);
  } finally { await h.close(); }
});

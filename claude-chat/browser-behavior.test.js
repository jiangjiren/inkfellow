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
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.CSS = { escape: String };
  w.fetch = async () => ({ ok: true, json: async () => ({ activeProfileId: "p_claude", profiles: [{ id: "p_claude", provider: "claude", name: "Claude" }] }) });
  w.WebSocket = class {
    static OPEN = 1; static CONNECTING = 0; static CLOSED = 3; static CLOSING = 2;
    constructor() { this.readyState = 1; }
    send(payload) { sent.push(JSON.parse(payload)); }
    close() { this.readyState = 3; }
  };
  for (const name of ["marked.min.js", "pending-queue.js", "account-status.js"]) evaluate(readFileSync(new URL(`public/${name}`, import.meta.url), "utf8"));
  evaluate(readFileSync(new URL("node_modules/dompurify/dist/purify.min.js", import.meta.url), "utf8"));
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) if (match[1].trim()) evaluate(match[1]);
  return { dom, w, sent, run: code => evaluate(code), close: async () => { await new Promise(resolve => setImmediate(resolve)); w.close(); } };
}

test("full chat page starts and sanitizes model HTML while retaining Markdown", async () => {
  const h = browser();
  try {
    const output = h.run('renderMarkdown("**safe** <img src=x onerror=alert(1)><script>alert(1)</script><a href=javascript:alert(1)>bad</a><style>body{display:none}</style>")');
    const el = h.w.document.createElement("div"); el.innerHTML = output;
    assert.equal(el.querySelector("strong").textContent, "safe");
    assert.equal(el.querySelector("script,style,[onerror],[href^='javascript:']"), null);
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

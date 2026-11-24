import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const trackerSource = await readFile(new URL("./public/turn-completion.js", import.meta.url), "utf8");

function tracker() {
  const context = vm.createContext({});
  vm.runInContext(trackerSource, context);
  const completions = [];
  const instance = new context.InkfellowTurnCompletionTracker(info => completions.push({ ...info }));
  return {
    completions, instance,
    send(type, fields = {}) { instance.ingest({ type, conversationId: "a", userMessageId: "r1", ...fields }); },
  };
}

test("one normal turn emits one completion after done, despite duplicate results and acknowledgements", () => {
  const c = tracker();
  c.send("request_started");
  c.send("request_ack", { state: "running" });
  c.send("result", { subtype: "success" });
  c.send("result", { subtype: "success" });
  assert.equal(c.completions.length, 0);
  c.send("done");
  c.send("done");
  c.send("request_started");
  c.send("done");
  assert.deepEqual(c.completions, [{ conversationId: "a", userMessageId: "r1" }]);
  c.send("request_started", { userMessageId: "r2" });
  c.send("done", { userMessageId: "r2" });
  assert.equal(c.completions.length, 2);
});

test("subtask completion and intermediate idle never produce a turn completion", () => {
  const c = tracker();
  c.send("request_started");
  c.send("task_notification", { status: "completed" });
  c.send("system", { subtype: "task_notification", task_id: "task-1", status: "completed" });
  c.send("system", { subtype: "session_state_changed", state: "idle" });
  assert.equal(c.completions.length, 0);
});

test("errors, stopped turns, local stopping and failed results suppress a later done", () => {
  for (const failure of [
    { type: "error" }, { type: "stopped" }, { type: "stopping" },
    { type: "result", is_error: true }, { type: "result", subtype: "error_max_turns" },
    { type: "result", status: "failed" },
  ]) {
    const c = tracker();
    c.send("request_started");
    c.send(failure.type, failure);
    c.send("done");
    assert.equal(c.completions.length, 0, JSON.stringify(failure));
  }
});

test("output retained with an unconfirmed Gemini turn never sends a completion alert", () => {
  for (const events of [
    [{ type: "result", status: "partial" }, { type: "done" }],
    [{ type: "done", status: "partial" }],
    [{ type: "request_ack", state: "partial" }, { type: "done" }],
  ]) {
    const c = tracker();
    c.send("request_started");
    for (const event of events) c.send(event.type, event);
    c.send("done");
    assert.equal(c.completions.length, 0, JSON.stringify(events));
    c.send("request_started", { userMessageId: "r2" });
    c.send("done", { userMessageId: "r2" });
    assert.deepEqual(c.completions, [{ conversationId: "a", userMessageId: "r2" }]);
  }
});

test("simultaneous conversations retain completion ownership even with equal request ids", () => {
  const c = tracker();
  c.send("request_started");
  c.send("request_started", { conversationId: "b" });
  c.send("done", { conversationId: "b" });
  c.send("done");
  assert.deepEqual(c.completions, [
    { conversationId: "b", userMessageId: "r1" },
    { conversationId: "a", userMessageId: "r1" },
  ]);
});

test("history replay and idle reconnect do not notify, but a reattached running turn can finish", () => {
  const c = tracker();
  c.send("result");
  c.send("done");
  c.send("request_ack", { state: "complete" });
  c.send("done");
  c.send("run_attached", { running: false });
  c.send("done");
  assert.equal(c.completions.length, 0);
  c.send("run_attached", { running: true });
  c.send("result");
  c.send("done");
  assert.equal(c.completions.length, 1);
});

test("queued turns can complete and malformed identities cannot notify", () => {
  const c = tracker();
  for (const fields of [{ conversationId: null }, { userMessageId: "" }, { userMessageId: 7 }]) {
    c.send("request_started", fields);
    c.send("done", fields);
  }
  assert.equal(c.completions.length, 0);
  c.send("request_ack", { state: "queued" });
  c.send("done");
  assert.equal(c.completions.length, 1);
});

test("resetting one conversation suppresses its old completions and leaves other conversations alone", () => {
  const c = tracker();
  c.send("request_started");
  c.send("request_started", { conversationId: "b" });
  c.instance.cancelConversation("a");
  c.send("done");
  c.send("done", { conversationId: "b" });
  assert.deepEqual(c.completions, [{ conversationId: "b", userMessageId: "r1" }]);
  c.send("request_started", { userMessageId: "r2" });
  c.send("reset_complete", { userMessageId: undefined });
  c.send("done", { userMessageId: "r2" });
  assert.equal(c.completions.length, 1);
});

test("聊天页收到切换请求：关掉历史面板再切，只认字符串 id", async () => {
  const page = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
  const handler = page.match(/if \(e\.data\?\.type === "open-conversation"[^]*?\n  \}/)?.[0];
  assert.ok(handler, "iframe 要处理 open-conversation");
  const calls = [];
  const c = vm.createContext({
    closeHistoryPanel: () => calls.push("close"),
    switchToConversation: (id) => { calls.push(id); return Promise.resolve(); },
  });
  const run = (data) => vm.runInContext(`((e) => { ${handler} })`, c)({ data });
  run({ type: "open-conversation", conversationId: "conv-a" });
  assert.deepEqual(calls, ["close", "conv-a"]);
  run({ type: "open-conversation", conversationId: 7 });
  run({ type: "other", conversationId: "conv-b" });
  assert.equal(calls.length, 2);
});

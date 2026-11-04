import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const trackerSource = await readFile(new URL("./public/turn-completion.js", import.meta.url), "utf8");
const alertsSource = await readFile(new URL("../desktop-lite/completion-alerts.js", import.meta.url), "utf8");
const appSource = await readFile(new URL("../desktop-lite/app.js", import.meta.url), "utf8");
const functionSource = name => appSource.match(new RegExp(`function ${name}\\([^]*?^}`, "m"))[0];

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

function desktopFixture(initial = null) {
  const c = vm.createContext({});
  vm.runInContext(alertsSource, c);
  const storage = new Map(initial ? [["inkfellow-completion-alerts-v1", initial]] : []);
  const notifications = [], fallbacks = [];
  const create = (notify = async info => { notifications.push({ ...info }); }) => new c.InkfellowCompletionAlerts({
    storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    notify, fallback: message => fallbacks.push(message),
  });
  return { c, storage, notifications, fallbacks, create };
}
const completion = (fields = {}) => ({ conversationId: "a", userMessageId: "r1", title: "Research", ...fields });

test("desktop notification preference defaults on and stays off after a restart", async () => {
  const c = desktopFixture();
  const alerts = c.create();
  assert.equal(alerts.enabled, true);
  alerts.setEnabled(false);
  await alerts.complete(completion());
  assert.equal(c.notifications.length, 0);
  assert.equal(c.create().enabled, false);
  alerts.setEnabled(true);
  await alerts.complete(completion());
  assert.equal(c.notifications.length, 0, "re-enabling must not replay already completed work");
  await alerts.complete(completion({ userMessageId: "r2" }));
  assert.equal(c.notifications.length, 1);
  assert.equal(c.create().enabled, true);
});

test("concurrent duplicate bridge deliveries invoke native notification only once", async () => {
  const c = desktopFixture();
  let finish;
  const alerts = c.create(info => {
    c.notifications.push({ ...info });
    return new Promise(resolve => { finish = resolve; });
  });
  const first = alerts.complete(completion());
  assert.equal(await alerts.complete(completion()), false);
  assert.equal(c.notifications.length, 1);
  finish();
  await first;
});

test("native notification failure stays silent without an unexpected foreground toast", async () => {
  const c = desktopFixture();
  const alerts = c.create(async () => { throw new Error("native internals"); });
  assert.equal(await alerts.complete(completion()), false);
  await alerts.complete(completion());
  assert.equal(c.fallbacks.length, 0);
});

test("foreground completions stay suppressed when the app later moves to the background", async () => {
  const c = desktopFixture();
  let background = false;
  const alerts = c.create(async info => {
    if (!background) return false; // Native window policy rejects a foreground alert.
    c.notifications.push({ ...info });
    return true;
  });
  assert.equal(await alerts.complete(completion()), false);
  assert.equal(c.notifications.length, 0);
  background = true;
  assert.equal(await alerts.complete(completion()), false, "do not replay a foreground completion after switching away");
  assert.equal(await alerts.complete(completion({ userMessageId: "r2" })), true);
  assert.equal(c.notifications.length, 1);
});

test("disabled notifications and malformed payloads do not invoke the native bridge", async () => {
  const c = desktopFixture("0");
  const alerts = c.create();
  for (const info of [null, {}, completion({ userMessageId: null }), completion()]) await alerts.complete(info);
  assert.equal(c.notifications.length, 0);
  assert.equal(c.fallbacks.length, 0);
});

test("storage denial does not break completion and native payload titles are bounded", async () => {
  const c = desktopFixture();
  const alerts = new c.c.InkfellowCompletionAlerts({
    storage: { getItem() { throw new Error(); }, setItem() { throw new Error(); } },
    notify: async info => c.notifications.push({ ...info }), fallback() {},
  });
  alerts.setEnabled(true);
  await alerts.complete(completion({ title: "x".repeat(1000) }));
  assert.equal(c.notifications[0].title.length, 60);
});

test("the existing authenticated iframe bridge rejects forged completion and preference messages", async () => {
  const f = desktopFixture();
  const c = f.c;
  const frameWindow = {};
  const states = [];
  Object.assign(c, {
    state: { agentToken: "session-token" }, qs: () => ({ contentWindow: frameWindow }),
    agentOrigin: () => "http://127.0.0.1:9999", completionAlerts: f.create(),
    postAgentMessage: message => states.push(message),
  });
  vm.runInContext(functionSource("syncCompletionNotificationPreference") + "\n" + functionSource("handleAgentCompletionMessage"), c);
  const start = appSource.indexOf('window.addEventListener("message", (event) => {');
  const body = appSource.slice(start + 'window.addEventListener("message", (event) => {'.length, appSource.indexOf("\n  });", start));
  vm.runInContext(`globalThis.handleBridge = (event) => {${body}\n}`, c);
  const valid = { source: frameWindow, origin: "http://127.0.0.1:9999", data: { type: "ai-turn-completed", __token: "session-token", ...completion() } };
  for (const overrides of [{ source: {} }, { origin: "https://example.com" }, { data: { ...valid.data, __token: "wrong" } }]) {
    c.handleBridge({ ...valid, ...overrides });
  }
  assert.equal(f.notifications.length, 0);
  c.handleBridge(valid);
  await Promise.resolve();
  assert.equal(f.notifications.length, 1);
  c.handleBridge({ ...valid, data: { type: "completion-notifications-preference", __token: "wrong", enabled: false } });
  assert.equal(c.completionAlerts.enabled, true);
  c.handleBridge({ ...valid, data: { type: "completion-notifications-preference", __token: "session-token", enabled: false } });
  assert.equal(c.completionAlerts.enabled, false);
  assert.equal(states.at(-1).enabled, false);
});
const plainMessages = (value) => JSON.parse(JSON.stringify(value));

test("点完成通知回到那条对话：展开 Fellow 并切过去，坏数据不动", () => {
  const posted = [];
  let opened = 0;
  const c = vm.createContext({
    postAgentMessage: (message) => posted.push(message),
    openFellowPanel: () => { opened += 1; },
  });
  vm.runInContext(functionSource("openConversationFromAlert"), c);
  assert.equal(vm.runInContext('openConversationFromAlert("conv-a")', c), true);
  assert.deepEqual(plainMessages(posted), [{ type: "open-conversation", conversationId: "conv-a" }]);
  assert.equal(opened, 1);
  for (const bad of ["null", "''", "7"]) {
    assert.equal(vm.runInContext(`openConversationFromAlert(${bad})`, c), false);
  }
  assert.equal(posted.length, 1);
  assert.equal(opened, 1);
  assert.match(appSource, /listen\("completion-alert-activated"/, "宿主要接住 Rust 发来的点击事件");
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

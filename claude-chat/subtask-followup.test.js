import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import crypto from "node:crypto";

const html = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
const server = await readFile(new URL("./server.js", import.meta.url), "utf8");
const fn = (src, name, async = false) => {
  const match = src.match(new RegExp(`^${async ? "async " : ""}function ${name}\\([^]*?^}`, "m"));
  assert.ok(match, name);
  return match[0];
};

test("subtask Escape yields to an open dialog before closing its view", () => {
  let listener, closed = 0, prevented = 0;
  const dialog = { open: true };
  const ctx = vm.createContext({
    document: { addEventListener: (_type, cb) => { listener = cb; }, querySelector: () => dialog.open ? {} : null },
    subtaskView: {}, subtaskViewEl: { contains: () => true, querySelector: () => ({ hidden: true }) },
    subtaskSplitActive: () => false, closeSubtaskView: () => { closed++; }, closeSubtaskModelMenu() {},
  });
  const source = html.match(/^document\.addEventListener\?\.\("keydown", \(e\) => \{[^]*?^\}, true\);/m)?.[0];
  assert.ok(source);
  vm.runInContext(source, ctx);
  const escape = { key: "Escape", isComposing: false, target: {}, preventDefault: () => prevented++, stopPropagation() {} };
  listener(escape);
  assert.equal(closed, 0);
  assert.equal(prevented, 0);
  dialog.open = false;
  listener(escape);
  assert.equal(closed, 1);
  assert.equal(prevented, 1);
});

test("subtask queue waits for original task, serializes replies and reconciles after reconnect", () => {
  const sent = [];
  const card = { order: [], state: new Map([["task1", { status: "running", kind: "dispatch", profileId: "p1", model: "m1" }]]), labels: new Map([["task1", "task"]]) };
  const ctx = vm.createContext({
    wsSend: message => (sent.push(message), true), selectedPermissionMode: "auto",
    subtaskCardRefs: new Map([["conv1|task1", card]]),
    subtaskThreads: new Map(), subtaskKey: (c, i) => `${c}|${i}`,
    subtaskItemSettled: s => s.status === "done", subtaskCanFollowUp: () => true,
    updateBackgroundActivity() {}, refreshSubtaskViewFor() {}, refreshSubtaskRowByKey() {},
    persistSubtaskPending() {},
    subagentToolLabel: name => name,
    subtaskProfile: () => ({ provider: "codex" }),
  });
  vm.runInContext([fn(html, "subtaskCurrentModel"), fn(html, "pumpSubtaskThread"), fn(html, "retryOfflineSubtaskFollowups"),
    'const SUBTASK_TERMINAL_EVENTS = { subtask_done: "done", subtask_error: "failed", subtask_stopped: "stopped" };',
    fn(html, "handleSubtaskEvent")].join("\n"), ctx);
  const thread = { key: "conv1|task1", conversationId: "conv1", itemId: "task1", items: [], queue: [], inflight: null };
  const first = { id: "req_1", role: "user", text: "first", status: "queued" };
  const second = { id: "req_2", role: "user", text: "second", status: "queued" };
  thread.items.push(first, second); thread.queue.push(first, second); ctx.subtaskThreads.set(thread.key, thread);
  ctx.pumpSubtaskThread(thread); assert.equal(sent.length, 0);
  card.state.get("task1").status = "done";
  ctx.pumpSubtaskThread(thread); assert.equal(sent.length, 1);
  thread.inflight.stopPending = true;
  ctx.retryOfflineSubtaskFollowups(); assert.equal(sent[1].type, "subtask_status");
  assert.equal(sent[2].type, "subtask_stop");
  ctx.handleSubtaskEvent({ type: "subtask_done", conversationId: "conv1", subtaskId: "task1", requestId: "req_1", output: "answer" });
  assert.equal(sent[3].requestId, "req_2");
  assert.equal(sent[3].thread[1].text, "answer");
  ctx.handleSubtaskEvent({ type: "subtask_done", conversationId: "conv1", subtaskId: "task1", requestId: "req_1", output: "duplicate" });
  assert.equal(thread.inflight.requestId, "req_2");
});

test("backend rejects concurrent same-task runs and releases ownership before terminal event", async () => {
  let finish;
  const events = [], messages = [], runs = new Map(), inflight = new Set(), statusRequests = [];
  const ctx = vm.createContext({
    historyIdOrNull: v => v || null, subtaskIdOrNull: v => v || null,
    deliver: e => events.push({ ...e, locked: inflight.size > 0 }), deletedHistoryConversationIds: new Set(),
    SUBTASK_FOLLOWUPS: runs, readProfiles: () => ({}), resolveDispatchProfile: () => ({ id: "p1", provider: "codex" }),
    unavailableProviderMessage: () => "unavailable", PERMISSION_MODES: new Set(["auto"]), DEFAULT_PERMISSION_MODE: "auto",
    subtaskSessionScope: (c, s) => `${c}|${s}`, recallSubtaskSession: () => "session1",
    markDispatchInflight: () => { inflight.add(1); return () => inflight.delete(1); },
    dispatchGenerationOf: () => 0, AbortController, historyRoute: o => o, dispatchModelForProfile: () => "m1",
    ensureHistoryConversation: () => ({ messages }), persistHistoryImmediate() {},
    readHistory: () => [{ id: "conv1", messages }], sendSubtaskStatus: (...args) => statusRequests.push(args),
    executeProviderDispatch: () => new Promise(resolve => { finish = resolve; }),
    subtaskFollowupPrompt: ({ text }) => text, resolveAllowedCwd: () => ".", compactToolInput: x => x,
    rememberSubtaskSession() {}, dropDispatchSession() {}, forgetPersistedSubtaskSession() {},
  });
  vm.runInContext(fn(server, "runSubtaskFollowup", true), ctx);
  const msg = { conversationId: "conv1", subtaskId: "task1", requestId: "req_1", prompt: "hello", profileId: "p1" };
  const run = ctx.runSubtaskFollowup(msg);
  await ctx.runSubtaskFollowup({ ...msg, requestId: "req_2" });
  assert.equal(events.at(-1).type, "subtask_error");
  finish({ output: "done", model: "m1", provider: "codex", resumed: true });
  await run;
  assert.equal(events.at(-1).type, "subtask_done");
  assert.equal(events.at(-1).locked, false);
  assert.equal(runs.size, 0);
  assert.equal(messages.at(-1).text, "done");
  await ctx.runSubtaskFollowup(msg);
  assert.equal(statusRequests.length, 1);
  assert.equal(messages.length, 2);
});

test("reconnect status distinguishes running, saved result and unknown delivery", () => {
  const events = [];
  const ctx = vm.createContext({
    SUBTASK_FOLLOWUPS: new Map([["req_1", { conversationId: "conv1", subtaskId: "task1", model: "m1", resumed: true, steps: [{ name: "Read", input: { file_path: "a.md" } }] }]]),
    readHistory: () => [{ id: "conv1", messages: [{ id: "req_2_reply", subtask: { id: "task1" }, status: "complete", text: "saved", via: { model: "m2" }, dispatchSteps: [{ name: "Edit", input: {} }] }] }],
    deliver: event => events.push(event),
  });
  vm.runInContext(fn(server, "sendSubtaskStatus"), ctx);
  ctx.sendSubtaskStatus("conv1", "task1", "req_1");
  ctx.sendSubtaskStatus("conv1", "task1", "req_2");
  ctx.sendSubtaskStatus("conv1", "other", "req_2");
  assert.equal(events[0].type, "subtask_started");
  assert.equal(events[0].steps[0].name, "Read");
  assert.equal(events[0].model, "m1");
  assert.equal(events[0].resumed, true);
  assert.equal(events[1].type, "subtask_done");
  assert.equal(events[1].output, "saved");
  assert.equal(events[1].model, "m2");
  assert.equal(events[1].steps[0].name, "Edit");
  assert.equal(events[2].type, "subtask_error");
  assert.match(events[2].text, /无法确认/);
});

test("only a confirmed missing native session opens a new context-backed session", async () => {
  const events = [], calls = [], messages = [];
  const ctx = vm.createContext({
    historyIdOrNull: v => v || null, subtaskIdOrNull: v => v || null,
    deliver: e => events.push(e), deletedHistoryConversationIds: new Set(), SUBTASK_FOLLOWUPS: new Map(),
    readProfiles: () => ({}), resolveDispatchProfile: () => ({ id: "p1", provider: "codex" }),
    PERMISSION_MODES: new Set(["auto"]), DEFAULT_PERMISSION_MODE: "auto", subtaskSessionScope: () => "scope",
    recallSubtaskSession: () => "missing-thread", markDispatchInflight: () => () => {}, dispatchGenerationOf: () => 0,
    AbortController, historyRoute: o => o, dispatchModelForProfile: () => "m1", readHistory: () => [],
    ensureHistoryConversation: () => ({ messages }), persistHistoryImmediate() {},
    executeProviderDispatch: async args => {
      calls.push(args);
      if (calls.length === 1) throw Object.assign(new Error("thread not found"), { dispatchSessionEstablished: false });
      return { output: "new answer", model: "m1", provider: "codex", resumed: false };
    },
    subtaskFollowupPrompt: args => JSON.stringify(args), resolveAllowedCwd: () => ".",
    dropDispatchSession() {}, forgetPersistedSubtaskSession() {}, rememberSubtaskSession() {}, compactToolInput: x => x,
  });
  vm.runInContext(fn(server, "isMissingSubtaskSession") + "\n" + fn(server, "runSubtaskFollowup", true), ctx);
  await ctx.runSubtaskFollowup({ conversationId: "conv1", subtaskId: "task1", requestId: "req_1", prompt: "continue", brief: "old task", output: "old answer", thread: [{ role: "user", text: "earlier" }] });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].resumeSessionId, "missing-thread");
  assert.equal(calls[1].resumeSessionId, null);
  const prompt = JSON.parse(calls[1].task);
  assert.equal(prompt.resumed, false);
  assert.equal(prompt.brief, "old task");
  assert.equal(prompt.thread[0].text, "earlier");
  assert.equal(events.at(-1).type, "subtask_done");
  assert.ok(events.some(event => event.type === "subtask_started" && event.resumed === false));
  assert.equal(ctx.isMissingSubtaskSession(new Error("rate limit exceeded")), false);
});

test("shared native session has only one writer across dispatch and subtask scopes", async () => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  class MockCodex {
    resumeThread() { return { id: "same-thread", async runStreamed() {
      return { events: (async function* () { await gate; yield { type: "thread.started", thread_id: "same-thread" }; yield { type: "item.completed", item: { type: "agent_message", text: "ok" } }; })() };
    } }; }
  }
  const ctx = vm.createContext({
    DISPATCH_SESSION_WRITERS: new Set(), resolveDispatchProfile: () => ({ id: "p1", provider: "codex", name: "Codex" }),
    isCodexAuthAvailable: () => true, isSubscriptionProvider: () => true, dispatchModelForProfile: () => "m1", Codex: MockCodex, CODEX_CLIENT_OPTIONS: {},
    codexSandboxMode: () => "workspace-write", codexItemText: item => item.text, AbortController,
  });
  vm.runInContext(server.slice(server.indexOf("async function executeProviderDispatch("), server.indexOf("/* 正在跑的子任务追问")), ctx);
  const options = { provider: "p1", profileData: {}, task: "hello", cwd: ".", permissionMode: "auto", resumeSessionId: "same-thread" };
  const first = ctx.executeProviderDispatch(options);
  await assert.rejects(ctx.executeProviderDispatch(options), /正在处理另一条消息/);
  finish();
  assert.equal((await first).output, "ok");
  assert.equal(ctx.DISPATCH_SESSION_WRITERS.size, 0);
  assert.equal((await ctx.executeProviderDispatch(options)).output, "ok");
});

test("history rebuilds each subtask thread and reconciles an unfinished reply", () => {
  const sent = [];
  const ctx = vm.createContext({ subtaskThreads: new Map(), wsSend: event => sent.push(event), subagentToolLabel: (name, input) => `${name} ${input?.file_path || ""}`.trim() });
  vm.runInContext([fn(html, "subtaskKey"), fn(html, "subtaskThreadFor"), fn(html, "restoreSubtaskThreads")].join("\n"), ctx);
  ctx.restoreSubtaskThreads("conv1", [
    { id: "request_1", role: "user", text: "question", subtask: { id: "task1" } },
    { id: "request_1_reply", role: "assistant", text: "answer", status: "complete", via: { model: "m2" }, subtask: { id: "task1" }, dispatchSteps: [{ name: "Read", input: { file_path: "a.md" } }, { name: "Edit", input: { file_path: "b.md" } }] },
    { id: "request_2", role: "user", text: "pending", subtask: { id: "task2" } },
  ]);
  const first = ctx.subtaskThreads.get("conv1|task1"), second = ctx.subtaskThreads.get("conv1|task2");
  assert.deepEqual(Array.from(first.items, item => item.text), ["question", "answer"]);
  assert.equal(first.model, "m2");
  assert.deepEqual(Array.from(first.items[1].steps), ["Read a.md", "Edit b.md"]);
  assert.equal(second.inflight.requestId, "request_2");
  assert.equal(sent[0].type, "subtask_status");
  ctx.restoreSubtaskThreads("conv1", []);
  assert.equal(first.items.length, 2);
});

test("restart preserves unsent and unacknowledged follow-ups without resending saved requests", () => {
  const key = "inkfellow.subtask.pending.conv1", sent = [];
  const storage = new Map([[key, JSON.stringify([
    { itemId: "task1", id: "already_saved", text: "saved", state: "sent" },
    { itemId: "task1", id: "uncertain", text: "maybe sent", state: "sent" },
    { itemId: "task1", id: "queued", text: "waiting", state: "queued" },
  ])]]);
  const localStorage = { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) };
  const ctx = vm.createContext({ subtaskThreads: new Map(), localStorage, wsSend: event => sent.push(event) });
  vm.runInContext([fn(html, "subtaskKey"), fn(html, "subtaskThreadFor"), fn(html, "persistSubtaskPending"), fn(html, "restoreSubtaskPending")].join("\n"), ctx);
  ctx.restoreSubtaskPending("conv1", [{ id: "already_saved" }]);
  const thread = ctx.subtaskThreads.get("conv1|task1");
  assert.equal(thread.inflight.requestId, "uncertain");
  assert.equal(thread.queue[0].id, "queued");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "subtask_status");
  assert.equal(sent[0].requestId, "uncertain");
  assert.equal(JSON.parse(storage.get(key)).some(item => item.id === "already_saved"), false);
});

test("recovered cards mark only tasks from an earlier server as interrupted", () => {
  const created = [], queued = { id: "q1", role: "user", text: "wait", status: "queued" };
  const thread = { queue: [queued], items: [queued] };
  const ctx = vm.createContext({
    subtaskCardRefs: new Map(), subtaskThreads: new Map([["conv1|task1", thread]]), subtaskKey: (conv, id) => `${conv}|${id}`, structuredClone,
    scopedSquadId: id => id,
    persistSubtaskPending() {}, pumpSubtaskThread() { assert.fail("interrupted task must not send queued work"); },
    SquadCard: { fromSnapshot: (id, snap) => { created.push(snap); return { state: new Map(snap.state), render: () => ({}) }; } },
    addMessage: () => ({ querySelector: () => ({ appendChild() {} }) }),
    messagesEl: { querySelector: () => null }, cssEscapeValue: value => value,
  });
  vm.runInContext(fn(html, "restoreSubtaskCards"), ctx);
  const snap = { order: ["task1"], state: [["task1", { status: "running" }]], labels: [] };
  ctx.restoreSubtaskCards({ id: "conv1", subtaskServerBootId: "new", subtaskSnapshots: { old: { bootId: "old", snapshot: snap }, live: { bootId: "new", snapshot: snap } } });
  assert.equal(created[0].state[0][1].status, "failed");
  assert.match(created[0].state[0][1].result, /重启/);
  assert.equal(queued.status, "held");
  assert.equal(thread.queue.length, 0);
  assert.equal(created[1].state[0][1].status, "running");
  assert.equal(snap.state[0][1].status, "running");
});

test("a recovered card takes the place of its replayed tool line instead of piling up at the end", () => {
  const rendered = { card: true };
  const lines = new Map([["task1", { replacedWith: null, removed: false }], ["task2", { replacedWith: null, removed: false }]]);
  for (const line of lines.values()) {
    line.replaceWith = node => { line.replacedWith = node; };
    line.remove = () => { line.removed = true; };
  }
  const appended = [];
  const ctx = vm.createContext({
    subtaskCardRefs: new Map(), subtaskThreads: new Map(), subtaskKey: (conv, id) => `${conv}|${id}`, structuredClone,
    scopedSquadId: id => id, persistSubtaskPending() {}, pumpSubtaskThread() {},
    SquadCard: { fromSnapshot: (id, snap) => ({ state: new Map(snap.state), render: () => rendered }) },
    addMessage: () => ({ querySelector: () => ({ appendChild: node => appended.push(node) }) }),
    messagesEl: { querySelector: selector => lines.get(selector.match(/data-tool-id="([^"]+)"/)?.[1]) ?? null },
    cssEscapeValue: value => value,
  });
  vm.runInContext(fn(html, "restoreSubtaskCards"), ctx);
  const snap = { order: ["task1", "task2"], state: [["task1", { status: "done" }], ["task2", { status: "done" }]], labels: [] };
  ctx.restoreSubtaskCards({ id: "conv1", subtaskServerBootId: "boot", subtaskSnapshots: { sq: { bootId: "boot", snapshot: snap } } });
  assert.equal(lines.get("task1").replacedWith, rendered);
  assert.equal(lines.get("task2").removed, true);
  assert.equal(appended.length, 0);

  // 那一行不在（比如历史里没有那次工具调用），才退到末尾
  lines.clear();
  ctx.restoreSubtaskCards({ id: "conv2", subtaskServerBootId: "boot", subtaskSnapshots: { sq: { bootId: "boot", snapshot: snap } } });
  assert.deepEqual(appended, [rendered]);
});

test("the card row names the model the subtask was switched to", () => {
  const ctx = vm.createContext({ subtaskThreads: new Map(), subtaskKey: (conv, id) => `${conv}|${id}` });
  vm.runInContext(fn(html, "subtaskRowOrigin"), ctx);
  const s = { origin: { provider: "codex", providerName: "Codex", model: "gpt-a" } };
  assert.equal(ctx.subtaskRowOrigin("conv1", "task1", s).model, "gpt-a");
  ctx.subtaskThreads.set("conv1|task1", { model: "gpt-b" });
  assert.equal(ctx.subtaskRowOrigin("conv1", "task1", s).model, "gpt-b");
  assert.equal(ctx.subtaskRowOrigin("conv1", "task1", s).providerName, "Codex");
  assert.equal(s.origin.model, "gpt-a");
  assert.equal(ctx.subtaskRowOrigin("conv1", "task1", { origin: null }), null);
});

test("persisted native sessions are bound to the same account credentials", () => {
  const profile = { id: "p1", provider: "deepseek", apiKey: "old-key", baseUrl: "https://example.test" };
  const saved = { id: "conv1", subtaskSessions: {} };
  const ctx = vm.createContext({ crypto, readHistory: () => [saved], readProfiles: () => ({ profiles: [profile] }),
    recallDispatchSession: () => null, subtaskSessionScope: () => "scope" });
  const recall = server.match(/^export function recallSubtaskSession\([^]*?^}/m)[0].replace(/^export /, "");
  vm.runInContext(fn(server, "subtaskProfileFingerprint") + "\n" + recall, ctx);
  saved.subtaskSessions.task1 = { profileId: "p1", sessionId: "native-id", fingerprint: ctx.subtaskProfileFingerprint(profile) };
  assert.equal(ctx.recallSubtaskSession("conv1", "task1", "p1"), "native-id");
  profile.apiKey = "new-key";
  assert.equal(ctx.recallSubtaskSession("conv1", "task1", "p1"), null);
  assert.equal(ctx.recallSubtaskSession("conv1", "task1", "other"), null);
});

test("Gemini follow-ups default to Hydrogen and send the displayed selection", () => {
  const sent = [];
  const s = { status: "done", kind: "dispatch", profileId: "p1", model: "gemini-3.8-flash" };
  const card = { state: new Map([["task1", s]]), labels: new Map() };
  const thread = { key: "conv1|task1", conversationId: "conv1", itemId: "task1", items: [], queue: [], inflight: null, model: "gemini-3.8-flash" };
  const ctx = vm.createContext({
    subtaskThreads: new Map([[thread.key, thread]]), subtaskCardRefs: new Map([[thread.key, card]]),
    subtaskProfile: () => ({ provider: "antigravity" }), subtaskKey: (c, i) => `${c}|${i}`,
    subtaskItemSettled: () => true, subtaskCanFollowUp: () => true, selectedPermissionMode: "auto",
    wsSend: event => (sent.push(event), true), persistSubtaskPending() {}, updateBackgroundActivity() {},
  });
  vm.runInContext(fn(html, "subtaskCurrentModel") + "\n" + fn(html, "pumpSubtaskThread"), ctx);
  const send = id => {
    const item = { id, role: "user", status: "queued", text: id };
    thread.items.push(item); thread.queue.push(item); thread.inflight = null;
    ctx.pumpSubtaskThread(thread);
  };
  assert.equal(ctx.subtaskCurrentModel("conv1", "task1", s), "gemini-4-hydrogen");
  send("req_1");
  assert.equal(sent[0].model, "gemini-4-hydrogen");
  s.followupModel = "gemini-4-argon";
  assert.equal(ctx.subtaskCurrentModel("conv1", "task1", s), "gemini-4-argon");
  send("req_2");
  assert.equal(sent[1].model, "gemini-4-argon", "an explicit saved choice beats a stale thread model");
  delete s.followupModel;
  s.origin = { model: "claude-opus-5-5" };
  thread.model = "gemini-4-hydrogen";
  assert.equal(ctx.subtaskCurrentModel("conv1", "task1", s), "claude-opus-5-5");
  send("req_3");
  assert.equal(sent[2].model, "claude-opus-5-5", "Antigravity's Claude model survives the Gemini default");
});

test("reconnect replaces missing steps and duplicate step events do not duplicate the process", () => {
  const reply = { id: "req_1_reply", role: "assistant", status: "running", steps: ["Read"], text: "" };
  const thread = { key: "conv1|task1", conversationId: "conv1", itemId: "task1", items: [reply], inflight: { requestId: "req_1", reply } };
  const ctx = vm.createContext({ subtaskThreads: new Map([[thread.key, thread]]), subtaskKey: (c, i) => `${c}|${i}`,
    subagentToolLabel: name => name, persistSubtaskPending() {}, pumpSubtaskThread() {}, updateBackgroundActivity() {},
    refreshSubtaskViewFor() {}, refreshSubtaskRowByKey() {},
  });
  vm.runInContext('const SUBTASK_TERMINAL_EVENTS = { subtask_done: "done", subtask_error: "failed", subtask_stopped: "stopped" };\n' + fn(html, "handleSubtaskEvent"), ctx);
  const event = type => ({ type, conversationId: "conv1", subtaskId: "task1", requestId: "req_1" });
  ctx.handleSubtaskEvent({ ...event("subtask_started"), steps: [{ name: "Read" }, { name: "Edit" }] });
  assert.deepEqual(Array.from(reply.steps), ["Read", "Edit"]);
  ctx.handleSubtaskEvent({ ...event("subtask_step"), stepIndex: 1, name: "Edit" });
  assert.equal(reply.steps.length, 2);
  ctx.handleSubtaskEvent({ ...event("subtask_done"), output: "saved", steps: [{ name: "Read" }, { name: "Edit" }, { name: "Bash" }] });
  assert.deepEqual(Array.from(reply.steps), ["Read", "Edit", "Bash"]);
  assert.equal(reply.status, "done");
  assert.equal(thread.inflight, null);
  ctx.handleSubtaskEvent({ ...event("subtask_done"), output: "duplicate", steps: [] });
  assert.equal(reply.steps.length, 3);
  assert.equal(reply.text, "saved");
});

test("Antigravity fallback respects the saved subtask model family", () => {
  const profile = { id: "p1", provider: "antigravity" };
  const state = { profileId: profile.id, origin: { model: "claude-opus-5-5" } };
  const conversation = { subtaskSnapshots: { squad: { snapshot: { state: [["task1", state]] } } } };
  const ctx = vm.createContext({ dispatchModelForProfile: () => "gemini-4-argon" });
  vm.runInContext(fn(server, "defaultAgySubtaskFollowupModel"), ctx);
  assert.equal(ctx.defaultAgySubtaskFollowupModel(conversation, "task1", profile), "claude-opus-5-5");
  state.origin.model = "gemini-3.8-flash";
  assert.equal(ctx.defaultAgySubtaskFollowupModel(conversation, "task1", profile), "gemini-4-hydrogen");
  state.followupModel = "gemini-4-argon";
  assert.equal(ctx.defaultAgySubtaskFollowupModel(conversation, "task1", profile), "gemini-4-argon");
});

test("Gemini backend defaults to Hydrogen and keeps every step through reconnect and completion", async () => {
  let finish;
  const events = [], calls = [], messages = [], runs = new Map();
  const ctx = vm.createContext({
    historyIdOrNull: v => v || null, subtaskIdOrNull: v => v || null, deliver: e => events.push(e),
    deletedHistoryConversationIds: new Set(), SUBTASK_FOLLOWUPS: runs, readProfiles: () => ({}),
    resolveDispatchProfile: () => ({ id: "p1", provider: "antigravity" }),
    PERMISSION_MODES: new Set(["auto"]), DEFAULT_PERMISSION_MODE: "auto", subtaskSessionScope: () => "scope",
    recallSubtaskSession: () => "existing-session", markDispatchInflight: () => () => {}, dispatchGenerationOf: () => 0,
    AbortController, historyRoute: o => o, dispatchModelForProfile: () => "gemini-4-argon",
    ensureHistoryConversation: () => ({ messages }), readHistory: () => [{ id: "conv1", messages }], persistHistoryImmediate() {},
    executeProviderDispatch: args => { calls.push(args); return new Promise(resolve => { finish = resolve; }); },
    subtaskFollowupPrompt: ({ text }) => text, resolveAllowedCwd: () => ".", compactToolInput: x => x,
  });
  vm.runInContext([
    fn(server, "defaultAgySubtaskFollowupModel"), fn(server, "sendSubtaskStatus"), fn(server, "runSubtaskFollowup", true),
  ].join("\n"), ctx);
  const run = ctx.runSubtaskFollowup({ conversationId: "conv1", subtaskId: "task1", requestId: "req_1", prompt: "continue", profileId: "p1" });
  assert.equal(calls[0].model, "gemini-4-hydrogen");
  assert.equal(calls[0].resumeSessionId, "existing-session");
  for (let i = 0; i < 205; i++) calls[0].onStep("Read", { file_path: `${i}.md` });
  assert.equal(events.at(-1).stepIndex, 204);
  ctx.sendSubtaskStatus("conv1", "task1", "req_1");
  assert.equal(events.at(-1).steps.length, 205);
  finish({ output: "answer", model: "gemini-4-hydrogen", provider: "antigravity", resumed: true });
  await run;
  assert.equal(events.at(-1).steps.length, 205);
  assert.equal(messages.at(-1).dispatchSteps.length, 205);
});

test("dispatch captures completed-only Gemini and Codex tools once", async () => {
  for (const provider of ["antigravity", "codex"]) {
    const steps = [];
    const ctx = vm.createContext({
      DISPATCH_SESSION_WRITERS: new Set(), resolveDispatchProfile: () => ({ id: "p1", provider, name: provider }),
      isCodexAuthAvailable: () => true, isAgyAuthAvailable: () => true, isSubscriptionProvider: () => true,
      dispatchModelForProfile: () => "model", codexSandboxMode: () => "workspace-write", CODEX_CLIENT_OPTIONS: {}, AbortController,
      codexToolName: item => item.type, codexToolInput: item => item, codexItemText: item => item.text,
      agyToolName: step => step.tool_name, agyToolInput: input => input,
      runAgy: async ({ onEvent }) => {
        for (const [step_index, state] of [[0, "ACTIVE"], [0, "ACTIVE"], [0, "DONE"], [1, "DONE"]]) {
          onEvent({ event: "step_update", step_update: { step_index, step_type: "tool", state, tool_name: `tool_${step_index}`, tool_info: {} } });
        }
        return { text: "done" };
      },
      Codex: class { startThread() { return { async runStreamed() { return { events: (async function* () {
        yield { type: "item.started", item: { id: "a", type: "command_execution" } };
        yield { type: "item.completed", item: { id: "a", type: "command_execution" } };
        yield { type: "item.completed", item: { id: "b", type: "file_change" } };
        yield { type: "item.completed", item: { id: "c", type: "agent_message", text: "done" } };
      })() }; } }; } },
    });
    vm.runInContext(server.slice(server.indexOf("async function executeProviderDispatch("), server.indexOf("/* 正在跑的子任务追问")), ctx);
    await ctx.executeProviderDispatch({ provider: "p1", profileData: {}, task: "test", cwd: ".", onStep: name => steps.push(name) });
    assert.equal(steps.length, 2, `${provider} must include completed-only tools without duplicating started tools`);
  }
});

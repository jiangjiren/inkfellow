import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
const completionTrackerSource = await readFile(new URL("./public/turn-completion.js", import.meta.url), "utf8");
const source = name => html.match(new RegExp(`function ${name}\\([^]*?^}`, "m"))[0];

function harness() {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const intervals = new Map();
  const c = vm.createContext({
    currentConvId: "a", activeRequestId: "r1", assistantBlocks: [], assistantEvents: [],
    sessionsRunning: new Set(), sessionsAwaiting: new Set(), sessionUnread: new Set(),
    renderSessionBadges() {},
    deletedConversationIds: new Set(),
    resetRequested: false,
    setTimeout(fn, delay = 0) { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn) { const id = ++timerId; intervals.set(id, fn); return id; },
    clearInterval(id) { intervals.delete(id); },
    document: { getElementById: () => null },
    updateGenChip() {}, updateTypingStatus() {}, blockTypeLabel: value => value,
    handleSteeringEvent: () => false,
    isToolUseType: () => false, isToolResultType: () => false,
    handleBackgroundDeliveryEvent() {},
    noteBackgroundEvent() {}, cloneJson: structuredClone, renderVideoOpenCard() {},
  });
  c.intervals = intervals;
  vm.runInContext(html.slice(html.indexOf("const TASK_EVENT_TYPES"), html.indexOf("// ── Event handling")), c);
  vm.runInContext(source("staleConversationTerminal") + "\n" + source("handleEvent"), c);
  // Exercise the production reducer and state; omit only DOM painting/animation.
  vm.runInContext(`
    SquadCard.prototype.refresh = function() {};
    SquadCard.prototype.paintRow = function() {};
    SquadCard.prototype.join = function() {};
    globalThis.cards = squadCards;
    globalThis.owning = squadOwning;
    globalThis.restoreCard = SquadCard.fromSnapshot;
    globalThis.taskIndex = squadOfTask;
    globalThis.aliases = squadTaskAlias;
    globalThis.asyncItems = asyncAgentItems;
  `, c);
  c.advance = ms => {
    const until = now + ms;
    while (true) {
      const next = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
    }
    now = until;
  };
  c.event = (subtype, fields = {}) => c.handleEvent({
    type: "system", subtype, conversationId: c.currentConvId,
    userMessageId: c.activeRequestId, task_id: "t1", ...fields,
  });
  return c;
}

test("completion from an earlier turn settles its card without entering the new reply", () => {
  const c = harness();
  c.event("task_started", { tool_use_id: "u1" });
  c.activeRequestId = "r2";
  c.assistantBlocks = [];
  c.assistantEvents = [];
  c.event("task_notification", { userMessageId: "r1", status: "completed" });
  assert.equal(c.owning("u1").counts.live, 0);
  assert.equal(c.assistantBlocks.length, 0);
  assert.equal(c.assistantEvents.length, 0);
});

test("background task notification keeps full summary as subtask output", () => {
  const c = harness();
  c.event("task_started", { tool_use_id: "u1" });
  const summary = "完整产出：" + "甲".repeat(240);
  c.event("task_notification", { tool_use_id: "u1", status: "completed", summary });
  const item = c.owning("u1").state.get("u1");
  assert.equal(item.output, summary);
  assert.ok(item.result.length <= 120);
});

function mountFixture(c, card) {
  const mounted = [];
  const body = { appendChild(el) { el.isConnected = true; mounted.push(el); } };
  const bubble = { querySelector: () => body };
  c.messagesEl = { querySelectorAll: selector => selector === ".msg.msg-assistant" ? [bubble] : [] };
  c.assistantEl = bubble;
  c.addMessage = () => bubble;
  c.removeTyping = c.removeGenChip = c.reanchorGenChip = c.scrollBottom = () => {};
  c.genChipEl = null;
  c.isGenerating = false;
  card.render = () => (card.el = { dataset: { squadId: card.id }, isConnected: false });
  vm.runInContext(source("restoreConversationRuntime"), c);
  return mounted;
}

test("leaving before SHOW_DELAY persists the block and re-arms the missing card on return", () => {
  const c = harness();
  c.event("task_started");
  const card = c.owning("t1");
  const mounted = mountFixture(c, card);
  const cached = { generating: true, assistantBlocks: [...c.assistantBlocks] };
  assert.equal(cached.assistantBlocks[0].snapshot.state[0][1].status, "running");
  c.advance(400);
  c.currentConvId = "b";
  c.advance(400);
  assert.equal(mounted.length, 0);
  assert.equal(card.mountArmed, false);
  c.currentConvId = "a";
  c.restoreConversationRuntime(cached);
  c.advance(800);
  assert.equal(mounted.length, 1);
  assert.equal(card.mountArmed, false);
  assert.equal(c.liveSquadCards().length, 1);
  assert.equal(c.assistantBlocks.length, 1);
});

test("switching back before the original timer fires mounts exactly once", () => {
  const c = harness();
  c.event("task_started");
  const card = c.owning("t1");
  const mounted = mountFixture(c, card);
  const cached = { generating: true, assistantBlocks: [...c.assistantBlocks] };
  c.currentConvId = "b";
  c.advance(200);
  c.currentConvId = "a";
  c.restoreConversationRuntime(cached);
  c.advance(1400);
  assert.equal(mounted.length, 1);
});

test("a derivation finishing inside SHOW_DELAY is recorded but never drawn", () => {
  const c = harness();
  c.event("task_started");
  const card = c.owning("t1");
  const mounted = mountFixture(c, card);
  vm.runInContext(source("appendAssistantBlock"), c);
  const body = { appendChild(el) { el.isConnected = true; mounted.push(el); } };

  // 块在 spawn 时就登记，否则切走前的快照会漏掉这张卡；但它还没露过面。
  assert.equal(c.assistantBlocks.length, 1);
  assert.equal(card.shown, false);
  // 派生发生在 assistant 事件里，同一个事件随后就会全量重渲染——不能把它画出来
  c.appendAssistantBlock(body, c.assistantBlocks[0]);
  assert.equal(mounted.length, 0);

  c.advance(200);
  c.event("task_notification", { status: "completed" });
  c.advance(800);
  assert.equal(mounted.length, 0, "短任务当轮不出卡");
  assert.equal(card.shown, false);
  c.appendAssistantBlock(body, c.assistantBlocks[0]);
  assert.equal(mounted.length, 0, "历史回放也不该凭空多出一张");

  // 跑满显示延迟的派生照常挂载，之后的重渲染也认它
  c.event("task_started", { task_id: "t2", tool_use_id: "u2" });
  c.advance(800);
  assert.equal(card.shown, true);
  assert.equal(mounted.length, 1);
  c.appendAssistantBlock(body, c.assistantBlocks[0]);
  assert.equal(mounted.length, 2);
});

test("direct origin mount and ensureBlock cannot write into another conversation", () => {
  const c = harness();
  const card = c.currentSquad(true);
  const mounted = mountFixture(c, card);
  c.currentConvId = "b";
  card.spawn("external", "other conversation", { provider: "claude" });
  card.mount();
  c.advance(800);
  assert.equal(mounted.length, 0);
  assert.equal(c.assistantBlocks.length, 0);
  assert.equal(card.block, null);
});

test("cleanup collects completed cards across conversations and keeps live tasks", () => {
  const c = harness();
  c.event("task_started", { task_id: "live", tool_use_id: "live-tool" });
  for (let i = 0; i < 40; i++) {
    c.currentConvId = `conv-${i}`;
    c.event("task_started", { task_id: `t-${i}`, tool_use_id: `u-${i}` });
    c.event("task_notification", { task_id: `t-${i}`, status: "completed" });
  }
  c.currentConvId = "new-conversation";
  c.resetSquads();
  assert.equal(c.cards.size, 1);
  assert.equal(c.taskIndex.size, 1);
  assert.equal(c.aliases.size, 1);
  assert.equal(c.asyncItems.size, 1);
  assert.equal(c.owning("live-tool").counts.live, 1);
});

test("squad ids are canonical for bare, scoped, and legacy double-prefixed history ids", () => {
  const c = harness();
  for (const id of ["sq_1", "a:sq_1", "a:a:sq_1"]) assert.equal(c.scopedSquadId(id), "a:sq_1");
});

test("history rendering reuses one canonical card id and its task index", () => {
  for (const id of ["sq_1", "a:sq_1", "a:a:sq_1"]) {
    const c = harness();
    const block = { type: "squad", squadId: id, snapshot: {
      order: ["t1"], state: [["t1", { status: "done", steps: [] }]],
    } };
    vm.runInContext(`SquadCard.prototype.render = function() { return this.el = {}; };`, c);
    vm.runInContext(source("appendAssistantBlock"), c);
    const body = { appendChild() {} };
    c.appendAssistantBlock(body, block);
    c.appendAssistantBlock(body, block);
    assert.equal(block.squadId, "a:sq_1");
    assert.equal(c.cards.size, 1);
    assert.equal(c.taskIndex.get("t1"), "a:sq_1");
  }
});

test("a completed card evicted in another conversation restores from cached snapshots", () => {
  const c = harness();
  c.event("task_started");
  const card = c.owning("t1");
  c.event("task_notification", { status: "completed" });
  const cached = { generating: false, messageLog: [{ blocks: structuredClone(c.assistantBlocks) }] };
  c.currentConvId = "b";
  c.resetSquads();
  assert.equal(c.cards.size, 0);
  c.currentConvId = "a";
  let replacement;
  c.messagesEl = { querySelectorAll: () => [{
    dataset: { squadId: card.id }, replaceWith: el => { replacement = el; },
  }] };
  c.removeGenChip = () => {};
  vm.runInContext(`SquadCard.prototype.render = function() { return this.el = { restored: true }; };`, c);
  vm.runInContext(source("restoreConversationRuntime"), c);
  c.restoreConversationRuntime(cached);
  assert.equal(replacement.restored, true);
  assert.equal(c.owning("t1").counts.done, 1);
  assert.equal(c.owning("t1").id, card.id);
});

test("task aliases preserve row order when renaming and merging across cards", () => {
  const c = harness();
  c.event("task_started", { task_id: "first" });
  c.event("task_started", { task_id: "middle" });
  c.event("task_started", { task_id: "last" });
  c.linkSquadTask("middle", "renamed");
  assert.deepEqual([...c.owning("first").order], ["first", "renamed", "last"]);
  c.resetSquads();
  c.event("task_started", { task_id: "other-first" });
  c.event("task_started", { task_id: "target" });
  c.event("task_started", { task_id: "other-last" });
  c.linkSquadTask("first", "target");
  assert.deepEqual([...c.owning("target").order], ["other-first", "target", "other-last"]);
  assert.deepEqual([...c.owning("renamed").order], ["renamed", "last"]);
});

test("switching conversations excludes old tasks and still accepts their completion", () => {
  const c = harness();
  c.event("task_started", { tool_use_id: "u1" });
  c.currentConvId = "b";
  assert.equal(c.liveBackgroundTasks(), 0);
  c.event("task_notification", { conversationId: "a", status: "completed" });
  c.currentConvId = "a";
  assert.equal(c.liveBackgroundTasks(), 0);
});

test("a tool id arriving after task_started merges the two rows", () => {
  const c = harness();
  c.subagentIngest({ type: "assistant", message: { content: [
    { type: "tool_use", id: "u1", name: "Agent", input: { description: "research" } },
  ] } });
  c.event("task_started");
  c.event("task_notification", { tool_use_id: "u1", status: "completed" });
  assert.equal(c.liveBackgroundTasks(), 0);
  assert.equal([...c.cards.values()].reduce((n, card) => n + card.order.length, 0), 1);
});

test("bare lifecycle events and lifecycle events with a parent settle normally", () => {
  for (const extra of [{ type: "task_notification" }, { parent_tool_use_id: "parent" }]) {
    const c = harness();
    c.event("task_started");
    c.event("task_notification", { status: "completed", ...extra });
    assert.equal(c.liveBackgroundTasks(), 0);
  }
});

test("late progress after turn cleanup cannot revive a completed task", () => {
  const c = harness();
  c.event("task_started", { tool_use_id: "u1" });
  c.event("task_notification", { status: "completed" });
  c.resetSquads();
  c.activeRequestId = "r2";
  c.event("task_progress", { userMessageId: "r1" });
  assert.equal(c.liveBackgroundTasks(), 0);
  c.event("task_progress");
  assert.equal(c.liveBackgroundTasks(), 0);
});

test("restored snapshots retain task aliases and accept completion", () => {
  const before = harness();
  before.event("task_started", { tool_use_id: "u1" });
  const snap = before.owning("u1").snapshot();
  const after = harness();
  const card = after.restoreCard("restored", snap);
  after.activeRequestId = "r2";
  after.event("task_notification", { userMessageId: "r1", status: "completed" });
  assert.equal(card.counts.live, 0);
  assert.equal(after.cards.size, 1);
});

test("background launch acknowledgement does not prematurely complete the task", () => {
  const c = harness();
  c.event("task_started", { tool_use_id: "u1" });
  c.subagentIngest({ type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "u1", content: "Async agent launched, agentId: t1" },
  ] } });
  assert.equal(c.liveBackgroundTasks(), 1);
  c.event("task_notification", { status: "completed" });
  assert.equal(c.liveBackgroundTasks(), 0);
});

test("stopped and failed tasks are not shown as successful", () => {
  for (const status of ["stopped", "failed", "cancelled"]) {
    const c = harness();
    c.event("task_started");
    c.event("task_notification", { status });
    assert.equal(c.owning("t1").counts.fail, 1);
    assert.equal(c.liveBackgroundTasks(), 0);
  }
});

test("cached conversation restoration rebinds task card DOM references", () => {
  const c = harness();
  c.event("task_started");
  const card = c.owning("t1");
  const oldNode = { detached: true };
  const newNode = { current: true };
  card.el = oldNode;
  let replaced;
  card.render = () => (card.el = newNode);
  c.messagesEl = { querySelectorAll: () => [{
    dataset: { squadId: card.id }, replaceWith: node => { replaced = node; },
  }] };
  c.removeGenChip = () => {};
  vm.runInContext(source("restoreConversationRuntime"), c);
  c.restoreConversationRuntime({ generating: false });
  assert.equal(replaced, newNode);
  assert.equal(card.el, newNode);
});

test("a real background task survives foreground turn cleanup", () => {
  const c = harness();
  c.event("task_started", { tool_use_id: "u1" });
  c.resetSquads();
  assert.equal(c.liveBackgroundTasks(), 1);
  c.event("task_progress");
  assert.equal(c.liveBackgroundTasks(), 1);
});

class ActivityElement {
  constructor() {
    this.hidden = true;
    this.children = [];
    this.parts = new Map();
    this.dataset = {};
    this.attributes = new Map();
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle(name, force = !classes.has(name)) {
        if (force) classes.add(name); else classes.delete(name);
        return force;
      },
    };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name); }
  appendChild(child) { this.children.push(child); }
  set innerHTML(value) {
    this.children = [];
    this.parts.clear();
    for (const [, name] of value.matchAll(/class="([\w-]+)"/g)) this.parts.set(`.${name}`, new ActivityElement());
  }
  querySelector(selector) {
    return this.parts.get(selector) ?? this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector) {
    if (selector.startsWith('.bga-item[data-s="running"]')) {
      return this.children.filter(child => child.dataset.s === "running" && child.dataset.start)
        .concat([...this.parts.values()].flatMap(part => part.querySelectorAll(selector)));
    }
    return [];
  }
}

function activityFixture() {
  const c = harness();
  const el = new ActivityElement();
  for (const name of ["bga-head", "bga-text", "bga-list"]) el.parts.set(`.${name}`, new ActivityElement());
  c.document = {
    getElementById: id => id === "bg-activity" ? el : null,
    createElement: () => new ActivityElement(),
  };
  c.bar = el;
  c.openActivity = () => el.querySelector(".bga-head").onclick();
  c.rows = () => el.querySelector(".bga-list").children;
  return c;
}

test("the composer activity bar disappears as soon as its last task completes", () => {
  const c = activityFixture();
  c.event("task_started");
  assert.equal(c.bar.hidden, false);
  c.event("task_notification", { status: "completed" });
  assert.equal(c.bar.hidden, true);
  assert.equal(c.owning("t1").counts.done, 1, "the completed result stays in conversation history");
  assert.equal(c.assistantBlocks.length, 1);
});

test("the active list uses task state before the delayed message card mounts", () => {
  const c = activityFixture();
  c.event("task_started", { description: "research" });
  assert.equal(c.owning("t1").el, null);
  c.openActivity();
  assert.equal(c.rows().length, 1);
  assert.equal(c.rows()[0].querySelector(".bga-ilabel").textContent, "research");
  assert.equal(c.bar.querySelector(".bga-head").getAttribute("aria-expanded"), "true");
  assert.equal(c.intervals.size, 1);
});

test("finished rows leave the composer list while remaining tasks keep running", () => {
  const c = activityFixture();
  c.event("task_started", { description: "first" });
  c.event("task_started", { task_id: "t2", description: "second" });
  c.openActivity();
  c.event("task_notification", { status: "completed" });
  assert.equal(c.bar.hidden, false);
  assert.equal(c.rows().length, 1);
  assert.equal(c.rows()[0].querySelector(".bga-ilabel").textContent, "second");
  c.event("task_notification", { task_id: "t2", status: "failed" });
  assert.equal(c.bar.hidden, true);
  assert.equal(c.rows().length, 0);
  assert.equal(c.intervals.size, 0);
  assert.equal(c.bar.querySelector(".bga-head").getAttribute("aria-expanded"), "false");
});

test("switching conversations removes the old floating activity and expanded list", () => {
  const c = activityFixture();
  c.event("task_started", { description: "conversation A" });
  c.openActivity();
  c.currentConvId = "b";
  c.updateBackgroundActivity();
  assert.equal(c.bar.hidden, true);
  assert.equal(c.rows().length, 0);
  assert.equal(c.intervals.size, 0);
  c.event("task_started", { task_id: "t2", description: "conversation B" });
  assert.equal(c.bar.hidden, false);
  assert.equal(c.bar.classList.contains("open"), false);
  c.openActivity();
  assert.equal(c.rows().length, 1);
  assert.equal(c.rows()[0].querySelector(".bga-ilabel").textContent, "conversation B");
  c.event("task_notification", { conversationId: "a", task_id: "t1", status: "completed" });
  assert.equal(c.bar.hidden, false, "completion in A cannot hide B's task");
  c.currentConvId = "a";
  c.updateBackgroundActivity();
  assert.equal(c.bar.hidden, true);
});

test("switching between running conversations starts with a fresh collapsed list", () => {
  const c = activityFixture();
  c.event("task_started", { description: "conversation A" });
  c.openActivity();
  c.currentConvId = "b";
  c.event("task_started", { task_id: "t2", description: "conversation B" });
  assert.equal(c.bar.classList.contains("open"), false);
  assert.equal(c.rows().length, 0);
  assert.equal(c.intervals.size, 0);
  c.currentConvId = "a";
  c.updateBackgroundActivity();
  assert.equal(c.bar.hidden, false);
  c.openActivity();
  assert.equal(c.rows()[0].querySelector(".bga-ilabel").textContent, "conversation A");
});

test("normal turn completion settles orphaned foreground rows and preserves background work", () => {
  const c = activityFixture();
  c.finishGenerationAndContinue = () => {};
  c.subagentIngest({ type: "assistant", message: { content: [
    { type: "tool_use", id: "foreground", name: "Agent", input: { description: "foreground task" } },
  ] } });
  c.event("task_started", { tool_use_id: "background" });
  c.handleEvent({ type: "done", conversationId: "a", userMessageId: "r1" });
  assert.equal(c.owning("foreground").state.get("foreground").status, "failed");
  assert.equal(c.owning("background").state.get("background").status, "running");
  assert.equal(c.liveBackgroundTasks(), 1);
  c.event("task_notification", { status: "completed", tool_use_id: "background" });
  assert.equal(c.bar.hidden, true);
});

test("normal turn cleanup leaves previous-turn tasks and another conversation alone", () => {
  const c = harness();
  c.finishGenerationAndContinue = () => {};
  c.subagentIngest({ type: "assistant", message: { content: [
    { type: "tool_use", id: "previous", name: "Agent", input: {} },
  ] } });
  c.resetSquads();
  c.activeRequestId = "r2";
  c.subagentIngest({ type: "assistant", message: { content: [
    { type: "tool_use", id: "current", name: "Agent", input: {} },
  ] } });
  c.currentConvId = "b";
  c.subagentIngest({ type: "assistant", message: { content: [
    { type: "tool_use", id: "other", name: "Agent", input: {} },
  ] } });
  c.currentConvId = "a";
  c.handleEvent({ type: "done", conversationId: "a", userMessageId: "r2" });
  assert.equal(c.owning("current").counts.live, 0);
  assert.equal(c.owning("previous").counts.live, 1);
  assert.equal(c.owning("other").counts.live, 1);
});

test("the final response saves settled foreground rows so history cannot revive them", () => {
  const c = activityFixture();
  Object.assign(c, {
    assistantTxt: "answer", assistantEl: null, assistantRawMessages: [], stopRequested: false, messageLog: [],
    genId: () => "saved-response", saveCurrentConversation() {},
    resetAssistantState() { c.resetSquads(); c.assistantBlocks = []; c.assistantEvents = []; },
  });
  c.subagentIngest({ type: "assistant", message: { content: [
    { type: "tool_use", id: "foreground", name: "Agent", input: { description: "foreground task" } },
  ] } });
  c.event("task_started", { tool_use_id: "background" });
  c.handleEvent({ type: "result", conversationId: "a", userMessageId: "r1" });
  const snapshot = c.messageLog[0].blocks.find(block => block.type === "squad").snapshot;
  const state = new Map(snapshot.state);
  assert.equal(state.get("foreground").status, "failed");
  assert.equal(state.get("background").status, "running");
  c.event("task_notification", { tool_use_id: "background", status: "completed" });
  const savedBlock = c.messageLog[0].blocks.find(block => block.type === "squad");
  const cached = structuredClone(savedBlock);
  c.currentConvId = "b";
  c.resetSquads();
  c.currentConvId = "a";
  const restored = c.restoreCard(cached.squadId, cached.snapshot);
  assert.equal(restored.counts.live, 0, "a late background result updates the saved snapshot too");
});

test("the real event router notifies for owned completions but ignores stale and deleted requests", () => {
  const c = harness();
  const completions = [];
  vm.runInContext(completionTrackerSource, c);
  c.InkfellowCompletion = new c.InkfellowTurnCompletionTracker(info => completions.push({ ...info }));
  c.finishGenerationAndContinue = c.clearAskUserQuestion = () => {};
  c.conversationDeliveryStates = new Map([["b", { activeRequestId: "b-run" }]]);
  for (const [conversationId, userMessageId] of [["a", "r1"], ["a", "old-run"], ["b", "b-run"], ["deleted", "deleted-run"]]) {
    c.InkfellowCompletion.ingest({ type: "request_started", conversationId, userMessageId });
  }
  c.deletedConversationIds.add("deleted");
  c.handleEvent({ type: "done", conversationId: "a", userMessageId: "old-run" });
  c.handleEvent({ type: "done", conversationId: "deleted", userMessageId: "deleted-run" });
  assert.equal(completions.length, 0);
  c.handleEvent({ type: "done", conversationId: "b", userMessageId: "b-run" });
  c.handleEvent({ type: "done", conversationId: "a", userMessageId: "r1" });
  c.handleEvent({ type: "done", conversationId: "a", userMessageId: "r1" });
  assert.deepEqual(completions, [
    { conversationId: "b", userMessageId: "b-run" },
    { conversationId: "a", userMessageId: "r1" },
  ]);
});

test("an offline stop request suppresses completion sound even if a done frame arrives first", () => {
  const c = harness();
  const completions = [];
  vm.runInContext(completionTrackerSource, c);
  c.InkfellowCompletion = new c.InkfellowTurnCompletionTracker(info => completions.push(info));
  c.InkfellowCompletion.ingest({ type: "request_started", conversationId: "a", userMessageId: "r1" });
  Object.assign(c, {
    isGenerating: true, steeringQueue: [], renderSteeringTray() {}, syncComposerAction() {}, ws: null,
    finishGenerationAndContinue() {},
  });
  vm.runInContext(source("sendStopRequest"), c);
  assert.equal(c.sendStopRequest(), false);
  c.handleEvent({ type: "done", conversationId: "a", userMessageId: "r1" });
  assert.equal(completions.length, 0);
});

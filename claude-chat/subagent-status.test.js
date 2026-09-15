import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
const source = name => html.match(new RegExp(`function ${name}\\([^]*?^}`, "m"))[0];

function harness() {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const c = vm.createContext({
    currentConvId: "a", activeRequestId: "r1", assistantBlocks: [], assistantEvents: [],
    resetRequested: false,
    setTimeout(fn, delay = 0) { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    document: { getElementById: () => null },
    updateGenChip() {}, updateTypingStatus() {}, blockTypeLabel: value => value,
    handleSteeringEvent: () => false,
    noteBackgroundEvent() {}, cloneJson: structuredClone,
  });
  vm.runInContext(html.slice(html.indexOf("const TASK_EVENT_TYPES"), html.indexOf("// ── Event handling")), c);
  vm.runInContext(source("handleEvent"), c);
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

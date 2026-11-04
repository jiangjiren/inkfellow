import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
function source(name) {
  const match = html.match(new RegExp(`(?:async )?function ${name}\\([^]*?^}`, "m"));
  assert.ok(match, `Missing ${name}`);
  return match[0];
}

function fixture() {
  const sent = [], rendered = [], errors = [], timers = new Map();
  const c = vm.createContext({
    currentConvId: "a", conversationSwitchVersion: 0,
    deletedConversationIds: new Set(),
    currentSessionId: null, currentSessionProvider: null,
    conversationDeliveryStates: new Map(), convViewCache: new Map(), convStaleIds: new Set(),
    sessionsRunning: new Set(),
    steeringQueue: [], steeringRemovalPending: new Set(), steeringEditingId: null, steeringDraggingId: null,
    pendingRequestDraft: null, requestRetryTimer: null, errorCompletionTimer: null,
    activeRequestId: "run-a", stopRequested: false, stopResendPending: false, resetRequested: false,
    isGenerating: true, selectedModel: "model", selectedPermissionMode: "auto", selectedEffort: "high",
    activeProfileId: () => "profile", conversationDrafts: new Map(),
    followLatestMessage: true, messageLog: [],
    messagesEl: { innerHTML: "a", scrollTop: 0, classList: { add() {}, remove() {} } },
    ws: { readyState: 1, send(payload) { sent.push(JSON.parse(payload)); } }, WebSocket: { OPEN: 1 },
    renderSteeringTray() {}, materializeSteeringItem(item, event) { rendered.push(event.id); },
    showInlineError(text) { errors.push(text); }, prepareRequestDraft(draft) { draft.displayText ||= draft.text; },
    setTimeout(callback) { const id = timers.size + 1; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    cacheCurrentConversationView() { c.saveConversationDeliveryState(); },
    saveCurrentConversation() {}, hideAskUserQuestion() {}, restoreComposerDraft() {},
    restoreConversationRuntime() {}, finishConversationSwitch() {}, closeSwitcher() {},
    restoreSubtaskThreads() {}, restoreSubtaskPending() {}, restoreSubtaskCards() { return new Set(); }, renderSubtaskHistoryMessage() {},
    isBlankConversation: () => false, forgetConversationLocally() {}, requestAnimationFrame() {},
    addMessage() { return {}; }, renderAssistantBlocks() {}, scrollBottom() {},
  });
  const names = ["conversationDeliveryState", "saveConversationDeliveryState", "restoreConversationDeliveryState",
    "handleBackgroundDeliveryEvent", "settleAcknowledgedSteering", "resendConversationRequests", "normalizeSteeringEvent",
    "upsertSteeringFromEvent", "applySteeringOrder", "reconcileSteeringSnapshot", "handleSteeringEvent",
    "wsSend", "sendSteeringItem", "flushLocalSteering", "requestPayloadForDraft", "loadConversation", "startNewConversation"];
  vm.runInContext(names.map(source).join("\n"), c);
  const event = (id, owner, type = "steering_queued", extra = {}) => c.handleSteeringEvent({
    type, conversationId: owner, userMessageId: id, displayText: id, composerText: id, ...extra,
  });
  return { c, sent, rendered, errors, timers, event };
}

test("switching concurrent conversations restores only each conversation's own queue and editing state", async () => {
  const { c, event } = fixture();
  event("pending-a", "a");
  c.steeringEditingId = "pending-a";
  c.steeringRemovalPending.add("pending-a");
  await c.loadConversation({ id: "b", messages: [] });
  assert.equal(c.steeringQueue.length, 0);
  assert.equal(c.steeringEditingId, null);
  assert.equal(c.steeringRemovalPending.size, 0);
  event("pending-b", "b");
  await c.loadConversation({ id: "a", messages: [] });
  assert.deepEqual(Array.from(c.steeringQueue, item => item.id), ["pending-a"]);
  assert.equal(c.steeringEditingId, "pending-a");
  assert.equal(c.steeringRemovalPending.has("pending-a"), true);
});

test("background application removes its own pending item without rendering into the visible chat", async () => {
  const { c, event, rendered } = fixture();
  event("pending-a", "a");
  await c.loadConversation({ id: "b", messages: [] });
  event("pending-b", "b");
  event("pending-a", "a", "steering_applied");
  assert.deepEqual(Array.from(c.steeringQueue, item => item.id), ["pending-b"]);
  assert.deepEqual(rendered, []);
  assert.equal(c.convStaleIds.has("a"), true);
  assert.equal(c.conversationDeliveryState("a").queue.length, 0);
});

test("reconnect reconciles all owners and retries removal using the item's original conversation", async () => {
  const { c, event, sent } = fixture();
  event("pending-a", "a");
  c.steeringRemovalPending.add("pending-a");
  await c.loadConversation({ id: "b", messages: [] });
  c.handleSteeringEvent({ type: "steering_snapshot", items: [
    { userMessageId: "pending-a", conversationId: "a", displayText: "a edited", paused: true },
    { userMessageId: "pending-b", conversationId: "b", displayText: "b" },
  ] });
  assert.deepEqual(Array.from(c.steeringQueue, item => item.id), ["pending-b"]);
  assert.equal(c.conversationDeliveryState("a").queue[0].paused, true);
  assert.deepEqual(sent, [{ type: "steering_remove", conversationId: "a", userMessageId: "pending-a" }]);
});

test("local drafts retain their conversation, image and model when flushed from another chat", async () => {
  const { c, sent } = fixture();
  c.steeringQueue.push({ id: "local-a", paused: false, sent: false, serverOwned: false,
    draft: { conversationId: "a", text: "a text", model: "a model", images: [{ data: "image-a", mediaType: "image/png" }] },
  });
  await c.loadConversation({ id: "b", messages: [] });
  c.flushLocalSteering();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].conversationId, "a");
  assert.equal(sent[0].model, "a model");
  assert.equal(sent[0].images[0].data, "image-a");
  assert.equal(c.steeringQueue.length, 0);
});

test("a paused local message never auto-sends on reconnect", () => {
  const { c, sent } = fixture();
  c.steeringQueue.push({ id: "local-a", paused: true, sent: false, serverOwned: false,
    draft: { conversationId: "a", text: "keep paused" },
  });
  c.handleSteeringEvent({ type: "steering_snapshot", items: [] });
  assert.equal(sent.length, 0);
  assert.equal(c.steeringQueue[0].paused, true);
});

test("switching preserves the unacknowledged request and a background acknowledgement releases only its own queue", async () => {
  const { c, sent } = fixture();
  c.pendingRequestDraft = { userMessageId: "run-a", wsPayload: { conversationId: "a", userMessageId: "run-a", prompt: "a" } };
  c.steeringQueue.push({ id: "follow-a", paused: false, sent: false, serverOwned: false,
    draft: { conversationId: "a", text: "follow a" },
  });
  await c.loadConversation({ id: "b", messages: [] });
  assert.equal(c.pendingRequestDraft, null);
  c.resendConversationRequests();
  assert.equal(sent[0].userMessageId, "run-a");
  c.handleBackgroundDeliveryEvent({ type: "request_ack", state: "running", conversationId: "a", userMessageId: "run-a" });
  assert.equal(c.conversationDeliveryState("a").pendingDraft, null);
  assert.equal(sent[1].userMessageId, "follow-a");
  assert.equal(sent[1].conversationId, "a");
});

test("late errors and pauses affect only their owning conversation", async () => {
  const { c, event, errors } = fixture();
  event("a", "a");
  await c.loadConversation({ id: "b", messages: [] });
  event("b", "b");
  event("a", "a", "steering_paused");
  event("a", "a", "steering_command_error", { command: "steering_resume" });
  assert.equal(c.steeringQueue[0].paused, false);
  assert.equal(c.conversationDeliveryState("a").queue[0].paused, true);
  assert.deepEqual(errors, []);
});

test("a background next-turn start consumes the queue and invalidates history without rendering", async () => {
  const { c, event, rendered } = fixture();
  event("a", "a", "steering_queued", { delivery: "next_turn" });
  await c.loadConversation({ id: "b", messages: [] });
  c.handleBackgroundDeliveryEvent({ type: "request_started", conversationId: "a", userMessageId: "a" });
  assert.equal(c.conversationDeliveryState("a").queue.length, 0);
  assert.equal(c.convStaleIds.has("a"), true);
  assert.deepEqual(rendered, []);
});

test("creating a new conversation preserves the original conversation's queue and unacknowledged request", async () => {
  const { c, event } = fixture();
  event("pending-a", "a");
  c.pendingRequestDraft = { userMessageId: "run-a" };
  Object.assign(c, {
    promptEl: { value: "", focus() {} }, genId: () => "new",
    resetAssistantState() {}, setGenerating(value) { c.isGenerating = value; }, removeTyping() {},
    clearMentionNotes() {}, adjustPromptHeight() {}, updateBackgroundActivity() {}, rememberConvModelPrefs() {},
    renderSessionTabs() {}, renderSessionSwitcher() {}, sendResetRequest() {},
  });
  await c.startNewConversation();
  assert.equal(c.currentConvId, "new");
  assert.equal(c.steeringQueue.length, 0);
  assert.equal(c.pendingRequestDraft, null);
  assert.equal(c.conversationDeliveryState("a").queue[0].id, "pending-a");
  assert.equal(c.conversationDeliveryState("a").pendingDraft.userMessageId, "run-a");
});

test("background retry callbacks cannot resend a request from the conversation opened afterward", async () => {
  const { c, sent, timers } = fixture();
  c.pendingRequestDraft = { userMessageId: "run-a", wsPayload: { conversationId: "a", userMessageId: "run-a" } };
  await c.loadConversation({ id: "b", messages: [] });
  c.handleBackgroundDeliveryEvent({ type: "request_retry", conversationId: "a", userMessageId: "run-a" });
  c.pendingRequestDraft = { userMessageId: "run-b", wsPayload: { conversationId: "b", userMessageId: "run-b" } };
  for (const callback of timers.values()) callback();
  assert.deepEqual(sent, [{ conversationId: "a", userMessageId: "run-a" }]);
});

test("a reset in one conversation does not block sending in another, and reconnect keeps its reset owner", async () => {
  const { c, sent } = fixture();
  c.resetRequested = true;
  await c.loadConversation({ id: "b", messages: [] });
  assert.equal(c.resetRequested, false);
  c.resendConversationRequests();
  assert.deepEqual(sent, [{ reset: true, conversationId: "a" }]);
  c.handleBackgroundDeliveryEvent({ type: "reset_complete", conversationId: "a" });
  assert.equal(c.conversationDeliveryState("a").resetPending, false);
});

test("delayed provider loading sends the captured text, images and model to its original conversation", async () => {
  const { c, sent } = fixture();
  let resolveProviders;
  Object.assign(c, {
    promptEl: { value: ">Kimi original task" }, _dispatchProvidersLoaded: false,
    looksLikeDispatchAttempt: text => text.startsWith(">"),
    captureComposerDraft: () => ({ text: c.promptEl.value }),
    takeRequestDraft: () => ({ conversationId: "a", composerText: ">Kimi original task", text: ">Kimi original task",
      images: [{ data: "image-a", mediaType: "image/png" }], model: "a model" }),
    ensureDispatchProvidersLoaded: () => new Promise(resolve => { resolveProviders = resolve; }),
    parseProviderDispatchText: () => ({ task: "original task", displayText: "Kimi: original task", profile: { id: "p_kimi" } }),
    genId: () => "delayed-a",
  });
  vm.runInContext([source("enqueueSteering"), source("submitRequest")].join("\n"), c);
  c.submitRequest();
  await c.loadConversation({ id: "b", messages: [] });
  c.promptEl.value = "b unsent draft";
  resolveProviders();
  await Promise.resolve();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].conversationId, "a");
  assert.equal(sent[0].dispatchProvider, "p_kimi");
  assert.equal(sent[0].model, "a model");
  assert.equal(sent[0].images[0].data, "image-a");
  assert.equal(c.promptEl.value, "b unsent draft");
  assert.equal(c.steeringQueue.length, 0);
});

test("an applied or completed retry acknowledgement consumes the original queue after a lost confirmation", async () => {
  for (const state of ["steering_applied", "complete", "stopped", "error"]) {
    const { c, event } = fixture();
    event("a", "a");
    await c.loadConversation({ id: "b", messages: [] });
    event("b", "b");
    c.handleBackgroundDeliveryEvent({ type: "request_ack", state, conversationId: "a", userMessageId: "a" });
    assert.equal(c.conversationDeliveryState("a").queue.length, 0, state);
    assert.equal(c.steeringQueue[0].id, "b");
    assert.equal(c.convStaleIds.has("a"), true);
  }
});

test("a message submitted while stop is pending stays paused until an explicit resume", () => {
  const { c, sent } = fixture();
  c.stopRequested = true;
  c.genId = () => "during-stop";
  vm.runInContext(source("enqueueSteering"), c);
  c.enqueueSteering({ conversationId: "a", text: "keep for later" });
  assert.equal(c.steeringQueue[0].paused, true);
  assert.equal(c.steeringQueue[0].status, "paused");
  c.stopRequested = false;
  c.flushLocalSteering();
  assert.equal(sent.length, 0);
});

test("a paused native claim unlocks its controls after stop or uncertain delivery", () => {
  const { c, event } = fixture();
  event("claim-a", "a", "steering_updated", { claimed: true });
  assert.equal(c.steeringQueue[0].claimed, true);
  event("claim-a", "a", "steering_paused");
  assert.equal(c.steeringQueue[0].claimed, false);
  assert.equal(c.steeringQueue[0].paused, true);
});

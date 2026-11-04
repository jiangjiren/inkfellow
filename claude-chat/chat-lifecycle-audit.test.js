import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
const source = name => {
  const value = html.match(new RegExp(`(?:async )?function ${name}\\([^]*?^}`, "m"));
  assert.ok(value, name);
  return value[0];
};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture(names) {
  const c = vm.createContext({
    currentConvId: "conv-a", selectedModel: "old-model", selectedEffort: "high",
    currentSessionId: "old-session", currentSessionProvider: "claude",
    conversationDrafts: new Map(), conversationDeliveryStates: new Map(), convModelPrefs: new Map(),
    deletedConversationIds: new Set(),
    subtaskView: null, subtaskThreads: new Map(), subtaskDrafts: new Map(), subtaskCardRefs: new Map(),
    profileActivationVersions: new Map(), attachmentVersions: new Map(),
    pendingImages: [], MAX_IMAGES: 20, imagePaints: 0, renderImageChip() { c.imagePaints++; },
    captureComposerDraft: () => ({ text: "a draft", images: [] }),
    renderProfileList(data, { adopt = false } = {}) { c._profileData = { ...data, activeProfileId: adopt ? data.activeProfileId : c.currentProfile }; if (adopt) c.currentProfile = data.activeProfileId; },
    currentProfile: "old", _profileData: { activeProfileId: "old", profiles: [] },
    activeProfileId: () => c.currentProfile, rememberConvModelPrefs() { c.convModelPrefs.set(c.currentConvId, { profileId: c.currentProfile }); },
    persistConvModelPrefs() {}, persistConvPrefsToServer() {},
    setAuthStatus() {}, closeAuthDialog() {}, setTimeout() {}, clearTimeout() {},
    resets: [], resetProviderSession(owner = c.currentConvId) { c.resets.push(owner); },
    localStorage: { getItem() { return null; }, setItem() {} },
    CLAUDE_MODELS: [{ model: "claude-model" }], CODEX_MODELS: [{ model: "codex-model" }], AGY_MODELS: [{ model: "agy-model" }], MODEL_MIGRATIONS: {},
    sessionsRunning: new Set(["conv-a"]), sessionsAwaiting: new Set(), sessionUnread: new Set(), renderSessionBadges() {},
    handleSteeringEvent: () => false, resetRequested: false, activeRequestId: "new-run", TASK_EVENT_TYPES: new Set(),
    convViewCache: new Map([["conv-a", { html: "old messages" }]]), convStaleIds: new Set(),
    messageLog: [{ role: "user", text: "old messages" }], messagesEl: { innerHTML: "old messages", classList: { add() {}, remove() {} } },
    promptEl: { value: "draft" }, recentConvIds: ["conv-a"], _historyCache: [{ id: "conv-a" }],
    releaseConvSlot() {}, clearAskUserQuestion() {}, renderHistoryFromData() {}, renderHistoryList() {},
    restoreConversationDeliveryState() {}, genId: () => "new-conv", errors: [], showInlineError(text) { c.errors.push(text); },
    conversationSwitchVersion: 0, errorCompletionTimer: null, pendingRequestDraft: null, requestRetryTimer: null,
    resetAssistantState() {}, setGenerating() {}, removeTyping() {}, updateBackgroundActivity() {},
    restoreComposerDraft() { c.promptEl.value = ""; c.pendingImages = []; },
  });
  vm.runInContext(names.map(source).join("\n"), c);
  return c;
}

test("an image that finishes reading after a switch belongs to the original conversation", () => {
  const c = fixture(["addImage"]);
  c.currentConvId = "conv-b";
  c.addImage("data:image/png;base64,aW1hZ2U=", "image/png", "conv-a");
  assert.equal(c.pendingImages.length, 0);
  assert.equal(c.conversationDrafts.get("conv-a").images[0].data, "aW1hZ2U=");
  assert.equal(c.imagePaints, 0);
});

test("account activation completing after a switch cannot adopt or reset the newly visible chat", async () => {
  const c = fixture(["modelOptionsForProfile", "applyConversationProfile", "activateProfile"]), response = deferred();
  c.fetch = () => response.promise;
  const activation = c.activateProfile("new-profile");
  c.currentConvId = "conv-b"; c.currentProfile = "b-profile";
  c.convModelPrefs.set("conv-b", { profileId: "b-profile" });
  response.resolve({ ok: true, json: async () => ({ resetSession: true, data: {
    activeProfileId: "new-profile", profiles: [{ id: "new-profile", provider: "codex" }, { id: "b-profile", provider: "claude" }],
  } }) });
  await activation;
  assert.equal(c.currentProfile, "b-profile");
  assert.equal(c.convModelPrefs.get("conv-b").profileId, "b-profile");
  assert.equal(c.convModelPrefs.get("conv-a").profileId, "new-profile");
  assert.deepEqual(c.resets, ["conv-a"]);
});

test("out-of-order account activation responses preserve the last selection", async () => {
  const c = fixture(["modelOptionsForProfile", "applyConversationProfile", "activateProfile"]), first = deferred(), second = deferred();
  let count = 0;
  c.fetch = () => (++count === 1 ? first.promise : second.promise);
  const a = c.activateProfile("profile-first"), b = c.activateProfile("profile-last");
  const reply = id => ({ ok: true, json: async () => ({ data: { activeProfileId: id, profiles: [{ id, provider: "codex" }] } }) });
  second.resolve(reply("profile-last")); await b;
  first.resolve(reply("profile-first")); await a;
  assert.equal(c.currentProfile, "profile-last");
});

test("account resets follow the conversation's change even when the server default already matches", async () => {
  const c = fixture(["modelOptionsForProfile", "applyConversationProfile", "activateProfile"]);
  c.fetch = async () => ({ ok: true, json: async () => ({ resetSession: false, data: {
    activeProfileId: "new", profiles: [{ id: "new", provider: "codex" }],
  } }) });
  await c.activateProfile("new");
  assert.deepEqual(c.resets, ["conv-a"]);
});

test("reselecting the same account does not interrupt its run because another chat changed the server default", async () => {
  const c = fixture(["modelOptionsForProfile", "applyConversationProfile", "activateProfile"]);
  c.fetch = async () => ({ ok: true, json: async () => ({ resetSession: true, data: {
    activeProfileId: "old", profiles: [{ id: "old", provider: "codex" }],
  } }) });
  await c.activateProfile("old");
  assert.deepEqual(c.resets, []);
});

test("late terminal events from an old request cannot clear the new request's running badge", () => {
  const c = fixture(["staleConversationTerminal", "handleEvent"]);
  c.handleEvent({ type: "done", conversationId: "conv-a", userMessageId: "old-run" });
  assert.equal(c.sessionsRunning.has("conv-a"), true);
  assert.equal(c.activeRequestId, "new-run");
});

test("a failed delete preserves history and the current conversation", async () => {
  const c = fixture(["deleteConversation"]);
  c.fetch = async () => ({ ok: false, status: 500 });
  await c.deleteConversation("conv-a");
  assert.equal(c.currentConvId, "conv-a");
  assert.equal(c.convViewCache.has("conv-a"), true);
  assert.equal(c._historyCache.length, 1);
  assert.equal(c.errors.length, 1);
});

test("late image reads are discarded after sending or clearing the owning draft", () => {
  const c = fixture(["addImage", "clearImages"]);
  c.clearImages();
  c.currentConvId = "conv-b";
  c.addImage("data:image/png;base64,b2xk", "image/png", "conv-a", 0);
  assert.equal(c.conversationDrafts.has("conv-a"), false);
  assert.equal(c.pendingImages.length, 0);
});

test("background image reads preserve the owner's text, mentions and quote", () => {
  const c = fixture(["addImage"]);
  const draft = { text: "keep", images: [], mentions: [{ path: "note.md" }], quote: { text: "quote" } };
  c.conversationDrafts.set("conv-a", draft);
  c.currentConvId = "conv-b";
  c.addImage("data:image/png;base64,aW1hZ2U=", "image/png", "conv-a", 0);
  assert.equal(draft.text, "keep");
  assert.equal(draft.mentions[0].path, "note.md");
  assert.equal(draft.quote.text, "quote");
});

test("successful deletion opens a clean conversation and invalidates pending image reads", async () => {
  const c = fixture(["deleteConversation", "addImage"]);
  c.fetch = async () => ({ ok: true });
  const cancelledTimers = [];
  c.requestRetryTimer = "draft-retry";
  c.clearTimeout = timer => cancelledTimers.push(timer);
  c.pendingImages = [{ data: "old" }];
  c.subtaskThreads.set("a", { conversationId: "conv-a" });
  c.subtaskThreads.set("b", { conversationId: "conv-b" });
  c.subtaskDrafts.set("a", "draft"); c.subtaskCardRefs.set("a", {});
  assert.equal(await c.deleteConversation("conv-a"), true);
  assert.equal(c.subtaskThreads.has("a"), false);
  assert.equal(c.subtaskDrafts.has("a"), false);
  assert.equal(c.subtaskCardRefs.has("a"), false);
  assert.equal(c.subtaskThreads.has("b"), true);
  assert.equal(c.currentConvId, "new-conv");
  assert.equal(c.messageLog.length, 0);
  assert.equal(c.messagesEl.innerHTML, "");
  assert.equal(c.promptEl.value, "");
  assert.equal(c.currentSessionId, null);
  assert.equal(c.activeRequestId, null);
  assert.ok(cancelledTimers.includes("draft-retry"));
  c.addImage("data:image/png;base64,b2xk", "image/png", "conv-a", 0);
  assert.equal(c.conversationDrafts.has("conv-a"), false);
});

test("a save that returns after deletion cannot recreate the deleted history summary", async () => {
  const c = fixture(["saveCurrentConversation"]), response = deferred();
  c.fetch = () => response.promise;
  const save = c.saveCurrentConversation();
  c.deletedConversationIds.add("conv-a"); c._historyCache = [];
  response.resolve({ ok: true });
  await save;
  assert.equal(c._historyCache.length, 0);
});

test("buffered events and stale snapshots cannot resurrect a deleted conversation's badges", () => {
  const c = fixture(["handleEvent", "applySessionsSnapshot"]);
  c.deletedConversationIds.add("conv-a");
  c.sessionsRunning.clear();
  c.pendingAskUserQuestions = new Map();
  c.handleEvent({ type: "request_started", conversationId: "conv-a", userMessageId: "late" });
  c.applySessionsSnapshot({ running: ["conv-a"], awaiting: ["conv-a"] });
  assert.equal(c.sessionsRunning.size, 0);
  assert.equal(c.sessionsAwaiting.size, 0);
});

test("offline account resets retry the exact owner and preserve history on reconnect", () => {
  const c = fixture(["conversationDeliveryState", "resetProviderSession", "resendConversationRequests"]);
  c.currentConvId = "conv-b";
  c.resetRequested = false;
  c.saveConversationDeliveryState = () => {};
  c.calls = []; c.wsSend = message => { c.calls.push(message); return false; };
  c._historyCache = [{ id: "conv-a", sessionId: "old", sessionProvider: "codex" }];
  c.resetProviderSession("conv-a");
  assert.equal(c.currentSessionId, "old-session");
  assert.equal(c.resetRequested, false);
  assert.equal(c.conversationDeliveryStates.get("conv-a").resetPending, true);
  assert.equal(c._historyCache[0].sessionId, null);
  c.resendConversationRequests();
  assert.equal(c.calls.length, 2);
  for (const message of c.calls) {
    assert.equal(message.conversationId, "conv-a");
    assert.equal(message.preserveMessages, true);
  }
});

test("background terminal events from a prior request preserve its new run", () => {
  const c = fixture(["staleConversationTerminal", "handleEvent", "noteBackgroundEvent"]);
  c.currentConvId = "conv-b";
  c.conversationDeliveryStates.set("conv-a", { activeRequestId: "new-a" });
  c.handleEvent({ type: "done", conversationId: "conv-a", userMessageId: "old-a" });
  c.noteBackgroundEvent({ type: "system", subtype: "session_state_changed", state: "idle", conversationId: "conv-a", userMessageId: "old-a" });
  assert.equal(c.sessionsRunning.has("conv-a"), true);
});

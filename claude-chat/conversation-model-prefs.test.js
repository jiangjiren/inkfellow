import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
const source = name => html.match(new RegExp(`(?:async )?function ${name}\\([^]*?^}`, "m"))[0];
const prefsBlock = html.slice(
  html.indexOf('const CONV_MODEL_PREFS_KEY'),
  html.indexOf('const modelBtn      = document.getElementById'),
);

function harness({ profiles = [{ id: "p_codex", provider: "codex" }], history = null } = {}) {
  const store = new Map();
  const c = vm.createContext({
    currentConvId: "conv-0001", configuredParentToken: null,
    deletedConversationIds: new Set(),
    selectedModel: "gpt-5.4", selectedEffort: "high", selectedCodexSpeed: null,
    currentSessionId: "thread-abc", currentSessionProvider: "codex",
    messageLog: [{ role: "user", text: "项目叫青松" }],
    _profileData: { activeProfileId: profiles[0]?.id ?? null, profiles },
    _historyCache: history,
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    },
    activeProfileId: () => c._profileData.activeProfileId,
    getActiveProfile: () => c._profileData.profiles.find(p => p.id === c._profileData.activeProfileId) ?? null,
    currentConvProfileId: () => c.convModelPrefs.get(c.currentConvId)?.profileId ?? null,
    renderProfileList() { c.calls.push("renderProfileList"); },
    renderModelOptions() { c.calls.push("renderModelOptions"); },
    calls: [], puts: [],
    fetch(url, init) {
      c.puts.push({ url, method: init?.method, body: JSON.parse(init?.body ?? "null") });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    },
  });
  vm.runInContext(source("agentApiFetch"), c);
  vm.runInContext(prefsBlock, c);
  vm.runInContext(source("saveCurrentConversation"), c);
  vm.runInContext("globalThis.convModelPrefs = convModelPrefs;", c);
  return c;
}

test("Codex speed persists per conversation and the draft matches model capability", () => {
  const c = harness({ history: [{ id: "conv-0001", model: "gpt-6.2-sol", effort: "ultra", profileId: "p_codex" }] });
  c.CODEX_MODELS = [
    { model: "gpt-6.2-sol", efforts: ["low", "high", "max", "ultra"], fast: true },
    { model: "gpt-6-luna", efforts: ["low", "high", "max"], fast: false },
  ];
  vm.runInContext(html.match(/const CODEX_EFFORT_ORDER = [^;]+;/)[0], c);
  vm.runInContext([
    "selectedCodexModel", "effortLevelsForCurrentModel", "effectiveEffort",
    "effectiveCodexSpeed", "requestThinkingSettings",
  ].map(source).join("\n"), c);
  c.adoptServerConvPrefs({ id: "conv-0001", model: "gpt-6.2-sol", effort: "ultra", codexSpeed: "fast", profileId: "p_codex" });
  c.selectedModel = "gpt-6.2-sol";
  c.applyConvModelPrefs();
  assert.equal(c.requestThinkingSettings().effort, "ultra");
  assert.equal(c.requestThinkingSettings().codexSpeed, "fast");
  c.selectedModel = "gpt-6-luna";
  assert.equal(c.requestThinkingSettings().effort, "max");
  assert.equal(c.requestThinkingSettings().codexSpeed, "standard");
  c.selectedModel = "gpt-6.2-sol";
  c.selectedCodexSpeed = "standard";
  c.rememberConvModelPrefs();
  assert.equal(c.puts.at(-1).body.codexSpeed, "standard");
  c.currentConvId = "old-conversation";
  c.applyConvModelPrefs();
  assert.equal(c.requestThinkingSettings().codexSpeed, "standard");
});

test("the lightning button toggles Standard and Fast only on capable Codex models", () => {
  const c = harness();
  const attributes = {};
  c.codexSpeedBtn = {
    setAttribute(name, value) { attributes[name] = value; },
    addEventListener(type, listener) { c.toggleSpeed = listener; },
  };
  c.codexSpeedLabel = {};
  c.closeHeaderPickers = () => {};
  c.CODEX_MODELS = [{ model: "gpt-6.2-sol", fast: true }];
  c.selectedModel = "gpt-6.2-sol";
  vm.runInContext([
    "selectedCodexModel", "effectiveCodexSpeed", "updateCodexSpeedDisplay",
  ].map(source).join("\n"), c);
  vm.runInContext(html.match(/^codexSpeedBtn\.addEventListener\("click", [^]*?^\}\);/m)[0], c);

  c.updateCodexSpeedDisplay();
  assert.equal(c.codexSpeedBtn.hidden, false);
  assert.equal(c.codexSpeedLabel.textContent, "Standard");
  c.toggleSpeed({ stopPropagation() {} });
  assert.equal(c.codexSpeedLabel.textContent, "Fast");
  assert.equal(attributes["aria-pressed"], "true");
  assert.equal(c.convModelPrefs.get(c.currentConvId).codexSpeed, "fast");

  c.toggleSpeed({ stopPropagation() {} });
  assert.equal(c.codexSpeedLabel.textContent, "Standard");
  assert.equal(attributes["aria-pressed"], "false");
  c.selectedModel = "unsupported";
  c.updateCodexSpeedDisplay();
  assert.equal(c.codexSpeedBtn.disabled, true);
  c.getActiveProfile = () => ({ provider: "claude" });
  c.updateCodexSpeedDisplay();
  assert.equal(c.codexSpeedBtn.hidden, true);
});

test("本地没记录时认服务端历史里那份厂商和模型", () => {
  const c = harness();
  c.adoptServerConvPrefs({ id: "conv-0001", model: "gpt-5.4-codex", effort: "medium", profileId: "p_codex" });
  const pref = c.convModelPrefs.get("conv-0001");
  assert.equal(pref.model, "gpt-5.4-codex");
  assert.equal(pref.effort, "medium");
  assert.equal(pref.profileId, "p_codex");
  // 也要落盘，下次开应用不用再问服务端一遍
  assert.match(c.localStorage.getItem("convModelPrefs-v1"), /gpt-5\.4-codex/);
});

test("本地已有记录时不被服务端那份覆盖", () => {
  const c = harness();
  c.convModelPrefs.set("conv-0001", { model: "claude-opus-5", effort: "high", profileId: "p_claude" });
  c.adoptServerConvPrefs({ id: "conv-0001", model: "gpt-5.4", effort: "low", profileId: "p_codex" });
  assert.equal(c.convModelPrefs.get("conv-0001").model, "claude-opus-5");
});

test("服务端记的账号已经删了就不认它，其余照收", () => {
  const c = harness();
  c.adoptServerConvPrefs({ id: "conv-0001", model: "gpt-5.4", effort: "low", profileId: "p_gone" });
  const pref = c.convModelPrefs.get("conv-0001");
  assert.equal(pref.model, "gpt-5.4");
  assert.equal("profileId" in pref, false, "指向死账号只会让每次切进来都白判断一次");
});

test("什么都没记的历史条目不凭空造一条记录", () => {
  const c = harness();
  c.adoptServerConvPrefs({ id: "conv-0001", title: "旧对话" });
  assert.equal(c.convModelPrefs.has("conv-0001"), false);
});

test("保存对话时把厂商、模型、档位一起写进历史", async () => {
  const c = harness();
  await c.saveCurrentConversation();
  const [put] = c.puts;
  assert.equal(put.method, "PUT");
  assert.match(put.url, /conv-0001$/);
  assert.equal(put.body.model, "gpt-5.4");
  assert.equal(put.body.effort, "high");
  assert.equal(put.body.profileId, "p_codex");
  assert.equal(put.body.sessionProvider, "codex");
});

test("改模型就补写服务端，但带上原来的 date，不把对话顶到列表最前面", () => {
  const c = harness({ history: [{ id: "conv-0001", date: "2026-01-01T00:00:00.000Z", model: "gpt-5.4-codex" }] });
  c.rememberConvModelPrefs();
  const [put] = c.puts;
  assert.equal(put.body.model, "gpt-5.4");
  assert.equal(put.body.date, "2026-01-01T00:00:00.000Z");
  assert.equal("title" in put.body, false, "只补选择，不动标题和消息");
  // 再记一次，值没变就不该再发一趟
  c.rememberConvModelPrefs();
  assert.equal(c.puts.length, 1);
});

test("服务端还没有这条对话时不补写，免得凭空建一条空对话", () => {
  const c = harness({ history: [] });
  c.rememberConvModelPrefs();
  assert.deepEqual(c.puts, []);
  // 历史面板没打开过、缓存还是 null 时同样不猜
  const fresh = harness();
  fresh.rememberConvModelPrefs();
  assert.deepEqual(fresh.puts, []);
});

function modelPickerHarness(profiles) {
  const c = harness({ profiles });
  Object.assign(c, {
    modelDropdown: { querySelector: () => ({ innerHTML: "" }) },
    modelLabel: { textContent: "" },
    escapeHtml: String, escapeAttr: String,
    updateEffortDisplay() {},
  });
  vm.runInContext(html.match(/const CLAUDE_MODELS = \[[^]*?\n\];/)[0], c);
  vm.runInContext(html.match(/const MODEL_MIGRATIONS = \{[^]*?\n\};/)[0], c);
  vm.runInContext(html.match(/let CODEX_MODELS = \[[^]*?\n\];/)[0], c);
  vm.runInContext(html.match(/let AGY_MODELS = \[[^]*?\n\];/)[0], c);
  vm.runInContext(html.match(/let AGY_EFFORT_LEVELS = \{[^]*?\n\};/)[0], c);
  c.loadCodexModelCatalog = () => {};
  c.loadAgyModelCatalog = () => {};
  vm.runInContext([
    "modelOptionsForProfile", "defaultChatModel", "upgradeLegacyAgyModel", "renderModelOptions", "applyConversationProfile",
  ].map(source).join("\n"), c);
  return c;
}

test("Gemini defaults to Neon and upgrades saved Flash conversations to Hydrogen", () => {
  const gemini = { id: "p_agy", provider: "antigravity", sonnetModel: "gemini-3.8-flash" };
  const claude = { id: "p_claude", provider: "claude" };
  const c = modelPickerHarness([gemini, claude]);
  c.localStorage.setItem("model:p_agy", "gemini-3.8-flash");
  c.renderModelOptions(gemini);
  assert.equal(c.selectedModel, "gemini-4-neon");
  assert.equal(c.modelLabel.textContent, "Gemini 4 Neon");
  assert.ok(c.modelOptionsForProfile(gemini).some(option => option.model === "gemini-4-carbon"));
  assert.ok(!c.modelOptionsForProfile(gemini).some(option => option.model === "gemini-3.8-flash"));

  const owner = "background-chat";
  c.convModelPrefs.set(owner, { profileId: claude.id, model: "claude-opus-5-5", effort: "high" });
  c.applyConversationProfile(c._profileData, owner, gemini.id, "medium");
  assert.equal(c.convModelPrefs.get(owner).model, "gemini-4-neon");

  c.convModelPrefs.set(owner, { profileId: gemini.id, model: "gemini-3.8-flash", effort: "low" });
  c.applyConversationProfile(c._profileData, owner, gemini.id, "medium");
  assert.equal(c.convModelPrefs.get(owner).model, "gemini-4-hydrogen");
  c.convModelPrefs.set(owner, { profileId: gemini.id, model: "gemini-3.8-flash", effort: "low" });
  c.currentConvId = owner;
  c.applyConvModelPrefs();
  assert.equal(c.selectedModel, "gemini-4-hydrogen");
  assert.equal(c.convModelPrefs.get(owner).model, "gemini-4-hydrogen");
  assert.equal(c.selectedEffort, "low");
});

test("旧 Hydrogen 独立型号恢复为 Hydrogen 极高档，请求持久化时保留两者", async () => {
  const c = modelPickerHarness([{ id: "p_agy", provider: "antigravity", sonnetModel: "gemini-3.8-flash" }]);
  c.adoptServerConvPrefs({ id: "conv-0001", model: "gemini-4-hydrogen-xhigh", effort: "medium", profileId: "p_agy" });
  c.applyConvModelPrefs();
  assert.equal(c.modelLabel.textContent, "Gemini 4 Hydrogen");
  assert.equal(c.selectedEffort, "xhigh");
  c.applyConvModelPrefs();
  await c.saveCurrentConversation();
  assert.equal(c.puts.at(-1).body.model, "gemini-4-hydrogen");
  assert.equal(c.puts.at(-1).body.effort, "xhigh");
});

test("Terra selection survives model menu rendering and conversation persistence", async () => {
  const c = modelPickerHarness([{ id: "p_codex", provider: "codex", sonnetModel: "gpt-6-sol" }]);
  c.localStorage.setItem("model:p_codex", "gpt-6.1-terra");
  c.localStorage.setItem("effort", "low");
  c.selectedEffort = "low";
  c.renderModelOptions(c.getActiveProfile());
  assert.equal(c.selectedModel, "gpt-6.2-sol");
  assert.equal(c.selectedEffort, "high");
  c.adoptServerConvPrefs({ id: "conv-0001", model: "gpt-6.1-terra", effort: "xhigh", profileId: "p_codex" });
  c.localStorage.setItem("model:p_codex", "gpt-6-sol");
  c.applyConvModelPrefs();
  assert.equal(c.selectedModel, "gpt-6.1-terra");
  assert.equal(c.modelLabel.textContent, "GPT-6.1 Terra");
  assert.equal(c.selectedEffort, "xhigh");
  await c.saveCurrentConversation();
  assert.equal(c.puts.at(-1).body.model, "gpt-6.1-terra");
  assert.equal(c.puts.at(-1).body.profileId, "p_codex");
  assert.match(c.localStorage.getItem("convModelPrefs-v1"), /gpt-6\.1-terra/);
});

test("旧 Claude 对话升级 Sonnet 5.5，保留账号和推理强度并持久化", () => {
  const c = modelPickerHarness([{ id: "p_claude", provider: "claude" }]);
  c.selectedEffort = "xhigh";
  c.convModelPrefs.set("conv-0001", { model: "claude-sonnet-5", effort: "xhigh", profileId: "p_claude" });
  c.renderModelOptions(c.getActiveProfile());
  assert.equal(c.selectedModel, "claude-sonnet-5-5");
  assert.equal(c.modelLabel.textContent, "Sonnet 5.5");
  assert.equal(c.selectedEffort, "xhigh");
  const stored = JSON.parse(c.localStorage.getItem("convModelPrefs-v1"))[0][1];
  assert.deepEqual(stored, { model: "claude-sonnet-5-5", effort: "xhigh", profileId: "p_claude" });
  assert.equal(c.localStorage.getItem("model:claude"), "claude-sonnet-5-5");
});

test("旧 Claude 全局模型选择也升级，已有 Opus 选择保持不变", () => {
  const c = modelPickerHarness([{ id: "p_claude", provider: "claude" }]);
  c.localStorage.setItem("model:claude", "claude-sonnet-5");
  c.renderModelOptions(c.getActiveProfile());
  assert.equal(c.selectedModel, "claude-sonnet-5-5");
  assert.equal(c.localStorage.getItem("model:claude"), "claude-sonnet-5-5");
  c.localStorage.setItem("model:claude", "claude-opus-5-5");
  c.renderModelOptions(c.getActiveProfile());
  assert.equal(c.selectedModel, "claude-opus-5-5");
});

test("选着 Fable 5 / 5.1 的升级到 Fable 5.2，对话自己记的那份和全局选择都跟着换", () => {
  const c = modelPickerHarness([{ id: "p_claude", provider: "claude" }]);
  c.localStorage.setItem("model:claude", "claude-fable-5");
  c.renderModelOptions(c.getActiveProfile());
  assert.equal(c.selectedModel, "claude-fable-5-2");
  assert.equal(c.modelLabel.textContent, "Fable 5.2");
  assert.equal(c.localStorage.getItem("model:claude"), "claude-fable-5-2");

  c.convModelPrefs.set("conv-0001", { model: "claude-fable-5-1", effort: "max", profileId: "p_claude" });
  c.renderModelOptions(c.getActiveProfile());
  assert.equal(c.selectedModel, "claude-fable-5-2");
  assert.equal(c.convModelPrefs.get("conv-0001").model, "claude-fable-5-2");
});

test("Claude 会员迁移不修改 API 账号的同名模型配置", () => {
  const c = modelPickerHarness([{ id: "p_api", provider: "custom", sonnetModel: "claude-sonnet-5" }]);
  c.convModelPrefs.set("conv-0001", { model: "claude-sonnet-5", effort: "high", profileId: "p_api" });
  c.renderModelOptions(c.getActiveProfile());
  assert.equal(c.selectedModel, "claude-sonnet-5");
  assert.equal(c.convModelPrefs.get("conv-0001").model, "claude-sonnet-5");
  assert.equal(c.localStorage.getItem("model:claude"), null);
});

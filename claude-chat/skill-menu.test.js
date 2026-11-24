import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
const server = await readFile(new URL("./server.js", import.meta.url), "utf8");
const source = (name, input = html) => input.match(new RegExp(`(?:async )?function ${name}\\([^]*?^}`, "m"))[0];

function harness(profiles) {
  const c = vm.createContext({
    WebSocket: { OPEN: 1 },
    ws: { readyState: 1 },
    sent: [],
    wsSend(msg) { c.sent.push(msg); },
    _profileData: { activeProfileId: profiles[0].id, profiles },
    activeProfileId: () => c._profileData.activeProfileId,
    getActiveProfile: () => c._profileData.profiles.find(p => p.id === c._profileData.activeProfileId) ?? null,
  });
  vm.runInContext("let currentSkillProvider = null;\n" + source("activeSkillProvider") + "\n" + source("requestSkillRefresh"), c);
  return c;
}

test("「/」技能菜单：Claude、Codex、agy 三家互切都会重新拉，同类账号之间不重复拉", () => {
  const c = harness([
    { id: "p_claude", provider: "claude" },
    { id: "p_claude2", provider: "claude" },
    { id: "p_api", provider: "deepseek" },
    { id: "p_agy", provider: "antigravity" },
    { id: "p_codex", provider: "codex" },
  ]);
  const switchTo = (id) => { c._profileData.activeProfileId = id; c.requestSkillRefresh(); };

  c.requestSkillRefresh();
  assert.deepEqual(c.sent.map(m => m.provider), ["claude"]);

  // 另一个会员号、API 账号都走 Claude SDK，技能是同一份
  switchTo("p_claude2");
  switchTo("p_api");
  assert.equal(c.sent.length, 1);

  // 以前 agy 被归成 claude，这一步不发请求，菜单里留着 Claude 的技能
  switchTo("p_agy");
  assert.deepEqual({ ...c.sent.at(-1) }, { type: "skills", provider: "antigravity", profileId: "p_agy" });

  switchTo("p_codex");
  switchTo("p_claude");
  assert.deepEqual(c.sent.map(m => m.provider), ["claude", "antigravity", "codex", "claude"]);
});

test("an explicit empty SDK discovery removes old plugin commands from the menu and cache", () => {
  const writes = [];
  const context = vm.createContext({
    sdkSkillsByProvider: { claude: ["uninstalled:command"] }, cachedSkillsByProvider: {},
    loadSkillsFromDisk: () => ["installed-local"], normalizeSkillProvider: provider => provider,
    DATA_DIR: "test", SDK_SKILLS_CACHE_FILE: "cache.json", mkdirSync() {},
    writeFileSync: (_path, contents) => writes.push(JSON.parse(contents)),
  });
  vm.runInContext(source("rememberSdkSkills", server) + "\n" + source("skillsForProvider", server), context);
  context.rememberSdkSkills("claude", {});
  assert.deepEqual([...context.skillsForProvider("claude")], ["installed-local", "uninstalled:command"]);
  assert.equal(writes.length, 0);

  context.rememberSdkSkills("claude", { skills: [], slash_commands: ["compact"] });
  assert.deepEqual([...context.skillsForProvider("claude")], ["installed-local"]);
  assert.deepEqual(writes, [{ claude: [] }]);
});

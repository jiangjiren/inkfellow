import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { fileNameFor } from "./history-store.js";

const html = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
const source = name => html.match(new RegExp(`(?:async )?function ${name}\\([^]*?^}`, "m"))[0];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("ordinary save and stale history responses cannot revert a successful rename", async () => {
  const save = deferred();
  const refresh = deferred();
  const c = vm.createContext({
    _historyCache: [{ id: "conv-a", title: "Original custom title" }],
    historyMutationVersion: 0, historyFetchVersion: 0, configuredParentToken: null,
    currentConvId: "conv-a", deletedConversationIds: new Set(),
    messageLog: [{ role: "user", text: "First question" }],
    currentSessionId: "session-a", currentSessionProvider: "codex",
    selectedModel: "test", selectedEffort: "high", selectedCodexSpeed: null, activeProfileId: () => "profile-a",
    fetch: (url, options) => options ? save.promise : refresh.promise,
  });
  vm.runInContext([source("agentApiFetch"), source("saveCurrentConversation"), source("fetchHistory")].join("\n"), c);
  const saving = c.saveCurrentConversation();
  const refreshing = c.fetchHistory();
  c.currentConvId = "conv-b";
  c._historyCache[0].title = "New manual title";
  c.historyMutationVersion += 1;
  save.resolve({ ok: true, json: async () => ({ title: "Original custom title" }) });
  await saving;
  refresh.resolve({ ok: true, json: async () => [{ id: "conv-a", title: "First question" }] });
  await refreshing;
  assert.equal(c._historyCache[0].title, "New manual title");
  assert.equal(c._historyCache[0].id, "conv-a");
});

test("newest history request wins even when older request returns last", async () => {
  const old = deferred();
  const c = vm.createContext({
    _historyCache: [], historyMutationVersion: 0, historyFetchVersion: 0, configuredParentToken: null,
    deletedConversationIds: new Set(), fetch: () => old.promise,
  });
  vm.runInContext([source("agentApiFetch"), source("fetchHistory")].join("\n"), c);
  const pending = c.fetchHistory();
  c.fetch = async () => ({ ok: true, json: async () => [{ id: "conv-a", title: "Latest" }] });
  await c.fetchHistory();
  old.resolve({ ok: true, json: async () => [{ id: "conv-a", title: "Stale" }] });
  await pending;
  assert.equal(c._historyCache[0].title, "Latest");
});

test("title-only rename survives stale saves and process restart without changing other data", { timeout: 25_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "inkfellow-title-"));
  const net = createServer();
  await new Promise(resolve => net.listen(0, "127.0.0.1", resolve));
  const port = net.address().port;
  await new Promise(resolve => net.close(resolve));
  const auth = join(scratch, "auth.json");
  await writeFile(auth, JSON.stringify({ activeProfileId: "p_codex", profiles: [{ id: "p_codex", name: "Offline", provider: "codex" }] }));
  let child;
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const closed = new Promise(resolve => child.once("close", resolve));
    child.kill();
    await closed;
  };
  const boot = async () => {
    let output = "";
    child = spawn(process.execPath, ["server.js"], {
      cwd: new URL(".", import.meta.url), windowsHide: true,
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DESKTOP_AGENT_TOKEN: "test", CLAUDE_CHAT_DATA_DIR: scratch, CLAUDE_CHAT_AUTH_PROFILE_FILE: auth },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const deadline = Date.now() + 8000;
    while (!output.includes("claude-chat listening")) {
      if (child.exitCode !== null || Date.now() > deadline) throw Error(output);
      await delay(20);
    }
  };
  const api = (method = "GET", body, id = "conv-title") => fetch(`http://127.0.0.1:${port}/api/history/${id}`, {
    method, headers: { "Content-Type": "application/json", Authorization: "Bearer test" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const initial = {
    title: "Legacy manual title", date: "2026-01-01T00:00:00.000Z",
    sessionId: "thread-a", sessionProvider: "codex", model: "test-model", effort: "high", profileId: "p_codex",
    messages: [{ id: "u1", role: "user", text: "Original question" }],
  };
  try {
    await boot();
    assert.equal((await api("PUT", initial)).status, 200);
    // Preserve old custom titles even before the first new-style rename.
    await api("PUT", { title: "Original question", date: initial.date });
    assert.equal((await (await api()).json()).title, initial.title);
    const shard = join(scratch, "conversations", fileNameFor("conv-title"));
    const backup = `${shard}.backup`;
    await rename(shard, backup);
    await mkdir(shard);
    try {
      assert.equal((await api("PATCH", { title: "Failed rename" })).status, 400);
      assert.equal((await (await api()).json()).title, initial.title);
    } finally {
      await rmdir(shard);
      await rename(backup, shard);
    }
    assert.equal((await api("PATCH", { title: "  手动命名后的对话  ", model: "stale", messages: [], date: "2020-01-01" })).status, 200);
    const renamed = await (await api()).json();
    for (const [key, value] of Object.entries(initial)) {
      assert.deepEqual(renamed[key], key === "title" ? "手动命名后的对话" : value, key);
    }
    await api("PUT", { title: "Original question", date: initial.date });
    assert.equal((await (await api()).json()).title, "手动命名后的对话");
    for (const title of ["", "   ", "x".repeat(121), "two\nlines"]) {
      assert.equal((await api("PATCH", { title })).status, 400);
    }
    assert.equal((await api("PATCH", { title: "Missing" }, "conv-missing")).status, 404);
    // Kill instead of graceful shutdown: PATCH must have flushed before returning 200.
    await stop();
    await boot();
    assert.equal((await (await api()).json()).title, "手动命名后的对话");
    const summaries = await (await fetch(`http://127.0.0.1:${port}/api/history`, {
      headers: { Authorization: "Bearer test" },
    })).json();
    assert.equal(summaries.find(c => c.id === "conv-title").title, "手动命名后的对话");
    await api("DELETE");
    assert.equal((await api("PATCH", { title: "Resurrected" })).status, 410);
    assert.equal((await api("PUT", initial)).status, 410);
    assert.equal((await api()).status, 404);
  } finally {
    await stop();
    await rm(scratch, { recursive: true, force: true });
  }
});

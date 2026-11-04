import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PRIMARY_CLAUDE_PROFILE_ID,
  claudeAccountConfigDir,
  claudeLoginManualCommand,
  hasLocalClaudeCredentials,
  launchClaudeLogin,
  normalizeLoginEmail,
  parseClaudeAuthStatus,
  prepareClaudeAccountDir,
  removeClaudeAccountDir,
} from "./claude-accounts.js";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function scratchDir(label) {
  return mkdtempSync(join(tmpdir(), `inkfellow-claude-accounts-${label}-`));
}

/** 一个假的主号配置目录：几样要共用的东西各放一点，能看出链过去之后读到的是不是同一份 */
function makeMainDir(root) {
  const mainDir = join(root, "main-claude");
  mkdirSync(join(mainDir, "skills", "demo"), { recursive: true });
  writeFileSync(join(mainDir, "skills", "demo", "SKILL.md"), "demo skill");
  mkdirSync(join(mainDir, "plugins"), { recursive: true });
  writeFileSync(join(mainDir, "plugins", "installed_plugins.json"), "{}");
  writeFileSync(join(mainDir, "CLAUDE.md"), "global rules");
  writeFileSync(join(mainDir, "settings.json"), JSON.stringify({ env: { DEMO: "1" } }));
  const mainStateFile = join(root, "main-state.json");
  writeFileSync(mainStateFile, JSON.stringify({
    oauthAccount: { emailAddress: "main@example.com" },
    mcpServers: { thinking: { command: "npx", args: ["thinking"] } },
  }));
  return { mainDir, mainStateFile };
}

test("primary Claude profile keeps the default config dir; extra accounts get one under the accounts root", () => {
  const root = join(tmpdir(), "accounts-root");
  assert.equal(claudeAccountConfigDir({ id: PRIMARY_CLAUDE_PROFILE_ID, provider: "claude" }, root), null);
  assert.equal(claudeAccountConfigDir({ id: "p_ds", provider: "deepseek" }, root), null);
  assert.equal(claudeAccountConfigDir({ id: "p_abc_12", provider: "claude" }, root), join(root, "p_abc_12"));
  // 手改过的怪 id 不能拼出跑到根目录外面的路径
  const weird = claudeAccountConfigDir({ id: "..\\..\\evil", provider: "claude" }, root);
  assert.equal(join(weird, ".."), root);
});

test("prepareClaudeAccountDir shares skills, plugins, projects, settings and MCP with the main account", () => {
  const root = scratchDir("prepare");
  try {
    const { mainDir, mainStateFile } = makeMainDir(root);
    const dir = join(root, "accounts", "p_second");
    const report = prepareClaudeAccountDir(dir, { mainDir, mainStateFile });
    assert.deepEqual(report.errors, []);

    for (const name of ["skills", "plugins", "projects"]) {
      assert.equal(lstatSync(join(dir, name)).isSymbolicLink(), true, `${name} should be linked`);
    }
    // 主号没有 projects 也要先建出来再链，否则第二个号会自己记一份
    assert.equal(existsSync(join(mainDir, "projects")), true);
    // 主号没有的目录不凭空造
    assert.equal(existsSync(join(dir, "agents")), false);
    assert.equal(readFileSync(join(dir, "skills", "demo", "SKILL.md"), "utf8"), "demo skill");

    // 第二个号写进 projects 的会话记录，主号那边看得到
    writeFileSync(join(dir, "projects", "session.jsonl"), "{}");
    assert.equal(existsSync(join(mainDir, "projects", "session.jsonl")), true);

    assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "global rules");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")), { env: { DEMO: "1" } });
    const state = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"));
    assert.deepEqual(state.mcpServers, { thinking: { command: "npx", args: ["thinking"] } });
    // 账号信息是每个号自己的，不能抄主号的
    assert.equal(state.oauthAccount, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareClaudeAccountDir is idempotent and follows later changes on the main account", () => {
  const root = scratchDir("resync");
  try {
    const { mainDir, mainStateFile } = makeMainDir(root);
    const dir = join(root, "accounts", "p_second");
    prepareClaudeAccountDir(dir, { mainDir, mainStateFile });

    // 这个号自己登录后 CLI 写进 .claude.json 的东西要保留
    const statePath = join(dir, ".claude.json");
    writeFileSync(statePath, JSON.stringify({
      oauthAccount: { emailAddress: "second@example.com" },
      mcpServers: { thinking: { command: "npx", args: ["thinking"] } },
    }));

    const again = prepareClaudeAccountDir(dir, { mainDir, mainStateFile });
    assert.deepEqual({ linked: again.linked, copied: again.copied, errors: again.errors }, { linked: [], copied: [], errors: [] });

    writeFileSync(join(mainDir, "settings.json"), JSON.stringify({ env: { DEMO: "2" } }));
    rmSync(join(mainDir, "CLAUDE.md"));
    mkdirSync(join(mainDir, "agents"));
    writeFileSync(mainStateFile, JSON.stringify({ mcpServers: { playwright: { command: "npx" } } }));
    const changed = prepareClaudeAccountDir(dir, { mainDir, mainStateFile });
    assert.deepEqual(changed.errors, []);

    assert.deepEqual(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")), { env: { DEMO: "2" } });
    assert.equal(existsSync(join(dir, "CLAUDE.md")), false, "main deleted CLAUDE.md, the copy follows");
    assert.equal(lstatSync(join(dir, "agents")).isSymbolicLink(), true, "a directory the main account gains later gets linked");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.deepEqual(state.mcpServers, { playwright: { command: "npx" } });
    assert.deepEqual(state.oauthAccount, { emailAddress: "second@example.com" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareClaudeAccountDir never overwrites what belongs to the account itself", () => {
  const root = scratchDir("keep");
  try {
    const { mainDir, mainStateFile } = makeMainDir(root);
    const dir = join(root, "accounts", "p_second");
    mkdirSync(join(dir, "skills"), { recursive: true });
    writeFileSync(join(dir, "skills", "own.md"), "own");
    // 读不懂的 .claude.json：覆盖掉就等于把这个号登出，宁可不同步 MCP
    writeFileSync(join(dir, ".claude.json"), "{ not json");

    const report = prepareClaudeAccountDir(dir, { mainDir, mainStateFile });
    assert.deepEqual(report.kept, ["skills"]);
    assert.equal(readFileSync(join(dir, "skills", "own.md"), "utf8"), "own");
    assert.equal(readFileSync(join(dir, ".claude.json"), "utf8"), "{ not json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removeClaudeAccountDir deletes the account but never what its links point to", () => {
  const root = scratchDir("remove");
  try {
    const { mainDir, mainStateFile } = makeMainDir(root);
    const accountsRoot = join(root, "accounts");
    const dir = join(accountsRoot, "p_second");
    prepareClaudeAccountDir(dir, { mainDir, mainStateFile });
    writeFileSync(join(dir, ".credentials.json"), "{\"secret\":true}");
    mkdirSync(join(dir, "backups"));
    writeFileSync(join(dir, "backups", "old.json"), "{}");

    assert.equal(hasLocalClaudeCredentials(dir, "win32"), true);
    assert.equal(hasLocalClaudeCredentials(dir, "darwin"), null);

    removeClaudeAccountDir(dir, accountsRoot);
    assert.equal(existsSync(dir), false);
    assert.equal(readFileSync(join(mainDir, "skills", "demo", "SKILL.md"), "utf8"), "demo skill");
    assert.equal(existsSync(join(mainDir, "plugins", "installed_plugins.json")), true);
    assert.equal(existsSync(join(mainDir, "projects")), true);

    assert.throws(() => removeClaudeAccountDir(mainDir, accountsRoot), /拒绝删除/);
    assert.throws(() => removeClaudeAccountDir(accountsRoot, accountsRoot), /拒绝删除/);
    assert.equal(existsSync(mainDir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parseClaudeAuthStatus reads the CLI JSON and tolerates garbage", () => {
  const ok = parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, email: "b@example.com", subscriptionType: "max" }));
  assert.deepEqual({ authenticated: ok.authenticated, email: ok.email, subscriptionType: ok.subscriptionType },
    { authenticated: true, email: "b@example.com", subscriptionType: "max" });
  const bad = parseClaudeAuthStatus("not json", "boom");
  assert.equal(bad.authenticated, false);
  assert.equal(bad.email, null);
  assert.deepEqual(bad.detail, { raw: "not json" });
});

function fakeSpawn() {
  const calls = [];
  const impl = (command, args, options) => {
    calls.push({ command, args, options });
    return { on() { }, unref() { } };
  };
  return { calls, impl };
}

test("launchClaudeLogin opens a visible terminal on Windows with the account's config dir", () => {
  const { calls, impl } = fakeSpawn();
  const result = launchClaudeLogin({
    dir: "C:\\data\\claude-accounts\\p_second",
    email: "second@example.com",
    env: { PATH: "x", CLAUDE_CODE_OAUTH_TOKEN: "would-override-login" },
    platform: "win32",
    spawnImpl: impl,
  });
  assert.equal(result.launched, true);
  assert.equal(calls.length, 1);
  const [{ command, args, options }] = calls;
  assert.equal(command, "cmd.exe");
  assert.deepEqual(args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(args[3], `"start "Claude login" cmd.exe /k claude auth login --claudeai --email second@example.com"`);
  assert.equal(options.windowsVerbatimArguments, true);
  assert.equal(options.env.CLAUDE_CONFIG_DIR, "C:\\data\\claude-accounts\\p_second");
  assert.equal("CLAUDE_CODE_OAUTH_TOKEN" in options.env, false);
  assert.match(result.command, /^\$env:CLAUDE_CONFIG_DIR='C:\\data\\claude-accounts\\p_second'; claude auth login/);
});

test("launchClaudeLogin keeps hostile email text off the command line", () => {
  const { calls, impl } = fakeSpawn();
  launchClaudeLogin({ dir: "C:\\d", email: "a@b.com & calc", env: {}, platform: "win32", spawnImpl: impl });
  assert.equal(calls[0].args[3].includes("calc"), false);
  assert.equal(calls[0].args[3].includes("--email"), false);
  assert.equal(normalizeLoginEmail(" x.y+z@ex-ample.co "), "x.y+z@ex-ample.co");
  assert.equal(normalizeLoginEmail("a\"b@c.com"), "");
});

test("launchClaudeLogin on macOS bakes the config dir into the Terminal command; elsewhere it hands back the command", () => {
  const mac = fakeSpawn();
  const macResult = launchClaudeLogin({ dir: "/Users/x/it's here", env: {}, platform: "darwin", spawnImpl: mac.impl });
  assert.equal(macResult.launched, true);
  assert.equal(mac.calls[0].command, "osascript");
  assert.match(mac.calls[0].args[1], /CLAUDE_CONFIG_DIR='\/Users\/x\/it'\\\\''s here' claude auth login --claudeai/);

  const linux = fakeSpawn();
  const linuxResult = launchClaudeLogin({ dir: "/home/x/acct", env: {}, platform: "linux", spawnImpl: linux.impl });
  assert.equal(linuxResult.launched, false);
  assert.equal(linux.calls.length, 0);
  assert.equal(linuxResult.command, "CLAUDE_CONFIG_DIR='/home/x/acct' claude auth login --claudeai");

  const failing = launchClaudeLogin({ dir: "C:\\d", env: {}, platform: "win32", spawnImpl: () => { throw new Error("ENOENT"); } });
  assert.equal(failing.launched, false);
  assert.equal(claudeLoginManualCommand(null), "claude auth login --claudeai");
});

// ── 接到 server.js 上：用真的 HTTP 接口走一遍加号、查状态、删号 ─────────────

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test("server adds, routes and deletes extra Claude member accounts", { timeout: 30_000 }, async () => {
  const root = scratchDir("server");
  const { mainDir } = makeMainDir(root);
  const accountsRoot = join(root, "data", "claude-accounts");
  const authFile = join(root, "auth-profile.json");
  writeFileSync(authFile, JSON.stringify({
    activeProfileId: "p_ds",
    profiles: [
      { id: PRIMARY_CLAUDE_PROFILE_ID, name: "Claude 会员", provider: "claude" },
      { id: "p_ds", name: "DeepSeek", provider: "deepseek", apiKey: "k", baseUrl: "https://example.invalid", sonnetModel: "m" },
    ],
  }));
  const port = await reservePort();
  const token = "claude-accounts-test-token";
  // CLAUDE_CONFIG_DIR 指到假的主号目录：测试绝不能往真的 ~/.claude 里建链接。
  // 家目录也换掉：查额度会顺带查 Codex 和 Antigravity，不能拿真的 ~/.codex 登录去发网络
  // 请求，也别在后台起一个 agy（它比服务端活得久，测试收尾时还占着文件）
  const fakeHome = join(root, "home");
  mkdirSync(fakeHome, { recursive: true });
  const env = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    LOCALAPPDATA: join(fakeHome, "AppData", "Local"),
    AGY_BIN: "",
    PORT: String(port),
    HOST: "127.0.0.1",
    DESKTOP_AGENT_TOKEN: token,
    CLAUDE_CHAT_DATA_DIR: join(root, "data"),
    CLAUDE_CHAT_AUTH_PROFILE_FILE: authFile,
    CLAUDE_CONFIG_DIR: mainDir,
  };
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL(".", import.meta.url),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const api = (path, init) => fetch(`http://127.0.0.1:${port}${path}?token=${encodeURIComponent(token)}`, init);
  const put = body => api("/api/auth-profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  try {
    const deadline = Date.now() + 8000;
    while (!output.includes("claude-chat listening")) {
      if (child.exitCode != null) throw new Error(`sidecar exited early (${child.exitCode}): ${output}`);
      if (Date.now() >= deadline) throw new Error(`sidecar did not start: ${output}`);
      await delay(20);
    }

    const addRes = await put({ action: "add", profile: { provider: "claude", name: "" } });
    const added = await addRes.json();
    assert.equal(addRes.status, 200, JSON.stringify(added));
    const newId = added.addedProfileId;
    assert.ok(newId && newId !== PRIMARY_CLAUDE_PROFILE_ID);
    // 没登录的号不能切过去，当前对话的会话也不该被清
    assert.equal(added.data.activeProfileId, "p_ds");
    assert.equal(added.resetSession, false);
    const addedProfile = added.data.profiles.find(p => p.id === newId);
    assert.equal(addedProfile.provider, "claude");
    assert.equal(addedProfile.name, "Claude 会员 2");

    const accountDir = join(accountsRoot, newId);
    assert.equal(lstatSync(join(accountDir, "skills")).isSymbolicLink(), true);
    assert.equal(readFileSync(join(accountDir, "CLAUDE.md"), "utf8"), "global rules");

    // 撞 id 的新增不能和已有账号共用一个配置目录
    const dupRes = await put({ action: "add", profile: { id: newId, provider: "claude", name: "Dup" } });
    const dup = await dupRes.json();
    assert.notEqual(dup.addedProfileId, newId);

    const usage = await (await api("/api/usage-limits")).json();
    assert.equal(usage.providers.claudeAccounts[newId].status, "unauthenticated");

    const auth = await (await api("/api/health/claude-auth")).json();
    assert.equal(auth.accounts[newId].authenticated, false);
    assert.ok(PRIMARY_CLAUDE_PROFILE_ID in auth.accounts);

    const badLogin = await api("/api/claude-accounts/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: "p_ds" }),
    });
    assert.equal(badLogin.status, 400);

    const primaryDelete = await put({ action: "delete", profileId: PRIMARY_CLAUDE_PROFILE_ID });
    assert.equal(primaryDelete.status, 400);

    const delRes = await put({ action: "delete", profileId: newId });
    assert.equal(delRes.status, 200);
    assert.equal(existsSync(accountDir), false);
    assert.equal(readFileSync(join(mainDir, "skills", "demo", "SKILL.md"), "utf8"), "demo skill");
  } finally {
    child.kill();
    await new Promise(resolve => (child.exitCode != null ? resolve() : child.once("close", resolve)));
    // 查额度时服务端会在后台起 agy，它往假家目录里写的日志要等它退干净才删得掉
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test("buildAgentEnv points extra Claude accounts at their own config dir and leaves the primary alone", { timeout: 20_000 }, async () => {
  const root = scratchDir("env");
  const { mainDir } = makeMainDir(root);
  const accountsRoot = join(root, "data", "claude-accounts");
  try {
    const probe = `
      const { buildAgentEnv } = await import(${JSON.stringify(new URL("server.js", import.meta.url).href)});
      const data = {
        activeProfileId: "p_claude",
        profiles: [
          { id: "p_claude", provider: "claude" },
          { id: "p_second", provider: "claude" },
        ],
      };
      const primary = buildAgentEnv(data, "medium", null);
      const second = buildAgentEnv(data, "medium", null, data.profiles[1]);
      const out = {
        primaryDir: primary.CLAUDE_CONFIG_DIR ?? null,
        primaryToken: primary.CLAUDE_CODE_OAUTH_TOKEN ?? null,
        secondDir: second.CLAUDE_CONFIG_DIR ?? null,
        secondToken: second.CLAUDE_CODE_OAUTH_TOKEN ?? null,
      };
      process.stdout.write("PROBE:" + JSON.stringify(out) + "\\n", () => process.exit(0));
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", probe], {
      cwd: new URL(".", import.meta.url),
      env: {
        ...process.env,
        PORT: "0",
        HOST: "127.0.0.1",
        CLAUDE_CHAT_DATA_DIR: join(root, "data"),
        CLAUDE_CHAT_AUTH_PROFILE_FILE: join(root, "auth-profile.json"),
        CLAUDE_CHAT_HISTORY_FILE: join(root, "history.json"),
        CLAUDE_CONFIG_DIR: mainDir,
        CLAUDE_CODE_OAUTH_TOKEN: "inherited-token",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    await new Promise(resolve => child.once("close", resolve));
    const line = stdout.split("\n").find(l => l.startsWith("PROBE:"));
    assert.ok(line, `probe produced no output: ${stdout}\n${stderr}`);
    const out = JSON.parse(line.slice("PROBE:".length));
    // 主号：用户自己设的配置目录和 token 原样保留
    assert.equal(out.primaryDir, mainDir);
    assert.equal(out.primaryToken, "inherited-token");
    // 额外账号：指到自己的目录，继承来的 token 必须去掉，否则会顶掉这个号的登录
    assert.equal(out.secondDir, join(accountsRoot, "p_second"));
    assert.equal(out.secondToken, null);
    assert.equal(lstatSync(join(accountsRoot, "p_second", "skills")).isSymbolicLink(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

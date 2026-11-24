// 多个 Claude 会员账号。
//
// Claude Code 认哪个账号，看的是配置目录（CLAUDE_CONFIG_DIR，默认 ~/.claude）里那份
// .credentials.json。主号就用默认目录；额外加的号各给一个独立目录，起 SDK 子进程时
// 把 CLAUDE_CONFIG_DIR 指过去，两边的登录互不干扰，也不影响终端里直接跑的 claude。
//
// 但配置目录里装的不只是登录：技能、插件、全局 CLAUDE.md、settings.json（里面有技能要用
// 的环境变量）、用户级 MCP、会话记录和自动记忆都在里面。新目录要是空的，换了号的
// Claude 就成了另一个人。所以除了凭证和这个号自己的状态，其余一律跟主号共用：目录用
// 链接（Windows 上是 junction，不要管理员权限），文件 Windows 上建不了链接只能照主号拷。

import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export const PRIMARY_CLAUDE_PROFILE_ID = "p_claude";

// projects 里是会话记录和自动记忆，两个号得读写同一份，所以主号那边没有也要先建出来。
// 不先建的话，第二个号的 CLI 一起来就在自己目录里建一个真目录，从此各记各的。
const SHARED_DIRS = ["skills", "plugins", "agents", "commands", "output-styles", "rules", "projects"];
const ALWAYS_SHARED_DIRS = new Set(["projects"]);
const SHARED_FILES = ["CLAUDE.md", "settings.json"];

export function mainClaudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(homedir(), ".claude");
}

// 用户级 MCP、onboarding 标记、账号信息在这个文件里。没设 CLAUDE_CONFIG_DIR 时它在家目录
// 下面，不在 ~/.claude 里；设了就在配置目录里——额外账号的那份也是这么落的。
export function mainClaudeStateFile(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? join(resolve(env.CLAUDE_CONFIG_DIR), ".claude.json") : join(homedir(), ".claude.json");
}

export function isExtraClaudeAccount(profile) {
  return profile?.provider === "claude" && profile.id !== PRIMARY_CLAUDE_PROFILE_ID;
}

/** 主号返回 null（用默认配置目录）；额外账号按 id 落在 accountsRoot 下。 */
export function claudeAccountConfigDir(profile, accountsRoot) {
  if (!isExtraClaudeAccount(profile)) return null;
  const id = String(profile.id ?? "");
  // id 是我们自己生成的，正常都能直接当目录名；手改过配置的才走哈希，免得拼出 ..\ 之类
  const name = /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : createHash("sha256").update(id).digest("hex").slice(0, 32);
  return join(resolve(accountsRoot), name);
}

function lstatOrNull(path) {
  try { return lstatSync(path); } catch { return null; }
}

function readOrNull(path) {
  try { return readFileSync(path); } catch { return null; }
}

function samePath(a, b) {
  const norm = (p) => {
    const full = resolve(p);
    return process.platform === "win32" ? full.toLowerCase() : full;
  };
  return norm(a) === norm(b);
}

function linkPointsTo(link, target) {
  try { return samePath(realpathSync(link), realpathSync(target)); } catch { return false; }
}

// 先写临时文件再改名：CLI 随时可能在读这份文件，不能让它读到写了一半的内容
function writeAtomic(path, content) {
  const tmp = `${path}.inkfellow-${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
    return true;
  } catch {
    try { unlinkSync(tmp); } catch { }
    return false;
  }
}

function linkSharedDir(dir, mainDir, name, report) {
  const target = join(mainDir, name);
  const link = join(dir, name);
  if (!existsSync(target)) {
    if (!ALWAYS_SHARED_DIRS.has(name)) return;
    mkdirSync(target, { recursive: true });
  }
  const current = lstatOrNull(link);
  if (current?.isSymbolicLink()) {
    if (linkPointsTo(link, target)) return;
    // 主号目录换过地方（改了 CLAUDE_CONFIG_DIR）：旧链接作废，重链
    unlinkSync(link);
  } else if (current) {
    // 已经是这个号自己的真目录，里面可能有它独有的东西，不替它做主
    report.kept.push(name);
    return;
  }
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  report.linked.push(name);
}

// 主号说了算：主号改了就跟着改，主号删了这边也删
function mirrorSharedFile(dir, mainDir, name, report) {
  const source = join(mainDir, name);
  const copy = join(dir, name);
  const want = readOrNull(source);
  const have = readOrNull(copy);
  if (want === null) {
    if (have !== null) { unlinkSync(copy); report.copied.push(name); }
    return;
  }
  if (have !== null && have.equals(want)) return;
  if (writeAtomic(copy, want)) report.copied.push(name);
}

// 只同步 mcpServers 这一个字段：文件里其余的是这个号自己的（账号信息、onboarding 状态）
function syncMcpServers(dir, mainStateFile, report) {
  let servers = {};
  try {
    const main = JSON.parse(readFileSync(mainStateFile, "utf8"));
    if (main?.mcpServers && typeof main.mcpServers === "object") servers = main.mcpServers;
  } catch { }
  const stateFile = join(dir, ".claude.json");
  let state = {};
  const raw = readOrNull(stateFile);
  if (raw !== null) {
    // 读不懂就别碰：覆盖掉等于把这个号登出
    try { state = JSON.parse(raw.toString("utf8")); } catch { return; }
    if (!state || typeof state !== "object" || Array.isArray(state)) return;
  } else if (Object.keys(servers).length === 0) {
    return;
  }
  if (JSON.stringify(state.mcpServers ?? {}) === JSON.stringify(servers)) return;
  if (writeAtomic(stateFile, `${JSON.stringify({ ...state, mcpServers: servers }, null, 2)}\n`)) {
    report.copied.push(".claude.json#mcpServers");
  }
}

/**
 * 每次要用这个号起 CLI 之前调一次：主号那边新装的技能、改过的设置要跟过来。
 * 不抛错——哪一项没弄成也只是少共用一样东西，不该拦住这一轮对话。
 */
export function prepareClaudeAccountDir(dir, {
  mainDir = mainClaudeConfigDir(),
  mainStateFile = mainClaudeStateFile(),
} = {}) {
  const report = { linked: [], copied: [], kept: [], errors: [] };
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    report.errors.push(`mkdir: ${error.message}`);
    return report;
  }
  if (samePath(dir, mainDir)) return report;
  for (const name of SHARED_DIRS) {
    try { linkSharedDir(dir, mainDir, name, report); } catch (error) { report.errors.push(`${name}: ${error.message}`); }
  }
  for (const name of SHARED_FILES) {
    try { mirrorSharedFile(dir, mainDir, name, report); } catch (error) { report.errors.push(`${name}: ${error.message}`); }
  }
  try { syncMcpServers(dir, mainStateFile, report); } catch (error) { report.errors.push(`.claude.json: ${error.message}`); }
  return report;
}

/**
 * 有没有本地凭证文件。macOS 上凭证进钥匙串，看文件说明不了问题，返回 null 表示不知道。
 * 用来在查额度之前挡掉明摆着没登录的号——查一次要起一个 CLI 进程。
 */
export function hasLocalClaudeCredentials(dir, platform = process.platform) {
  if (platform === "darwin") return null;
  return existsSync(join(dir, ".credentials.json"));
}

// 碰到链接只删链接本身，绝不顺着进去：projects、skills 这些链的是主号的真数据
function removeTreeNoFollow(path) {
  const st = lstatOrNull(path);
  if (!st) return;
  if (st.isSymbolicLink()) { unlinkSync(path); return; }
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) removeTreeNoFollow(join(path, name));
    rmdirSync(path);
    return;
  }
  unlinkSync(path);
}

/** 删账号时清掉它的配置目录。只认 accountsRoot 底下的目录，别处的一概不删。 */
export function removeClaudeAccountDir(dir, accountsRoot) {
  const rel = relative(resolve(accountsRoot), resolve(dir));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`拒绝删除账号目录之外的路径：${dir}`);
  }
  // 先删凭证：后面哪一步失败（文件被占用之类），至少登录信息不会留在磁盘上
  try { unlinkSync(join(dir, ".credentials.json")); } catch { }
  removeTreeNoFollow(dir);
}

export function parseClaudeAuthStatus(stdout, stderr = "") {
  let detail;
  try { detail = JSON.parse(stdout); } catch { detail = { raw: String(stdout || "").trim() || String(stderr || "").trim() }; }
  return {
    authenticated: detail?.loggedIn === true,
    email: typeof detail?.email === "string" ? detail.email : null,
    subscriptionType: typeof detail?.subscriptionType === "string" ? detail.subscriptionType : null,
    detail,
  };
}

// 邮箱会拼进命令行，只放行规规矩矩的地址，免得混进 & | " 之类
export function normalizeLoginEmail(value) {
  const email = String(value ?? "").trim();
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email) ? email : "";
}

function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** 给用户手动跑的那条命令：弹窗没起来，或者不在 Windows / macOS 上时用。 */
export function claudeLoginManualCommand(dir, { email = "", platform = process.platform } = {}) {
  const emailArg = email ? ` --email ${email}` : "";
  if (!dir) return `claude auth login --claudeai${emailArg}`;
  if (platform === "win32") {
    return `$env:CLAUDE_CONFIG_DIR=${powershellQuote(dir)}; claude auth login --claudeai${emailArg}; Remove-Item Env:CLAUDE_CONFIG_DIR`;
  }
  return `CLAUDE_CONFIG_DIR=${shellQuote(dir)} claude auth login --claudeai${emailArg}`;
}

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * 登录要在浏览器里点授权，回调失败时还得把授权码贴回终端，所以开一个看得见的终端窗口
 * 跑官方的 claude auth login，不自己解析它的输出。返回 { launched, command }：
 * 没开成就让界面把 command 给用户自己跑。
 */
export function launchClaudeLogin({ dir, email = "", env = process.env, platform = process.platform, spawnImpl }) {
  const safeEmail = normalizeLoginEmail(email);
  const command = claudeLoginManualCommand(dir, { email: safeEmail, platform });
  const childEnv = { ...env };
  if (dir) {
    childEnv.CLAUDE_CONFIG_DIR = dir;
    // 环境里要是挂着长期 token，它的优先级比 /login 高，登进去的号会被它顶掉
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;
  }
  const loginArgs = `claude auth login --claudeai${safeEmail ? ` --email ${safeEmail}` : ""}`;
  try {
    if (platform === "win32") {
      // 外层 cmd 只负责 start，藏起来；start 出来的那个窗口是给人看的。/k 让窗口留着，
      // 用户能看到 Login successful 或报错，而不是一闪而过
      const child = spawnImpl("cmd.exe", ["/d", "/s", "/c", `"start "Claude login" cmd.exe /k ${loginArgs}"`], {
        env: childEnv,
        windowsHide: true,
        windowsVerbatimArguments: true,
        stdio: "ignore",
        detached: true,
      });
      child.on?.("error", () => { });
      child.unref?.();
      return { launched: true, command };
    }
    if (platform === "darwin") {
      // Terminal 开的新窗口不继承我们的环境，变量得写进命令本身
      const script = dir ? `CLAUDE_CONFIG_DIR=${shellQuote(dir)} ${loginArgs}` : loginArgs;
      const child = spawnImpl("osascript", [
        "-e", `tell application "Terminal" to do script ${appleScriptString(script)}`,
        "-e", `tell application "Terminal" to activate`,
      ], { env: childEnv, stdio: "ignore", detached: true });
      child.on?.("error", () => { });
      child.unref?.();
      return { launched: true, command };
    }
  } catch {
    return { launched: false, command };
  }
  return { launched: false, command };
}

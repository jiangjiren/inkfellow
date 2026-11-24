/**
 * 对照真实 codex 二进制的契约测试：不发 turn、不连模型、不花额度。
 *
 * thread/resume 的失败没有结构化的错误码（都是 -32600/-32603），ensureThread 只能
 * 靠报错原文分辨「这条 thread 救不回来了」和「只是暂时读不了」。原文归上游所有，
 * 升级 @openai/codex-sdk 时要是改了措辞，假服务端的单测照样全绿，而用户那边的对话
 * 会一直报错。这个文件就是用来在升级当场发现这件事的。
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PersistentCodexRuntime } from "./codex-runtime.js";

const PLATFORM_PACKAGES = {
  "win32-x64": ["@openai/codex-win32-x64", "x86_64-pc-windows-msvc"],
  "win32-arm64": ["@openai/codex-win32-arm64", "aarch64-pc-windows-msvc"],
  "darwin-x64": ["@openai/codex-darwin-x64", "x86_64-apple-darwin"],
  "darwin-arm64": ["@openai/codex-darwin-arm64", "aarch64-apple-darwin"],
  "linux-x64": ["@openai/codex-linux-x64", "x86_64-unknown-linux-musl"],
  "linux-arm64": ["@openai/codex-linux-arm64", "aarch64-unknown-linux-musl"],
};

function findRealBinary() {
  const target = PLATFORM_PACKAGES[`${process.platform}-${process.arch}`];
  if (!target) return null;
  try {
    const require = createRequire(import.meta.url);
    const codexRequire = createRequire(require.resolve("@openai/codex/package.json"));
    const root = dirname(codexRequire.resolve(`${target[0]}/package.json`));
    const bin = join(root, "vendor", target[1], "bin", process.platform === "win32" ? "codex.exe" : "codex");
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

function killTree(proc) {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else proc.kill("SIGKILL");
}

const bin = findRealBinary();
const skip = bin ? false : "这个平台没装 codex 二进制";
let home;
let cwd;
let runtime;
let proc;

before(async () => {
  if (skip) return;
  home = mkdtempSync(join(tmpdir(), "codex-contract-"));
  cwd = mkdtempSync(join(tmpdir(), "codex-contract-cwd-"));
  // 关掉插件同步：它会在后台 git ls-remote，测试不该碰网络。
  writeFileSync(join(home, "config.toml"), "[features]\nplugins = false\n");
  runtime = new PersistentCodexRuntime({ killProcess: killTree });
  runtime.start({
    signature: "contract",
    spawn: () => {
      proc = spawn(bin, ["app-server"], { cwd, env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      return proc;
    },
  });
  await runtime.initialize({ name: "inkfellow-contract", version: "1.0.0" });
});

after(async () => {
  if (skip) return;
  const closed = new Promise(resolve => proc.once("close", resolve));
  runtime.kill();
  await closed;
  for (const dir of [home, cwd]) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 临时目录，清不掉也无妨 */ }
  }
});

/** 按 codex 的命名规则在 sessions 里摆一个会话文件，返回对应的 thread id。 */
function placeRollout(write) {
  const threadId = crypto.randomUUID();
  const day = join(home, "sessions", "2026", "11", "05");
  mkdirSync(day, { recursive: true });
  write(join(day, `rollout-2026-11-05T10-00-00-${threadId}.jsonl`));
  return threadId;
}

const resume = threadId => runtime.ensureThread({ threadId, params: { cwd, approvalPolicy: "never" } });

test("真实 codex：不存在的 thread 换一条新的", { skip, timeout: 30_000 }, async () => {
  const gone = crypto.randomUUID();
  const ensured = await resume(gone);
  assert.equal(ensured.resumed, false);
  assert.notEqual(ensured.threadId, gone);
});

for (const [label, write] of [
  ["空文件", file => writeFileSync(file, "")],
  ["不是 JSON", file => writeFileSync(file, "not json at all\n")],
  ["不是会话内容的 JSON", file => writeFileSync(file, '{"hello":"world"}\n')],
  ["二进制垃圾", file => writeFileSync(file, Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]))],
]) {
  test(`真实 codex：历史损坏（${label}）换一条新的`, { skip, timeout: 30_000 }, async () => {
    const damaged = placeRollout(write);
    const ensured = await resume(damaged);
    assert.equal(ensured.resumed, false);
    assert.notEqual(ensured.threadId, damaged);
  });
}

test("真实 codex：读不了文件只是暂时的，不能把原 thread 换掉", { skip, timeout: 30_000 }, async () => {
  // 会话路径上放个目录，稳定地制造一次操作系统层面的读取失败（os error N）。
  const unreadable = placeRollout(file => mkdirSync(file));
  const held = runtime.threadId;
  await assert.rejects(resume(unreadable), error => error.codexRpcError === true && /os error \d+/.test(error.message));
  assert.equal(runtime.threadId, held, "手上这条 thread 不该被动过");
});

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistentCodexRuntime, codexRuntimeSignature } from "./codex-runtime.js";
import { PersistentAgyRuntime, agyPersistentArgs, agyRuntimeSignature } from "./agy-runtime.js";
import { codexAuthFile, codexCommand } from "./providers/codex-models.js";
import * as antigravity from "./providers/antigravity.js";
import { getCatalog, runAntigravity } from "./antigravity-runtime.js";

const children = new Set();
const slots = new Map();
const IDLE_MS = 15 * 60_000;
const mimeExt = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };

function kill(proc) {
  if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    if (process.platform === "win32") {
      const result = spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      if (result.status !== 0) proc.kill("SIGKILL");
    } else process.kill(-proc.pid, "SIGKILL");
  } catch { try { proc.kill("SIGKILL"); } catch { /* already closed */ } }
}

function child(binary, args, cwd) {
  const proc = spawn(binary, args, {
    cwd, windowsHide: true, detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
  });
  proc.stdin.on("error", () => {});
  children.add(proc);
  proc.on("close", () => children.delete(proc));
  return proc;
}

process.once("exit", () => { for (const proc of children) kill(proc); });

function dispose(key, slot) {
  clearTimeout(slot.timer);
  if (slots.get(key) === slot) slots.delete(key);
  slot.runtime.kill();
}

export function closeNativeChat(conversationId) {
  for (const provider of ["codex", "antigravity"]) {
    const key = `${provider}:${conversationId}`;
    const slot = slots.get(key);
    if (slot) dispose(key, slot);
  }
}

function take(key, signature, create, matches = () => true) {
  let slot = slots.get(key);
  if (slot && (slot.signature !== signature || !slot.runtime.started || !matches(slot.runtime))) {
    if (slot.runtime.busy) throw new Error("执行器仍在处理上一轮。");
    dispose(key, slot);
    slot = null;
  }
  if (!slot) {
    slot = { signature, runtime: create(), timer: null };
    slots.set(key, slot);
  }
  clearTimeout(slot.timer);
  return slot;
}

function park(key, slot) {
  if (slots.get(key) !== slot) return;
  clearTimeout(slot.timer);
  slot.timer = setTimeout(() => dispose(key, slot), IDLE_MS);
  slot.timer.unref?.();
}

function authFingerprint() {
  try {
    const stat = statSync(codexAuthFile);
    return `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch { return ""; }
}

function stageImages(images, tempDir) {
  return images.map((image, index) => {
    const path = join(tempDir, `image-${index}.${mimeExt[image.mediaType] || "png"}`);
    writeFileSync(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
    return path;
  });
}

export async function runPersistentCodex({
  conversationId, sessionId, prompt, freshPrompt, images = [], cwd, model, effort,
  sandbox, extraArgs = [], signal, onSession, onEvent,
}) {
  const command = codexCommand();
  const signature = codexRuntimeSignature({ bin: command.executable, cwd, permissionMode: sandbox, extraArgs: [...command.args, ...extraArgs, authFingerprint()] });
  const key = `codex:${conversationId}`;
  const slot = take(key, signature, () => new PersistentCodexRuntime({ killProcess: kill }));
  const { runtime } = slot;
  const dir = images.length ? mkdtempSync(join(tmpdir(), "inkfellow-codex-")) : null;
  let startedTurn = false;
  try {
    signal?.throwIfAborted();
    if (!runtime.started) {
      runtime.start({ signature, spawn: () => child(command.executable, [...command.args, "app-server", ...extraArgs], cwd) });
      await runtime.initialize({ name: "inkfellow", title: "Inkfellow", version: "1.0.0" });
    }
    signal?.throwIfAborted();
    const sandboxType = { "read-only": "readOnly", "workspace-write": "workspaceWrite", "danger-full-access": "dangerFullAccess" }[sandbox];
    const thread = await runtime.ensureThread({
      threadId: sessionId, params: { cwd, approvalPolicy: "never", sandbox, ...(model ? { model } : {}) },
    });
    signal?.throwIfAborted();
    onSession?.(thread.threadId);
    const text = sessionId && !thread.resumed ? (freshPrompt?.() ?? prompt) : prompt;
    const input = [...stageImages(images, dir).map(path => ({ type: "localImage", path })), { type: "text", text }];
    startedTurn = true;
    const result = await runtime.runTurn({
      input, signal, onEvent,
      params: { approvalPolicy: "never", sandboxPolicy: { type: sandboxType }, ...(effort ? { effort } : {}), ...(model ? { model } : {}) },
    });
    if (result.turn?.status === "interrupted") throw Object.assign(new Error("Codex 请求已停止"), { name: "AbortError" });
    if (result.turn?.status !== "completed") throw new Error(result.turn?.error?.message || "Codex 未返回完成确认。");
    return result;
  } catch (error) {
    if (!startedTurn || !runtime.started) dispose(key, slot);
    throw error;
  } finally {
    park(key, slot);
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

export async function runPersistentAntigravity({
  conversationId, sessionId, prompt, images = [], cwd, model, effort,
  permissionMode, extraAddDirs = [], extraArgs = [], signal, onSession, onEvent,
}) {
  const state = await getCatalog();
  signal?.throwIfAborted();
  if (!state.ready) throw new Error(state.message);
  if (!state.persistent) {
    if (extraArgs.length || extraAddDirs.length) throw Object.assign(new Error("请升级 Antigravity CLI 以运行 Fellow 工单。"), { code: "FELLOW_RUNTIME_UNAVAILABLE" });
    return runAntigravity({ prompt, images, cwd, model, effort, permissionMode, resumeConversationId: sessionId, signal, onSession, onEvent });
  }
  const dir = images.length ? mkdtempSync(join(tmpdir(), "inkfellow-agy-")) : null;
  const bin = antigravity.findBinary();
  const key = `antigravity:${conversationId}`;
  let slot;
  try {
    const paths = stageImages(images, dir);
    const text = paths.length ? `请先读取用户附图：\n${paths.join("\n")}\n\n${prompt}` : prompt;
    const additions = dir ? [...extraAddDirs, dir] : extraAddDirs;
    const signature = agyRuntimeSignature({ bin, cwd, model, effort, permissionMode, extraAddDirs: [...additions, ...extraArgs] });
    slot = take(key, signature, () => new PersistentAgyRuntime({ killProcess: kill }), runtime => runtime.boundConversationId === (sessionId || null));
    const { runtime } = slot;
    if (!runtime.started) {
      const args = agyPersistentArgs({ cwd, model, effort, permissionMode, resumeConversationId: sessionId, extraAddDirs: additions, extraArgs });
      const command = antigravity.binaryCommand();
      runtime.start({ signature, resumeConversationId: sessionId, spawn: () => child(command.executable, [...command.args, ...args], cwd) });
    }
    const result = await runtime.runTurn({
      message: { event: "user", message: { role: "user", content: [{ type: "text", text }] } },
      signal, onSession, onEvent,
    });
    if (result.status !== "SUCCESS") throw new Error(result.error || result.stderr || result.response || "Antigravity 未返回完成确认。");
    return result;
  } finally {
    if (slot && (dir || !slot.runtime.started)) dispose(key, slot);
    else if (slot) park(key, slot);
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * WriteScopeLock —— 本地 Vault 目录/文件级并发写软锁
 * ══════════════════════════════════════════════════════════════════════
 *
 * 多个 Worker 并行干活时，最容易把同一篇笔记或 wiki/index.md 写花。
 * 对本地 Markdown 知识库而言，目录/文件级软锁 + 自动排队比 git worktree
 * 更贴合桌面端实时阅读体验：
 *   - 互不重叠的 writeScope 立刻并行跑；
 *   - 路径重叠（相同文件、父子目录包含、或通配 "*"）的新工单自动排队，
 *     等占用者完成后自动唤醒。
 */

import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";

export function canonicalPath(rawPath, cwd = process.cwd()) {
  const raw = String(rawPath ?? "").trim().replace(/\\/g, "/");
  if (!raw || raw.includes("\0") || raw.includes("*") || raw.includes("?")) {
    throw new Error("无效的工单路径");
  }
  if (process.platform === "win32" && (
    raw.startsWith("//?/") || raw.startsWith("//./")
    || /^[a-z]:(?!\/)/i.test(raw) || raw.replace(/^[a-z]:\//i, "").includes(":")
    || raw.split("/").some(part => (
      (/[ .]$/.test(part) && part !== "." && part !== "..")
      || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)
    ))
  )) throw new Error("无效的 Windows 工单路径");

  const absolute = resolve(cwd || process.cwd(), raw);
  let ancestor = absolute;
  while (true) {
    try {
      lstatSync(ancestor);
      const actual = realpathSync.native(ancestor);
      const full = resolve(actual, relative(ancestor, absolute)).replace(/\\/g, "/");
      return process.platform === "win32" ? full.toLowerCase() : full;
    } catch (error) {
      if (error.code !== "ENOENT" || ancestor === parse(ancestor).root) throw error;
      // A dangling link is not a missing leaf.
      try { lstatSync(ancestor); } catch (missing) {
        if (missing.code !== "ENOENT") throw missing;
        ancestor = dirname(ancestor);
        continue;
      }
      throw error;
    }
  }
}

export function pathWithin(target, root) {
  return target === root || target.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** 系统核心目录红线：即使开启全机操作模式，也严禁写入或覆盖操作系统核心文件。 */
export function isSystemProtectedPath(target) {
  const norm = String(target || "").replace(/\\/g, "/").toLowerCase();
  if (!norm) return true;
  if (process.platform === "win32") {
    return [
      "c:/windows",
      "c:/program files",
      "c:/program files (x86)",
      "c:/programdata",
      "c:/system volume information",
      "c:/$recycle.bin",
    ].some(root => pathWithin(norm, root));
  }
  return ["/system", "/usr", "/bin", "/sbin", "/etc", "/boot", "/lib", "/proc", "/sys"].some(root => pathWithin(norm, root));
}

export function normalizeScopePath(rawPath, cwd = "", vault = cwd || process.cwd()) {
  return String(rawPath).trim() === "*" ? canonicalPath(vault) : canonicalPath(rawPath, cwd);
}

export function pathsOverlap(a, b) {
  return Boolean(a && b && (a === "*" || b === "*" || pathWithin(a, b) || pathWithin(b, a)));
}

export function scopesOverlap(scopeA = [], scopeB = [], cwd = "") {
  const a = scopeA.map(p => normalizeScopePath(p, cwd));
  const b = scopeB.map(p => normalizeScopePath(p, cwd));
  return a.some(left => b.some(right => pathsOverlap(left, right)));
}

export function scopedWriteTarget(
  filePath,
  writeScope = [],
  cwd = "",
  vault = cwd || process.cwd(),
  { canonical = false, allowOutsideVault = false } = {},
) {
  try {
    const root = canonicalPath(vault);
    const target = canonicalPath(filePath, cwd);
    if (isSystemProtectedPath(target)) return null;
    if (!allowOutsideVault && !pathWithin(target, root)) return null;
    const stat = statSync(target, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.nlink !== 1)) return null;
    // 未显式声明 writeScope 时：Vault 模式下放行当前 Vault 内写入；全机模式下放行非系统保护目录写入
    const hasExplicitScopes = Array.isArray(writeScope) && writeScope.length > 0;
    if (!hasExplicitScopes) {
      return (allowOutsideVault || pathWithin(target, root)) ? target : null;
    }
    const isCanonical = canonical && hasExplicitScopes;
    const allowed = writeScope.some(path => {
      const scope = isCanonical ? path : normalizeScopePath(path, cwd, allowOutsideVault ? (cwd || root) : root);
      if (isSystemProtectedPath(scope)) return false;
      return (allowOutsideVault || pathWithin(scope, root)) && pathWithin(target, scope);
    });
    return allowed ? target : null;
  } catch {
    return null;
  }
}

export function isPathWithinScope(filePath, writeScope, cwd, vault, options) {
  return Boolean(scopedWriteTarget(filePath, writeScope, cwd, vault, options));
}

export class WriteScopeLock {
  constructor({ cwd = "" } = {}) {
    this.cwd = cwd;
    this._held = new Map();    // ticketId -> normalized scopes[]
    this._waiting = new Map(); // ticketId -> { scopes: normalized[], rawScopes: [] }
  }

  /** 尝试为 ticketId 获取写锁；冲突则登记进等待队列并返回阻塞者列表。 */
  tryAcquire(ticketId, writeScope = [], cwd = this.cwd, { enqueue = true, canonical = false } = {}) {
    const id = String(ticketId ?? "").trim();
    if (!id) return { acquired: true, blockedBy: [] };
    const norm = (Array.isArray(writeScope) ? writeScope : [])
      .map((p) => canonical ? p : normalizeScopePath(p, cwd, this.cwd || cwd || process.cwd()))
      .filter(Boolean);
    if (norm.length === 0) {
      this._held.set(id, []);
      this._waiting.delete(id);
      return { acquired: true, blockedBy: [] };
    }
    const blockedBy = [];
    for (const [holderId, holderScopes] of this._held) {
      if (holderId === id) continue;
      if (norm.some(a => holderScopes.some(b => pathsOverlap(a, b)))) blockedBy.push(holderId);
    }
    if (blockedBy.length > 0) {
      if (enqueue) this._waiting.set(id, { scopes: norm });
      return { acquired: false, blockedBy };
    }
    this._waiting.delete(id);
    this._held.set(id, norm);
    return { acquired: true, blockedBy: [] };
  }

  /** 释放 ticketId 占用的写锁，并返回因此解除阻塞、现在可以启动的等待工单列表。 */
  release(ticketId) {
    const id = String(ticketId ?? "").trim();
    this._held.delete(id);
    this._waiting.delete(id);
    const unblocked = [];
    for (const [waitingId, entry] of [...this._waiting.entries()]) {
      let stillBlocked = false;
      for (const [holderId, holderScopes] of this._held) {
        if (entry.scopes.some(a => holderScopes.some(b => pathsOverlap(a, b)))) {
          stillBlocked = true;
          break;
        }
      }
      if (!stillBlocked) {
        this._waiting.delete(waitingId);
        this._held.set(waitingId, entry.scopes);
        unblocked.push(waitingId);
      }
    }
    return unblocked;
  }

  matches(ticketId, scopes) {
    const held = this._held.get(ticketId);
    return held?.length === scopes.length && scopes.every((scope, idx) => scope === held[idx]);
  }

  heldBy(ticketId) {
    return this._held.has(String(ticketId ?? "").trim());
  }

  snapshot() {
    return {
      held: Object.fromEntries([...this._held.entries()]),
      waiting: Object.fromEntries([...this._waiting.entries()].map(([k, v]) => [k, v.scopes])),
    };
  }
}

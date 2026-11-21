import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";

/** @typedef {{path: string, vaultId: string, noteId: string}} ShareTarget */
/** @typedef {ShareTarget & {enabled: boolean, noindex: boolean, expiresAt: string | null, title?: string}} ShareRecord */
/** @typedef {Record<string, unknown>} ShareRegistry */

export class SharedNoteAccessError extends Error {
  constructor(message, status = 404) {
    super(message);
    this.name = "SharedNoteAccessError";
    this.status = status;
  }
}

export const EXCLUDED_VAULT_DIRECTORIES = new Set([
  ".git", ".obsidian", ".claude", ".claudian", "node_modules",
]);

export const isShareToken = (token) => /^[A-Za-z0-9_-]{6,128}$/.test(token);

export const getShareRegistryPath = () =>
  path.resolve(process.env.SHARED_NOTES_PATH?.trim() || "shared-notes.json");

/** @param {import('node:fs').BigIntStats} stat */
export const shareNoteId = (stat) => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;

export const shareVaultId = (vaultRoot) => createHash("sha256").update(vaultRoot).digest("hex");

/** @returns {Promise<ShareTarget | null>} */
export async function resolveShareTarget(vaultPath, notePath) {
  const vaultRoot = await fs.realpath(vaultPath);
  let decoded = notePath;
  try {
    decoded = decodeURIComponent(notePath);
  } catch {
    // Bare percent signs are valid in filenames.
  }
  const relative = path.posix.normalize(decoded.replace(/\\/g, "/").trim().replace(/^\/+/, ""));
  const isNotePath = (value) => /\.(md|html?)$/i.test(value) &&
    !value.split("/").some((segment) => segment === ".." || EXCLUDED_VAULT_DIRECTORIES.has(segment));
  if (!isNotePath(relative) || relative.includes("\0")) return null;

  try {
    const absolute = await fs.realpath(path.join(vaultRoot, relative));
    const canonical = path.relative(vaultRoot, absolute).split(path.sep).join("/");
    if (path.isAbsolute(canonical) || !isNotePath(canonical)) return null;
    const stat = await fs.stat(absolute, { bigint: true });
    return stat.isFile()
      ? { path: canonical, vaultId: shareVaultId(vaultRoot), noteId: shareNoteId(stat) }
      : null;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

/** @returns {Promise<ShareRegistry>} */
export async function readShareRegistry(registryPath = getShareRegistryPath()) {
  try {
    const value = JSON.parse(await fs.readFile(registryPath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid share registry.");
    }
    return Object.assign(Object.create(null), value);
  } catch (error) {
    if (error.code === "ENOENT") return Object.create(null);
    throw error;
  }
}

/**
 * @template T
 * @param {string} registryPath
 * @param {(registry: ShareRegistry) => {changed: boolean, value: T} | Promise<{changed: boolean, value: T}>} change
 * @returns {Promise<T>}
 */
export async function updateShareRegistry(registryPath, change) {
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  let compromised;
  const unlock = await lockfile.lock(registryPath, {
    realpath: false,
    stale: 30_000,
    retries: { retries: 120, factor: 1.2, minTimeout: 10, maxTimeout: 150, randomize: true },
    onCompromised: (error) => { compromised = error; },
  });
  try {
    const registry = await readShareRegistry(registryPath);
    const result = await change(registry);
    if (!result.changed) return result.value;

    const temporary = `${registryPath}.${randomBytes(12).toString("hex")}.tmp`;
    try {
      const file = await fs.open(temporary, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(registry, null, 2)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      if (compromised) throw compromised;
      await fs.rename(temporary, registryPath);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    return result.value;
  } finally {
    if (!compromised) await unlock();
  }
}

/** @param {unknown} value @returns {ShareRecord | null} */
export function readShareRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = /** @type {ShareRegistry} */ (value);
  if (typeof entry.path !== "string" || !entry.path.trim() ||
      typeof entry.vaultId !== "string" || typeof entry.noteId !== "string") return null;

  return {
    path: entry.path,
    vaultId: entry.vaultId,
    noteId: entry.noteId,
    enabled: entry.enabled !== false,
    noindex: entry.noindex !== false,
    expiresAt: typeof entry.expiresAt === "string" ? entry.expiresAt : null,
    title: typeof entry.title === "string" ? entry.title : undefined,
  };
}

/** @param {ShareRecord} record */
export const isActiveShare = (record) =>
  record.enabled && (record.expiresAt === null || Date.parse(record.expiresAt) > Date.now());

/** @param {ShareTarget} a @param {ShareTarget} b */
export const isSameShareTarget = (a, b) => a.vaultId === b.vaultId && a.noteId === b.noteId;

/** @param {ShareRegistry} registry @param {ShareTarget} target */
export function findShareByTarget(registry, target) {
  for (const [token, value] of Object.entries(registry)) {
    const share = readShareRecord(value);
    if (isShareToken(token) && share && isSameShareTarget(share, target) && isActiveShare(share)) {
      return { token, share };
    }
  }
  return null;
}

/** @param {unknown} value */
export function normalizeShareExpiration(value) {
  if (value === undefined || value === null) return value;
  const format = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
  const match = typeof value === "string" ? format.exec(value.trim()) : null;
  const deadline = match ? new Date(value.trim()) : new Date(NaN);
  const day = match ? new Date(`${match[1]}T00:00:00Z`) : new Date(NaN);
  if (!match || !Number.isFinite(deadline.getTime()) || !Number.isFinite(day.getTime()) ||
      day.toISOString().slice(0, 10) !== match[1] || deadline.getTime() <= Date.now()) {
    throw new SharedNoteAccessError("有效期必须是未来的日期和时间。", 400);
  }
  return deadline.toISOString();
}

/**
 * @param {ShareRegistry} registry
 * @param {ShareTarget} target
 * @param {{title?: string | null, expiresAt?: string | null, token?: string}} options
 */
export function saveShareRecord(registry, target, options) {
  const expiresAt = normalizeShareExpiration(options.expiresAt);
  const existing = findShareByTarget(registry, target);
  if (options.token && (!isShareToken(options.token) || (existing && options.token !== existing.token))) {
    throw new SharedNoteAccessError("Invalid token or the note already has a share link.", 409);
  }

  let token = existing?.token || options.token || randomBytes(12).toString("base64url");
  if (!existing) {
    if (options.token && Object.hasOwn(registry, token)) {
      throw new SharedNoteAccessError("Share token already exists.", 409);
    }
    while (Object.hasOwn(registry, token)) token = randomBytes(12).toString("base64url");
  }

  /** @type {ShareRecord} */
  const share = {
    ...target,
    enabled: true,
    noindex: existing?.share.noindex ?? true,
    expiresAt: expiresAt === undefined ? existing?.share.expiresAt ?? null : expiresAt,
    title: options.title === undefined ? existing?.share.title : options.title?.trim() || undefined,
  };
  registry[token] = share;
  return { token, share };
}

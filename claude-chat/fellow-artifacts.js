import crypto from "node:crypto";
import { closeSync, constants, createReadStream, fstatSync, openSync, statSync } from "node:fs";
import { basename, extname, relative } from "node:path";
import { canonicalPath, pathWithin } from "./write-scope-lock.js";

const formats = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".avif": "image/avif", ".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm",
  ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
  ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".csv": "text/plain; charset=utf-8",
  ".json": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8",
  ".docx": "", ".xlsx": "", ".pptx": "", ".zip": "", ".html": "", ".svg": "",
};

function artifacts(ticket, vault) {
  const root = canonicalPath(vault);
  const found = new Map();
  for (const input of [...(ticket.result?.artifactPaths ?? []), ...(ticket.result?.changedFiles ?? [])]) {
    try {
      const path = canonicalPath(input, ticket.execution.cwd || root);
      const name = relative(root, path);
      if (!pathWithin(path, root) || name.split(/[\\/]/).some(part => part.startsWith("."))) continue;
      const ext = extname(path).toLowerCase();
      if (!Object.hasOwn(formats, ext)) continue;
      const stat = statSync(path, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.nlink !== 1 || found.has(path)) continue;
      const id = crypto.createHash("sha256").update(path).digest("hex").slice(0, 32);
      const mime = formats[ext];
      found.set(path, { id, path, name: name.replaceAll("\\", "/"), size: stat.size, mime: mime || "application/octet-stream", preview: Boolean(mime) });
    } catch { /* path is stale or out of scope */ }
  }
  return [...found.values()];
}

export function listFellowArtifacts(ticket, vault) {
  return artifacts(ticket, vault).map(({ path: _path, ...entry }) => entry);
}

function parseRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
  return { start, end };
}

function streamSafeEntry(req, res, entry) {
  let fd;
  let size;
  try {
    fd = openSync(entry.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Invalid artifact");
    size = stat.size;
  } catch {
    if (fd !== undefined) closeSync(fd);
    res.writeHead(404).end();
    return;
  }

  const params = new URLSearchParams((req.url || "").split("?")[1] || "");
  const attachment = params.get("download") === "1" || !entry.preview;
  const filename = basename(entry.path);
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16)}`);
  const range = req.headers.range ? parseRange(req.headers.range, size) : null;
  if (req.headers.range && !range) {
    closeSync(fd);
    res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
    return;
  }
  res.writeHead(range ? 206 : 200, {
    "Content-Type": entry.mime,
    "Content-Length": range ? range.end - range.start + 1 : size,
    "Content-Disposition": `${attachment ? "attachment" : "inline"}; filename*=UTF-8''${encoded}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Accept-Ranges": "bytes",
    "Cross-Origin-Resource-Policy": "same-origin",
    ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${size}` } : {}),
  });
  if (req.method === "HEAD") {
    closeSync(fd);
    res.end();
    return;
  }
  const stream = createReadStream(entry.path, { fd, ...(range || {}) });
  stream.on("error", () => res.destroy());
  res.once("close", () => stream.destroy());
  stream.pipe(res);
}

export function serveFellowArtifact(req, res, ticket, vault, id) {
  const entry = artifacts(ticket, vault).find(item => item.id === id);
  if (!entry) { res.writeHead(404).end(); return; }
  streamSafeEntry(req, res, entry);
}

export function serveVaultFile(req, res, vault, requestedPath) {
  const raw = String(requestedPath || "").trim().replace(/^["'](.+)["']$/, "$1");
  let cleaned = raw.replace(/^file:\/\//i, "");
  if (/^\/[a-zA-Z]:/.test(cleaned)) cleaned = cleaned.slice(1);
  try { cleaned = decodeURIComponent(cleaned); } catch { /* keep raw */ }
  if (!cleaned) { res.writeHead(400).end(); return; }
  try {
    const root = canonicalPath(vault);
    const target = canonicalPath(cleaned, root);
    const name = relative(root, target);
    if (!pathWithin(target, root) || name.split(/[\\/]/).some(part => part.startsWith("."))) {
      res.writeHead(404).end();
      return;
    }
    const ext = extname(target).toLowerCase();
    if (!Object.hasOwn(formats, ext)) { res.writeHead(404).end(); return; }
    const mime = formats[ext];
    streamSafeEntry(req, res, { path: target, mime: mime || "application/octet-stream", preview: Boolean(mime) });
  } catch {
    res.writeHead(404).end();
  }
}

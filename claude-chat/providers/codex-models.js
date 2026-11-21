import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const codexAuthFile = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");

const CATALOG_TTL_MS = 5 * 60_000;
const RETRY_MS = 30_000;
const QUERY_TIMEOUT_MS = 12_000;
const FALLBACK_ULTRA_MODELS = new Set(["gpt-6-astra", "gpt-6.1-sol"]);
const requireFromSdk = createRequire(import.meta.resolve("@openai/codex-sdk"));
let cache;

function catalogCache() {
  let authVersion = null;
  try {
    const stat = statSync(codexAuthFile);
    authVersion = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch { }
  if (cache?.authVersion !== authVersion) {
    cache = { authVersion, catalog: null, expiresAt: 0, pending: null };
  }
  return cache;
}

async function queryCatalog() {
  // Use the CLI installed with the SDK so discovery and execution use the same runtime.
  const cli = requireFromSdk.resolve("@openai/codex/bin/codex.js");
  const child = spawn(process.execPath, [cli, "app-server"], { stdio: ["pipe", "pipe", "ignore"] });
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const timer = setTimeout(() => child.kill(), QUERY_TIMEOUT_MS);
  const send = message => child.stdin.write(JSON.stringify(message) + "\n");
  let requestId = 1;
  const models = new Map();
  const cursors = new Set();

  function listModels(cursor) {
    send({ id: ++requestId, method: "model/list", params: { limit: 50, includeHidden: false, cursor } });
  }

  try {
    send({ id: requestId, method: "initialize", params: {
      clientInfo: { name: "inkfellow", title: "Inkfellow", version: "1.0.0" },
    } });
    for await (const line of lines) {
      const { id, result, error } = JSON.parse(line);
      if (id !== requestId) continue;
      if (error) throw new Error("Codex app-server rejected the model catalog request");
      if (id === 1) {
        send({ method: "initialized" });
        listModels();
        continue;
      }
      if (!Array.isArray(result?.data)) throw new Error("Invalid Codex model catalog");
      for (const entry of result.data) {
        if (entry?.hidden || typeof entry?.model !== "string" || !entry.model || models.has(entry.model)) continue;
        models.set(entry.model, {
          model: entry.model,
          label: entry.displayName || entry.model,
          desc: entry.description || "",
          isDefault: entry.isDefault === true,
          efforts: (entry.supportedReasoningEfforts ?? []).map(option => option.reasoningEffort),
          defaultEffort: entry.defaultReasoningEffort,
        });
      }
      const cursor = result.nextCursor;
      if (!cursor) {
        const options = [...models.values()];
        if (!options.length) throw new Error("Empty Codex model catalog");
        return { models: options, defaultModel: options.find(model => model.isDefault)?.model ?? options[0].model };
      }
      if (cursors.has(cursor)) throw new Error("Repeated Codex model catalog cursor");
      cursors.add(cursor);
      listModels(cursor);
    }
    throw new Error("Codex app-server exited before returning the model catalog");
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}

export async function getCodexCatalog() {
  const entry = catalogCache();
  if (Date.now() < entry.expiresAt) return entry.catalog;
  entry.pending ??= queryCatalog().then(catalog => {
    entry.catalog = catalog;
    entry.expiresAt = Date.now() + CATALOG_TTL_MS;
    return catalog;
  }).catch(() => {
    entry.expiresAt = Date.now() + RETRY_MS;
    return entry.catalog;
  }).finally(() => { entry.pending = null; });
  return entry.pending;
}

export function resolveCodexEffort(effort, model) {
  const catalog = catalogCache().catalog;
  const entry = catalog?.models.find(option => option.model === (model || catalog.defaultModel));
  if (!entry) {
    return effort === "ultra" && !FALLBACK_ULTRA_MODELS.has(model) ? "max" : effort;
  }
  if (entry.efforts.includes(effort)) return effort;
  if (effort === "ultra" && entry.efforts.includes("max")) return "max";
  return entry.defaultEffort ?? effort;
}

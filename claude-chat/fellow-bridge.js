import crypto from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const bridgeScript = fileURLToPath(new URL("fellow-stdio.js", import.meta.url));
const leases = new Map();
const tokens = new Map();
const TTL = 16 * 60_000;
let listening;

export function operation(name, description, fields, run) {
  return { name, description, fields, schema: z.object(fields), run };
}

export async function callOperation(op, args) {
  try {
    if (!op) throw new Error("工具未注册。");
    const result = await op.run(op.schema.parse(args ?? {}));
    if (Array.isArray(result?.content)) return result;
    return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result ?? null) }], isError: result?.ok === false };
  } catch (error) {
    return { content: [{ type: "text", text: error instanceof z.ZodError ? "工具参数无效。" : error.message }], isError: true };
  }
}

function listen() {
  return listening ??= new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const lease = tokens.get(req.headers.authorization?.slice(7));
      const operations = lease?.operations;
      if (!req.headers.authorization?.startsWith("Bearer ") || req.method !== "POST" || req.url !== "/mcp" || !operations) {
        res.writeHead(403).end();
        return;
      }
      try {
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) throw new Error("工具请求过大。");
          chunks.push(chunk);
        }
        if (lease.operations !== operations) throw new Error("本轮已结束。");
        const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const result = request.method === "tools/list"
          ? { tools: operations.map(op => ({ name: op.name, description: op.description, inputSchema: z.toJSONSchema(op.schema, { target: "draft-7" }) })) }
          : request.method === "tools/call"
            ? await callOperation(operations.find(op => op.name === request.params?.name), request.params?.arguments)
            : null;
        if (!result) { res.writeHead(400).end(); return; }
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
      } catch {
        if (!res.destroyed) res.writeHead(400).end();
      }
    });
    // Only local tool subprocesses use this listener. Its address is never public.
    server.once("error", error => { listening = null; reject(error); });
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      resolve(`http://127.0.0.1:${server.address().port}/mcp`);
    });
  });
}

function removeLease(lease) {
  clearTimeout(lease.timer);
  leases.delete(lease.key);
  tokens.delete(lease.token);
  try { rmSync(lease.root, { recursive: true, force: true }); } catch { /* subprocess may be shutting down */ }
}

export async function openFellowBridge(key, operations) {
  const endpoint = await listen();
  let lease = leases.get(key);
  if (lease?.operations) throw new Error("Fellow 执行器仍在处理上一轮。");
  if (!lease) {
    const root = mkdtempSync(join(tmpdir(), "inkfellow-fellow-"));
    const cwd = join(root, "workspace");
    const plugins = join(root, "plugins");
    const plugin = join(plugins, ".agents", "plugins", "inkfellow-fellow");
    mkdirSync(cwd);
    mkdirSync(plugin, { recursive: true });
    const token = crypto.randomBytes(32).toString("hex");
    const server = {
      command: process.execPath, args: [bridgeScript],
      env: { INKFELLOW_FELLOW_BRIDGE: endpoint, INKFELLOW_FELLOW_TOKEN: token },
    };
    writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ name: "inkfellow-fellow" }), { mode: 0o600 });
    writeFileSync(join(plugin, "mcp_config.json"), JSON.stringify({ mcpServers: { fellow: server } }), { mode: 0o600 });
    const literal = value => JSON.stringify(value);
    const settings = `{fellow={command=${literal(server.command)},args=[${literal(bridgeScript)}],env={INKFELLOW_FELLOW_BRIDGE=${literal(endpoint)},INKFELLOW_FELLOW_TOKEN=${literal(token)}},tool_timeout_sec=1800}}`;
    lease = { root, cwd, plugins, key, token, codexArgs: ["-c", `mcp_servers=${settings}`], timer: null, operations: null };
    leases.set(key, lease);
    tokens.set(token, lease);
  }
  clearTimeout(lease.timer);
  lease.operations = operations;
  return {
    cwd: lease.cwd, agyDirs: [lease.plugins], codexArgs: lease.codexArgs,
    end() {
      if (lease.operations !== operations) return;
      lease.operations = null;
      lease.timer = setTimeout(() => removeLease(lease), TTL);
      lease.timer.unref?.();
    },
  };
}

process.once("exit", () => { for (const lease of leases.values()) removeLease(lease); });

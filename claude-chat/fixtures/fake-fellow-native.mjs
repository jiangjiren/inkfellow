import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const isCodex = args.includes("app-server");
if (args.includes("--help")) {
  console.log("--output-format --input-format --mode --effort --sandbox --disable-slash-commands");
  process.exit(0);
}
if (args[0] === "models") {
  console.log("gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)");
  process.exit(0);
}

const send = obj => process.stdout.write(JSON.stringify(obj) + "\n");
const profileId = isCodex ? "p_codex" : "p_antigravity";
let threadCount = 0;
let session = args.includes("--conversation") ? args[args.indexOf("--conversation") + 1] : `agy-${process.pid}`;
let turnCount = 0;

function toolConfig() {
  if (isCodex) {
    const config = args.find(arg => arg.startsWith("mcp_servers=")) || "";
    const find = key => JSON.parse(config.match(new RegExp(`${key}=("(?:[^"\\\\]|\\\\.)*")`))?.[1] || "null");
    if (!config.includes('default_tools_approval_mode="approve"')) throw new Error("Missing scoped Codex MCP approval");
    return {
      command: find("command"), args: JSON.parse(config.match(/args=(\[[^\]]*\])/)[1]),
      env: { INKFELLOW_FELLOW_BRIDGE: find("INKFELLOW_FELLOW_BRIDGE"), INKFELLOW_FELLOW_TOKEN: find("INKFELLOW_FELLOW_TOKEN") },
    };
  }
  if (!args.includes("--sandbox") || args[args.indexOf("--mode") + 1] !== "plan") throw new Error("Unscoped Gemini runtime");
  const permissions = JSON.parse(args[args.indexOf("--settings") + 1])?.permissions;
  if (!permissions?.allow?.includes("mcp(fellow/*)") || !permissions?.deny?.includes("command(*)")) {
    throw new Error("Missing scoped Gemini MCP approval");
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--add-dir") continue;
    try {
      return JSON.parse(readFileSync(join(args[i + 1], ".agents/mcp_config.json"), "utf8")).mcpServers.fellow;
    } catch { /* this is another workspace root */ }
  }
  throw new Error("Missing Gemini MCP configuration");
}

async function useTools(action) {
  const config = toolConfig();
  const proc = spawn(config.command, config.args, {
    stdio: ["pipe", "pipe", "inherit"], windowsHide: true, env: { ...process.env, ...config.env },
  });
  const output = createInterface({ input: proc.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  let next = 0;
  async function rpc(method, params = {}) {
    const id = ++next;
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    const reply = JSON.parse((await output.next()).value);
    if (reply.id !== id || reply.error) throw new Error(reply.error?.message || "MCP response mismatch");
    return reply.result;
  }
  try {
    await rpc("initialize", { protocolVersion: "2025-06-18" });
    const catalog = await rpc("tools/list");
    return await action((name, args) => rpc("tools/call", { name, arguments: args }), catalog.tools);
  } finally { proc.stdin.end(); }
}

async function respond(prompt) {
  if (prompt.includes("派出原生测试") || prompt.includes("微信派单演练")) {
    const title = prompt.includes("微信派单演练") ? "微信原生工单" : `原生任务 ${profileId}`;
    return await useTools(async (call, tools) => {
      if (!tools.some(tool => tool.name === "dispatch_task")) throw new Error("Dispatch tool missing");
      const path = `${title}.md`;
      const result = await call("dispatch_task", {
        title, brief: `写入原生工单 ${path}`, goal: "交付笔记", writeScope: [path], profileId,
      });
      if (result.isError) throw new Error(result.content[0].text);
      return `已派发 ${title}`;
    });
  }
  const worker = /写入原生工单 ([^\r\n]+\.md)/.exec(prompt);
  if (worker) {
    return await useTools(async call => {
      const written = await call("write_file", { path: worker[1], text: "abcdef\n" });
      const denied = await call("write_file", { path: "越界文件.md", text: "deny" });
      if (written.isError || !denied.isError) throw new Error("Scope policy mismatch");
      return `已交付 ${worker[1]}`;
    });
  }
  return `runtime:${process.pid} ${prompt}`;
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const msg = JSON.parse(line);
  if (isCodex) {
    const reply = result => send({ id: msg.id, result });
    if (msg.method === "initialize") { reply({}); continue; }
    if (msg.method === "model/list") {
      reply({ data: [{ model: "gpt-6.1-sol", isDefault: true, defaultReasoningEffort: "medium" }] }); continue;
    }
    if (msg.method === "thread/start" || msg.method === "thread/resume") {
      session = msg.params.threadId || `codex-${process.pid}-${++threadCount}`;
      reply({ thread: { id: session } }); continue;
    }
    if (msg.method !== "turn/start") continue;
    const turnId = `turn-${++turnCount}`;
    reply({ turn: { id: turnId } });
    send({ method: "turn/started", params: { threadId: session, turn: { id: turnId } } });
    try {
      if (args.some(arg => arg.startsWith("mcp_servers=")) && msg.params.sandboxPolicy?.type !== "readOnly") throw new Error("Unscoped Codex runtime");
      const text = await respond(msg.params.input.find(input => input.type === "text").text);
      send({ method: "item/completed", params: { threadId: session, turnId, item: { id: `answer-${turnId}`, type: "agentMessage", text } } });
      send({ method: "turn/completed", params: { threadId: session, turn: { id: turnId, status: "completed" } } });
    } catch (error) {
      send({ method: "turn/completed", params: { threadId: session, turn: { id: turnId, status: "failed", error: { message: error.message } } } });
    }
  } else {
    try {
      send({ event: "init", init: { conversation_id: session } });
      const text = await respond(msg.message.content[0].text);
      send({ event: "step_update", step_update: { step_index: ++turnCount, step_type: "agent_response", state: "DONE", text_delta: text } });
      send({ event: "result", result: { status: "SUCCESS", response: text, conversation_id: session } });
    } catch (error) {
      send({ event: "result", result: { status: "ERROR", error: error.message } });
    }
  }
}

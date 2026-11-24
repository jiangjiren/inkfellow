#!/usr/bin/env node
/**
 * ══════════════════════════════════════════════════════════════════════
 * orchestrator-mcp-bridge.js —— 跨厂商（Antigravity / Codex）原生 MCP 桥接
 * ══════════════════════════════════════════════════════════════════════
 *
 * Claude 通道使用进程内 SDK MCP（createSdkMcpServer），而 Antigravity (agy)
 * 与 Codex (app-server) 运行在独立子进程中，无法直接调用进程内函数。
 *
 * 本脚本是一个零外部依赖的标准 stdio MCP Server，仅在 Fellow 主对话启动时
 * 挂载给 agy / codex，将 7 个工单调度工具透明转发到本机 inkfellow sidecar 的
 * /api/orchestrator/* 接口（携带桌面端鉴权令牌），让三家模型都能原生并发派单。
 */

import { currentScheduleTime } from "./scheduler-intent.js";

const API_BASE = (process.env.INKFELLOW_API_BASE || "").replace(/\/+$/, "");
const DESKTOP_TOKEN = process.env.INKFELLOW_DESKTOP_TOKEN || "";
const PARENT_CONV_ID = process.env.INKFELLOW_PARENT_CONV_ID || "strategist";
const DEFAULT_VAULT_CWD = process.env.INKFELLOW_VAULT_CWD || "";

const TOOLS = [
  {
    name: "dispatch_task",
    description: "异步派发一个后台任务给独立的执行专员（Worker）。调用后会立即返回 ticketId，不阻塞主对话；可连续多次调用并行派发多个任务。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "简短任务标题（8~24字），展示在任务卡片上" },
        goal: { type: "string", description: "清晰的一句话核心目标" },
        brief: { type: "string", description: "给执行专员的完整、自包含任务说明（背景、步骤、约束与风格要求）" },
        contextFiles: { type: "array", items: { type: "string" }, description: "建议执行专员先阅读的笔记或文件路径列表" },
        writeScope: { type: "array", items: { type: "string" }, description: "可选：允许修改或新建的目录/文件路径（不填则默认允许写入非系统保护目录）" },
        cwd: { type: "string", description: "可选：任务工作目录的绝对路径（如其他代码仓库、桌面或视频素材目录；不填则默认当前 Vault）" },
        acceptanceCriteria: { type: "array", items: { type: "string" }, description: "可核对的验收标准清单" },
        provider: { type: "string", description: "可选：指定厂商、账号名称或 profile id（可先调 list_providers 查看）" },
        model: { type: "string", description: "可选：指定模型名称" },
        specialistId: { type: "string", description: "可选：指派给 .inkfellow/agents/ 下的常驻专岗 ID" },
        allowBash: { type: "boolean", description: "可选：是否允许执行命令行（写代码、剪视频、操作电脑、网页发布、跑脚本时设为 true）" },
        allowExternalAction: { type: "boolean", description: "可选：是否允许调用已配置的外部 MCP 工具（默认 false）" },
        maxTurns: { type: "integer", minimum: 1, maximum: 100, description: "工具执行回合上限" },
      },
      required: ["title", "goal", "brief"],
    },
  },
  {
    name: "list_tickets",
    description: "查看当前所有后台任务的精简状态盘面（含需拍板、进行中、排队中、已完成）以及可用常驻专岗。",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "可选按状态过滤：queued / running / needs_attention / completed / failed / stopped / interrupted" },
        limit: { type: "integer", minimum: 1, maximum: 80, description: "最多返回条数，默认 20" },
      },
    },
  },
  {
    name: "inspect_ticket",
    description: "查看某张后台任务的压缩状态报告、改动文件清单与最近执行步骤。",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string", description: "任务编号（tk_...）" },
      },
      required: ["ticketId"],
    },
  },
  {
    name: "recall_ticket_detail",
    description: "链式召回：按任务编号分页读取执行专员的对话片段与详细步骤。",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string", description: "任务编号（tk_...）" },
        offset: { type: "integer", minimum: 0, description: "消息起始偏移，默认 0" },
        limit: { type: "integer", minimum: 1, maximum: 12, description: "读取条数，默认 6" },
      },
      required: ["ticketId"],
    },
  },
  {
    name: "message_ticket",
    description: "向指定后台任务的执行专员发送补充要求、方向纠偏或返工指令。",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string", description: "任务编号（tk_...）" },
        instruction: { type: "string", description: "给执行专员的新指令或返工要求" },
      },
      required: ["ticketId", "instruction"],
    },
  },
  {
    name: "stop_ticket",
    description: "立即中止某张正在运行或排队的后台任务。",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string", description: "任务编号（tk_...）" },
      },
      required: ["ticketId"],
    },
  },
  {
    name: "list_providers",
    description: "查看当前所有已配置的 AI 账号、模型与擅长领域，便于派单时择优分配。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_schedule",
    description: "仅在用户明确要求未来自动执行或提醒，且时间与内容清楚时，创建周期性或一次性定时任务。讨论、引用文案、描述计划、自动汇报或要求现在做事时不用此工具。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["cron", "once"], description: "cron=周期性定时任务，once=一次性定时提醒" },
        description: { type: "string", description: "任务简短中文名称，如「每日AI热点晨报」" },
        cronExpr: { type: "string", description: "kind=cron 时必填，标准 5 位 cron 表达式（如 '30 8 * * *' 表示每天 8:30）" },
        runAtMs: { type: "integer", description: "kind=once 时必填，未来触发时间的毫秒时间戳，可用 get_schedule_time 读取当前时间" },
        prompt: { type: "string", description: "触发时要执行的完整指令" },
        timezone: { type: "string", description: "可选时区，默认 Asia/Shanghai" },
        outputs: { type: "array", items: { type: "string" }, description: "可选输出目标，如 ['wechat'] 或 ['chat_history']" },
      },
      required: ["kind", "description", "prompt"],
    },
  },
  {
    name: "get_schedule_time",
    description: "读取当前时间与 Unix 毫秒时间戳，以计算一次性定时任务的触发时间。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_schedules",
    description: "列出当前所有已配置的定时任务及其状态。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "delete_schedule",
    description: "删除指定 ID 的定时任务。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "定时任务 ID（可先通过 list_schedules 查看）" },
      },
      required: ["id"],
    },
  },
  {
    name: "toggle_schedule",
    description: "暂停或恢复指定 ID 的定时任务。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "定时任务 ID" },
        enabled: { type: "boolean", description: "true=启用，false=暂停" },
      },
      required: ["id", "enabled"],
    },
  },
];

function authHeaders(extra = {}) {
  const headers = { ...extra };
  if (DESKTOP_TOKEN) headers.Authorization = `Bearer ${DESKTOP_TOKEN}`;
  return headers;
}

async function apiJson(path, { method = "GET", body } = {}) {
  if (!API_BASE) throw new Error("INKFELLOW_API_BASE 未配置");
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: authHeaders(body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { ok: false, error: text || `HTTP ${response.status}` }; }
  return { ok: response.ok && data?.ok !== false, status: response.status, data };
}

function cleanDispatchArgs(raw = {}) {
  const allowedKeys = [
    "title", "goal", "brief", "cwd", "contextFiles", "writeScope", "acceptanceCriteria",
    "specialistId", "provider", "model", "effort", "allowBash", "allowExternalAction", "maxTurns",
  ];
  const body = {};
  for (const key of allowedKeys) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && !v.trim()) continue;
    body[key] = v;
  }
  if (!body.cwd && DEFAULT_VAULT_CWD) body.cwd = DEFAULT_VAULT_CWD;
  return body;
}

async function executeTool(name, args = {}) {
  if (name === "dispatch_task") {
    const res = await apiJson("/api/orchestrator/tickets", {
      method: "POST",
      body: cleanDispatchArgs(args),
    });
    return { isError: !res.ok, text: JSON.stringify(res.data) };
  }
  if (name === "list_tickets") {
    const qs = new URLSearchParams();
    if (args.status) qs.set("status", String(args.status));
    if (PARENT_CONV_ID) qs.set("parentConversationId", PARENT_CONV_ID);
    const res = await apiJson(`/api/orchestrator/tickets?${qs.toString()}`);
    if (res.ok && Array.isArray(res.data?.tickets) && Number.isFinite(Number(args.limit))) {
      res.data.tickets = res.data.tickets.slice(0, Math.max(1, Number(args.limit)));
    }
    return { isError: !res.ok, text: JSON.stringify(res.data) };
  }
  if (name === "inspect_ticket") {
    const id = encodeURIComponent(String(args.ticketId || ""));
    const res = await apiJson(`/api/orchestrator/tickets/${id}`);
    return { isError: !res.ok, text: JSON.stringify(res.data) };
  }
  if (name === "recall_ticket_detail") {
    const id = encodeURIComponent(String(args.ticketId || ""));
    const qs = new URLSearchParams();
    if (args.offset != null) qs.set("offset", String(args.offset));
    if (args.limit != null) qs.set("limit", String(args.limit));
    const res = await apiJson(`/api/orchestrator/tickets/${id}/recall?${qs.toString()}`);
    return { isError: !res.ok, text: JSON.stringify(res.data) };
  }
  if (name === "message_ticket") {
    const id = encodeURIComponent(String(args.ticketId || ""));
    const res = await apiJson(`/api/orchestrator/tickets/${id}/message`, {
      method: "POST",
      body: { instruction: String(args.instruction || "") },
    });
    return { isError: !res.ok, text: JSON.stringify(res.data) };
  }
  if (name === "stop_ticket") {
    const id = encodeURIComponent(String(args.ticketId || ""));
    const res = await apiJson(`/api/orchestrator/tickets/${id}/stop`, { method: "POST", body: {} });
    return { isError: !res.ok, text: JSON.stringify(res.data) };
  }
  if (name === "list_providers") {
    const res = await apiJson("/api/providers");
    return { isError: !res.ok, text: JSON.stringify(res.data?.providers ?? res.data) };
  }
  if (name === "create_schedule") {
    const isOnce = args.kind === "once";
    const endpoint = isOnce ? "/api/cron/jobs/once" : "/api/cron/jobs";
    const payload = {
      description: String(args.description || "").trim(),
      prompt: String(args.prompt || "").trim(),
      ...(isOnce ? { runAtMs: Number(args.runAtMs) } : { cronExpr: String(args.cronExpr || "").trim(), timezone: args.timezone || "Asia/Shanghai" }),
      ...(Array.isArray(args.outputs) && args.outputs.length ? { outputs: args.outputs } : {}),
    };
    const res = await apiJson(endpoint, { method: "POST", body: payload });
    return { isError: !res.ok, text: JSON.stringify(res.data) };
  }
  if (name === "get_schedule_time") {
    return { text: JSON.stringify(currentScheduleTime()) };
  }
  if (name === "list_schedules") {
    const res = await apiJson("/api/cron/jobs");
    return { isError: !res.ok, text: JSON.stringify(res.data) };
  }
  if (name === "delete_schedule") {
    const id = encodeURIComponent(String(args.id || ""));
    const res = await apiJson(`/api/cron/jobs/${id}`, { method: "DELETE" });
    return { isError: !res.ok, text: JSON.stringify(res.data) };
  }
  if (name === "toggle_schedule") {
    const id = encodeURIComponent(String(args.id || ""));
    const res = await apiJson(`/api/cron/jobs/${id}`, {
      method: "PATCH",
      body: { enabled: Boolean(args.enabled) },
    });
    return { isError: !res.ok, text: JSON.stringify(res.data) };
  }
  return { isError: true, text: `未知工具：${name}` };
}

let useHeaderFraming = false;

function writeMessage(msg) {
  const payload = JSON.stringify(msg);
  if (useHeaderFraming) {
    const bytes = Buffer.byteLength(payload, "utf8");
    process.stdout.write(`Content-Length: ${bytes}\r\n\r\n${payload}`);
  } else {
    process.stdout.write(`${payload}\n`);
  }
}

async function handleRequest(msg) {
  if (!msg || typeof msg !== "object") return;
  const { id, method, params } = msg;
  // 通知消息不需要回执
  if (id === undefined || id === null) return;
  try {
    if (method === "initialize") {
      writeMessage({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "orchestrator", version: "1.0.0" },
        },
      });
      return;
    }
    if (method === "ping") {
      writeMessage({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (method === "tools/list") {
      writeMessage({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      return;
    }
    if (method === "tools/call") {
      const toolName = String(params?.name || "");
      const toolArgs = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
      const out = await executeTool(toolName, toolArgs);
      writeMessage({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: out.text }],
          ...(out.isError ? { isError: true } : {}),
        },
      });
      return;
    }
    writeMessage({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  } catch (error) {
    writeMessage({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: String(error?.message || error) },
    });
  }
}

let buffer = Buffer.alloc(0);

function pumpBuffer() {
  while (buffer.length > 0) {
    // 跳过前导空白/换行
    let start = 0;
    while (start < buffer.length && (buffer[start] === 0x20 || buffer[start] === 0x09 || buffer[start] === 0x0d || buffer[start] === 0x0a)) {
      start += 1;
    }
    if (start > 0) buffer = buffer.subarray(start);
    if (buffer.length === 0) break;

    // 兼容 Content-Length 帧与 NDJSON 两种 MCP stdio 传输
    if (buffer.subarray(0, 15).toString("ascii").toLowerCase().startsWith("content-length:")) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const headerText = buffer.subarray(0, headerEnd).toString("ascii");
      const m = headerText.match(/content-length:\s*(\d+)/i);
      if (!m) { buffer = buffer.subarray(headerEnd + 4); continue; }
      const len = Number(m[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + len) break;
      useHeaderFraming = true;
      const bodyText = buffer.subarray(bodyStart, bodyStart + len).toString("utf8");
      buffer = buffer.subarray(bodyStart + len);
      try { void handleRequest(JSON.parse(bodyText)); } catch { /* 忽略非法帧 */ }
      continue;
    }

    const nl = buffer.indexOf(0x0a);
    if (nl < 0) break;
    const line = buffer.subarray(0, nl).toString("utf8").trim();
    buffer = buffer.subarray(nl + 1);
    if (!line) continue;
    try { void handleRequest(JSON.parse(line)); } catch { /* 忽略非法行 */ }
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
  pumpBuffer();
});
process.stdin.on("end", () => process.exit(0));

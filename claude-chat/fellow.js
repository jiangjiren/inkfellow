import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { join } from "node:path";
import { z } from "zod";
import { createOrchestrator, STRATEGIST_CONVERSATION_ID } from "./orchestrator.js";
import { createTicketStore, TICKET_ID_PATTERN } from "./ticket-store.js";

const text = z.string().trim().min(1).max(32_000);
const path = z.string().trim().min(1).max(2048);
const title = z.string().trim().min(1).max(120);
const dispatchFields = {
  title: title.describe("工单标题"),
  goal: text.optional().describe("独立可执行的目标"),
  brief: text.optional().describe("执行要求与相关背景"),
  writeScope: z.array(path).max(20).optional().describe("允许写入的文件或目录。路径不重叠的工单可以并行。"),
  contextFiles: z.array(path).max(30).optional().describe("应先读取的参考文件"),
  acceptanceCriteria: z.array(text.max(1000)).max(15).optional(),
  cwd: path.optional().describe("笔记库内的工作目录，缺省为笔记库根目录"),
  profileId: z.string().trim().min(1).max(120).optional().describe("执行账号 ID。缺省使用当前 Fellow 的账号。"),
  model: z.string().trim().min(1).max(250).optional(),
  specialistId: z.string().trim().min(1).max(120).optional(),
};
const dispatchSchema = z.object(dispatchFields);
const instructionSchema = z.object({
  instruction: text,
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,96}$/),
  displayText: text.optional(),
  images: z.array(z.object({
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    data: z.string().max(8_000_000),
  })).max(5).optional(),
});

export function createFellow({ dataDir, port, cwd, readProfiles, launch, stop, readMessages, hasRequest, notify, report }) {
  const tickets = createTicketStore({ dir: join(dataDir, "tickets", String(port)), vault: cwd });

  function listProfiles() {
    return readProfiles().profiles.filter(profile => (
      !["codex", "antigravity"].includes(profile.provider) && (profile.provider === "claude" || profile.apiKey)
    ));
  }

  function selectProfile(id, provider) {
    const profiles = listProfiles();
    const found = id ? profiles.find(profile => profile.id === id) :
      profiles.find(profile => profile.provider === (provider || "claude"));
    if (!found) throw new Error("请选择已配置的 Claude 或 Claude 兼容账号执行 Fellow 工单。");
    return found;
  }

  const orchestrator = createOrchestrator({
    ticketStore: tickets,
    defaultCwd: cwd,
    validateExecution: ({ profileId, provider }) => selectProfile(profileId, provider),
    launchWorker: launch,
    messageWorker: (ticket, instruction, context) => launch(ticket, { ...context, instruction }),
    stopWorker: stop,
    readWorkerMessages: readMessages,
    listProviders: () => listProfiles().map(({ id, name, provider }) => ({ id, name, provider })),
    notifyClient: notify,
    wakeStrategist: report,
  });

  async function dispatch(args, defaultProfileId) {
    const input = dispatchSchema.parse(args);
    const profile = input.profileId || !input.specialistId
      ? selectProfile(input.profileId || defaultProfileId)
      : null;
    return orchestrator.dispatchTask({
      ...input,
      ...(profile ? { profileId: profile.id, provider: profile.provider, profileName: profile.name } : {}),
      sourceChannel: "web",
      parentConversationId: STRATEGIST_CONVERSATION_ID,
    });
  }

  function tools(profileId) {
    const ticketId = z.string().regex(TICKET_ID_PATTERN);
    const limit = z.number().int().min(1).max(80);
    function fellowTool(name, description, fields, action) {
      return tool(name, description, fields, async args => {
        try {
          const result = await action(args);
          return { content: [{ type: "text", text: JSON.stringify(result) }], isError: result?.ok === false };
        } catch (error) {
          return { content: [{ type: "text", text: error.message }], isError: true };
        }
      });
    }
    return createSdkMcpServer({
      name: "orchestrator",
      tools: [
        fellowTool("dispatch_task", "异步派出工单，返回编号后可继续派其他任务或回复用户。", dispatchFields, args => dispatch(args, profileId)),
        fellowTool("list_tickets", "查看工单盘面。", {
          status: z.string().optional(), limit: limit.optional(),
        }, args => orchestrator.listTickets({ ...args, parentConversationId: STRATEGIST_CONVERSATION_ID })),
        fellowTool("inspect_ticket", "查看工单结果和近期执行步骤。", { ticketId }, args => orchestrator.inspectTicket(args.ticketId)),
        fellowTool("recall_ticket_detail", "读取 Worker 的历史消息。", {
          ticketId, offset: z.number().int().nonnegative().optional(), limit: limit.optional(),
        }, args => orchestrator.recallTicketDetail(args.ticketId, args)),
        fellowTool("message_ticket", "向工单转达用户的新增要求。", { ticketId, instruction: text },
          args => orchestrator.messageTicket(args.ticketId, args.instruction)),
        fellowTool("stop_ticket", "停止工单并等待执行器退出。", { ticketId }, args => orchestrator.stopTicket(args.ticketId)),
        fellowTool("list_providers", "列出可执行工单的账号。", {}, orchestrator.listProviders),
      ],
    });
  }

  async function handle(req, res, url, method) {
    function reply(status, payload) {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(payload));
    }
    try {
      if (url === "/api/fellow/tickets") {
        if (method === "GET") return reply(200, orchestrator.listTickets({ limit: Infinity }));
        if (method === "POST") {
          const result = await dispatch(await readJson(req));
          return reply(result.ok ? 202 : 409, result);
        }
      }
      if (url === "/api/fellow/profiles" && method === "GET") return reply(200, orchestrator.listProviders());
      const match = url.match(/^\/api\/fellow\/tickets\/(tk_[a-z0-9_-]{1,80})(?:\/(message|stop|retry|archive|unarchive))?$/i);
      if (!match) return reply(404, { error: "工单接口不存在。" });
      const [, id, action] = match;
      const ticket = tickets.get(id);
      if (!ticket) return reply(404, { error: "工单不存在。" });
      if (!action && method === "GET") return reply(200, orchestrator.inspectTicket(id));
      if (method !== "POST") return reply(405, { error: "不支持此请求方法。" });
      let result;
      switch (action) {
        case "message": {
          const { instruction, requestId, ...message } = instructionSchema.parse(await readJson(req));
          if (hasRequest(ticket.workerConversationId, requestId)) return reply(202, { ok: true, duplicate: true });
          result = await orchestrator.messageTicket(id, instruction, { ...message, fromUser: true, requestId });
          break;
        }
        case "stop": result = await orchestrator.stopTicket(id); break;
        case "retry": result = await orchestrator.retryTicket(id); break;
        case "archive":
        case "unarchive": result = orchestrator.setTicketArchived(id, action === "archive"); break;
        default: return reply(405, { error: "不支持此请求方法。" });
      }
      return reply(result.ok ? 200 : 409, result);
    } catch (error) {
      if (!res.destroyed) reply(400, { error: error instanceof z.ZodError ? "工单参数无效。" : error.message });
    }
  }

  return { orchestrator, selectProfile, tools, handle, getWorkerTicket: tickets.findByWorkerConversationId };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_000_000) {
      req.resume();
      return Promise.reject(new Error("请求内容过大。"));
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * WorkerWatchdog —— 后台 Worker 外部看门狗
 * ══════════════════════════════════════════════════════════════════════
 *
 * 桌面端主会话为了不误杀长任务取消了静默超时，但后台并发 Worker 一旦陷入
 * 工具报错死循环、卡死不动、或越界改文件，用户切回军师根本察觉不到。
 *
 * 看门狗在 Worker 之外独立巡检，命中异常时自动标黄为 needs_attention 并触发
 * 回调（暂停或告警通知军师与用户），绝不让后台任务默默空转烧额度。
 */

import { scopedWriteTarget } from "./write-scope-lock.js";

export const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "AskUserQuestion", "WebSearch", "WebFetch"];
export const WORKER_TOOLS = [...READ_ONLY_TOOLS, "Write", "Edit", "NotebookEdit"];

export function workerToolDecision(
  ticket,
  toolName,
  input,
  vault,
  pinned = ticket.mandate.canonicalScopes,
  { allowOutsideVault = false } = {},
) {
  if (READ_ONLY_TOOLS.includes(toolName)) return {};
  if (toolName === "Bash") {
    return ticket?.mandate?.allowBash === true
      ? {}
      : { reason: "当前工单未开启命令行（allowBash）权限" };
  }
  if (ticket?.mandate?.allowExternalAction === true
    && typeof toolName === "string"
    && toolName.startsWith("mcp__")
    && !toolName.startsWith("mcp__orchestrator__")) {
    return {};
  }
  if (!WORKER_TOOLS.includes(toolName)) return { reason: "工单运行器未授权此工具" };
  const key = toolName === "NotebookEdit" ? "notebook_path" : "file_path";
  const target = input?.[key];
  if (typeof target !== "string" || !target.trim()) return { reason: "工单写入操作缺少目标文件" };
  const cwd = ticket.execution.cwd || vault;
  const effectiveScope = Array.isArray(pinned) && pinned.length > 0
    ? pinned
    : (ticket.mandate.writeScope || []);
  const path = scopedWriteTarget(target, effectiveScope, cwd, vault, {
    canonical: Array.isArray(pinned) && pinned.length > 0,
    allowOutsideVault,
  });
  return path ? { input: { ...input, [key]: path } } : { reason: `已拦截工单范围之外的写入：${target}` };
}

export function workerToolEvents(event) {
  const blocks = event.type === "assistant" || event.type === "user"
    ? (event.message?.content ?? event.content ?? [])
    : [event];
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap(block => {
    if (["tool_use", "server_tool_use", "mcp_tool_use"].includes(block?.type)) {
      return [{ phase: "start", id: block.id, name: block.name, input: block.input }];
    }
    const raw = block?.raw;
    if (["command_execution", "mcp_tool_call", "web_search", "file_change"].includes(raw?.type) && raw.id) {
      return [{
        phase: "result", id: raw.id,
        name: raw.type === "file_change" ? "apply_patch" : raw.type === "command_execution" ? "Bash" : raw.tool || raw.type,
        isError: raw.status === "failed" || raw.status === "declined" || Boolean(raw.error)
          || raw.result?.isError === true || (Number.isInteger(raw.exit_code ?? raw.exitCode) && (raw.exit_code ?? raw.exitCode) !== 0),
        input: raw.type === "file_change" ? { changes: raw.changes } : undefined,
      }];
    }
    if (block?.type === "tool_result" || block?.type === "mcp_tool_result") {
      return [{
        phase: "result", id: block.tool_use_id,
        isError: block.is_error === true || raw?.tool_info?.is_error === true || Boolean(raw?.tool_info?.error),
      }];
    }
    return [];
  });
}

export class WorkerWatchdog {
  constructor({
    ticketStore,
    onFlag,
    intervalMs = 30_000,
    stallTimeoutMs = 5 * 60_000,
    maxConsecutiveErrors = 4,
    now = () => Date.now(),
    activityAt = ticket => ticket.execution?.lastActivityAt,
  } = {}) {
    if (!ticketStore) throw new TypeError("ticketStore is required");
    if (typeof onFlag !== "function") throw new TypeError("onFlag is required");
    this.ticketStore = ticketStore;
    this.onFlag = onFlag;
    this.intervalMs = intervalMs;
    this.stallTimeoutMs = stallTimeoutMs;
    this.maxConsecutiveErrors = maxConsecutiveErrors;
    this.now = now;
    this.activityAt = activityAt;
    this._timer = null;
    this._flagged = new Set(); // ticketId:attempt 防止同一轮重复告警
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      try { this.checkOnce(); } catch { /* 巡检异常不崩主进程 */ }
    }, this.intervalMs);
    this._timer.unref?.();
  }

  stop() {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  clearFlag(ticketId, attempt = null) {
    if (attempt != null) {
      this._flagged.delete(`${ticketId}:${attempt}`);
      return;
    }
    for (const key of [...this._flagged]) {
      if (key.startsWith(`${ticketId}:`)) this._flagged.delete(key);
    }
  }

  /** 单次全量巡检（也方便单测直接同步调用）。 */
  checkOnce() {
    const running = this.ticketStore.list({ status: ["running", "needs_attention"], limit: Infinity });
    const current = this.now();
    const flagged = [];
    for (const ticket of running) {
      const attempt = ticket.execution?.attempt ?? 0;
      const flagKey = `${ticket.id}:${attempt}`;
      if (this._flagged.has(flagKey)) continue;

      const consecutiveErrors = ticket.execution?.consecutiveErrors ?? 0;
      if (consecutiveErrors >= this.maxConsecutiveErrors) {
        const reason = `后台任务连续 ${consecutiveErrors} 次工具执行报错，可能陷入重试循环，请进入现场检查或中止。`;
        this._trigger(ticket, reason, { kind: "error_loop", consecutiveErrors });
        flagged.push({ ticketId: ticket.id, reason });
        continue;
      }

      const lastActivity = Number(this.activityAt(ticket) || 0);
      if (lastActivity > 0 && current - lastActivity >= this.stallTimeoutMs) {
        const mins = Math.max(1, Math.round((current - lastActivity) / 60_000));
        const reason = `后台任务已超过 ${mins} 分钟无新进展，可能卡住，建议进入现场查看或中止。`;
        this._trigger(ticket, reason, { kind: "stalled", silentMs: current - lastActivity });
        flagged.push({ ticketId: ticket.id, reason });
      }
    }
    return flagged;
  }

  _trigger(ticket, reason, meta = {}) {
    const attempt = ticket.execution?.attempt ?? 0;
    const flagKey = `${ticket.id}:${attempt}`;
    if (this._flagged.has(flagKey)) return;
    this._flagged.add(flagKey);
    try {
      this.onFlag(ticket, reason, meta);
    } catch { /* 回调异常不阻塞其他工单巡检 */ }
  }
}

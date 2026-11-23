/**
 * ══════════════════════════════════════════════════════════════════════
 * TicketStore —— 持久化任务工单（存算分离）
 * ══════════════════════════════════════════════════════════════════════
 *
 * 把「任务（Ticket）」与「干活的会话算力（Worker ConversationSession）」解耦：
 *   - Ticket 是持久化的一等公民，落盘在 <dir>/<ticketId>.json，携带不可变的
 *     Mandate（目标、范围、写权限边界、验收标准）以及最新的执行状态与产物摘要。
 *   - Worker 会话只是当前承接这张工单的算力实例：进程重启、模型限额切换、
 *     用户点进现场亲自指挥后，工单的身份与台账始终连续。
 */

import crypto from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { canonicalPath } from "./write-scope-lock.js";

export const TICKET_STATUSES = new Set([
  "queued",
  "running",
  "needs_attention",
  "stopping",
  "completed",
  "failed",
  "stopped",
  "interrupted",
  "partial",
]);

export const TERMINAL_TICKET_STATUSES = new Set([
  "completed",
  "failed",
  "stopped",
  "interrupted",
  "partial",
]);

export const ACTIVE_TICKET_STATUSES = new Set([
  "queued",
  "running",
  "needs_attention",
  "stopping",
]);

function safeFileName(id) {
  const safe = String(id).replace(/[^A-Za-z0-9_-]/g, "_");
  return `${safe}.json`;
}

function normalizeStringList(values, maxItems = 40) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const out = [];
  for (const item of values) {
    const s = String(item ?? "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

export const TICKET_ID_PATTERN = /^tk_[a-z0-9_-]{1,80}$/i;

export function makeTicketId() {
  return `tk_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
}

export function workerConversationIdFor(ticketId) {
  return `wrk_${ticketId}`;
}

export function createTicketStore({ dir, vault = null, now = () => Date.now() }) {
  mkdirSync(dir, { recursive: true });
  const tickets = new Map();
  const vaultId = vault ? canonicalPath(vault) : null;

  function filePathFor(id) {
    return join(dir, safeFileName(id));
  }

  function writeTicketToDisk(ticket) {
    const file = filePathFor(ticket.id);
    const tmp = `${file}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(ticket, null, 2)}\n`, "utf8");
      renameSync(tmp, file);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* preserve the write error */ }
      throw error;
    }
  }

  function loadAll() {
    tickets.clear();
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
    for (const file of files) {
      try {
        const raw = readFileSync(join(dir, file), "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && TICKET_ID_PATTERN.test(parsed.id) && file === safeFileName(parsed.id)) {
          // Legacy records with a different working directory cannot identify their owning Vault.
          if (vaultId && (parsed.vaultId
            ? parsed.vaultId !== vaultId
            : !parsed.execution?.cwd || canonicalPath(parsed.execution.cwd) !== vaultId)) continue;
          if (vaultId && !parsed.vaultId) {
            parsed.vaultId = vaultId;
            writeTicketToDisk(parsed);
          }
          parsed.workerConversationId = workerConversationIdFor(parsed.id);
          tickets.set(parsed.id, parsed);
        }
      } catch {
        // 损坏的单个工单文件不阻塞整体启动
      }
    }
  }

  loadAll();

  /**
   * 进程重启后对账：上次退出时还标着 running / queued 的工单已经没有活跃子进程了，
   * 统一标成 interrupted，用户可一键重试或继续指挥，不会永远显示转圈。
   */
  function reconcileOnBoot() {
    const updated = [];
    for (const ticket of tickets.values()) {
      if (!ACTIVE_TICKET_STATUSES.has(ticket.status)) continue;
      updated.push(update(ticket.id, draft => {
        draft.status = "interrupted";
        draft.execution.finishedAt = new Date(now()).toISOString();
        draft.result.pendingQuestion = null;
        draft.result.attentionReason = null;
        if (draft.pendingReport?.status === "needs_attention") delete draft.pendingReport;
        draft.result.error = "服务重启导致后台任务中断，请检查已有进展后继续。";
      }));
    }
    return updated;
  }

  function create({
    id = makeTicketId(),
    parentConversationId = "strategist",
    title,
    goal,
    brief,
    contextFiles = [],
    writeScope = [],
    acceptanceCriteria = [],
    specialistId = null,
    allowBash = false,
    allowExternalAction = false,
    maxTurns = 30,
    provider = null,
    profileId = null,
    profileName = null,
    model = null,
    effort = null,
    permissionMode = "auto",
    cwd = null,
    canonicalScopes = null,
    sourceChannel = "desktop",
    sourcePeer = null,
  } = {}) {
    if (!TICKET_ID_PATTERN.test(id) || tickets.has(id)) throw new Error("无效或重复的工单 ID");
    const cleanTitle = String(title || goal || "未命名任务").trim().slice(0, 120);
    const cleanGoal = String(goal || title || "").trim();
    const cleanBrief = String(brief || cleanGoal).trim();
    if (!cleanGoal && !cleanBrief) {
      throw new Error("创建工单需要提供 goal 或 brief");
    }
    const ts = new Date(now()).toISOString();
    const ticket = {
      id,
      vaultId,
      revision: 1,
      parentConversationId: String(parentConversationId || "strategist").trim(),
      workerConversationId: workerConversationIdFor(id),
      title: cleanTitle,
      kind: specialistId ? "specialist" : "ephemeral",
      specialistId: specialistId ? String(specialistId).trim() : null,
      status: "queued",
      sourceChannel: String(sourceChannel || "desktop"),
      sourcePeer: sourcePeer ? String(sourcePeer) : null,
      mandate: {
        goal: cleanGoal || cleanTitle,
        brief: cleanBrief,
        contextFiles: normalizeStringList(contextFiles, 30),
        writeScope: normalizeStringList(writeScope, 20),
        acceptanceCriteria: normalizeStringList(acceptanceCriteria, 15),
        allowBash: allowBash === true,
        canonicalScopes,
        allowExternalAction: allowExternalAction === true,
        maxTurns: Number.isFinite(Number(maxTurns)) ? Math.max(1, Math.min(100, Number(maxTurns))) : 30,
        maxDelegationDepth: 0,
      },
      execution: {
        provider: provider || null,
        profileId: profileId || null,
        profileName: profileName || null,
        model: model || null,
        effort: effort || null,
        permissionMode: permissionMode || "auto",
        cwd: cwd || null,
        attempt: 0,
        pendingInstructions: [],
        startedAt: null,
        finishedAt: null,
        lastActivityAt: now(),
        stepsCount: 0,
        consecutiveErrors: 0,
        lastStepLabel: "",
        recentSteps: [],
        blockedBy: [],
      },
      result: {
        summary: "",
        changedFiles: [],
        artifactPaths: [],
        error: null,
        attentionReason: null,
        pendingQuestion: null,
      },
      createdAt: ts,
      updatedAt: ts,
      reportedAt: null,
    };
    writeTicketToDisk(ticket);
    tickets.set(ticket.id, ticket);
    return structuredClone(ticket);
  }

  function get(id) {
    const t = tickets.get(String(id ?? "").trim());
    return t ? structuredClone(t) : null;
  }

  function findByWorkerConversationId(workerConversationId) {
    const key = String(workerConversationId ?? "").trim();
    if (!key) return null;
    for (const ticket of tickets.values()) {
      if (ticket.workerConversationId === key) return structuredClone(ticket);
    }
    return null;
  }

  function update(id, mutator) {
    const key = String(id ?? "").trim();
    const existing = tickets.get(key);
    if (!existing) return null;
    const draft = structuredClone(existing);
    if (typeof mutator === "function") {
      mutator(draft);
    } else if (mutator && typeof mutator === "object") {
      Object.assign(draft, mutator);
    }
    // Mandate 一旦签发不可随意改写（只允许状态、执行与结果演化）
    draft.id = existing.id;
    draft.workerConversationId = existing.workerConversationId;
    draft.mandate = existing.mandate;
    draft.vaultId = existing.vaultId;
    draft.revision = (existing.revision || 0) + 1;
    if (!TICKET_STATUSES.has(draft.status)) draft.status = existing.status;
    draft.updatedAt = new Date(now()).toISOString();
    writeTicketToDisk(draft);
    tickets.set(key, draft);
    return structuredClone(draft);
  }

  function remove(id) {
    const key = String(id ?? "").trim();
    if (!tickets.has(key)) return false;
    const file = filePathFor(key);
    try { unlinkSync(file); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    tickets.delete(key);
    return true;
  }

  function removeFinished(canRemove = () => true) {
    const removedIds = [];
    const failedIds = [];
    for (const ticket of tickets.values()) {
      if (!TERMINAL_TICKET_STATUSES.has(ticket.status) || !canRemove(ticket.id)) continue;
      try {
        if (remove(ticket.id)) removedIds.push(ticket.id);
      } catch (error) {
        console.warn(`[Orchestrator] Could not remove ticket ${ticket.id}:`, error.message);
        failedIds.push(ticket.id);
      }
    }
    return { removedIds, failedIds };
  }

  /**
   * 列表排序按注意力优先级：
   *   needs_attention > running > queued > 其他按更新时间倒序
   */
  function list({ status = null, parentConversationId = null, limit = 100 } = {}) {
    const priority = {
      needs_attention: 0,
      running: 1,
      stopping: 1,
      queued: 2,
      failed: 3,
      interrupted: 4,
      completed: 5,
      stopped: 6,
    };
    const statusSet = Array.isArray(status)
      ? new Set(status)
      : (typeof status === "string" && status.trim() ? new Set([status.trim()]) : null);

    let items = [...tickets.values()];
    if (statusSet) items = items.filter((t) => statusSet.has(t.status));
    if (parentConversationId) {
      items = items.filter((t) => t.parentConversationId === parentConversationId);
    }
    items.sort((a, b) => {
      const pa = priority[a.status] ?? 9;
      const pb = priority[b.status] ?? 9;
      if (pa !== pb) return pa - pb;
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });
    return items.slice(0, Math.max(1, limit)).map((t) => structuredClone(t));
  }

  /** 返回给军师 Inline 注入或前端看板的精简摘要，严控体积。 */
  function toSummary(ticket) {
    if (!ticket) return null;
    return {
      id: ticket.id,
      revision: ticket.revision || 0,
      parentConversationId: ticket.parentConversationId,
      workerConversationId: ticket.workerConversationId,
      title: ticket.title,
      kind: ticket.kind,
      specialistId: ticket.specialistId,
      status: ticket.status,
      provider: ticket.execution?.provider || null,
      profileId: ticket.execution?.profileId || null,
      profileName: ticket.execution?.profileName || null,
      model: ticket.execution?.model || null,
      effort: ticket.execution?.effort || null,
      nextConfig: ticket.execution?.nextConfig || null,
      cwd: ticket.execution?.cwd || null,
      writeScope: ticket.mandate?.writeScope || [],
      blockedBy: ticket.execution?.blockedBy || [],
      stepsCount: ticket.execution?.stepsCount || 0,
      lastStepLabel: ticket.execution?.lastStepLabel || "",
      startedAt: ticket.execution?.startedAt || null,
      finishedAt: ticket.execution?.finishedAt || null,
      lastActivityAt: ticket.execution?.lastActivityAt || null,
      summary: ticket.result?.summary || "",
      changedFiles: ticket.result?.changedFiles || [],
      artifactPaths: ticket.result?.artifactPaths || [],
      error: ticket.result?.error || null,
      attentionReason: ticket.result?.attentionReason || null,
      pendingQuestion: ticket.result?.pendingQuestion || null,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
    };
  }

  return {
    dir,
    create,
    get,
    findByWorkerConversationId,
    update,
    remove,
    removeFinished,
    list,
    toSummary,
    reconcileOnBoot,
  };
}

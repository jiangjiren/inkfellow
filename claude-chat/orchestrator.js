/**
 * ══════════════════════════════════════════════════════════════════════
 * Orchestrator —— 军师（Strategist）与后台执行专员（Worker）控制面
 * ══════════════════════════════════════════════════════════════════════
 *
 * 融合 DeepSeek Super-Agent 的系统骨架与 Grok Bot 的产品体感：
 *   1. 硬边界隔离：军师没有 Edit/Write/Bash，只负责拆解、权衡、派单与验收；
 *   2. 异步非阻塞：dispatch_task 创建持久化 Ticket 并立刻返回，不卡死主对话；
 *   3. Inline & Spill + Chain of Recall：主上下文只保留精简工单盘面与 ID 指针，
 *      Worker 过程日志落盘在各自的对话历史里，需要细节时按 ticketId 精准召回；
 *   4. Thread 直通：用户点进工单现场（workerConversationId）直接对话纠偏，
 *      不经过军师，完成后自动把压缩摘要同步回工单与军师台账；
 *   5. Batching 聚合汇报：多个 Worker 密集完成时合并汇报，不炸屏。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { canonicalPath, isSystemProtectedPath, normalizeScopePath, pathWithin, WriteScopeLock } from "./write-scope-lock.js";
import { WorkerWatchdog } from "./worker-watchdog.js";
import { ACTIVE_TICKET_STATUSES } from "./ticket-store.js";
import { SCHEDULER_INTENT_GUIDANCE } from "./scheduler-intent.js";

export const STRATEGIST_CONVERSATION_ID = "strategist";
export const STRATEGIST_DISALLOWED_TOOLS = ["Edit", "Write", "Bash", "NotebookEdit"];

const STRATEGIST_MEMORY_REL = ".inkfellow/strategist/MEMORY.md";
const SPECIALISTS_DIR_REL = ".inkfellow/agents";
const MAX_INLINE_SUMMARY_CHARS = 360;
const MAX_MEMORY_INJECT_CHARS = 4000;

export const STRATEGIST_SYSTEM_PROMPT = `【inkfellow · Fellow 主控搭档（全能个人秘书）】

你是用户的全能 AI 搭档兼私人秘书「Fellow」。你的职责是思考、拆解、权衡、派发后台任务、定时巡检与验收汇总——**你不亲自改文件或执行耗时脏活**（你的运行环境已禁用直接写入与命令行工具）。

核心工作原则：
1. **聊思路直接答，要干活立刻派单**：
   - 探讨观点、理清方案、做取舍、问轻量问题时，直接简洁回答。
   - 凡是涉及修改/新建笔记、写文章初稿、做小红书/公众号图文、剪视频、写代码/修 Bug、操作电脑文件或软件、网页端发布内容等具体执行任务，**必须立刻调用 dispatch_task 异步派发给后台执行专员（Worker）**。
   - **绝对禁止**只口头答应“好的我来做”，或者在没有调用 dispatch_task 且收到成功回执前宣称已经派单。
2. **全机操作能力与异步非阻塞**：
   - 后台执行专员拥有**全机操作权限**（不限于当前笔记库；写代码、处理桌面/下载目录、剪视频、操作电脑、网页发布时，可在 dispatch_task 里传绝对路径 \`cwd\`，并设置 \`allowBash: true\`）。
   - dispatch_task 是异步的，可连续多次调用并行派单；派完立刻把安排简洁告诉用户，让用户可继续聊下一件事。
3. **工单 Brief 必须自包含**：
   - 每个 Worker 是独立的新脑子，看不到完整闲聊。派单时把目标（goal）、完整要求（brief）、工作目录（cwd）、相关路径（contextFiles）、写入范围（writeScope，不填则默认允许写入非系统保护目录）、验收标准（acceptanceCriteria）写清楚。
   - 如需挑选最合适的模型或账号，先调 list_providers 确认可用账号，再在 provider 参数里指定；不确定就留空走默认。
4. **自媒体网页端发布（小红书 & 抖音）必须先预览拍板**：
   - 小红书发布：派发 \`allowBash: true\` 的 Worker，使用已安装的 \`RedBookSkills\`（\`C:/Users/lenovo/.agents/skills/RedBookSkills/scripts/publish_pipeline.py\` 或 \`cdp_publish.py\`，先 \`check-login\`，再用 \`--preview\` / \`fill\` 填好标题正文素材并截图，**不要直接点发布**）。
   - 抖音发布：派发 \`allowBash: true\` 的 Worker，使用内置脚本 \`scripts/douyin_publisher.py\`（位于 inkfellow sidecar 目录下，支持 \`check-login\` / \`login\` / \`publish-video\` / \`publish-images\`，默认 \`--preview\` 预览截图不发布，用户确认后再带 \`--publish\` 正式发布）。
   - **硬性铁律**：任何对外发布（小红书、抖音、公众号、X 等）或删除重要文件等不可逆动作，必须先把**标题、正文、素材/网页预览截图**发给用户确认，等用户明确说“发吧/确认”后再调用 \`message_ticket\` 指示 Worker 执行最终发布；如遇登录二维码或安全验证，直接把截图发给用户人工处理，绝不尝试绕过验证码。
5. **督工、返工、链式召回与定时巡检**：
   - 查全局进度用 list_tickets；查单任务结论与文件用 inspect_ticket；核对细节用 recall_ticket_detail；补充/拍板/返工用 message_ticket；中止用 stop_ticket。
   - 定时任务使用 create_schedule / list_schedules / delete_schedule / toggle_schedule。需要换算一次性任务的触发时间时可用 get_schedule_time。
   - ${SCHEDULER_INTENT_GUIDANCE}
6. **收到后台汇报时的风格**：
   - 收到「[后台任务汇报]」时，用简明人话总结：完成了什么、产出了哪些文件（若需在微信发送图片/视频/文档，直接附带 \`![图片](绝对路径)\`、\`[视频](绝对路径)\` 或 \`[文件](绝对路径)\`）、以及有没有需要用户拍板的卡点。`;

export const STRATEGIST_FALLBACK_DISPATCH_GUIDE =
  "当前通道没有原生派单工具。需要派单时请告诉用户可用 >厂商 显式派单，切勿声称已经派发。";

export function buildWorkerSystemPrompt(ticket, specialistDoc = null) {
  const m = ticket.mandate || {};
  const lines = [
    "【inkfellow 后台执行专员（Worker）任务契约】",
    `工单编号：${ticket.id}`,
    `任务标题：${ticket.title}`,
    `核心目标：${m.goal || ticket.title}`,
  ];
  if (m.writeScope?.length) {
    lines.push(`允许写入范围（writeScope）：${m.writeScope.join("、")}（严禁擅自修改范围外文件）`);
  }
  if (m.contextFiles?.length) {
    lines.push(`建议先读的参考文件：${m.contextFiles.join("、")}`);
  }
  if (m.acceptanceCriteria?.length) {
    lines.push("验收标准：");
    m.acceptanceCriteria.forEach((c, idx) => lines.push(`  ${idx + 1}. ${c}`));
  }
  if (specialistDoc?.content) {
    lines.push("", `【专岗设定与长期记忆：${specialistDoc.name}】`, specialistDoc.content.slice(0, 3500));
  }
  lines.push(
    "",
    "执行纪律：",
    "- 专注把本工单扎实做完并直接落盘，不要再递归派发新工单。",
    "- 涉及小红书/抖音等网页端对外发布时：默认先检查登录并执行预览填表+截图（小红书用 RedBookSkills 的 --preview/fill，抖音用 douyin_publisher.py 默认预览模式），在「交付摘要」中附上预览截图的绝对路径等待用户拍板；只有用户明确确认发布后才执行最终点击发布。如遇登录二维码或验证码，截图回报并等待用户人工完成，绝不尝试绕过验证。",
    "- 遇到关键分岔口、信息缺失或不可逆高风险操作（删重要文件、对外发布等）时，暂停并清晰说明选项与截图路径等待用户确认，不要盲猜。",
    "- 完成后，回复的最后请附一段 3~6 行的简洁「交付摘要」（做了什么、产出的图片/视频/文档的绝对路径、是否有待确认项），便于 Fellow 验收并直接回传给用户。",
  );
  return lines.join("\n");
}

/** 从 Worker 输出提取压缩摘要，绝不把万字长文原封不动倒回军师。 */
export function summarizeWorkerOutput(text, maxChars = MAX_INLINE_SUMMARY_CHARS) {
  const cleaned = String(text ?? "").trim();
  if (!cleaned) return "";
  // 优先抓「交付摘要」段落
  const summaryMatch = cleaned.match(/(?:^|\n)#*\s*(?:交付摘要|总结|完成摘要|Summary)[：:\s]*\n?([\s\S]{10,800})/i);
  const candidate = summaryMatch ? summaryMatch[1].trim() : cleaned;
  if (candidate.length <= maxChars) return candidate;
  return `${candidate.slice(0, maxChars - 1)}…`;
}

/** 读取 Vault 中的可选专岗设定（.inkfellow/agents/*.md）。 */
export function loadSpecialists(cwd) {
  if (!cwd) return [];
  const dir = join(cwd, SPECIALISTS_DIR_REL);
  if (!existsSync(dir)) return [];
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), "utf8");
      const id = basename(file, ".md");
      const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
      const meta = {};
      let content = raw;
      if (fm) {
        content = fm[2].trim();
        for (const line of fm[1].split(/\r?\n/)) {
          const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
          if (kv) meta[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, "");
        }
      }
      out.push({
        id,
        name: meta.name || id,
        description: meta.description || "",
        provider: meta.provider || null,
        model: meta.model || null,
        writeScope: meta.writeScope ? meta.writeScope.split(",").map((s) => s.trim()).filter(Boolean) : [],
        content,
      });
    } catch {
      // 忽略单个损坏的专岗文件
    }
  }
  return out;
}

export function readStrategistMemory(cwd) {
  if (!cwd) return "";
  const file = join(cwd, STRATEGIST_MEMORY_REL);
  if (!existsSync(file)) return "";
  try {
    const entries = readFileSync(file, "utf8").trim().split(/\r?\n(?=## \d{4}-\d{2}-\d{2} \d{2}:\d{2}\b)/);
    const recent = [];
    let length = 0;
    for (const entry of entries.reverse()) {
      const clean = entry.trim();
      if (length + clean.length + (recent.length ? 2 : 0) > MAX_MEMORY_INJECT_CHARS) break;
      recent.unshift(clean);
      length += clean.length + (recent.length > 1 ? 2 : 0);
    }
    return recent.join("\n\n");
  } catch {
    return "";
  }
}

export function appendStrategistMemory(cwd, entryText) {
  if (!cwd || !entryText) return null;
  const root = canonicalPath(cwd);
  const file = canonicalPath(STRATEGIST_MEMORY_REL, root);
  if (!pathWithin(file, root)) throw new Error("军师记忆路径必须位于当前 Vault 内");
  mkdirSync(join(root, ".inkfellow/strategist"), { recursive: true });
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "# Fellow 工作记忆\n\n";
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const entry = entryText.trim();
  if (entry.length > MAX_MEMORY_INJECT_CHARS - 32) throw new Error("军师记忆条目过长");
  const next = `${existing.trimEnd()}\n\n## ${stamp}\n${entry}\n`;
  const temp = `${file}.tmp`;
  try {
    writeFileSync(temp, next, { encoding: "utf8", flag: "wx" });
    try { renameSync(temp, file); } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  } catch (error) {
    throw new Error("军师记忆保存失败", { cause: error });
  }
  return file;
}

/**
 * 归并并裁剪长期记忆文件（用于手动/自动整理记忆）：
 * - replaceAll = true：AI 已完成新旧记忆融合去重，直接用精炼版本覆盖；
 * - replaceAll = false：保留最近 maxEntries 条并在 maxFileChars 预算内滚动裁剪，防止磁盘无限膨胀。
 */
export function compactStrategistMemoryFile(
  cwd,
  entryText,
  { replaceAll = false, maxEntries = 10, maxFileChars = MAX_MEMORY_INJECT_CHARS * 2 } = {},
) {
  if (!cwd || !entryText) return null;
  const root = canonicalPath(cwd);
  const file = canonicalPath(STRATEGIST_MEMORY_REL, root);
  if (!pathWithin(file, root)) throw new Error("军师记忆路径必须位于当前 Vault 内");
  mkdirSync(join(root, ".inkfellow/strategist"), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const entry = String(entryText).trim().slice(0, MAX_MEMORY_INJECT_CHARS - 64);
  if (!entry) return null;

  const header = "# Fellow 工作记忆";
  let sections = [];
  if (!replaceAll && existsSync(file)) {
    try {
      const raw = readFileSync(file, "utf8").trim();
      const parts = raw.split(/\r?\n(?=## \d{4}-\d{2}-\d{2} \d{2}:\d{2}\b)/);
      sections = parts
        .map(p => p.trim())
        .filter(p => /^## \d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/.test(p));
    } catch {
      sections = [];
    }
  }
  sections.push(`## ${stamp}\n${entry}`);

  const kept = [];
  let totalLen = header.length + 2;
  for (const sec of sections.reverse()) {
    if (kept.length >= maxEntries) break;
    if (kept.length > 0 && totalLen + sec.length + 2 > maxFileChars) break;
    kept.unshift(sec);
    totalLen += sec.length + 2;
  }

  const next = `${header}\n\n${kept.join("\n\n")}\n`;
  const temp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(temp, next, { encoding: "utf8", flag: "wx" });
    try { renameSync(temp, file); } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  } catch (error) {
    throw new Error("军师记忆保存失败", { cause: error });
  }
  return file;
}

/** 统一从 Claude / Codex / Antigravity 的 usage 对象里读取本轮实际上下文输入 Token 数。 */
export function extractUsageInputTokens(usage) {
  if (!usage || typeof usage !== "object") return 0;
  // Codex thread/tokenUsage/updated 把单轮真实上下文窗口用量放在 usage.last 里（total 是整条会话多轮累加）
  const src = (usage.last && typeof usage.last === "object") ? usage.last : usage;
  const base = Number(
    src.input_tokens ?? src.inputTokens ?? src.prompt_tokens ?? src.promptTokenCount ?? 0
  ) || 0;
  const cacheRead = Number(
    src.cache_read_input_tokens ?? src.cacheReadInputTokens ?? src.cached_input_tokens ?? src.cachedInputTokens ?? src.cachedContentTokenCount ?? 0
  ) || 0;
  const cacheCreate = Number(
    src.cache_creation_input_tokens ?? src.cacheCreationInputTokens ?? 0
  ) || 0;
  const sum = Math.max(0, Math.round(base + cacheRead + cacheCreate));
  if (sum > 0) return sum;
  const totalFallback = Number(src.total_tokens ?? src.totalTokens ?? 0) || 0;
  return Math.max(0, Math.round(totalFallback));
}

/** 判断是否为后台工单唤醒军师的内部系统汇报消息（不计入用户主动对话轮数）。 */
export function isInternalStrategistReportPrompt(text) {
  return /^\[后台工单系统自动汇报\]/.test(String(text || "").trim());
}

/**
 * 提取单条消息的可见文本 + 关键工具调用摘要（dispatch_task / create_schedule / message_ticket 等），
 * 避免 Fellow 只回复“好的已安排”而把真正派单目标藏在 blocks 里导致整理记忆时丢失。
 */
export function summarizeStrategistMessageForMemory(msg) {
  if (!msg || typeof msg !== "object") return "";
  const parts = [];
  const rawText = String(msg.text || "").trim();
  if (rawText && !isInternalStrategistReportPrompt(rawText)) {
    parts.push(rawText);
  }
  if (Array.isArray(msg.blocks)) {
    for (const b of msg.blocks) {
      if (!b || b.type !== "tool_use" || !b.name) continue;
      const name = String(b.name);
      const inp = b.input && typeof b.input === "object" ? b.input : {};
      if (name === "dispatch_task" || /(?:__|:|_|\/)dispatch_task$/.test(name)) {
        const title = String(inp.title || inp.goal || "").trim().slice(0, 80);
        const cwd = inp.cwd ? ` (目录:${inp.cwd})` : "";
        if (title) parts.push(`[派发任务：${title}${cwd}]`);
      } else if (name === "create_schedule" || /(?:__|:|_|\/)create_schedule$/.test(name)) {
        const desc = String(inp.description || inp.prompt || "").trim().slice(0, 80);
        if (desc) parts.push(`[创建定时：${desc}]`);
      } else if (name === "message_ticket" || /(?:__|:|_|\/)message_ticket$/.test(name)) {
        const instr = String(inp.instruction || inp.prompt || "").trim().slice(0, 80);
        if (instr) parts.push(`[追加工单指令(${inp.ticketId || ""})：${instr}]`);
      }
    }
  }
  return parts.join(" ").trim();
}

/**
 * 为 Codex / Antigravity 构建 Fellow 主控前置上下文：
 * - 首次建会话（!nativeSession）：注入完整角色设定、长期记忆与任务盘面；
 * - 续接原生会话（nativeSession = true）：不再重复灌几千字系统提示词，只在任务盘面变化或切到微信渠道时附极简增量。
 */
export function buildNonClaudeStrategistPrefix({
  nativeSession = false,
  systemPrompt = "",
  note = "",
  wechatAddon = "",
  isWechatTurn = false,
  contextBlock = "",
  ticketBoardBlock = "",
  lastBoardFingerprint = null,
  memoryBlock = "",
  lastMemoryFingerprint = null,
} = {}) {
  const boardFingerprint = String(ticketBoardBlock || "");
  const memoryFingerprint = String(memoryBlock || "");
  if (!nativeSession) {
    const full = `${systemPrompt}${note}${wechatAddon}${contextBlock ? `\n\n${contextBlock}` : ""}\n\n---\n`;
    return { prefix: full, boardFingerprint, memoryFingerprint };
  }
  const deltaParts = [];
  if (lastMemoryFingerprint !== null && memoryFingerprint !== lastMemoryFingerprint) {
    deltaParts.push(memoryFingerprint
      ? `【长期工作记忆已更新（${STRATEGIST_MEMORY_REL}）】\n${memoryFingerprint}`
      : "【长期工作记忆已更新】当前长期记忆已清空。");
  }
  if (boardFingerprint && boardFingerprint !== (lastBoardFingerprint || "")) {
    deltaParts.push(`【后台任务盘面更新】\n${boardFingerprint}`);
  } else if (!boardFingerprint && lastBoardFingerprint) {
    deltaParts.push("【后台任务盘面更新】当前已无未归档后台任务。");
  }
  if (isWechatTurn) {
    deltaParts.push("【渠道提示】本条消息来自用户微信，请保持手机端简洁易读；有产物文件时说明绝对路径以便自动回传。");
  }
  return {
    prefix: deltaParts.length ? `${deltaParts.join("\n\n")}\n\n---\n` : "",
    boardFingerprint,
    memoryFingerprint,
  };
}

const DECISION_SIGNAL_RE = /(?:以后|默认|记住|偏好|决定|确定|改成|不要|只用|目标|方案|结论|拍板|规则|风格|账号|目录|优先|统一|切到|保留)/;

/**
 * 无外部 API 或超时降级时，从整段对话窗口里提炼结构化记忆（偏好/决策 + 近期要点 + 当时活跃任务），
 * 替代旧版机械截最后 8 条的做法，避免丢失前文敲定的关键约定。
 */
export function extractStructuredCompactionSummary(messages = [], activeTickets = []) {
  const cleanMsgs = (Array.isArray(messages) ? messages : [])
    .filter(m => m && (m.role === "user" || m.role === "assistant"))
    .map(m => ({ role: m.role, summaryText: summarizeStrategistMessageForMemory(m) }))
    .filter(m => m.summaryText);

  const decisions = [];
  const seen = new Set();
  const pushUnique = (target, text, limit) => {
    const norm = text.replace(/\s+/g, " ").trim();
    if (!norm || norm.length < 4) return;
    const key = norm.slice(0, 48);
    if (seen.has(key) || target.length >= limit) return;
    seen.add(key);
    target.push(norm.length > 150 ? `${norm.slice(0, 149)}…` : norm);
  };

  // 从整段窗口抓取显式偏好与决策（倒序优先保留最新拍板）
  for (let i = cleanMsgs.length - 1; i >= 0 && decisions.length < 8; i -= 1) {
    const m = cleanMsgs[i];
    const lines = String(m.summaryText || "").split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.replace(/^[-*•\d.\s]+/, "").trim();
      if (line.length >= 6 && DECISION_SIGNAL_RE.test(line)) {
        pushUnique(decisions, `${m.role === "user" ? "用户" : "Fellow"}：${line}`, 8);
        if (decisions.length >= 8) break;
      }
    }
  }

  // 补上最近若干条关键往返，确保上下文衔接不断档
  const recent = [];
  for (const m of cleanMsgs.slice(-6)) {
    const snippet = String(m.summaryText || "").replace(/\s+/g, " ").trim();
    if (!snippet) continue;
    pushUnique(recent, `${m.role === "user" ? "用户" : "Fellow"}：${snippet}`, 6);
  }

  const parts = [];
  if (decisions.length) {
    parts.push(`### 关键偏好与决策\n${decisions.reverse().map(d => `- ${d}`).join("\n")}`);
  }
  if (recent.length) {
    parts.push(`### 近期讨论摘要\n${recent.map(r => `- ${r}`).join("\n")}`);
  }
  const active = (Array.isArray(activeTickets) ? activeTickets : [])
    .filter(t => t && ACTIVE_TICKET_STATUSES.has(t.status))
    .slice(0, 8);
  if (active.length) {
    const rows = active.map(t => `- [${t.status}] ${t.id}「${t.title}」${t.result?.attentionReason ? ` · 卡点：${t.result.attentionReason}` : ""}`);
    parts.push(`### 进行中任务\n${rows.join("\n")}`);
  }
  const combined = parts.join("\n\n").trim();
  if (!combined) return "手动整理记忆，承接活跃任务。";
  return combined.slice(0, MAX_MEMORY_INJECT_CHARS - 128);
}

/**
 * 批处理汇报器：多个 Worker 在短窗口内密集完成/告警时合并成一条系统回报，
 * 既省军师 Token，也避免前端与微信连续刷屏。
 */
export class ReportBatcher {
  constructor({ onFlush, delayMs = 1800 } = {}) {
    if (typeof onFlush !== "function") throw new TypeError("onFlush is required");
    this.onFlush = onFlush;
    this.delayMs = delayMs;
    this._pending = new Map(); // parentConversationId -> Map<ticketId, report>
    this._timers = new Map();
    this._inflight = new Set();
  }

  enqueue(parentConversationId, report) {
    const parentId = String(parentConversationId || STRATEGIST_CONVERSATION_ID);
    if (!this._pending.has(parentId)) this._pending.set(parentId, new Map());
    this._pending.get(parentId).set(report.ticketId, report);
    if (this.delayMs <= 0) this.flush(parentId);
    else this.schedule(parentId, this.delayMs);
  }

  schedule(parentId, delay) {
    clearTimeout(this._timers.get(parentId));
    const timer = setTimeout(() => this.flush(parentId), delay);
    timer.unref?.();
    this._timers.set(parentId, timer);
  }

  flush(parentId) {
    clearTimeout(this._timers.get(parentId));
    this._timers.delete(parentId);
    const map = this._pending.get(parentId);
    if (!map?.size || this._inflight.has(parentId)) return;
    const reports = [...map.values()];
    this._inflight.add(parentId);
    Promise.resolve().then(() => this.onFlush(parentId, reports)).then(confirmed => {
      if (confirmed !== false) {
        for (const report of reports) {
          if (map.get(report.ticketId) === report) map.delete(report.ticketId);
        }
      }
    }, error => console.warn("[Orchestrator] Report delivery failed:", error)).finally(() => {
      this._inflight.delete(parentId);
      if (this._pending.get(parentId) !== map) return;
      if (map.size) this.schedule(parentId, Math.max(this.delayMs, 1000));
      else this._pending.delete(parentId);
    });
  }

  clear() {
    for (const timer of this._timers.values()) clearTimeout(timer);
    this._timers.clear();
    this._pending.clear();
  }
}

export function formatBatchedReportPrompt(reports) {
  if (!Array.isArray(reports) || reports.length === 0) return "";
  const statusLabel = {
    completed: "已完成",
    failed: "执行失败",
    needs_attention: "需要拍板/关注",
    stopped: "已停止",
    partial: "结果待确认",
  };
  const blocks = reports.map((r) => {
    const lines = [
      `- 工单「${r.title}」（${r.ticketId}）：${statusLabel[r.status] || r.status}`,
    ];
    if (r.summary) lines.push(`  摘要：${r.summary}`);
    if (r.changedFiles?.length) lines.push(`  改动文件：${r.changedFiles.join("、")}`);
    if (r.attentionReason) lines.push(`  卡点说明：${r.attentionReason}`);
    if (r.error) lines.push(`  错误信息：${r.error}`);
    return lines.join("\n");
  });
  return `[后台任务汇报]\n以下是刚产生状态更新的后台工单，请用简洁人话向用户汇总结果、产物路径以及是否需要拍板（不需要重复派单，除非明确需要补救）：\n${blocks.join("\n")}`;
}

/**
 * 创建 Orchestrator 控制面实例，由 server.js 注入具体运行能力（启动 Worker、
 * 停止 Worker、向 Worker 发消息、查历史、推送事件与唤醒军师）。
 */
export function createOrchestrator({
  ticketStore,
  defaultCwd,
  allowOutsideVault = false,
  launchWorker,
  messageWorker,
  stopWorker,
  readWorkerMessages,
  validateExecution = () => {},
  listProviders,
  notifyClient,
  wakeStrategist,
  batchDelayMs = 1800,
  watchdogIntervalMs = 30_000,
  stallTimeoutMs = 5 * 60_000,
  maxConsecutiveErrors = 4,
  now = () => Date.now(),
}) {
  const vault = canonicalPath(defaultCwd);
  const lock = new WriteScopeLock({ cwd: vault });
  const attempts = new Map();
  const resetting = new Set();

  function validateCwd(rawCwd) {
    const cwd = canonicalPath(rawCwd || vault, vault);
    if (isSystemProtectedPath(cwd)) throw new Error("禁止在系统受保护目录执行工单");
    if ((!allowOutsideVault && !pathWithin(cwd, vault)) || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(allowOutsideVault ? "工作目录不存在或不是有效文件夹" : "工作目录不在当前 Vault 内或已失效");
    }
    return cwd;
  }

  function getScopes(writeScope, cwd) {
    return writeScope.map(scope => {
      const path = normalizeScopePath(scope, cwd, allowOutsideVault ? (cwd || vault) : vault);
      if (isSystemProtectedPath(path)) throw new Error("工单写入范围不能指向系统受保护目录");
      if (!allowOutsideVault && !pathWithin(path, vault)) throw new Error("工单写入范围必须位于当前 Vault 内");
      return path;
    });
  }

  function executionScope(ticket) {
    if (!ticket.execution?.cwd || (ticket.vaultId && ticket.vaultId !== vault)) {
      throw new Error("工单所属 Vault 或工作目录已失效");
    }
    const cwd = validateCwd(ticket.execution.cwd);
    if (cwd !== ticket.execution.cwd && ticket.mandate.canonicalScopes) throw new Error("工单工作目录已变化");
    const scopes = getScopes(ticket.mandate.writeScope, cwd);
    if (ticket.mandate.canonicalScopes && JSON.stringify(scopes) !== JSON.stringify(ticket.mandate.canonicalScopes)) {
      throw new Error("工单写入范围已变化，请重新派单");
    }
    return { cwd, scopes };
  }

  function lockScopes(scopes) {
    return scopes.length ? scopes : [allowOutsideVault ? "*" : vault];
  }

  const batcher = new ReportBatcher({
    delayMs: batchDelayMs,
    onFlush: async (parentConversationId, reports) => {
      reports = reports.filter(report => ticketStore.get(report.ticketId)?.pendingReport?.revision === report.revision);
      if (!reports.length) return true;
      if (typeof wakeStrategist !== "function") return false;
      const confirmed = await wakeStrategist(parentConversationId, reports, formatBatchedReportPrompt(reports));
      if (confirmed === false) return false;
      for (const report of reports) {
        const current = ticketStore.get(report.ticketId);
        if (current?.pendingReport?.revision !== report.revision) continue;
        ticketStore.update(report.ticketId, draft => {
          draft.reportedAt = new Date(now()).toISOString();
          delete draft.pendingReport;
        });
      }
      return true;
    },
  });

  const watchdog = new WorkerWatchdog({
    ticketStore,
    intervalMs: watchdogIntervalMs,
    stallTimeoutMs,
    maxConsecutiveErrors,
    activityAt: ticket => attempts.get(ticket.id)?.activityAt ?? ticket.execution.lastActivityAt,
    now,
    onFlag: (ticket, reason) => {
      onWorkerNeedsAttention(ticket.workerConversationId, { reason, attempt: ticket.execution.attempt });
    },
  });

  function pushTicketUpdate(ticket, eventType = "ticket_updated") {
    if (typeof notifyClient !== "function" || !ticket) return;
    notifyClient({
      type: eventType,
      conversationId: ticket.parentConversationId,
      ticket: ticketStore.toSummary(ticket),
    });
  }

  function pushTicketsSnapshot(parentConversationId = null, { replace = false, removedIds } = {}) {
    if (typeof notifyClient !== "function") return;
    const complete = replace && !parentConversationId;
    const all = ticketStore.list({ parentConversationId, limit: complete && !removedIds ? Infinity : 200 })
      .map((t) => ticketStore.toSummary(t));
    notifyClient({
      type: "tickets_snapshot",
      ...(parentConversationId ? { conversationId: parentConversationId } : {}),
      ...(complete ? { replace: true } : {}),
      ...(removedIds ? { removedIds } : {}),
      tickets: all,
    });
  }

  function archiveCompletedTickets() {
    const { archivedIds, failedIds } = ticketStore.archiveFinished(id => !attempts.has(id) && !resetting.has(id));
    const tickets = ticketStore.list({ limit: 200 }).map((t) => ticketStore.toSummary(t));
    if (archivedIds.length) pushTicketsSnapshot(null, { replace: true });
    return { ok: true, archivedCount: archivedIds.length, archivedIds, failedIds, tickets };
  }

  function setTicketArchived(ticketId, archived) {
    const ticket = ticketStore.get(ticketId);
    if (!ticket) return { ok: false, error: "未找到工单" };
    if (archived) {
      if (ACTIVE_TICKET_STATUSES.has(ticket.status) || attempts.has(ticket.id) || resetting.has(ticket.id)) {
        return { ok: false, error: "仅已结束的任务可以归档。" };
      }
    }
    try {
      const updated = ticketStore.update(ticket.id, draft => {
        draft.archivedAt = archived ? new Date(now()).toISOString() : null;
      });
      pushTicketUpdate(updated);
      return { ok: true, ticket: ticketStore.toSummary(updated) };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }

  function clearArchivedTickets() {
    const { removedIds, failedIds } = ticketStore.removeArchived(id => !attempts.has(id) && !resetting.has(id));
    const tickets = ticketStore.list({ limit: 200 }).map((t) => ticketStore.toSummary(t));
    if (removedIds.length) pushTicketsSnapshot(null, { replace: true, removedIds });
    return { ok: true, removedCount: removedIds.length, removedIds, failedIds, tickets };
  }

  function clearCompletedTickets() {
    const { removedIds, failedIds } = ticketStore.removeFinished(id => !attempts.has(id) && !resetting.has(id));
    const tickets = ticketStore.list({ limit: 200 }).map((t) => ticketStore.toSummary(t));
    if (removedIds.length) pushTicketsSnapshot(null, { replace: true, removedIds });
    return { ok: true, removedCount: removedIds.length, removedIds, failedIds, tickets };
  }

  function releaseTicket(id) {
    for (const nextId of lock.release(id)) {
      const next = ticketStore.get(nextId);
      if (next?.status === "queued" && !resetting.has(nextId)) {
        queueMicrotask(() => {
          const queued = ticketStore.get(nextId);
          if (queued?.status === "queued") void startTicketExecution(queued, queued.execution.runInstruction === true);
        });
      }
      else releaseTicket(nextId);
    }
  }

  function showFailure(ticket, error) {
    notifyClient?.({ type: "ticket_action_error", ticketId: ticket.id, error: String(error?.message || error) });
  }

  async function startTicketExecution(ticket, useInstruction = false) {
    const current = ticketStore.get(ticket.id);
    if (!lock.heldBy(ticket.id) || !current || resetting.has(ticket.id) || attempts.has(ticket.id)) return current;
    ticket = current;
    let running;
    let entry;
    try {
      const { cwd, scopes } = executionScope(ticket);
      if (!lock.matches(ticket.id, lockScopes(scopes))) throw new Error("工单写入范围已变化，请重新派单");
      const specialistDoc = loadSpecialists(vault).find(s => s.id === ticket.specialistId);
      entry = useInstruction ? ticket.execution.pendingInstructions?.[0] : null;
      const config = entry?.config || ticket.execution.nextConfig;
      validateExecution({ ...ticket.execution, ...config }, ticket.mandate);
      running = ticketStore.update(ticket.id, draft => {
        draft.status = "running";
        draft.execution.cwd = cwd;
        draft.execution.attempt = (draft.execution.attempt || 0) + 1;
        draft.execution.startedAt = new Date(now()).toISOString();
        draft.execution.finishedAt = null;
        draft.execution.lastActivityAt = now();
        draft.execution.consecutiveErrors = 0;
        draft.execution.blockedBy = [];
        draft.execution.runInstruction = false;
        if (entry) draft.execution.pendingInstructions.shift();
        Object.assign(draft.execution, config);
        if (config && JSON.stringify(config) === JSON.stringify(draft.execution.nextConfig)) delete draft.execution.nextConfig;
        draft.result.error = null;
        draft.result.attentionReason = null;
        draft.result.pendingQuestion = null;
        draft.archivedAt = null;
      });
      let resolve;
      const done = new Promise(complete => { resolve = complete; });
      attempts.set(ticket.id, {
        number: running.execution.attempt, done, resolve, tools: new Map(), activityAt: now(), scopes, entry,
      });
      watchdog.clearFlag(ticket.id);
      pushTicketUpdate(running);
      const context = { workerSystemPrompt: buildWorkerSystemPrompt(running, specialistDoc), specialistDoc };
      const response = entry
        ? await messageWorker(running, entry.prompt, { ...entry, ...context })
        : await launchWorker(running, context);
      if (response?.state === "rejected" || response?.state === "queued") {
        throw new Error(response.error || "执行器未接受工单");
      }
    } catch (error) {
      if (running && attempts.get(ticket.id)?.number === running.execution.attempt) {
        onWorkerSettled(running.workerConversationId, {
          attempt: running.execution.attempt, status: "failed", error: String(error?.message || error), restoreInstruction: true,
        });
      } else if (!running) {
        const message = String(error?.message || error);
        try {
          pushTicketUpdate(ticketStore.update(ticket.id, draft => {
            draft.status = "failed";
            draft.execution.blockedBy = [];
            draft.result.error = message;
          }));
        } catch (persistError) {
          showFailure(ticket, persistError);
          return { ...ticket, status: "failed", result: { ...ticket.result, error: message } };
        } finally {
          releaseTicket(ticket.id);
        }
        showFailure(ticket, error);
      }
    }
    return ticketStore.get(ticket.id);
  }

  async function queueOrStart(ticket, useInstruction = false) {
    const { cwd, scopes } = executionScope(ticket);
    const requestedScopes = lockScopes(scopes);
    const result = lock.tryAcquire(ticket.id, requestedScopes, cwd, { enqueue: false, canonical: true });
    if (result.acquired) return startTicketExecution(ticket, useInstruction);
    const queued = ticketStore.update(ticket.id, draft => {
      draft.status = "queued";
      draft.archivedAt = null;
      draft.execution.runInstruction = useInstruction;
      draft.execution.blockedBy = result.blockedBy;
      draft.result.error = null;
    });
    lock.tryAcquire(ticket.id, requestedScopes, cwd, { canonical: true });
    pushTicketUpdate(queued);
    return queued;
  }

  function dispatchReceipt(ticket) {
    return {
      ok: ticket.status !== "failed",
      ticketId: ticket.id,
      workerConversationId: ticket.workerConversationId,
      blockedBy: ticket.execution.blockedBy,
      status: ticket.status,
      error: ticket.result.error,
      message: ticket.status === "queued" ? "已排队，写入范围空闲后自动启动。" : ticket.result.error || "工单已接收。",
    };
  }

  async function dispatchTask(params = {}) {
    const cwd = validateCwd(params.cwd);
    const specialist = loadSpecialists(vault).find(s => s.id === params.specialistId);
    const writeScope = params.writeScope?.length ? params.writeScope : getScopes(specialist?.writeScope || [], vault);
    const canonicalScopes = getScopes(writeScope, cwd);
    const execution = {
      provider: params.provider || specialist?.provider || null,
      profileId: params.profileId || null,
      profileName: params.profileName || null,
      model: params.model || specialist?.model || null,
      effort: params.effort || null,
    };
    validateExecution(execution, params);
    const ticket = ticketStore.create({
      ...params, ...execution, id: undefined, cwd, writeScope, canonicalScopes, permissionMode: "auto",
    });
    return dispatchReceipt(await queueOrStart(ticket));
  }

  function listTickets({ status = null, parentConversationId = null, archived = "all", limit = 30 } = {}) {
    const items = ticketStore.list({ status, parentConversationId, archived, limit });
    return {
      tickets: items.map((t) => ticketStore.toSummary(t)),
      specialists: loadSpecialists(defaultCwd).map(({ id, name, description, provider, model }) => ({
        id, name, description, provider, model,
      })),
    };
  }

  function inspectTicket(ticketId) {
    const ticket = ticketStore.get(ticketId);
    if (!ticket) return { ok: false, error: `未找到工单：${ticketId}` };
    return {
      ok: true,
      ticket: {
        ...ticketStore.toSummary(ticket),
        goal: ticket.mandate?.goal || "",
        acceptanceCriteria: ticket.mandate?.acceptanceCriteria || [],
        recentSteps: (ticket.execution?.recentSteps || []).slice(-6),
      },
    };
  }

  /** Chain of Recall：按需拉取 Worker 对话片段，避免一次性灌爆军师上下文。 */
  function recallTicketDetail(ticketId, { offset = 0, limit = 6 } = {}) {
    const ticket = ticketStore.get(ticketId);
    if (!ticket) return { ok: false, error: `未找到工单：${ticketId}` };
    const messages = typeof readWorkerMessages === "function"
      ? (readWorkerMessages(ticket.workerConversationId) || [])
      : [];
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.max(1, Math.min(12, Number(limit) || 6));
    const slice = messages.slice(safeOffset, safeOffset + safeLimit).map((m) => ({
      role: m.role,
      text: String(m.text || "").slice(0, 1200),
      status: m.status || null,
      createdAt: m.createdAt || null,
    }));
    return {
      ok: true,
      ticketId: ticket.id,
      workerConversationId: ticket.workerConversationId,
      totalMessages: messages.length,
      offset: safeOffset,
      messages: slice,
      changedFiles: ticket.result?.changedFiles || [],
      recentSteps: (ticket.execution?.recentSteps || []).slice(-12),
    };
  }

  async function messageTicket(ticketId, prompt, { fromUser = false, requestId = null, config = null, images = null, displayText = null, composerText = null, steering = false } = {}) {
    const ticket = ticketStore.get(ticketId);
    if (!ticket) return { ok: false, error: "未找到工单" };
    if (ticket.status === "stopping" || resetting.has(ticket.id)) return { ok: false, error: "正在等待执行器停止，请稍后继续。" };
    const cleanPrompt = typeof prompt === "string" ? prompt.trim() : "";
    if (!cleanPrompt || cleanPrompt.length > 32_000) return { ok: false, error: "补充指令须为 1 到 32000 字符" };
    executionScope(ticket);
    validateExecution({ ...ticket.execution, ...ticket.execution.nextConfig, ...config }, ticket.mandate);
    const pending = ticket.execution.pendingInstructions || [];
    if (requestId && (pending.some(entry => entry.requestId === requestId)
      || attempts.get(ticket.id)?.entry?.requestId === requestId)) return { ...dispatchReceipt(ticket), delivery: "queued" };
    if (pending.length >= 20) return { ok: false, error: "补充指令已满，请等待已有指令执行。" };
    const updated = ticketStore.update(ticket.id, draft => {
      draft.archivedAt = null;
      const entries = draft.execution.pendingInstructions || [];
      const entry = { prompt: cleanPrompt, fromUser, requestId, config, images, displayText, composerText, steering };
      draft.execution.pendingInstructions = ACTIVE_TICKET_STATUSES.has(ticket.status)
        ? [...entries, entry] : [entry, ...entries];
    });
    if (ACTIVE_TICKET_STATUSES.has(ticket.status)) {
      pushTicketUpdate(updated);
      return { ...dispatchReceipt(updated), delivery: "queued" };
    }
    return dispatchReceipt(await queueOrStart(updated, true));
  }

  function updatePendingInstructions(ticketId, update) {
    const ticket = ticketStore.get(ticketId);
    if (!ticket || ticket.status === "stopping" || resetting.has(ticketId)) return null;
    const entries = update(ticket.execution.pendingInstructions || []);
    if (!entries) return null;
    return ticketStore.update(ticketId, draft => { draft.execution.pendingInstructions = entries; });
  }

  function discardPendingInstructions(ticket) {
    for (const entry of ticket.execution.pendingInstructions || []) {
      if (!entry.requestId) continue;
      notifyClient?.({
        type: entry.steering ? "steering_removed" : "stopped",
        userMessageId: entry.requestId, conversationId: ticket.workerConversationId, reason: "stopped",
      });
    }
  }

  async function stopTicket(ticketId) {
    const ticket = ticketStore.get(ticketId);
    if (!ticket) return { ok: false, error: "未找到工单" };
    const active = attempts.get(ticket.id);
    if (ticket.status === "stopping" && active) return active.done;
    if (!ACTIVE_TICKET_STATUSES.has(ticket.status)) return { ...dispatchReceipt(ticket), ok: true };
    const updated = ticketStore.update(ticket.id, draft => {
      draft.status = active ? "stopping" : "stopped";
      draft.execution.pendingInstructions = [];
      draft.execution.blockedBy = [];
      draft.result.pendingQuestion = null;
      draft.result.attentionReason = null;
      if (!active) draft.execution.finishedAt = new Date(now()).toISOString();
    });
    pushTicketUpdate(updated);
    discardPendingInstructions(ticket);
    if (!active) {
      releaseTicket(ticket.id);
      return dispatchReceipt(updated);
    }
    try {
      const response = await stopWorker(updated);
      if (!response?.pending) onWorkerSettled(ticket.workerConversationId, { status: "stopped", attempt: active.number });
    } catch (error) {
      showFailure(ticket, error);
      return { ok: false, status: "stopping", error: String(error?.message || error) };
    }
    return active.done;
  }

  async function retryTicket(ticketId) {
    const ticket = ticketStore.get(ticketId);
    if (!ticket) return { ok: false, error: "未找到工单" };
    if (ACTIVE_TICKET_STATUSES.has(ticket.status) || attempts.has(ticket.id) || resetting.has(ticket.id)) {
      return { ok: false, error: "工单正在执行、排队或停止中。" };
    }
    if (ticket.status === "partial") return { ok: false, error: "请先检查已有结果，再补充指令继续。" };
    return dispatchReceipt(await queueOrStart(ticket, Boolean(ticket.execution.pendingInstructions?.length)));
  }

  async function resetTicket(ticketId, reset) {
    const ticket = ticketStore.get(ticketId);
    if (!ticket || resetting.has(ticketId)) return { ok: false, error: "工单不存在或正在重置" };
    resetting.add(ticketId);
    try {
      const stopped = await stopTicket(ticketId);
      if (!stopped.ok) return stopped;
      const current = ticketStore.get(ticketId);
      if (current?.execution.pendingInstructions?.length) {
        ticketStore.update(ticketId, draft => { draft.execution.pendingInstructions = []; });
        discardPendingInstructions(current);
      }
      await reset(ticket);
      return { ok: true };
    } finally {
      resetting.delete(ticketId);
    }
  }

  function configureTicket(ticketId, config) {
    const ticket = ticketStore.get(ticketId);
    if (!ticket) return { ok: false, error: "未找到工单" };
    validateExecution(config, ticket.mandate);
    const updated = ticketStore.update(ticketId, draft => {
      if (attempts.has(ticketId)) draft.execution.nextConfig = config;
      else {
        Object.assign(draft.execution, config);
        delete draft.execution.nextConfig;
      }
    });
    pushTicketUpdate(updated);
    return { ok: true, ticket: ticketStore.toSummary(updated) };
  }

  function currentAttempt(workerId, attempt) {
    const ticket = ticketStore.findByWorkerConversationId(workerId);
    const active = ticket && attempts.get(ticket.id);
    if (!active || attempt !== active.number) return [];
    return [ticket, active];
  }

  function recordWorkerStep(workerId, toolName, input = {}, { attempt, id, phase = "start", isError = false } = {}) {
    const [ticket, active] = currentAttempt(workerId, attempt);
    if (!active || !id || ticket.status === "stopping") return;
    if (phase === "start") {
      if (active.tools.has(id)) return;
      active.tools.set(id, { toolName, input });
    } else {
      const tool = active.tools.get(id);
      if (!tool && !toolName) return;
      active.tools.delete(id);
      toolName = tool?.toolName || toolName;
      input = { ...tool?.input, ...input };
    }
    active.activityAt = now();
    const paths = ["Write", "Edit", "NotebookEdit"].includes(toolName)
      ? [input?.file_path || input?.notebook_path || input?.path]
      : toolName === "apply_patch" && Array.isArray(input?.changes)
        ? input.changes.filter(change => change?.kind !== "delete").map(change => change?.path) : [];
    const artifacts = phase === "result" && !isError ? paths.flatMap(path => {
      try {
        const target = canonicalPath(path, ticket.execution.cwd);
        const inVault = pathWithin(target, vault);
        if (isSystemProtectedPath(target) || (!inVault && !allowOutsideVault)) return [];
        if (active.scopes.length && !active.scopes.some(scope => pathWithin(target, scope))) return [];
        return [inVault ? relative(vault, target).replace(/\\/g, "/") : target];
      } catch { return []; }
    }) : [];
    try {
      const updated = ticketStore.update(ticket.id, draft => {
        draft.execution.lastActivityAt = active.activityAt;
        if (phase === "start") draft.execution.stepsCount += 1;
        else draft.execution.consecutiveErrors = isError ? draft.execution.consecutiveErrors + 1 : 0;
        const label = `${toolName}${paths[0] ? ` ${basename(paths[0])}` : ""}${isError ? "（失败）" : ""}`;
        draft.execution.lastStepLabel = label;
        draft.execution.recentSteps = [...draft.execution.recentSteps, { at: now(), name: toolName, label, isError }].slice(-20);
        draft.result.changedFiles = [...new Set([...draft.result.changedFiles, ...artifacts])];
        draft.result.artifactPaths = [...new Set([...draft.result.artifactPaths, ...artifacts])];
      });
      pushTicketUpdate(updated);
      if (phase === "result" && isError) watchdog.checkOnce();
    } catch (error) {
      showFailure(ticket, error);
    }
  }

  function onWorkerActivity(workerId, attempt) {
    const [, active] = currentAttempt(workerId, attempt);
    if (active) active.activityAt = now();
  }

  function onWorkerNeedsAttention(workerId, { reason = "", question = null, attempt } = {}) {
    const [ticket] = currentAttempt(workerId, attempt);
    if (!ticket || ticket.status === "stopping") return null;
    try {
      const updated = ticketStore.update(ticket.id, draft => {
        draft.status = "needs_attention";
        draft.execution.lastActivityAt = now();
        draft.result.attentionReason = reason || "执行专员需要你确认下一步。";
        if (question) draft.result.pendingQuestion = question;
        draft.pendingReport = {
          ticketId: draft.id, revision: (draft.revision || 0) + 1,
          title: draft.title, status: draft.status,
          attentionReason: draft.result.attentionReason, changedFiles: draft.result.changedFiles,
        };
      });
      pushTicketUpdate(updated);
      batcher.enqueue(updated.parentConversationId, updated.pendingReport);
      return updated;
    } catch (error) {
      showFailure(ticket, error);
      return null;
    }
  }

  function onWorkerSettled(workerId, { attempt, status = "completed", output = "", error = null, restoreInstruction = false } = {}) {
    const [ticket, active] = currentAttempt(workerId, attempt);
    if (!active) return null;
    const finalStatus = ticket.status === "stopping" ? "stopped" : status;
    let updated;
    try {
      updated = ticketStore.update(ticket.id, draft => {
        draft.status = finalStatus;
        draft.execution.finishedAt = new Date(now()).toISOString();
        draft.execution.lastActivityAt = now();
        if (restoreInstruction && active.entry && finalStatus !== "stopped") {
          draft.execution.pendingInstructions.unshift(active.entry);
        }
        draft.result.summary = summarizeWorkerOutput(output);
        draft.result.error = error ? String(error) : null;
        draft.result.attentionReason = null;
        draft.result.pendingQuestion = null;
        draft.pendingReport = {
          ticketId: draft.id, revision: (draft.revision || 0) + 1,
          title: draft.title, status: finalStatus, summary: draft.result.summary,
          changedFiles: draft.result.changedFiles, error: draft.result.error,
        };
      });
      pushTicketUpdate(updated);
      batcher.enqueue(updated.parentConversationId, updated.pendingReport);
    } catch (persistError) {
      showFailure(ticket, persistError);
    } finally {
      watchdog.clearFlag(ticket.id);
      attempts.delete(ticket.id);
      active.resolve(updated ? dispatchReceipt(updated) : { ok: false, error: "工单终态保存失败" });
      if (updated?.status === "completed" && updated.execution.pendingInstructions?.length && !resetting.has(ticket.id)) {
        try {
          ticketStore.update(ticket.id, draft => {
            draft.status = "queued";
            draft.execution.runInstruction = true;
          });
          queueMicrotask(() => {
            const queued = ticketStore.get(ticket.id);
            if (queued?.status === "queued") void startTicketExecution(queued, true);
          });
        } catch (persistError) {
          showFailure(ticket, persistError);
          releaseTicket(ticket.id);
        }
      } else releaseTicket(ticket.id);
    }
    return updated;
  }

  /** 仅返回精简的活跃任务盘面文本，用于非 Claude 续接轮次做轻量增量变化对比。 */
  function buildStrategistTicketBoardBlock(parentConversationId = STRATEGIST_CONVERSATION_ID) {
    const tickets = ticketStore.list({ parentConversationId, archived: "active", limit: 12 });
    if (tickets.length === 0) return "";
    const rows = tickets.map((t) => {
      const files = t.result?.changedFiles?.length ? ` · 改动:${t.result.changedFiles.length}个文件` : "";
      const note = t.status === "needs_attention"
        ? ` · 卡点:${t.result?.attentionReason || "待确认"}`
        : (t.result?.summary ? ` · 摘要:${t.result.summary.slice(0, 80)}` : "");
      return `- [${t.status}] ${t.id}「${t.title}」(${t.execution?.provider || "默认"})${files}${note}`;
    });
    return `【当前后台工单盘面（共 ${tickets.length} 条，细节用 inspect_ticket / recall_ticket_detail 按需查看）】\n${rows.join("\n")}`;
  }

  /** 为军师构建极轻量的 Inline 盘面上下文（活跃工单 + 长期记忆摘录）。 */
  function buildStrategistContextBlock(parentConversationId = STRATEGIST_CONVERSATION_ID, cwd = defaultCwd) {
    const parts = [];
    const memory = readStrategistMemory(cwd);
    if (memory) {
      parts.push(`【军师长期工作记忆（${STRATEGIST_MEMORY_REL}）】\n${memory}`);
    }
    const board = buildStrategistTicketBoardBlock(parentConversationId);
    if (board) parts.push(board);
    const specialists = loadSpecialists(cwd);
    if (specialists.length > 0) {
      const sRows = specialists.map((s) => `- ${s.id}（${s.name}）：${s.description || "专岗助手"}`);
      parts.push(`【可用常驻专岗（派单时可填 specialistId）】\n${sRows.join("\n")}`);
    }
    return parts.join("\n\n");
  }

  function start() {
    ticketStore.reconcileOnBoot();
    for (const ticket of ticketStore.list({ limit: Infinity })) {
      if (ticket.pendingReport) batcher.enqueue(ticket.parentConversationId, ticket.pendingReport);
    }
    watchdog.start();
  }

  function stop() {
    watchdog.stop();
    batcher.clear();
  }

  return {
    lock,
    watchdog,
    batcher,
    start,
    stop,
    dispatchTask,
    listTickets,
    inspectTicket,
    recallTicketDetail,
    messageTicket,
    stopTicket,
    retryTicket,
    resetTicket,
    configureTicket,
    updatePendingInstructions,
    attemptScopes: (id, number) => attempts.get(id)?.number === number ? attempts.get(id)?.scopes : null,
    recordWorkerStep,
    onWorkerActivity,
    onWorkerNeedsAttention,
    onWorkerSettled,
    pushTicketsSnapshot,
    archiveCompletedTickets,
    setTicketArchived,
    clearArchivedTickets,
    clearCompletedTickets,
    ownsAttempt: (ticketId, attempt) => attempts.get(ticketId)?.number === attempt && attempts.has(ticketId),
    buildStrategistTicketBoardBlock,
    buildStrategistContextBlock,
    listProviders: () => (typeof listProviders === "function" ? listProviders() : []),
  };
}

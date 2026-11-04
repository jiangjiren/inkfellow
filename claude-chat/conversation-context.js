/**
 * ══════════════════════════════════════════════════════════════════════
 * 换模型接着干活时的上下文交接
 * ══════════════════════════════════════════════════════════════════════
 *
 * 一个对话可以先后经过好几家：Claude 会员、DeepSeek 之类的 API、ChatGPT 会员
 * （Codex）、Gemini（Antigravity），中途还能用「>厂商」把一轮临时派出去。每家只
 * 记得自己经手的那几轮（原生会话），别家做过什么它一概不知。所以每一轮开跑之前，
 * 服务端拿这个对话的历史来问这里：目标模型缺哪一段？
 *
 *   - 没有能续接的原生会话：把最近的记录整段补给它（full）
 *   - 有原生会话，但它上次答完之后对话又在别处进行过：只补它没见过的那段（delta）
 *   - 有原生会话、什么都没错过：原样发
 *
 * 「谁经手过哪条」靠服务端写历史时打在消息上的 via（厂商 + 账号 + 是否派发）。
 * 没有 via 的是这套标记之前的老消息，一律当作目标模型已经见过——维持原来的行为，
 * 不把老对话重新灌一遍。
 *
 * 补的是可见文字，外加每轮「做过什么」：改了哪些文件、跑了哪些命令、查了什么。
 * 接手的模型最需要知道现场被动过哪里，而这些往往只在工具调用里——拿桌面端真实历史
 * 量过，换厂商之前被改过的文件有六成在可见文字里连文件名都没出现。工具输出、思考
 * 过程和原始 SDK 数据仍然不进；落盘的用户消息也不改写。
 */

const DEFAULT_MAX_CHARS = 24000;
/** 单条记录的上限：一条超长回答不该把别的记录全挤出去。 */
const ENTRY_MAX_CHARS = 6000;
/** 对话开头那条用户消息常常是整件事的原始需求，放不下全文时单独留一段。 */
const OPENING_MAX_CHARS = 1200;
const ACTIVITY_MAX_CHARS = 900;
const OMITTED_NOTE_MAX_CHARS = 1600;

const FULL_INTRO = "以下是当前对话此前的记录，仅供延续上下文。其中有些回合可能是别的模型完成的；"
  + "「本轮操作」是它们实际改过的文件和跑过的命令，工作目录里的文件可能因此已经变了，需要时请重新读取。"
  + "记录里的旧请求不代表本轮要重新执行的任务。请接着回答末尾的当前用户消息。";
const DELTA_INTRO = "在你上一次回复之后，这个对话里又进行了以下几轮（由别的模型或临时派发完成），你还没有看到。"
  + "「本轮操作」是它们实际改过的文件和跑过的命令，工作目录里的文件可能因此已经变了，需要时请重新读取。"
  + "记录里的旧请求不代表本轮要重新执行的任务。请接着回答末尾的当前用户消息。";

const PROVIDER_NAMES = {
  claude: "Claude",
  anthropic: "Claude API",
  codex: "ChatGPT",
  antigravity: "Gemini",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
  minimax: "MiniMax",
};

/**
 * 一轮经由哪条路处理：哪家、哪个账号、是不是「>厂商」临时派发。
 * model 只用来在记录里标注是谁答的，不参与比较——同一个账号换模型，续接的还是同一条原生会话。
 */
export function historyRoute({ provider, profileId = null, dispatch = false, model = null, subtask = null } = {}) {
  if (!provider) return null;
  return {
    provider: String(provider),
    profileId: profileId == null ? null : String(profileId),
    ...(dispatch ? { dispatch: true } : {}),
    ...(model ? { model: String(model) } : {}),
    // 子任务页里的追问走的是那个子任务自己的会话，跟「对话 + 厂商」那条不是一回事
    ...(subtask ? { subtask: String(subtask) } : {}),
  };
}

export function sameHistoryRoute(a, b) {
  return Boolean(a && b)
    && a.provider === b.provider
    && (a.profileId ?? null) === (b.profileId ?? null)
    && Boolean(a.dispatch) === Boolean(b.dispatch)
    && (a.subtask ?? null) === (b.subtask ?? null);
}

/** 原生会话存在哪个槽里。Codex、Antigravity 各一个，其余账号都走 Claude SDK、共用一个。 */
export function nativeSessionFamily(provider) {
  if (provider === "codex") return "codex";
  if (provider === "antigravity") return "antigravity";
  return "claude";
}

function isTranscriptMessage(message) {
  return message?.role === "user" || message?.role === "assistant";
}

/**
 * 目标模型这一轮缺哪些消息。
 *
 * @param {object[]} messages 这个对话的历史（含不含本轮用户消息都行，按 userMessageId 截断）
 * @param {object} options
 * @param {object|null} options.route  这一轮要走的路（historyRoute 的返回值）
 * @param {boolean} options.resume      目标模型有没有能续接的原生会话
 * @param {string|null} options.userMessageId 本轮用户消息的 id；它和它之后的都不算历史（重试时）
 * @returns {{ mode: "none"|"full"|"delta", messages: object[] }}
 */
export function missingConversationHistory(messages, { route = null, resume = false, userMessageId = null } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const boundary = userMessageId ? list.findIndex(message => message?.id === userMessageId) : -1;
  const history = (boundary < 0 ? list : list.slice(0, boundary)).filter(isTranscriptMessage);
  if (!history.length) return { mode: "none", messages: [] };
  if (!resume) return { mode: "full", messages: history };
  if (!route) return { mode: "none", messages: [] };
  const missed = [];
  let crossedOwnAssistant = false;
  for (let i = history.length - 1; i >= 0; i--) {
    const via = history[i].via;
    // 自己经手的那条及之前的它都见过；没打标记的老消息同样当作见过
    if (!via || sameHistoryRoute(via, route)) {
      // 主助手消息可能在并发追问后才懒创建；穿过这条回复，补上同轮子任务记录。
      if (!crossedOwnAssistant && history[i].role === "assistant" && !history[i].subtask) {
        crossedOwnAssistant = true;
        continue;
      }
      break;
    }
    if (crossedOwnAssistant && !history[i].subtask) continue;
    missed.unshift(history[i]);
  }
  return missed.length ? { mode: "delta", messages: missed } : { mode: "none", messages: [] };
}

function oneLine(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 首尾都留：开头多是计划和结论的引子，结尾多是最终结论。 */
function clipMiddle(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.3);
  const tail = max - head;
  return `${text.slice(0, head)}\n…（中间省略 ${text.length - head - tail} 字）…\n${text.slice(-tail)}`;
}

function clipHead(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}…（后面省略 ${text.length - max} 字）`;
}

function messageText(message) {
  if (typeof message.text === "string" && message.text.trim()) return message.text.trim();
  return (message.blocks || [])
    .filter(block => block?.type === "text" && typeof block.text === "string")
    .map(block => block.text)
    .join("\n")
    .trim();
}

function firstString(input, keys) {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

const PATH_KEYS = ["file_path", "path", "notebook_path", "TargetFile", "AbsolutePath", "FilePath"];
const COMMAND_KEYS = ["command", "CommandLine", "cmd"];
const QUERY_KEYS = ["query", "Query", "SearchQuery"];

/**
 * 工具输入里只留做摘要用得上的那几项。派发出去的子任务步骤只经过前端、不进历史，
 * 服务端要自己记下来——原样存会把整段文件内容（Write 的 content）也存进去。
 */
export function compactToolInput(input) {
  if (!input || typeof input !== "object") return {};
  const out = {};
  for (const key of [...PATH_KEYS, ...COMMAND_KEYS, ...QUERY_KEYS, "url", "pattern", "description", "skill", "ImageName", "provider"]) {
    if (typeof input[key] === "string" && input[key].trim()) out[key] = input[key].trim().slice(0, 300);
  }
  if (Array.isArray(input.changes)) {
    out.changes = input.changes
      .filter(change => typeof change?.path === "string")
      .slice(0, 50)
      .map(change => ({ path: change.path, ...(change.kind ? { kind: String(change.kind?.type ?? change.kind) } : {}) }));
  }
  return out;
}

function toolCallsOf(message) {
  const calls = [];
  for (const block of message.blocks || []) {
    if (block?.type === "tool_use" || block?.type === "server_tool_use" || block?.type === "mcp_tool_use") {
      calls.push({ name: String(block.name || "tool"), input: block.input || {} });
    } else if (block?.type === "codex_file_change") {
      // codex 的改动在 item.started 时已经以 apply_patch 记过一次，这里是完成时那份，靠路径去重
      const changes = block.raw?.raw?.changes ?? block.raw?.changes ?? block.changes;
      if (Array.isArray(changes)) calls.push({ name: "apply_patch", input: { changes } });
    }
  }
  for (const step of Array.isArray(message.dispatchSteps) ? message.dispatchSteps : []) {
    if (step?.name) calls.push({ name: String(step.name), input: step.input || {} });
  }
  return calls;
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "str_replace_based_edit_tool"]);
const READ_TOOLS = new Set(["Read"]);
const LOCAL_SEARCH_TOOLS = new Set(["Grep", "Glob", "LS"]);
const WEB_SEARCH_TOOLS = new Set(["WebSearch", "web_search"]);
const WEB_FETCH_TOOLS = new Set(["WebFetch"]);
const COMMAND_TOOLS = new Set(["Bash", "PowerShell"]);
/* 对接手的模型没有信息量的内部动作：任务清单、提问、工具检索、调度 */
const SILENT_TOOLS = new Set([
  "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskStop", "TaskOutput",
  "ToolSearch", "AskUserQuestion", "ExitPlanMode", "EnterPlanMode", "ScheduleWakeup", "Monitor",
  "manage_task", "list_providers", "todo_list",
]);
const CHANGE_KIND_LABELS = { add: "新建", create: "新建", delete: "删除", remove: "删除" };

/** 一轮助手回复里做过的事，压成一行。没有值得一提的工具调用时返回空串。 */
export function summarizeTurnActivity(message) {
  const { changed, commands, reads, web, localSearches, other } = collectTurnActivity(message);
  const parts = [];
  if (changed.size) {
    parts.push(`改动文件：${[...changed].map(([path, kind]) => (kind ? `${path}（${kind}）` : path)).join("、")}`);
  }
  if (commands.length) {
    const shown = commands.slice(-6).map(command => `\`${command}\``).join("、");
    parts.push(`运行命令：${shown}${commands.length > 6 ? ` 等 ${commands.length} 条` : ""}`);
  }
  if (reads.size) {
    const names = [...reads].slice(0, 4).map(path => path.split(/[\\/]/).pop()).join("、");
    parts.push(`读取 ${reads.size} 个文件（${names}${reads.size > 4 ? " 等" : ""}）`);
  }
  if (localSearches) parts.push(`在文件里搜索 ${localSearches} 次`);
  if (web.length) parts.push(`${web.slice(0, 4).join("、")}${web.length > 4 ? ` 等 ${web.length} 次` : ""}`);
  if (other.size) {
    const labels = [...other].slice(0, 8).map(([label, count]) => (count > 1 ? `${label} ×${count}` : label));
    parts.push(`其他：${labels.join("、")}${other.size > 8 ? " 等" : ""}`);
  }
  if (!parts.length) return "";
  const line = `（本轮操作）${parts.join("；")}`;
  return line.length > ACTIVITY_MAX_CHARS ? `${line.slice(0, ACTIVITY_MAX_CHARS - 1)}…` : line;
}

function collectTurnActivity(message) {
  const changed = new Map();
  const commands = [];
  const reads = new Set();
  const web = [];
  let localSearches = 0;
  const other = new Map();
  const bump = label => other.set(label, (other.get(label) || 0) + 1);

  for (const { name, input } of toolCallsOf(message)) {
    if (SILENT_TOOLS.has(name)) continue;
    if (name === "apply_patch" && Array.isArray(input.changes)) {
      for (const change of input.changes) {
        if (typeof change?.path !== "string") continue;
        const kind = CHANGE_KIND_LABELS[String(change.kind?.type ?? change.kind ?? "").toLowerCase()] ?? "";
        if (!changed.has(change.path) || kind) changed.set(change.path, kind);
      }
    } else if (EDIT_TOOLS.has(name)) {
      const path = firstString(input, PATH_KEYS);
      if (path && !changed.has(path)) changed.set(path, "");
    } else if (COMMAND_TOOLS.has(name)) {
      // 「cd "一长串中文路径" && 真正的命令」：开头那段 cd 会把额度吃光，留后面的
      const command = firstString(input, COMMAND_KEYS)
        .replace(/^(?:cd|Set-Location)\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/i, "");
      if (command) commands.push(oneLine(command, 120));
    } else if (READ_TOOLS.has(name)) {
      const path = firstString(input, PATH_KEYS);
      if (path) reads.add(path);
    } else if (LOCAL_SEARCH_TOOLS.has(name)) {
      localSearches += 1;
    } else if (WEB_SEARCH_TOOLS.has(name)) {
      const query = firstString(input, QUERY_KEYS);
      if (query) web.push(`搜索「${oneLine(query, 60)}」`);
    } else if (WEB_FETCH_TOOLS.has(name)) {
      const url = firstString(input, ["url"]);
      if (url) web.push(`打开 ${oneLine(url, 100)}`);
    } else if (name === "dispatch_to_provider") {
      // 「>厂商」那一轮的标签上已经写了派给谁，这里只记主模型自己发起的派发
      if (!message.via?.dispatch) bump(`派发子任务给 ${firstString(input, ["provider"]) || "其他厂商"}`);
    } else if (name === "Skill") {
      bump(`技能 ${firstString(input, ["skill"]) || "skill"}`);
    } else if (name === "Agent" || name === "Task") {
      bump(`子任务「${oneLine(firstString(input, ["description"]) || "subagent", 40)}」`);
    } else if (name === "generate_image") {
      bump(`生成图片${firstString(input, ["ImageName"]) ? ` ${firstString(input, ["ImageName"])}` : ""}`);
    } else {
      bump(name.replace(/^mcp__/, ""));
    }
  }
  return { changed, commands, reads, web, localSearches, other };
}

/* 被预算挤掉的那几轮，内容可以不要，动过哪些文件得留下——接手的模型不知道
   某个文件被改过，就会照着自己记忆里的旧样子去改。 */
function omittedChangesNote(messages) {
  const paths = new Set();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const path of collectTurnActivity(message).changed.keys()) paths.add(path);
  }
  const head = `（中间省略了 ${messages.length} 条较早的记录`;
  if (!paths.size) return `${head}）`;
  const listed = [...paths].slice(-20);
  const note = `${head}；其间改动过的文件：${listed.join("、")}${paths.size > listed.length ? ` 等 ${paths.size} 个` : ""}）`;
  return note.length > OMITTED_NOTE_MAX_CHARS ? `${note.slice(0, OMITTED_NOTE_MAX_CHARS - 2)}…）` : note;
}

function speakerLabel(message) {
  // 子任务页里的追问不在主时间线上，得写明是冲着哪个子任务说的
  const subtask = message.subtask?.label ? `子任务「${oneLine(message.subtask.label, 40)}」` : (message.subtask ? "子任务" : "");
  if (message.role === "user") return subtask ? `用户（追问${subtask}）` : "用户";
  const via = message.via;
  if (!via) return "助手";
  const vendor = PROVIDER_NAMES[via.provider] || via.provider;
  if (subtask) return `助手（${subtask} · ${vendor}${via.model ? ` · ${via.model}` : ""}）`;
  if (via.dispatch) return `助手（派发给 ${vendor}${via.model ? ` · ${via.model}` : ""}）`;
  return `助手（${via.model || vendor}）`;
}

function statusNote(message) {
  if (message.role !== "assistant") return "";
  if (message.status === "stopped") return "（这一轮被中途停止，没有做完）";
  if (message.status === "running") return "（这一轮没有正常结束）";
  if (message.status === "error") {
    const detail = (message.blocks || []).find(block => block?.type === "codex_error")?.message;
    return `（这一轮以报错结束${detail ? `：${oneLine(detail, 160)}` : ""}）`;
  }
  return "";
}

function renderEntry(message) {
  const text = clipMiddle(messageText(message), ENTRY_MAX_CHARS);
  const notes = message.role === "assistant"
    ? [summarizeTurnActivity(message), statusNote(message)].filter(Boolean)
    : [];
  if (!text && !notes.length) return "";
  return [`${speakerLabel(message)}：${text || "（没有文字回复）"}`, ...notes].join("\n");
}

/**
 * 把一段消息排成给模型看的记录，总长不超过 maxChars。
 * 放不下时优先留最近的；对话开头那条用户消息单独截一段放在最前（它往往是整件事的
 * 原始需求），中间省略的条数照实写出来，免得模型以为记录是完整的。
 */
export function formatConversationTranscript(messages, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  const entries = [];
  for (const message of messages || []) {
    if (!isTranscriptMessage(message)) continue;
    const text = renderEntry(message);
    if (text) entries.push({ message, text });
  }
  if (!entries.length) return "";
  const separator = 2;
  const total = entries.reduce((sum, entry) => sum + entry.text.length + separator, 0);
  if (total <= maxChars) return entries.map(entry => entry.text).join("\n\n");

  const firstUser = entries.findIndex(entry => entry.message.role === "user");
  let opening = firstUser >= 0
    ? `（对话开头）用户：${clipHead(messageText(entries[firstUser].message), OPENING_MAX_CHARS)}`
    : "";
  // 预算很紧时不硬塞开头，先保住最近的
  if (opening.length > maxChars / 4) opening = "";

  // 省略说明（含被省略那几轮改过的文件）也要占预算，先按上限留出来
  const noteReserve = Math.min(OMITTED_NOTE_MAX_CHARS, Math.floor(maxChars / 8));
  let budget = maxChars - opening.length - noteReserve;
  const kept = [];
  let oldestKept = entries.length;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (opening && i === firstUser) break;
    const cost = entries[i].text.length + separator;
    if (cost > budget) {
      if (!kept.length && budget > 0) {
        kept.unshift(`（前文已截断）${entries[i].text.slice(-budget)}`);
        oldestKept = i;
      }
      break;
    }
    kept.unshift(entries[i].text);
    budget -= cost;
    oldestKept = i;
  }
  const omittedFrom = opening ? firstUser + 1 : 0;
  const omitted = entries.slice(omittedFrom, oldestKept).map(entry => entry.message);
  let note = omitted.length ? omittedChangesNote(omitted) : "";
  if (note.length > noteReserve + Math.max(budget, 0)) note = `（中间省略了 ${omitted.length} 条较早的记录）`;
  return [opening, note, ...kept].filter(Boolean).join("\n\n");
}

/**
 * 给这一轮的 prompt 补上目标模型缺的那段上下文；什么都不缺时原样返回。
 */
export function withConversationContext(prompt, messages, {
  route = null,
  resume = false,
  userMessageId = null,
  maxChars = DEFAULT_MAX_CHARS,
} = {}) {
  const { mode, messages: missing } = missingConversationHistory(messages, { route, resume, userMessageId });
  if (mode === "none") return prompt;
  const transcript = formatConversationTranscript(missing, { maxChars });
  if (!transcript) return prompt;
  const intro = mode === "delta" ? DELTA_INTRO : FULL_INTRO;
  return `${intro}\n\n<conversation_history>\n${transcript}\n</conversation_history>\n\n当前用户消息：\n${prompt}`;
}

/**
 * Codex provider —— OpenAI Codex SDK 的事件归一化。
 *
 * Codex 吐的是 thread item（agent_message / reasoning / command_execution /
 * mcp_tool_call / web_search / file_change / todo_list / error），带
 * item.started | item.updated | item.completed 三个生命周期阶段。
 * 这里把它们翻译成 wire.js 那套统一事件。
 *
 * 全部是纯函数：给定 item 就能算出该发什么，不读任何全局状态。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as wire from "./wire.js";

export const PROVIDER_ID = "codex";

export function isAuthAvailable() {
  const authFile = join(homedir(), ".codex", "auth.json");
  if (!existsSync(authFile)) return false;
  try {
    const auth = JSON.parse(readFileSync(authFile, "utf8"));
    return !!(auth.tokens?.access_token || auth.OPENAI_API_KEY);
  } catch { return false; }
}

export function sandboxMode(permissionMode) {
  if (permissionMode === "plan") return "read-only";
  if (permissionMode === "bypassPermissions") return "danger-full-access";
  return "workspace-write";
}

/* ── 模型目录 ────────────────────────────────────────────────
   有哪些 GPT 可选，唯一的真相源是 Codex CLI 自己维护的
   ~/.codex/models_cache.json：它带 etag 向 OpenAI 要清单，进程起来时刷一次
   写回磁盘。所以这边既不用起进程，也不用手写一张表——读那个文件就是最新的，
   GPT-6 上线的那天菜单自己就有了，一行代码都不用改。

   文件里每个模型的字段，用到的是这几个：
     slug                 传给 SDK 的模型名
     display_name         菜单上显示的名字（GPT-6-Astra）
     description          一句话说明（英文，中文对照见 MENU_DESCS）
     visibility           "list" 才上菜单，"hide" 的是内部模型（gpt-reserve、
                          codex-auto-review），能跑但不该让人选
     priority             OpenAI 给的推荐顺序，越小越靠前
     upgrade              非 null = 官方已标记弃用并给了替代（gpt-5.4-mini →
                          gpt-5.6-luna），这种不该再出现在菜单上

   菜单只取前 MENU_LIMIT 个：清单里连 gpt-5.5、gpt-5.4-mini 这些上一代也在，
   全铺出来菜单会很长，而 priority 已经把当代主力排在最前面。目录本身保留全
   部（含 hide 和弃用的）——用户对话里还选着旧模型时，要认得出它属于这个账号。

   有一点要记住：这个文件是「最后一个跑过的 codex 客户端」写的，而 OpenAI 给
   哪些模型是按客户端版本发的。实测 0.144.6 拿回来的清单里根本没有 gpt-6-astra，
   0.153.4 才有，两个版本交替跑会把同一个文件写来写去。桌面端每跑一轮 Codex，
   用的都是 @openai/codex-sdk 自带的那个二进制，所以这份缓存最终会跟本应用的
   SDK 版本对齐——菜单上列出来的，就是这边真跑得起来的。菜单里少了新模型时，
   先看 package.json 里的 SDK 版本，不是这段解析的问题。 */

export const MODELS_CACHE_FILE = join(homedir(), ".codex", "models_cache.json");

const MENU_LIMIT = 4;

/* 兜底表：只有「没装 Codex CLI 或那个缓存文件读不出来」时才用得上，是
   2026-09-06 那天 models_cache.json 的原样摘录。模型升级不需要来改它。 */
const FALLBACK_CATALOG = [
  { model: "gpt-6-astra",   label: "GPT-6-Astra",   desc: "Our most capable model for complex, demanding work.", rank: 1,  listed: true },
  { model: "gpt-5.6-sol",   label: "GPT-5.6-Sol",   desc: "Reliable agentic workhorse for everyday tasks.",      rank: 6,  listed: true },
  { model: "gpt-5.6-terra", label: "GPT-5.6-Terra", desc: "Balanced agentic coding model for everyday work.",    rank: 7,  listed: true },
  { model: "gpt-5.6-luna",  label: "GPT-5.6-Luna",  desc: "Fast and affordable agentic coding model.",           rank: 8,  listed: true },
  { model: "gpt-5.5",       label: "GPT-5.5",       desc: "Proven previous-generation model.",                   rank: 12, listed: true },
];

// 菜单上的中文说明。认不出的新模型退回缓存里那句英文 description——宁可英文，
// 也不要为了凑中文把新模型挡在菜单外面。
const MENU_DESCS = [
  [/astra$/, "旗舰最强"],
  [/sol$/,   "综合可靠"],
  [/terra$/, "均衡通用"],
  [/luna$/,  "快速经济"],
  [/mini$/,  "轻量快速"],
];

let _catalog = null;        // setCatalog 灌进来的那份，null = 还没读到过
let _cacheStamp = null;     // 上次读进来的文件指纹，用来跳过没变化的重复解析

/** 现在生效的模型目录，[{ model, label, desc, rank, listed }]。 */
export function getCatalog() {
  return _catalog ?? FALLBACK_CATALOG;
}

/** 目录是不是真读到过（false = 还在用兜底表）。 */
export function hasLiveCatalog() {
  return _catalog !== null;
}

/** 换一份目录。空的、认不出来的一律拒绝，宁可留着旧的也别让菜单空掉。 */
export function setCatalog(models) {
  const normalized = normalizeCatalog(models);
  if (!normalized) return false;
  _catalog = normalized;
  return true;
}

/** 测试用：退回兜底表。 */
export function _resetCatalog() {
  _catalog = null;
  _cacheStamp = null;
}

function normalizeCatalog(models) {
  if (!Array.isArray(models)) return null;
  const out = [];
  const seen = new Set();
  for (const raw of models) {
    const model = String(raw?.model ?? "").trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    const rank = Number.isFinite(raw?.rank) ? Number(raw.rank) : Number.MAX_SAFE_INTEGER;
    out.push({
      model,
      label: String(raw?.label ?? "").trim() || model,
      desc: String(raw?.desc ?? "").trim(),
      rank,
      listed: raw?.listed !== false,
    });
  }
  out.sort((a, b) => a.rank - b.rank);
  return out.length ? out : null;
}

/**
 * models_cache.json 的内容 → [{ model, label, desc, rank, listed }]。
 * 一个都认不出来时返回 null（文件被写坏、格式换了），让调用方留着旧目录。
 */
export function parseModelsCache(json) {
  const models = Array.isArray(json?.models) ? json.models : null;
  if (!models) return null;
  return normalizeCatalog(models.map(entry => ({
    model: entry?.slug,
    label: entry?.display_name,
    desc: entry?.description,
    rank: entry?.priority,
    // hide 的是内部模型，被官方标了 upgrade 的是等着下线的，两种都不上菜单
    listed: entry?.visibility === "list" && !entry?.upgrade,
  })));
}

/**
 * 读一次本地缓存文件。永不抛：没装 CLI、文件被写了一半、JSON 坏了，都返回 null。
 * 文件没变过（mtime + 大小相同）时返回 undefined，表示「不用重新灌了」——这个
 * 文件 240KB 出头，没必要每次请求都解析一遍。
 */
export function readModelsCache(file = MODELS_CACHE_FILE) {
  try {
    if (!existsSync(file)) return null;
    const { mtimeMs, size } = statSync(file);
    const stamp = `${file}:${mtimeMs}:${size}`;
    if (stamp === _cacheStamp) return undefined;
    const parsed = parseModelsCache(JSON.parse(readFileSync(file, "utf8")));
    if (parsed) _cacheStamp = stamp;
    return parsed;
  } catch { return null; }
}

/** 读缓存并灌进目录；返回目录是不是真的换了一份。 */
export function refreshCatalog(file = MODELS_CACHE_FILE) {
  const models = readModelsCache(file);
  if (models === undefined) return false;   // 文件没动过
  return setCatalog(models);
}

/** 菜单上要显示的模型：按 OpenAI 的推荐顺序取前几个，带好展示用的名字和说明。 */
export function menuModels() {
  return getCatalog()
    .filter(entry => entry.listed)
    .slice(0, MENU_LIMIT)
    .map((entry) => {
      const desc = MENU_DESCS.find(([pattern]) => pattern.test(entry.model))?.[1] ?? entry.desc;
      return { model: entry.model, label: entry.label, name: entry.label, desc: desc || entry.label };
    });
}

/** 目录里全部模型名（含 hide 和已弃用的）——用来反推「这个模型属于哪个账号」。 */
export function knownModels() {
  return getCatalog().map(entry => entry.model);
}

/**
 * 三档槽位的默认值。这三个槽位现在只剩两个用处：账号卡片上显示这个通道主要
 * 跑什么，以及 /dispatch 派过来时的默认模型（走 opus 槽，派发的都是硬任务）。
 * 界面上的模型菜单由 menuModels() 推，不再受这三个槽位限制。
 */
export function defaultModels() {
  const menu = menuModels();
  const first = menu[0]?.model ?? FALLBACK_CATALOG[0].model;
  return {
    opusModel: first,
    sonnetModel: menu[1]?.model ?? first,
    haikuModel: menu[menu.length - 1]?.model ?? first,
  };
}

export function itemText(item) {
  if (!item) return "";
  if (typeof item.text === "string") return item.text;
  if (typeof item.message === "string") return item.message;
  return "";
}

/** Codex 的 item.type 映射到前端工具卡片认识的名字。 */
export function toolName(item) {
  if (!item) return "tool";
  if (item.type === "command_execution") return "Bash";
  if (item.type === "mcp_tool_call") return item.tool || "mcp";
  if (item.type === "web_search") return "web_search";
  if (item.type === "file_change") return "apply_patch";
  return item.type || "tool";
}

export function toolInput(item) {
  if (!item) return {};
  if (item.type === "command_execution") return { command: item.command || "" };
  if (item.type === "mcp_tool_call") return item.arguments ?? {};
  if (item.type === "web_search") return { query: item.query || "" };
  if (item.type === "file_change") return { changes: item.changes || [], status: item.status };
  if (item.type === "todo_list") return { items: item.items || [] };
  return item;
}

/* codex 把启动期的提醒也塞进 error item（SDK 的类型注释写明 ErrorItem 是
   "non-fatal error surfaced as an item"），它们在每一轮的最前面出现，内容每次
   都一样，也不影响这轮跑不跑得完。原样渲染的话，桌面端每开一轮对话都先弹一张
   红色的「Codex 错误」卡片——用户在聊天界面里也做不了什么。

   所以这几条按内容丢掉，别的 error item 一律照旧显示。前缀写全、逐条列出，
   不用模糊匹配：宁可漏过一条新的提醒，也不能把真错误吞了。
   （第一条 codex 自己有开关，server.js 已经用 --config 关掉；这里留着是为了
   万一那个开关哪天改名，界面上不至于又开始弹。原文在 ~/.codex/log 里还在。） */
const STARTUP_NOTICE_PREFIXES = [
  "Under-development features enabled:",
  "Skill descriptions were shortened",
];

/** 这条 error item 是不是启动期的提醒（而不是真出了错）。 */
export function isStartupNotice(item) {
  if (item?.type !== "error") return false;
  const message = String(item.message ?? "").trim();
  return STARTUP_NOTICE_PREFIXES.some(prefix => message.startsWith(prefix));
}

/** 一个已完成的 item 对应的历史内容块；null 表示这个 item 不进历史。 */
export function contentBlock(item) {
  if (!item) return null;
  const raw = item;
  if (item.type === "agent_message") {
    const text = itemText(item);
    return text ? wire.textBlock(text, raw) : null;
  }
  if (item.type === "reasoning") {
    const thinking = itemText(item);
    return thinking ? wire.thinkingBlock(thinking, raw) : null;
  }
  if (item.type === "mcp_tool_call") {
    return wire.mcpToolResultBlock({
      content: item.result?.content ?? item.result ?? item.error ?? null,
      raw,
    });
  }
  if (item.type === "command_execution") {
    return wire.toolResultBlock({ content: item.aggregated_output || "", raw });
  }
  if (item.type === "error") {
    if (isStartupNotice(item)) return null;
    return wire.providerBlock(PROVIDER_ID, "error", raw, { message: item.message || "Codex item error" });
  }
  return wire.providerBlock(PROVIDER_ID, item.type, raw);
}

const TOOL_ITEM_TYPES = new Set(["command_execution", "mcp_tool_call", "web_search", "file_change"]);
const PROGRESS_ITEM_TYPES = new Set(["command_execution", "mcp_tool_call", "todo_list"]);

/**
 * 一条 Codex 生命周期事件该发给前端的 wire 事件列表（可能为空）。
 *
 * 之所以返回数组而不是直接 send：纯函数可以单测，喂一段录制的 item 流就能
 * 断言归一化结果。原先内联在 server.js 里时，这段逻辑只能靠人肉跑起来验证。
 */
export function itemEvents(eventType, item) {
  if (!item) return [];

  if (eventType === "item.started") {
    if (TOOL_ITEM_TYPES.has(item.type)) {
      const use = {
        id: item.id ?? "",
        name: toolName(item),
        serverName: item.server ?? null,
        input: toolInput(item),
        provider: PROVIDER_ID,
        raw: item,
      };
      return [item.type === "mcp_tool_call" ? wire.mcpToolUse(use) : wire.serverToolUse(use)];
    }
    if (item.type === "reasoning") {
      const block = contentBlock(item);
      return block ? [wire.assistantMessage([block])] : [];
    }
    return [];
  }

  if (eventType === "item.updated") {
    return PROGRESS_ITEM_TYPES.has(item.type)
      ? [wire.toolProgress({ provider: PROVIDER_ID, itemType: item.type, raw: item })]
      : [];
  }

  if (eventType === "item.completed") {
    const block = contentBlock(item);
    return block ? [wire.assistantMessage([block])] : [];
  }

  return [];
}

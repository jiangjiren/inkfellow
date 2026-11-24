/**
 * Antigravity provider（agy）—— Gemini 会员通道的事件归一化。
 *
 * 官方没出 Node SDK（Python 版只认 API key、不认 CLI 登录），所以这条链路是
 * 起 agy 子进程读 stream-json。它吐的是 step_update 事件流，带 step_index /
 * step_type / state，跟 Claude、Codex 都不一样。
 *
 * 这里的翻译器是**有状态的**：文本要按 step_index 累积、工具 id 要配对、
 * 「工具跑完后新起一段回复」要先补一条 message_start。所以是 factory，
 * 每轮对话建一个。返回事件数组而不是直接 send，是为了能喂录制的流做单测。
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as wire from "./wire.js";

export const PROVIDER_ID = "antigravity";

const TOOL_OUTPUT_LIMIT = 20000;

let _binaryCache;

export function findBinary() {
  if (_binaryCache !== undefined) return _binaryCache;
  const candidates = [];
  if (process.env.AGY_BIN) candidates.push(process.env.AGY_BIN);
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    candidates.push(join(localAppData, "agy", "bin", "agy.exe"));
  } else {
    candidates.push(join(homedir(), ".local", "bin", "agy"));
    candidates.push("/usr/local/bin/agy");
  }
  _binaryCache = candidates.find(p => { try { return existsSync(p); } catch { return false; } }) ?? null;
  return _binaryCache;
}

/** 测试用：清掉二进制路径缓存。 */
export function _resetBinaryCache() { _binaryCache = undefined; }

// 登录状态没有可读的凭证文件（agy 把 token 收在自己的 store 里），只能退一步：
// 装了二进制 + 建过配置目录，就认为登录过。真没登录时第一轮会由 CLI 自己报错。
export function isAuthAvailable() {
  if (!findBinary()) return false;
  return existsSync(join(homedir(), ".gemini", "antigravity-cli"));
}

export function modeFlag(permissionMode) {
  if (permissionMode === "plan") return "plan";
  return "accept-edits";
}

// 目录明确支持 xhigh 时优先使用该档，其他模型沿用 high 兜底。
const EFFORT = { low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };

/* ── 模型目录 ────────────────────────────────────────────────
   有哪些模型、每个认哪些档位，唯一的真相源是 `agy models`。它一行一个组合：

     gemini-4-argon-high<TAB>Gemini 4 Argon (High)
     claude-opus-5-5-low<TAB>Claude Opus 5.5 (Low)
     claude-sonnet-4-6<TAB>Claude Sonnet 4.6 (Thinking)

   末尾的 -low/-medium/-high/-xhigh 是「模型 × 档位」的组合，剥掉它就是模型名，剥出
   来的那几个后缀合起来就是这个模型支持的档位；压根没后缀的（上面第三行那种，
   现在的清单里已经没有了，但格式还认）表示它不吃 --effort，传了会报
   "effort is not supported"。档位给错 agy 直接拒绝启动，所以这张表必须准。

   这条命令要起进程走一遍登录，实测 7 秒，不能放在启动路径上。所以 server 侧
   先用磁盘缓存把界面顶起来，再在后台刷新（见 server.js 的 getAgyModelCatalog），
   刷回来的结果调 setCatalog 灌进这里。

   下面这张兜底表在还没查到当前账号的目录时使用。Orchestrator 的可用项因套餐而异，
   由 agy 的实时目录或磁盘缓存提供。

   （旧注释说这条命令在管道里会挂住不退出、只能写死一张表——那是早期版本的
   毛病。现在管道和文件重定向都是 7 秒正常退出，已复测。） */
const FALLBACK_CATALOG = [
  { model: "gemini-4-argon", label: "Gemini 4 Argon", efforts: ["low", "medium", "high"] },
  { model: "gemini-4-neon", label: "Gemini 4 Neon", efforts: ["low", "medium", "high", "xhigh"] },
  { model: "gemini-4-carbon", label: "Gemini 4 Carbon", efforts: ["low", "medium", "high"] },
  { model: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", efforts: ["low", "medium", "high", "xhigh"] },
  { model: "claude-opus-5-5", label: "Claude Opus 5.5", efforts: ["low", "medium", "high"] },
  { model: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", efforts: ["low", "medium", "high"] },
  { model: "gpt-oss-120b", label: "GPT-OSS 120B", efforts: ["medium"] },
];

// 2026-11-05 的模型换代是磁盘缓存的最低版本线。
const FALLBACK_CATALOG_AS_OF = Date.parse("2026-11-05T11:20:00+08:00");

/**
 * 磁盘上那份缓存还能不能用。比这个版本自带的兜底表还旧就不用：升级后第一次查询要是
 * 正好失败（2026-11-05 就碰上了 TLS 握手超时），宁可显示兜底表，也不能退回升级前的
 * 清单——那上面的模型可能已经下线，新模型也没有。
 */
export function isCachedCatalogUsable(fetchedAt) {
  const at = Date.parse(fetchedAt ?? "");
  return Number.isFinite(at) && at >= FALLBACK_CATALOG_AS_OF;
}

const EFFORT_SUFFIX = /-(low|medium|high|xhigh)$/;
const EFFORT_LABEL_SUFFIX = /\s*\((low|medium|high|xhigh)\)$/i;
const EFFORT_ORDER = ["low", "medium", "high", "xhigh"];

let _catalog = null;                  // setCatalog 灌进来的那份，null = 还没查过
const _effortOverrides = new Map();   // learnEffortsFromError 从报错里学到的修正

/** 现在生效的模型目录，[{ model, label, efforts }]。 */
export function getCatalog() {
  return _catalog ?? FALLBACK_CATALOG;
}

/** 目录是不是查回来的（false = 还在用兜底表）。 */
export function hasLiveCatalog() {
  return _catalog !== null;
}

/** 换一份目录。查回来的是权威的，之前从报错里学的那些修正一并作废。 */
export function setCatalog(models) {
  const normalized = normalizeCatalog(models);
  if (!normalized) return false;
  _catalog = normalized;
  _effortOverrides.clear();
  return true;
}

/** 测试用：退回兜底表。 */
export function _resetCatalog() {
  _catalog = null;
  _effortOverrides.clear();
}

function normalizeCatalog(models) {
  if (!Array.isArray(models)) return null;
  const byModel = new Map();
  for (const raw of models) {
    const slug = String(raw?.model ?? "").trim();
    if (!slug || /\s/.test(slug)) continue;
    // 旧缓存把 xhigh 单存成一条模型，读缓存和解析 CLI 输出走同一套合并规则。
    const suffix = EFFORT_SUFFIX.exec(slug);
    const model = suffix ? slug.slice(0, -suffix[0].length) : slug;
    if (!model) continue;
    const efforts = (Array.isArray(raw?.efforts) ? raw.efforts : [])
      .map(level => String(level).trim().toLowerCase())
      .filter(level => EFFORT_ORDER.includes(level));
    const rawLabel = String(raw?.label ?? "").trim();
    const label = suffix ? rawLabel.replace(EFFORT_LABEL_SUFFIX, "").trim() : rawLabel;
    const entry = byModel.get(model) ?? { model, label: "", efforts: new Set() };
    if (!entry.label && label) entry.label = label;
    if (suffix) entry.efforts.add(suffix[1]);
    for (const level of efforts) entry.efforts.add(level);
    byModel.set(model, entry);
  }
  if (!byModel.size) return null;
  return [...byModel.values()].map(({ model, label, efforts }) => ({
    model,
    label: label || model,
    efforts: EFFORT_ORDER.filter(level => efforts.has(level)),
  }));
}

/**
 * `agy models` 的 stdout → [{ model, label, efforts }]，顺序照它给的（新的在前）。
 * 一行都认不出来时返回 null——那多半是没登录或者输出格式变了，宁可继续用旧目录。
 */
export function parseModelsList(stdout) {
  const models = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;   // "Fetching available models..." 这类日志行没有 TAB
    models.push({ model: line.slice(0, tab), label: line.slice(tab + 1) });
  }
  return normalizeCatalog(models);
}

// agy 拒绝启动时会把真实档位写进错误里，例如
//   `gpt-oss-120b has no "high" effort (available: medium)`
//   `effort is not supported for model "claude-opus-4-6-thinking"`
// 目录哪天跟不上了（比如缓存还没刷新就赶上一次升级），就按它说的改，然后重试一次。
export function learnEffortsFromError(model, message) {
  if (!model || !message) return false;
  const before = supportedEfforts(model);
  if (/effort is not supported for model/i.test(message)) {
    if (before && before.length === 0) return false;
    _effortOverrides.set(model, []);
    return true;
  }
  const available = /available:\s*([a-z,\s]+)\)/i.exec(message);
  if (available) {
    const levels = [...new Set(available[1].split(",").map(part => part.trim()).filter(Boolean))]
      .filter(level => EFFORT_ORDER.includes(level))
      .sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
    if (!levels.length) return false;
    if (before && before.length === levels.length && levels.every(level => before.includes(level))) return false;
    _effortOverrides.set(model, levels);
    return true;
  }
  return false;
}

/** 这个模型认哪些档位，null = 目录里没有它。 */
function supportedEfforts(model) {
  if (_effortOverrides.has(model)) return _effortOverrides.get(model);
  return getCatalog().find(entry => entry.model === model)?.efforts ?? null;
}

/**
 * 这个模型这一轮该传什么 --effort，返回 null 表示这一项整个别传。
 */
export function effortForModel(model, effort) {
  const wanted = EFFORT[effort] || "medium";
  if (!model) return wanted;
  // 档位已经写死在模型名里，再传 --effort 会冲突
  if (EFFORT_SUFFIX.test(model)) return null;
  const supported = supportedEfforts(model);
  if (!supported) return wanted;          // 没见过的模型，照传让 agy 自己判
  if (supported.length === 0) return null; // claude-* 这类不接受档位
  if (supported.includes(effort)) return effort;
  if (supported.includes(wanted)) return wanted;
  // 就近取。medium 缺失时优先往下走：high 更慢更费额度，不该由我们替用户升上去
  const order = wanted === "high"
    ? ["high", "medium", "low"]
    : wanted === "low"
    ? ["low", "medium", "high"]
    : ["low", "high", "medium"];
  return order.find(level => supported.includes(level)) ?? supported[0];
}

/* ── 模型菜单 ────────────────────────────────────────────────
   菜单从 Gemini 4 起展示，每个系列只放最新型号。系列 key 抹掉版本号整段，
   例如 gemini-3.8-flash 和 gemini-4-flash 都归到 gemini-#-flash。

   下面这张表只管排序和一句话说明，认的是「哪一类模型」而不是具体版本，
   所以模型升级同样不用动它；匹配不上的新家族排在最后，照样进菜单。

   Gemini 旗舰的名字会随代际变化，Flash、Hydrogen 和 Orchestrator 有各自的菜单说明。 */
const FLASH = /-flash(?:-|$)/;
const FLAGSHIP = /^gemini-\d(?!.*-(?:neon|carbon|flash|hydrogen|orchestrator)(?:-|$))/;
const NEON = /^gemini-\d+(?:[.-]\d+)*-neon$/;
const CARBON = /^gemini-\d+(?:[.-]\d+)*-carbon$/;
const HYDROGEN = /^gemini-\d.*-hydrogen(?:-|$)/;
const ORCHESTRATOR = /(?:^|-)orchestrator(?:-|$)/;
const LEGACY_GEMINI = /^gemini-[1-3](?:[.-]|$)/i;

const MENU_RULES = [
  [FLAGSHIP, "旗舰最强"],
  [NEON, "默认对话"],
  [CARBON, "通用任务"],
  [HYDROGEN, "快速执行"],
  [ORCHESTRATOR, "规划与执行协作"],
  [FLASH, "快速通用"],
  [/^claude-opus/, "Claude 旗舰"],
  [/^claude-sonnet/, "Claude 均衡"],
];

// 目录里有、但不摆进菜单的。这几个能跑，只是平时用不上，摆出来只会让菜单变长。
// 注意只藏菜单，不动目录：还选着它的对话照常跑，档位选择器也照常认它。
const MENU_HIDDEN = [/^gpt-/, LEGACY_GEMINI];
const isVisibleModel = entry => !MENU_HIDDEN.some(pattern => pattern.test(entry.model));

// 版本号整段算一个 #：3.8 和 4、5-5 和 5 写法不同，但都是同一个系列的不同版本。
// -thinking 是旧命名的后缀（claude-opus-4-6-thinking），不代表另一个系列。
function seriesKey(model) {
  return model.replace(/-thinking$/, "").replace(/\d+(?:[.-]\d+)*/g, "#");
}

function versionOf(model) {
  return (model.match(/\d+/g) ?? []).map(Number);
}

function isNewer(a, b) {
  const left = versionOf(a);
  const right = versionOf(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff) return diff > 0;
  }
  return false;
}

/** 菜单上要显示的模型：每个系列只留最新的一个，带好展示用的名字和说明。 */
export function menuModels() {
  const latest = new Map();
  const visible = getCatalog().filter(isVisibleModel);
  for (const entry of visible.length ? visible : FALLBACK_CATALOG.filter(isVisibleModel)) {
    const key = ORCHESTRATOR.test(entry.model) ? entry.label : seriesKey(entry.model);
    const prev = latest.get(key);
    if (!prev || isNewer(entry.model, prev.model)) latest.set(key, entry);
  }
  return [...latest.values()]
    .map((entry) => {
      const rank = MENU_RULES.findIndex(([pattern]) => pattern.test(entry.model));
      const name = entry.label.replace(/\s*\(Thinking\)$/i, "").replace(/^Claude\s+/, "").trim() || entry.model;
      return {
        model: entry.model,
        label: name,
        name,
        desc: rank < 0 ? entry.label : MENU_RULES[rank][1],
        efforts: entry.efforts,
        rank: rank < 0 ? MENU_RULES.length : rank,
      };
    })
    .sort((a, b) => a.rank - b.rank)   // 稳定排序，同一档保持 agy 给的先后
    .map(({ rank, ...item }) => item);
}

/**
 * 对话默认优先用 Neon，派发优先用旗舰，快速档优先用 Hydrogen。
 */
export function defaultModels() {
  const menu = menuModels();
  const neon = menu.find(item => NEON.test(item.model))?.model;
  const hydrogen = menu.find(item => HYDROGEN.test(item.model))?.model;
  const flash = menu.find(item => FLASH.test(item.model))?.model;
  const flagship = menu.find(item => FLAGSHIP.test(item.model))?.model
    ?? neon ?? hydrogen ?? flash ?? menu[0].model;
  return { opusModel: flagship, sonnetModel: neon ?? hydrogen ?? flash ?? flagship, haikuModel: hydrogen ?? flash ?? neon ?? flagship };
}

/**
 * 这个模型下线之后该顶上来的是谁——同系列里最新的那个，没有就 null。
 * 用在两处：用户之前选的模型从目录里消失了（gemini-3.5-flash 那样），以及
 * 对话历史里存着旧模型名。比一律退回默认更接近他当初的选择。
 */
export function successorFor(model) {
  if (!model) return null;
  const key = seriesKey(model);
  let best = null;
  for (const entry of getCatalog()) {
    if (LEGACY_GEMINI.test(entry.model)) continue;
    if (entry.model === model) return null;          // 还在目录里，不用换
    if (seriesKey(entry.model) !== key) continue;
    if (!best || isNewer(entry.model, best)) best = entry.model;
  }
  // 只往上换。目录还没刷新就赶上一次升级时，请求里的版本会比目录里的都新，
  // 那种情况要原样放行让 agy 自己判，绝不能把用户选的新模型悄悄降回旧的。
  return best && isNewer(best, model) ? best : null;
}

/** 历史对话和派发任务里保存的旧 Gemini 型号，在下一轮开始前切到可用型号。 */
export function upgradeLegacyModel(model) {
  if (!LEGACY_GEMINI.test(model)) return model;
  const base = model.replace(EFFORT_SUFFIX, "");
  const defaults = defaultModels();
  return successorFor(base) ?? (FLASH.test(base) ? defaults.haikuModel : defaults.sonnetModel);
}

// 看着像 agy 的模型名。目录里找不到时用它分辨「还没收录的新模型」和「别家的名字」。
const AGY_MODEL_NAME = /^(gemini-\d|claude-(opus|sonnet)-\d|gpt-oss-)/;

/* 这个名字确实已经下线了吗。agy 对下线的名字是直接拒绝启动，所以这里要判准：
   同系列还在目录里，说明它比目录还新（比它新的话 successorFor 早就换走了），要放行；
   整个系列都没了（gemini-3.1-pro），就看同家族有没有比它新的——有就是下线了，
   没有就是目录还没跟上（gemini-5-neon）。没查过真目录时不敢断定，一律放行。 */
function isRetired(model) {
  if (!hasLiveCatalog()) return false;
  const catalog = getCatalog();
  const series = seriesKey(model);
  if (catalog.some(entry => seriesKey(entry.model) === series)) return false;
  const family = `${model.split("-")[0]}-`;
  return catalog.some(entry => entry.model.startsWith(family) && isNewer(entry.model, model));
}

/**
 * 界面或对话历史里带来的模型名，这一轮该跑哪个。返回 null 表示这个名字用不了，
 * 调用方退回默认模型。
 *   Gemini 4 以前的型号  → 升到可用的替代型号
 *   还在目录里的其他型号 → 原样
 *   下线了但同系列有新的  → 顺着升上去，比一律退回默认更接近用户当初的选择
 *   整个系列都下线了      → null
 *   不是 agy 的名字       → null，传过去只会报 not recognized
 *   比目录还新            → 原样，目录刷新前不能把新模型拦下来
 */
export function resolveModel(requested) {
  if (LEGACY_GEMINI.test(requested)) return upgradeLegacyModel(requested);
  const base = requested.replace(EFFORT_SUFFIX, "");   // 档位可以直接写在名字里
  if (getCatalog().some(entry => entry.model === base)) return requested;
  const successor = successorFor(base);
  if (successor) return successor;
  if (!AGY_MODEL_NAME.test(base) || isRetired(base)) return null;
  return requested;
}

// agy 的参数名是 PascalCase 的一套（AbsolutePath / TargetFile / …），
// 前端工具卡片取的是 file_path / command / query 这几个键，对不上就只能
// 把整个 JSON 摊在卡片上。这里补一份小写别名，原字段保留不动。
const PARAM_ALIAS = {
  AbsolutePath: "file_path",
  TargetFile: "file_path",
  DirectoryPath: "file_path",
  FilePath: "file_path",
  NotebookPath: "file_path",
  Command: "command",
  CommandLine: "command",
  Query: "query",
  SearchQuery: "query",
  SearchTerm: "query",
  Url: "url",
  URL: "url",
};

export function toolInput(info) {
  if (!info || typeof info !== "object") return {};
  const params = info.parameters;
  if (!params || typeof params !== "object") return {};
  const out = { ...params };
  for (const [from, to] of Object.entries(PARAM_ALIAS)) {
    if (out[to] === undefined && typeof params[from] === "string") out[to] = params[from];
  }
  return out;
}

export function toolOutput(info) {
  if (!info || typeof info !== "object") return "";
  const out = info.output;
  if (typeof out === "string") return out;
  if (out == null) return "";
  try { return JSON.stringify(out); } catch { return String(out); }
}

// agy 的工具名是自己一套（view_file / run_command / …），前端的工具卡片按名字
// 认图标和中文名，所以映射到已有的那套名字，让 Gemini 的步骤流和另外两家长一样。
const TOOL_ALIAS = {
  view_file: "Read",
  read_url_content: "WebFetch",
  search_web: "WebSearch",
  grep_search: "Grep",
  find_by_name: "Glob",
  list_dir: "Glob",
  run_command: "Bash",
  write_to_file: "Write",
  replace_file_content: "Edit",
  multi_replace_file_content: "Edit",
  sed_file: "Edit",
  notebook_edit: "NotebookEdit",
};

export function toolName(step) {
  const raw = step?.tool_name || step?.tool_info?.name || "tool";
  return TOOL_ALIAS[raw] || raw;
}

/**
 * 建一个流式翻译器。translate(agyEvent) 返回该发给前端的 wire 事件数组。
 */
export function createTranslator() {
  const texts = new Map();        // step_index → 累积的文本
  const openedText = new Set();   // 已经发过 content_block_start 的文本 step
  const toolIds = new Map();      // step_index → 前端用来配对的工具 id
  let streamed = false;           // 本轮是否已经开过流式块
  let hasAnswer = false;
  let hasToolResult = false;

  const openTextBlock = (idx, out) => {
    if (openedText.has(idx)) return;
    // 工具跑完后的新一段回复：先 message_start，前端据此清掉 spinner 并重置块表
    if (streamed) out.push(wire.streamMessageStart());
    out.push(wire.streamTextStart());
    openedText.add(idx);
    streamed = true;
  };

  function translate(ev) {
    const out = [];
    if (!ev || typeof ev !== "object") return out;
    if (ev.event !== "step_update") return out;
    const step = ev.step_update;
    if (!step) return out;
    const idx = step.step_index ?? 0;

    if (step.step_type === "agent_response") {
      const delta = typeof step.text_delta === "string" ? step.text_delta : "";
      if (delta) {
        openTextBlock(idx, out);
        texts.set(idx, (texts.get(idx) || "") + delta);
        out.push(wire.streamTextDelta(delta));
      }
      if (step.state === "DONE") {
        const text = (texts.get(idx) || "").trim();
        if (openedText.has(idx)) out.push(wire.streamTextStop());
        // 定稿：前端拿这条重渲染，历史也只认这条
        if (text) {
          hasAnswer = true;
          out.push(wire.assistantMessage([wire.textBlock(text)]));
        }
        texts.delete(idx);
        openedText.delete(idx);
      }
      return out;
    }

    if (step.step_type === "tool") {
      if (step.state === "DONE") {
        if (toolIds.has(idx) || step.tool_name || step.tool_info?.name || step.tool_info?.output != null) {
          hasToolResult = true;
        }
        const id = toolIds.get(idx) || `agy_${idx}`;
        toolIds.delete(idx);
        const output = toolOutput(step.tool_info);
        const content = output.length > TOOL_OUTPUT_LIMIT
          ? `${output.slice(0, TOOL_OUTPUT_LIMIT)}\n…（输出已截断）`
          : output;
        out.push(wire.assistantMessage([
          wire.toolResultBlock({ toolUseId: id, content, raw: step }),
        ]));
        out.push(wire.toolSettled(id));
        return out;
      }
      if (toolIds.has(idx)) return out;   // ACTIVE 可能来多次
      const id = `agy_${idx}`;
      toolIds.set(idx, id);
      out.push(wire.serverToolUse({
        id,
        name: toolName(step),
        input: toolInput(step.tool_info),
        provider: PROVIDER_ID,
        raw: step,
      }));
      streamed = true;
      return out;
    }

    return out;
  }

  // 流式增量不会写进对话历史，连接中断时也要补成正式的助手消息。
  translate.finishPartial = (response) => {
    const pending = [...texts.values()].map(text => text.trim()).filter(Boolean);
    if (pending.length) {
      return [wire.streamTextStop(), wire.assistantMessage(pending.map(text => wire.textBlock(text)))];
    }
    if (!hasAnswer && response) return [wire.assistantMessage([wire.textBlock(response)])];
    return hasAnswer || hasToolResult ? [] : null;
  };
  translate.hasToolActivity = () => hasToolResult || toolIds.size > 0;
  return translate;
}

/* ── 用量额度 ──────────────────────────────────────────────
   `agy -p "/usage" --output-format json` 是 CLI 的只读快捷路径：不起 agent
   轮次、不花额度、不留会话，直接回一份结构化配额。这是官方唯一给出来的
   非交互查法——直连 v1internal:retrieveUserQuota* 会 403，服务端要认
   Antigravity 客户端标识，我们伪造不出来。

   回来的形状（截取）：
     command.data.groups[] = { name, buckets[] }
     bucket = { id: "gemini-weekly", window: "weekly"|"5h",
                remaining_fraction: 0.87, reset_time: "2026-…Z" }

   每组配额是各自独立的池子：Gemini 烧一组，Claude/GPT 烧一组，Pro 计划下
   Gemini 4 Argon 还单独一组（只有周限额，id 是 gemini-argon-wtu-weekly）。所以不能
   合并成一个数字，前端按组分行显示。认不出的组就用 agy 自己给的名字。 */

const USAGE_GROUP_LABEL = { gemini: "Gemini", "3p": "Claude/GPT" };

// bucket id 长这样：gemini-weekly / gemini-5h / 3p-weekly / 3p-5h
function usageGroupKey(buckets) {
  for (const bucket of buckets) {
    const id = String(bucket?.id ?? "");
    const dash = id.lastIndexOf("-");
    if (dash > 0) return id.slice(0, dash);
  }
  return null;
}

function usageWindow(bucket) {
  if (!bucket) return null;
  const fraction = Number(bucket.remaining_fraction);
  if (!Number.isFinite(fraction)) return null;
  const remainingPercent = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  return {
    usedPercent: 100 - remainingPercent,
    remainingPercent,
    resetAt: bucket.reset_time || null,
  };
}

/**
 * 把 `/usage` 的 stdout 解析成分组配额，读不出来返回 null。
 * agy 正常只吐一行 JSON，但它偶尔会在前面掺日志，所以逐行找最后一个能解析的对象。
 */
export function parseUsage(stdout) {
  let payload = null;
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.command?.data?.groups) payload = parsed;
    } catch { /* 半行日志，跳过 */ }
  }
  const rawGroups = payload?.command?.data?.groups;
  if (!Array.isArray(rawGroups)) return null;

  const groups = [];
  for (const group of rawGroups) {
    const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
    const key = usageGroupKey(buckets);
    const fiveHour = usageWindow(buckets.find(b => b?.window === "5h"));
    const week = usageWindow(buckets.find(b => b?.window === "weekly"));
    if (!fiveHour && !week) continue;
    groups.push({
      key: key ?? String(group?.name ?? ""),
      // 带型号的组名（"Gemini 4 Argon"）只留最后的名字，太长会把数字那一列挤掉
      label: USAGE_GROUP_LABEL[key] ?? String(group?.name ?? key ?? "").replace(/^Gemini\s+[\d.]+\s+/i, ""),
      fiveHour,
      week,
    });
  }
  return groups.length ? groups : null;
}

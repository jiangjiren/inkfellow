import { createServer } from "node:http";
import { chmodSync, readFileSync, existsSync, writeFileSync, readdirSync, statSync, lstatSync, unlinkSync } from "node:fs";
import { extname } from "node:path";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import crypto from "node:crypto";

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" };
import { WebSocketServer } from "ws";
import { query } from "@anthropic-ai/claude-agent-sdk";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number.parseInt(process.env.PORT || "8082", 10);
const HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_CWD = resolve(process.env.VAULT_PATH || process.cwd());
const PERMISSION_MODES = new Set(["plan", "acceptEdits", "auto", "bypassPermissions"]);
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const DEFAULT_PERMISSION_MODE = PERMISSION_MODES.has(process.env.CLAUDE_PERMISSION_MODE)
  ? process.env.CLAUDE_PERMISSION_MODE
  : "auto";

const htmlPath   = join(__dirname, "public/index.html");
const SESSION_FILE = process.env.CLAUDE_CHAT_SESSION_FILE || join(__dirname, `session-${PORT}.json`);
const AUTH_PROFILE_FILE = process.env.CLAUDE_CHAT_AUTH_PROFILE_FILE || join(__dirname, "auth-profile.json");

// ── WeChat Bot Configs & Isolated Paths ──────────────────────
const WECHAT_CONFIG_FILE = join(__dirname, `wechat-bot-${PORT}.json`);
const WECHAT_SYNC_FILE = join(__dirname, `wechat-bot-${PORT}.sync.json`);
const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";

const PROVIDER_PRESETS = {
  anthropic:  { baseUrl: "",                                    opusModel: "claude-opus-4-8",                 sonnetModel: "claude-sonnet-4-6",                haikuModel: "claude-haiku-4-5-20251001" },
  deepseek:   { baseUrl: "https://api.deepseek.com/anthropic", opusModel: "deepseek-v4-pro[1m]",            sonnetModel: "deepseek-v4-pro[1m]",             haikuModel: "deepseek-v4-flash" },
  openrouter: { baseUrl: "https://openrouter.ai/api",          opusModel: "~anthropic/claude-opus-latest",   sonnetModel: "~anthropic/claude-sonnet-latest",  haikuModel: "~anthropic/claude-haiku-latest" },
};
const CLAUDE_COMPAT_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_EFFORT_LEVEL",
  // 剥离从父进程继承来的陈旧 PWD：本服务可能从 clawapp/claude-chat 目录启动，
  // 若把该 PWD 透传给 agent，Claude 会误报工作目录（实际 cwd 已由 SDK 设为 vault）。
  "PWD",
  "OLDPWD",
];

// ── Session persistence ───────────────────────────────────
let sessionId = null;
try {
  if (existsSync(SESSION_FILE)) {
    sessionId = JSON.parse(readFileSync(SESSION_FILE, "utf8")).sessionId ?? null;
    if (sessionId) console.log(`Restored session: ${sessionId}`);
  }
} catch { }

function saveSession(id) {
  sessionId = id;
  try { writeFileSync(SESSION_FILE, JSON.stringify({ sessionId }), "utf8"); } catch { }
}

function clearSession() {
  sessionId = null;
  try { writeFileSync(SESSION_FILE, JSON.stringify({ sessionId: null }), "utf8"); } catch { }
}

// ── Profiles (账号配置) ────────────────────────────────────
function genProfileId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeProfile(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const provider = typeof p.provider === "string" && p.provider.trim() ? p.provider.trim() : "claude";
  const preset = PROVIDER_PRESETS[provider] ?? {};
  // Legacy field migration: old model/fastModel → new three-tier fields
  const legacyModel     = typeof p.model     === "string" ? p.model.trim()     : "";
  const legacyFastModel = typeof p.fastModel === "string" ? p.fastModel.trim() : "";
  const str = (v) => typeof v === "string" && v.trim() ? v.trim() : "";
  return {
    id:          str(p.id)   || genProfileId(),
    name:        str(p.name) || provider,
    provider,
    apiKey:      typeof p.apiKey === "string" ? p.apiKey.trim() : "",
    opusModel:   str(p.opusModel)   || legacyModel          || preset.opusModel   || "",
    sonnetModel: str(p.sonnetModel) || legacyModel          || preset.sonnetModel || "",
    haikuModel:  str(p.haikuModel)  || legacyFastModel || legacyModel || preset.haikuModel  || "",
    baseUrl:     str(p.baseUrl)     || preset.baseUrl || "",
  };
}

/** 从旧格式迁移到新 profiles 格式 */
function migrateOldFormat(old) {
  const profiles = [];
  // Claude 始终存在
  profiles.push({ id: "p_claude", name: "Claude 会员", provider: "claude", apiKey: "", opusModel: "", sonnetModel: "", haikuModel: "", baseUrl: "" });

  // 迁移 DeepSeek keys
  const dsKeys = Array.isArray(old.deepseek?.keys) ? old.deepseek.keys : [];
  if (old.deepseek?.apiKey && !dsKeys.some(k => k.apiKey === old.deepseek.apiKey)) {
    dsKeys.unshift({ id: "deepseek-default", name: "默认", apiKey: old.deepseek.apiKey });
  }
  for (const key of dsKeys) {
    if (key.apiKey) {
      const legacyModel     = old.deepseek?.model     || PROVIDER_PRESETS.deepseek.sonnetModel;
      const legacyFastModel = old.deepseek?.flashModel || old.deepseek?.fastModel || PROVIDER_PRESETS.deepseek.haikuModel;
      profiles.push({
        id: key.id || genProfileId(),
        name: key.name || "DeepSeek",
        provider: "deepseek",
        apiKey: key.apiKey,
        opusModel:   legacyModel,
        sonnetModel: legacyModel,
        haikuModel:  legacyFastModel,
        baseUrl: PROVIDER_PRESETS.deepseek.baseUrl,
      });
    }
  }

  // 迁移 OpenRouter key
  if (old.openrouter?.apiKey) {
    profiles.push({
      id: genProfileId(),
      name: "OpenRouter",
      provider: "openrouter",
      apiKey: old.openrouter.apiKey,
      opusModel:   old.openrouter.opusModel   || PROVIDER_PRESETS.openrouter.opusModel,
      sonnetModel: old.openrouter.sonnetModel || PROVIDER_PRESETS.openrouter.sonnetModel,
      haikuModel:  old.openrouter.haikuModel  || PROVIDER_PRESETS.openrouter.haikuModel,
      baseUrl: PROVIDER_PRESETS.openrouter.baseUrl,
    });
  }

  let activeProfileId = "p_claude";
  if (old.provider === "deepseek") {
    const match = profiles.find(p => p.provider === "deepseek" &&
      (old.deepseek?.selectedKeyId ? p.id === old.deepseek.selectedKeyId : true));
    if (match) activeProfileId = match.id;
  } else if (old.provider === "openrouter") {
    const match = profiles.find(p => p.provider === "openrouter");
    if (match) activeProfileId = match.id;
  }
  return { activeProfileId, profiles };
}

function normalizeProfiles(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  // 旧格式没有 profiles 数组 → 迁移
  if (!Array.isArray(data.profiles)) return migrateOldFormat(data);

  const profiles = data.profiles.map(normalizeProfile).filter(p => p.provider === "claude" || p.apiKey);
  if (!profiles.some(p => p.provider === "claude")) {
    profiles.unshift({ id: "p_claude", name: "Claude 会员", provider: "claude", apiKey: "", opusModel: "", sonnetModel: "", haikuModel: "", baseUrl: "" });
  }
  const activeProfileId = typeof data.activeProfileId === "string" && profiles.some(p => p.id === data.activeProfileId)
    ? data.activeProfileId
    : profiles[0].id;
  return { activeProfileId, profiles };
}

function readProfiles() {
  try {
    if (existsSync(AUTH_PROFILE_FILE)) {
      return normalizeProfiles(JSON.parse(readFileSync(AUTH_PROFILE_FILE, "utf8")));
    }
  } catch { }
  return normalizeProfiles(null);
}

function writeProfiles(data) {
  writeFileSync(AUTH_PROFILE_FILE, JSON.stringify(data, null, 2), "utf8");
  try { chmodSync(AUTH_PROFILE_FILE, 0o600); } catch { }
}

function maskSecret(secret) {
  if (!secret) return "";
  if (secret.length <= 10) return "已保存";
  return `${secret.slice(0, 5)}…${secret.slice(-4)}`;
}

function toPublicProfiles(data = readProfiles()) {
  return {
    activeProfileId: data.activeProfileId,
    profiles: data.profiles.map(p => ({
      id:           p.id,
      name:         p.name,
      provider:     p.provider,
      maskedApiKey: maskSecret(p.apiKey),
      opusModel:   p.opusModel,
      sonnetModel: p.sonnetModel,
      haikuModel:  p.haikuModel,
      // 仅 custom provider 暴露 baseUrl（内置厂商不需要显示）
      ...(p.provider === "custom" ? { baseUrl: p.baseUrl } : {}),
    })),
  };
}

function getActiveProfile(data = readProfiles()) {
  return data.profiles.find(p => p.id === data.activeProfileId) ?? data.profiles[0] ?? null;
}

export function buildAgentEnv(profileData, effort, requestedModel) {
  const env = { ...process.env };
  for (const key of CLAUDE_COMPAT_ENV_KEYS) delete env[key];

  const active = getActiveProfile(profileData);
  if (!active || active.provider === "claude") return env;
  if (!active.apiKey) return env;
  // anthropic provider uses the default Anthropic base URL — no baseUrl required
  if (!active.baseUrl && active.provider !== "anthropic") return env;

  const opusM   = active.opusModel   || "";
  const sonnetM = active.sonnetModel || opusM;
  const haikuM  = active.haikuModel  || sonnetM;
  // requestedModel = 用户在顶部下拉手动选择的模型，作为当前对话的主模型
  const conversationModel = requestedModel || sonnetM || opusM;

  if (active.provider === "anthropic") {
    // Direct Anthropic API key — standard ANTHROPIC_API_KEY, no base URL override
    env.ANTHROPIC_API_KEY = active.apiKey;
  } else {
    // Third-party providers (DeepSeek / OpenRouter / custom) use bearer token + custom base URL
    env.ANTHROPIC_API_KEY    = "";
    env.ANTHROPIC_BASE_URL   = active.baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = active.apiKey;
  }

  env.ANTHROPIC_MODEL                = conversationModel;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL   = opusM   || conversationModel;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnetM || conversationModel;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL  = haikuM  || conversationModel;  // ← haiku 用快速模型
  env.CLAUDE_CODE_SUBAGENT_MODEL     = haikuM  || conversationModel;  // ← subagent 用快速模型
  // DeepSeek 成本低，默认给满；其余保守用 medium
  env.CLAUDE_CODE_EFFORT_LEVEL = (active.provider === "deepseek") ? (effort || "max") : (effort || "medium");
  if (active.provider === "openrouter") env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK = "1";

  return env;
}

// ── Server-side history ────────────────────────────────────
const HISTORY_FILE = process.env.CLAUDE_CHAT_HISTORY_FILE || join(__dirname, `history-${PORT}.json`);
const MAX_SERVER_HISTORY = 100;

export function resolveAllowedCwd(requestedCwd) {
  const cwd = typeof requestedCwd === "string" && requestedCwd.trim()
    ? resolve(requestedCwd)
    : DEFAULT_CWD;
  const rel = relative(DEFAULT_CWD, cwd);
  if (rel.startsWith("..") || isAbsolute(rel)) return DEFAULT_CWD;
  return cwd;
}

function resolvePublicFile(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }

  const normalized = decoded.replace(/^\/+/, "");
  const filePath = resolve(__dirname, "public", normalized);
  const publicRoot = resolve(__dirname, "public");
  const rel = relative(publicRoot, filePath);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return filePath;
}

function readHistory() {
  try {
    if (existsSync(HISTORY_FILE)) return JSON.parse(readFileSync(HISTORY_FILE, "utf8"));
  } catch { }
  return [];
}

function writeHistory(arr) {
  try { writeFileSync(HISTORY_FILE, JSON.stringify(arr), "utf8"); } catch { }
}

// ── Skills preload ─────────────────────────────────────────
// Read skill slugs from ~/.claude/skills/ directory (fast, no subprocess needed)
function loadSkillsFromDisk() {
  const dirs = [
    join(homedir(), ".claude", "skills"),
    join(DEFAULT_CWD, ".claude", "skills"),
  ];
  const slugs = new Set();
  for (const dir of dirs) {
    try {
      for (const entry of readdirSync(dir)) {
        try {
          // Use lstatSync so broken symlinks are counted (symlink = installed skill)
          const st = lstatSync(join(dir, entry));
          if (st.isDirectory() || st.isSymbolicLink()) slugs.add(entry);
        } catch { /* skip */ }
      }
    } catch { /* dir not found */ }
  }
  return [...slugs].sort();
}

let cachedSkills = loadSkillsFromDisk();
console.log(`Loaded ${cachedSkills.length} skills from disk`);


// ── WeChat Bot In-Memory Session & Live Poller Loop ──────────
const activeWechatLogins = new Map();
let wechatPollingController = null;

// 每个微信 sender 的对话历史（多轮上下文）
// 结构 Map<sender, { turns: [{role, content}], lastAt: number }>
// 使用 Anthropic SDK messages.create() 直接传结构化消息，彻底绕开 thinking signature 问题
const wechatSenderSessions = new Map();
const WECHAT_SESSION_TTL_MS = 30 * 60 * 1000; // 30 分钟无消息自动开启新对话
const WECHAT_MAX_HISTORY_TURNS = 10;           // 最多保留 10 轮（5 来 5 回）
const WECHAT_HISTORY_FILE = join(__dirname, `wechat-history-${PORT}.json`);

// 启动时从文件恢复历史
try {
  if (existsSync(WECHAT_HISTORY_FILE)) {
    const raw = JSON.parse(readFileSync(WECHAT_HISTORY_FILE, "utf8"));
    for (const [sender, entry] of Object.entries(raw)) {
      wechatSenderSessions.set(sender, entry);
    }
    console.log(`[WeChat] Restored history for ${wechatSenderSessions.size} senders.`);
  }
} catch { }

function saveWechatHistory() {
  try {
    const obj = Object.fromEntries(wechatSenderSessions);
    writeFileSync(WECHAT_HISTORY_FILE, JSON.stringify(obj), "utf8");
  } catch { }
}

// 根据当前激活的账号配置构建 Anthropic SDK 客户端
// claude 会员返回 null —— OAuth token 不能直接调 API，需走 query()
function buildAnthropicClientForWechat(profileData) {
  const active = getActiveProfile(profileData);
  const DEFAULT_MODEL = "claude-sonnet-4-6";

  // claude 会员：OAuth token 仅供网页端使用，直接调 API 会触发 429
  // 返回 null，调用方改走 query() 路径
  if (!active || active.provider === "claude") return null;

  // 直接 Anthropic API Key
  if (active.provider === "anthropic") {
    const model = active.sonnetModel || active.opusModel || DEFAULT_MODEL;
    return { client: new Anthropic({ apiKey: active.apiKey }), model };
  }

  // 第三方兼容接口（DeepSeek / OpenRouter / custom）：Bearer token + 自定义 baseURL
  // 模型名去掉 Claude Code 内部的 ~ 前缀
  const model = (active.sonnetModel || active.opusModel || DEFAULT_MODEL).replace(/^~/, "");
  return {
    client: new Anthropic({ authToken: active.apiKey, baseURL: active.baseUrl }),
    model,
  };
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

async function requestWechat(baseUrl, token, endpoint, body = {}) {
  const url = `${baseUrl.replace(/\/$/, "")}/${endpoint.replace(/^\//, "")}`;
  const headers = {
    "Content-Type": "application/json",
    "AuthorizationType": "ilink_bot_token",
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": "132099",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...body,
      base_info: { channel_version: "2.4.3", bot_agent: "inkfellow-wechat" }
    })
  });
  if (!res.ok) throw new Error(`WeChat Gateway HTTP ${res.status}`);
  return res.json();
}

async function sendWechatMessage(baseUrl, token, toUser, text, contextToken = undefined) {
  const clientId = `inkfellow-wechat-${crypto.randomUUID()}`;
  await requestWechat(baseUrl, token, "ilink/bot/sendmessage", {
    msg: {
      from_user_id: "",
      to_user_id: toUser,
      client_id: clientId,
      message_type: 2, // MessageType.BOT
      message_state: 2, // MessageState.FINISH
      item_list: [
        {
          type: 1, // MessageItemType.TEXT
          text_item: { text: text }
        }
      ],
      context_token: contextToken || undefined,
    }
  });
}

async function sendWechatTyping(baseUrl, token, toUser, status = 1, contextToken = undefined) {
  try {
    const config = await requestWechat(baseUrl, token, "ilink/bot/getconfig", {
      ilink_user_id: toUser,
      context_token: contextToken || undefined,
    });
    if (config.typing_ticket) {
      await requestWechat(baseUrl, token, "ilink/bot/sendtyping", {
        ilink_user_id: toUser,
        typing_ticket: config.typing_ticket,
        status
      });
    }
  } catch {}
}

async function startWechatPolling(baseUrl, token, initialBuf = "") {
  if (wechatPollingController) {
    wechatPollingController.abort();
  }
  
  const ac = new AbortController();
  wechatPollingController = ac;
  let getUpdatesBuf = initialBuf;

  console.log(`[WeChat Loop] Poller initiated on base: ${baseUrl}`);

  (async () => {
    while (!ac.signal.aborted) {
      try {
        const resp = await requestWechat(baseUrl, token, "ilink/bot/getupdates", {
          get_updates_buf: getUpdatesBuf
        });

        if (ac.signal.aborted) break;

        const isApiError = (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0);
        if (isApiError) {
          console.warn(`[WeChat Loop] Polling error ret=${resp.ret} errcode=${resp.errcode}. Backing off...`);
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        if (resp.get_updates_buf) {
          getUpdatesBuf = resp.get_updates_buf;
          try {
            writeFileSync(WECHAT_SYNC_FILE, JSON.stringify({ get_updates_buf }), "utf8");
          } catch {}
        }

        const messages = resp.msgs ?? [];
        for (const msg of messages) {
          const textItem = msg.item_list?.find(i => i.type === 1)?.text_item;
          if (!textItem) continue;

          const sender = msg.from_user_id;
          const prompt = textItem.text.trim();
          const contextToken = msg.context_token;
          console.log(`[WeChat Inbound] message from ${sender}: "${prompt}"`);

          // 用户主动开启新对话
          if (/^(新对话|new|\/new|重新开始|清除记忆)$/i.test(prompt)) {
            wechatSenderSessions.delete(sender);
            sendWechatMessage(baseUrl, token, sender, "✅ 已开启新对话，之前的上下文已清除。", contextToken).catch(() => {});
            continue;
          }

          processWechatQuery(baseUrl, token, sender, prompt, contextToken, ac.signal);
        }
      } catch (err) {
        if (ac.signal.aborted) break;
        console.error("[WeChat Loop] Error polling updates:", err.message);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    console.log("[WeChat Loop] Poller stopped successfully.");
  })();
}

async function processWechatQuery(baseUrl, token, sender, prompt, contextToken, abortSignal) {
  console.log(`[WeChat Agent] processWechatQuery starting for ${sender}...`);
  try {
    await sendWechatTyping(baseUrl, token, sender, 1, contextToken);

    const profileData = readProfiles();
    const active = getActiveProfile(profileData);
    console.log(`[WeChat Agent] Active profile: ${active ? active.name : "none"} (provider: ${active ? active.provider : "none"})`);

    // 取出该 sender 的对话历史，超时则清除重新开始
    const sessionEntry = wechatSenderSessions.get(sender);
    const isExpired = sessionEntry && (Date.now() - sessionEntry.lastAt >= WECHAT_SESSION_TTL_MS);
    if (isExpired) wechatSenderSessions.delete(sender);
    const history = (!isExpired && sessionEntry?.turns) ? sessionEntry.turns : [];

    const sdkClient = buildAnthropicClientForWechat(profileData);

    const typingInterval = setInterval(() => {
      sendWechatTyping(baseUrl, token, sender, 1, contextToken);
    }, 6000);

    let finalResponse = "";
    try {
      if (sdkClient) {
        // ── 有独立 API Key 的 provider（anthropic / deepseek / openrouter）──
        // 用 Anthropic SDK messages.create()，传结构化消息数组
        const { client, model } = sdkClient;
        const messages = [
          ...history.map(t => ({ role: t.role, content: t.content })),
          { role: "user", content: prompt },
        ];
        console.log(`[WeChat Agent] messages.create (model: ${model}, history: ${history.length} turns)`);
        const response = await client.messages.create({ model, max_tokens: 4096, messages });
        // 只取 text 块，过滤掉 thinking / redacted_thinking（不存 signature，不会报错）
        finalResponse = response.content.filter(b => b.type === "text").map(b => b.text).join("");
      } else {
        // ── claude 会员：OAuth token 不能直接调 API，走 Agent SDK query() ──
        // 不使用 resume（thinking signature 问题），改用文本注入历史
        const agentEnv = buildAgentEnv(profileData, "medium", null);
        const wechatCwd = resolveAllowedCwd("");
        agentEnv.PWD = wechatCwd; // 工作目录与实际 cwd 一致，避免误报为启动目录
        let fullPrompt = prompt;
        if (history.length > 0) {
          const historyText = history.map(t => `${t.role === "user" ? "用户" : "助手"}：${t.content}`).join("\n");
          fullPrompt = `以下是本次对话的历史记录：\n${historyText}\n\n用户：${prompt}`;
        }
        console.log(`[WeChat Agent] query() via Agent SDK (history: ${history.length} turns)`);
        const userMsg = {
          type: "user",
          message: { role: "user", content: [{ type: "text", text: fullPrompt }] },
          parent_tool_use_id: null,
        };
        const generator = query({
          prompt: (async function* () { yield userMsg; })(),
          options: { cwd: wechatCwd, permissionMode: "auto", allowDangerouslySkipPermissions: true, includePartialMessages: false, env: agentEnv, abortController: { signal: abortSignal } },
        });
        for await (const ev of generator) {
          if (ev.type === "assistant") {
            const text = (ev.message?.content || ev.content || []).filter(b => b.type === "text").map(b => b.text).join("");
            if (text) finalResponse = text;
          }
          if (ev.type === "result" && ev.subtype === "success" && ev.result) finalResponse = ev.result;
        }
      }
    } catch (err) {
      if (abortSignal.aborted) { console.warn(`[WeChat Agent] Aborted.`); return; }
      console.error("[WeChat Agent] Error:", err);
      finalResponse = `⚠️ 助手发生错误: ${err.message}`;
    } finally {
      clearInterval(typingInterval);
      await sendWechatTyping(baseUrl, token, sender, 2, contextToken);
    }

    console.log(`[WeChat Agent] Response (length: ${finalResponse.length}): "${finalResponse.slice(0, 60)}..."`);

    if (!abortSignal.aborted && finalResponse.trim()) {
      try {
        await sendWechatMessage(baseUrl, token, sender, finalResponse.trim(), contextToken);
        console.log(`[WeChat Agent] Message sent to ${sender}.`);

        // 追加本轮到历史，只存文本，超限时丢弃最早一轮
        const newTurns = [...history,
          { role: "user", content: prompt },
          { role: "assistant", content: finalResponse.trim() },
        ];
        if (newTurns.length > WECHAT_MAX_HISTORY_TURNS * 2) newTurns.splice(0, 2);
        wechatSenderSessions.set(sender, { turns: newTurns, lastAt: Date.now() });
        saveWechatHistory();
      } catch (err) {
        console.error("[WeChat Agent] Failed to send message to WeChat:", err.message);
      }
    }
  } catch (outerErr) {
    console.error("[WeChat Agent] Outer execution crash:", outerErr);
  }
}

// Automatically spin up WeChat polling at server boot if credentials exist
if (existsSync(WECHAT_CONFIG_FILE)) {
  try {
    const creds = JSON.parse(readFileSync(WECHAT_CONFIG_FILE, "utf8"));
    if (creds.token && creds.baseUrl) {
      let syncBuf = "";
      if (existsSync(WECHAT_SYNC_FILE)) {
        syncBuf = JSON.parse(readFileSync(WECHAT_SYNC_FILE, "utf8")).get_updates_buf ?? "";
      }
      startWechatPolling(creds.baseUrl, creds.token, syncBuf);
    }
  } catch (err) {
    console.error("[WeChat Boot] Failed to auto-start polling:", err.message);
  }
}


// ── HTTP ──────────────────────────────────────────────────
const http = createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  const queryParams = new URLSearchParams((req.url ?? "/").split("?")[1] ?? "");
  const method = req.method?.toUpperCase() ?? "GET";

  // ── WeChat Settings API ──
  if (url === "/api/wechat/status" && method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (existsSync(WECHAT_CONFIG_FILE)) {
      try {
        const creds = JSON.parse(readFileSync(WECHAT_CONFIG_FILE, "utf8"));
        res.end(JSON.stringify({ connected: true, botId: creds.botId ?? "微信助手" }));
        return;
      } catch {}
    }
    res.end(JSON.stringify({ connected: false }));
    return;
  }

  if (url === "/api/wechat/login/start" && method === "POST") {
    (async () => {
      try {
        const qrResp = await requestWechat(FIXED_BASE_URL, null, "ilink/bot/get_bot_qrcode?bot_type=3", { local_token_list: [] });
        if (!qrResp.qrcode_img_content) {
          throw new Error("Tencent Gateway returned empty QR code payload");
        }
        const sessionKey = `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        activeWechatLogins.set(sessionKey, {
          qrcode: qrResp.qrcode,
          qrcodeUrl: qrResp.qrcode_img_content,
          startedAt: Date.now(),
          pollBaseUrl: FIXED_BASE_URL
        });
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, sessionKey, qrcodeUrl: qrResp.qrcode_img_content }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  if (url === "/api/wechat/login/poll" && method === "GET") {
    const sessionKey = queryParams.get("sessionKey");
    const verifyCode = queryParams.get("verifyCode") ?? "";
    const session = activeWechatLogins.get(sessionKey);
    
    if (!session) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or expired login session" }));
      return;
    }

    (async () => {
      try {
        let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(session.qrcode)}`;
        if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;

        const fetchUrl = `${session.pollBaseUrl}/${endpoint}`;
        const pollRes = await fetch(fetchUrl, {
          method: "GET",
          headers: { "iLink-App-Id": "bot", "iLink-App-ClientVersion": "132099" }
        });
        
        if (!pollRes.ok) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "wait" }));
          return;
        }

        const data = await pollRes.json();
        if (data.status === "scaned_but_redirect" && data.redirect_host) {
          session.pollBaseUrl = `https://${data.redirect_host}`;
        }

        if (data.status === "confirmed") {
          const configData = {
            token: data.bot_token,
            savedAt: new Date().toISOString(),
            baseUrl: data.baseurl || session.pollBaseUrl,
            userId: data.ilink_user_id,
            botId: data.ilink_bot_id
          };
          writeFileSync(WECHAT_CONFIG_FILE, JSON.stringify(configData, null, 2), "utf8");
          activeWechatLogins.delete(sessionKey);

          // Start WeChat Listener background loop automatically
          startWechatPolling(configData.baseUrl, configData.token);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: data.status, botId: data.ilink_bot_id }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  if (url === "/api/wechat/logout" && method === "POST") {
    if (wechatPollingController) {
      wechatPollingController.abort();
      wechatPollingController = null;
    }
    if (existsSync(WECHAT_CONFIG_FILE)) unlinkSync(WECHAT_CONFIG_FILE);
    if (existsSync(WECHAT_SYNC_FILE)) unlinkSync(WECHAT_SYNC_FILE);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── REST API: history ─────────────────────────────────────
  if (url === "/api/history" && method === "GET") {
    const history = readHistory();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(history));
    return;
  }

  if (url === "/api/auth-profile" && method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(toPublicProfiles()));
    return;
  }

  // ── Claude subscription auth status ──────────────────────────
  // Run `claude auth status` — the only reliable way to check login state,
  // since credentials may be stored in the system keychain rather than a file.
  if (url === "/api/health/claude-auth" && method === "GET") {
    let stdout = "";
    let stderr = "";
    const proc = spawn("claude", ["auth", "status"], {
      timeout: 6000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    proc.stdout?.on("data", d => { stdout += d; });
    proc.stderr?.on("data", d => { stderr += d; });
    proc.on("error", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ authenticated: false, detail: "claude CLI not found" }));
    });
    proc.on("close", () => {
      let detail = {};
      try { detail = JSON.parse(stdout); } catch { detail = { raw: stdout.trim() || stderr.trim() }; }
      const authenticated = detail.loggedIn === true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ authenticated, detail }));
    });
    return;
  }

  if (url === "/api/auth-profile" && method === "PUT") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const current = readProfiles();
        let next;

        if (payload.action === "activate") {
          // 切换当前账号
          const id = String(payload.profileId ?? "");
          if (!current.profiles.some(p => p.id === id)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "账号不存在" }));
            return;
          }
          next = { ...current, activeProfileId: id };

        } else if (payload.action === "add") {
          // 新增账号
          const profile = normalizeProfile(payload.profile ?? {});
          if (profile.provider !== "claude" && !profile.apiKey) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "API Key 不能为空" }));
            return;
          }
          if (!profile.baseUrl && profile.provider !== "claude" && profile.provider !== "anthropic") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Base URL 不能为空" }));
            return;
          }
          next = { ...current, profiles: [...current.profiles, profile], activeProfileId: profile.id };

        } else if (payload.action === "update") {
          // 编辑已有账号
          const id = String(payload.profile?.id ?? "");
          const target = current.profiles.find(p => p.id === id);
          if (!target) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "账号不存在" }));
            return;
          }
          const updated = normalizeProfile({ ...target, ...payload.profile, id: target.id, provider: target.provider });
          if (updated.provider !== "claude" && !updated.apiKey) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "API Key 不能为空" }));
            return;
          }
          if (!updated.baseUrl && updated.provider !== "claude" && updated.provider !== "anthropic") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Base URL 不能为空" }));
            return;
          }
          next = { ...current, profiles: current.profiles.map(p => p.id === id ? updated : p) };

        } else if (payload.action === "delete") {
          // 删除账号（不能删 Claude 会员 / 不能删到空）
          const id = String(payload.profileId ?? "");
          const target = current.profiles.find(p => p.id === id);
          if (!target || target.provider === "claude") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "该账号不能删除" }));
            return;
          }
          const profiles = current.profiles.filter(p => p.id !== id);
          const activeProfileId = current.activeProfileId === id
            ? (profiles[0]?.id ?? "p_claude")
            : current.activeProfileId;
          next = { profiles, activeProfileId };

        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unknown action" }));
          return;
        }

        const changed = JSON.stringify(current) !== JSON.stringify(next);
        writeProfiles(next);
        if (changed) clearSession();

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, resetSession: changed, data: toPublicProfiles(next) }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad request" }));
      }
    });
    return;
  }

  const historyItemRe = url.match(/^\/api\/history\/([^/]+)$/);
  if (historyItemRe) {
    const id = historyItemRe[1];
    if (method === "PUT") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const conv = JSON.parse(body);
          const history = readHistory();
          const idx = history.findIndex(h => h.id === conv.id);
          if (idx >= 0) {
            history[idx] = conv;
          } else {
            history.unshift(conv);
            if (history.length > MAX_SERVER_HISTORY) history.splice(MAX_SERVER_HISTORY);
          }
          writeHistory(history);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "bad request" }));
        }
      });
      return;
    }
    if (method === "DELETE") {
      const history = readHistory().filter(h => h.id !== id);
      writeHistory(history);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
  }

  // ── Static assets ─────────────────────────────────────────
  if (url !== "/" && url !== "/index.html") {
    const filePath = resolvePublicFile(url);
    if (filePath && existsSync(filePath)) {
      const mime = MIME[extname(filePath)] ?? "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime });
      res.end(readFileSync(filePath));
      return;
    }
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(readFileSync(htmlPath, "utf8"));
});


// ── WebSocket ─────────────────────────────────────────────
const wss = new WebSocketServer({ server: http });

wss.on("connection", (ws) => {
  let abortCtrl = null;
  // Send cached skills immediately so "/" popup works before first message
  ws.send(JSON.stringify({ type: "system", subtype: "init", skills: cachedSkills, slash_commands: cachedSkills }));

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.reset) {
      clearSession();
      if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; }
      return;
    }

    if (msg.setSession != null) { saveSession(String(msg.setSession)); return; }

    if (msg.stop) {
      if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; }
      else send({ type: "stopped" });
      return;
    }

    // Cancel any in-flight query before starting a new one
    if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; }

    // Build message content — text only, or images + text
    const content = [];
    const images = msg.images ?? (msg.image ? [msg.image] : []); // support both formats
    for (const img of images) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.data },
      });
    }
    content.push({ type: "text", text: msg.prompt });

    const userMsg = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    };

    const ac = new AbortController();
    abortCtrl = ac;
    const permissionMode = PERMISSION_MODES.has(msg.permissionMode)
      ? msg.permissionMode
      : DEFAULT_PERMISSION_MODE;
    const effort = EFFORT_LEVELS.has(msg.effort) ? msg.effort : "medium";
    const profileData = readProfiles();
    const activeProfile = getActiveProfile(profileData);

    if (activeProfile && activeProfile.provider !== "claude" && !activeProfile.apiKey) {
      send({ type: "error", text: `${activeProfile.name} 的 API Key 还没有配置，请先在账号设置里保存。` });
      send({ type: "done" });
      abortCtrl = null;
      return;
    }

    const resolvedCwd = resolveAllowedCwd(msg.cwd);
    const webEnv = buildAgentEnv(profileData, effort, msg.model);
    webEnv.PWD = resolvedCwd; // 让 agent 报告的工作目录与实际 cwd 一致
    const options = {
      cwd: resolvedCwd,
      permissionMode,
      allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
      abortController: ac,
      includePartialMessages: true,
      effort,
      env: webEnv,
    };
    if (sessionId) options.resume = sessionId;
    if (!activeProfile || activeProfile.provider === "claude") {
      if (msg.model) options.model = msg.model;
    }

    (async () => {
      try {
        for await (const ev of query({
          prompt: (async function* () { yield userMsg; })(),
          options,
        })) {
          if (ev.type === "system" && ev.subtype === "init") {
            saveSession(ev.session_id);
            send({ type: "session", sessionId: ev.session_id });
            // ev.skills = skill slugs only; ev.slash_commands = skills + built-in names
            const skillsFromSdk = Array.isArray(ev.skills) && ev.skills.length > 0
              ? ev.skills
              : (Array.isArray(ev.slash_commands) ? ev.slash_commands : []);
            if (skillsFromSdk.length > 0) cachedSkills = skillsFromSdk; // keep cache fresh
            send({
              type: "system",
              subtype: "init",
              slash_commands: skillsFromSdk,
              skills: skillsFromSdk,
            });
            continue;
          }
          if (ev.type !== "system") send(ev);
        }
        send({ type: "done" });
      } catch (err) {
        if (err?.name === "AbortError") {
          send({ type: "stopped" });
        } else {
          send({ type: "error", text: String(err) });
          send({ type: "done" });
        }
      } finally {
        if (abortCtrl === ac) abortCtrl = null;
      }
    })();
  });

  ws.on("close", () => {
    if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; }
  });
});

http.listen(PORT, HOST, () => {
  console.log(`claude-chat listening on ${HOST}:${PORT}`);
});

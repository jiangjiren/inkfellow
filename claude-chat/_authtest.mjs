import { query } from "@anthropic-ai/claude-agent-sdk";

// 复刻 server.js 走 "Claude 会员" 的认证路径：
// buildAgentEnv 对 claude 会员只是删掉 CLAUDE_COMPAT_ENV_KEYS，返回干净 env，
// 不注入任何 apiKey/baseUrl —— query() 靠内置二进制读系统 OAuth 凭证认证。
const CLAUDE_COMPAT_ENV_KEYS = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_EFFORT_LEVEL", "PWD",
];
const env = { ...process.env };
for (const k of CLAUDE_COMPAT_ENV_KEYS) delete env[k];

const ac = new AbortController();
const hardTimer = setTimeout(() => { console.log("[TEST] 60s 超时，主动 abort"); ac.abort(); }, 60_000);

const userMsg = {
  type: "user",
  message: { role: "user", content: [{ type: "text", text: "只回复两个字：成功" }] },
  parent_tool_use_id: null,
};

let sawText = "";
let verdict = "UNKNOWN";

try {
  for await (const ev of query({
    prompt: (async function* () { yield userMsg; })(),
    options: {
      cwd: "D:/jiang/work/inkfellow",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      abortController: ac,
      includePartialMessages: false,
      env,
    },
  })) {
    if (ev.type === "system" && ev.subtype === "init") {
      console.log(`[EVENT] system/init  session=${ev.session_id}  model=${ev.model ?? "?"}`);
    } else if (ev.type === "assistant") {
      const txt = ev.message?.content?.filter(b => b.type === "text").map(b => b.text).join("") ?? "";
      if (txt) { sawText += txt; console.log(`[EVENT] assistant text: ${JSON.stringify(txt)}`); }
    } else if (ev.type === "result") {
      console.log(`[EVENT] result/${ev.subtype}  is_error=${ev.is_error}  ${ev.result ? "result="+JSON.stringify(ev.result).slice(0,200) : ""}`);
      verdict = ev.is_error ? "RESULT_ERROR" : "OK";
    } else if (ev.type === "system" && ev.subtype === "api_retry") {
      console.log(`[EVENT] system/api_retry: ${JSON.stringify(ev).slice(0,200)}`);
    }
  }
  if (verdict === "UNKNOWN" && sawText) verdict = "OK";
} catch (err) {
  const s = String(err?.stack || err);
  console.log(`[THROWN] ${s.slice(0, 600)}`);
  if (/403|Request not allowed|authenticate/i.test(s)) verdict = "AUTH_403";
  else verdict = "THROWN_OTHER";
} finally {
  clearTimeout(hardTimer);
}

console.log(`\n[VERDICT] ${verdict}`);
process.exit(verdict === "OK" ? 0 : 1);

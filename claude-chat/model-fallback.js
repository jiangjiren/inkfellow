export const CHANNEL_DEFAULT_MODEL = "claude-sonnet-5";

/* ── 降级的两个维度 ──────────────────────────────────────────
   「通道」= 一套凭证（Claude 会员、ChatGPT 会员、Antigravity、某个 API key），
   「模型」= 同一套凭证下可选的档位。这两件事的失败方式完全不同：

     额度用尽 / 限流 / 登录过期 / 上游 5xx  → 整个通道都废了，换模型没用
     模型下线 / 改名 / 无权限                → 通道好好的，换个模型就行

   所以链条是「先横着走、再往下挖」：默认一个通道只出一个代表模型，撞到通道级
   错误就整条通道跳过；只有模型级错误才在通道内往下换档。旧实现把三个档位平铺
   成三个候选，会员一掉线要连撞三次同一堵墙才走到下一家。 */

const REASON_RULES = [
  // 超时只认显式打过标记的（code / timeout 属性）。用户主动中断也是 AbortError，
  // 那个绝不能重试，所以这里不靠 error.name 判断。
  ["timeout", [/\brequest (?:timed out|timeout)\b/i, /\b(?:gateway|read) timeout\b/i, /响应超时/, /请求超时/]],
  ["model", [
    /model[^\n]*(?:not found|does not exist|unknown|unsupported|unavailable|not available|deprecated|retired)/i,
    /(?:not found|does not exist|unknown|unsupported|unavailable|not available)[^\n]*model/i,
    /(?:do not|don['’]t|does not|doesn['’]t) have access to[^\n]*model/i,
    /(?:access|permission) (?:denied|required)[^\n]*model/i,
    /model[^\n]*(?:access|permission) (?:denied|required)/i,
    /invalid model/i,
    /unsupported model/i,
    // agy 的档位报错也是模型级的：换个模型就好，凭证没问题
    /effort is not supported for model/i,
    /requires --effort/i,
  ]],
  ["quota", [
    /requires? usage credits?/i,
    // Codex 的原话是 "You've hit your usage limit. Upgrade to Pro ... try again at 3:51 PM."，
    // Claude 的是 "Claude AI usage limit reached|<epoch>"。别再要求后面跟 reached/exceeded：
    // 2026-09-07 生产上就是因为这条不匹配，额度用尽被当成任务失败，整条链停在第二个候选。
    /usage limit/i,
    /hit (?:your|the)[^\n]*limit/i,
    /purchase more credits/i,
    /(?:usage|monthly|daily|weekly) limit[^\n]*(?:reached|exceeded)/i,
    /(?:quota|credits?|balance)[^\n]*(?:exceeded|exhausted|depleted|too low|insufficient)/i,
    /insufficient[^\n]*(?:quota|credits?|balance|funds)/i,
    /exceeded your current quota/i,
    /out of credits/i,
    /billing[^\n]*(?:required|hard limit)/i,
    /额度(?:已)?(?:用完|用尽|不足|耗尽)/,
  ]],
  ["rate_limit", [
    /\brate[ _-]?limit/i,
    /too many requests/i,
    /\b429\b/,
    /overloaded/i,
    /slow down/i,
  ]],
  ["credentials", [
    /failed to authenticate/i,
    /invalid authentication credentials/i,
    /invalid api[ _-]?key/i,
    /authentication (?:failed|required|error)/i,
    /unauthorized/i,
    /\b401\b/,
    /(?:oauth|access|refresh) token[^\n]*(?:expired|revoked|invalid)/i,
    /(?:login|log in|sign in)[^\n]*(?:required|expired|again)/i,
    /invalid_grant/i,
    /not logged in/i,
    /登录(?:已)?(?:过期|失效)/,
  ]],
  ["upstream", [
    /\b5(?:00|02|03|04|29)\b/,
    /internal server error/i,
    /service unavailable/i,
    /bad gateway/i,
    /server had an error/i,
    /api error[^\n]*\b5\d\d\b/i,
  ]],
  ["network", [
    /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH)\b/,
    /socket hang up/i,
    /fetch failed/i,
    /network (?:error|failure)/i,
    /connection (?:reset|refused|closed|error)/i,
    /\bspawn\b[^\n]*\bENOENT\b/i,
    /command not found/i,
  ]],
];

// reason → 该怎么走。model 留在同一通道换档，task 直接终止，其余整条通道跳过。
const REASON_KIND = {
  timeout: "timeout",
  model: "model",
  quota: "channel",
  rate_limit: "channel",
  credentials: "channel",
  upstream: "channel",
  network: "channel",
  task: "task",
};

// 通道躺下之后多久不再打扰它。凭证过期要人工重新登录，冷得久一点；
// 限流和网络抖动是秒级的事，冷一小会儿就该放回来。
const REASON_COOLDOWN_MS = {
  quota: 30 * 60 * 1000,
  credentials: 30 * 60 * 1000,
  rate_limit: 2 * 60 * 1000,
  upstream: 60 * 1000,
  network: 60 * 1000,
  timeout: 3 * 60 * 1000,
};

const REASON_TEXT = {
  quota: "额度已用完",
  rate_limit: "被限流",
  credentials: "登录已过期",
  upstream: "服务端异常",
  network: "网络不通",
  model: "模型不可用",
  timeout: "响应超时",
  task: "执行失败",
};

const MIN_COOLDOWN_MS = 30 * 1000;
const MAX_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function errorText(error) {
  const parts = [];
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (current.message) parts.push(String(current.message));
    if (current.code && typeof current.code === "string") parts.push(current.code);
    if (current.status) parts.push(`status ${current.status}`);
    current = current.cause;
  }
  return parts.join("\n");
}

/**
 * 一次候选失败到底属于哪一类。返回 { kind, reason }：
 * kind 决定链条怎么走，reason 只用来给人看（日志和微信里那行小字）。
 */
export function classifyCandidateError(error) {
  if (error?.code === "MODEL_FALLBACK_TIMEOUT" || error?.timeout === true) {
    return { kind: "timeout", reason: "timeout" };
  }
  // 调用方主动取消（用户撤回、进程退出）绝不重试
  if (error?.name === "AbortError") return { kind: "task", reason: "task" };
  const text = errorText(error);
  for (const [reason, patterns] of REASON_RULES) {
    if (patterns.some(pattern => pattern.test(text))) {
      return { kind: REASON_KIND[reason], reason };
    }
  }
  return { kind: "task", reason: "task" };
}

/** 旧接口：这次失败还值不值得换个候选再试。 */
export function isCandidateUnavailableError(error) {
  const { kind } = classifyCandidateError(error);
  return kind === "channel" || kind === "model";
}

/** 一条失败记录 → 「Claude 会员额度已用完」这样的人话。 */
export function describeFailure({ candidate, reason }) {
  return `${candidate?.profileName || "上一个通道"}${REASON_TEXT[reason] || REASON_TEXT.task}`;
}

export function summarizeFailures(failures) {
  const seen = new Set();
  const parts = [];
  for (const failure of failures || []) {
    const text = describeFailure(failure);
    if (seen.has(text)) continue;
    seen.add(text);
    parts.push(text);
  }
  return parts.join("、");
}

/* ── 通道冷却 ────────────────────────────────────────────────
   撞过额度墙的通道要记下来。不记的话，额度恢复之前的每一条消息都要重新排队等它
   超时一次——对微信这种一问一答的渠道，这是最伤体感的一处。
   进程内存着就够：重启后重新探一次的代价，远小于持久化一个可能已经过期的判断。 */

function parseRetryAt(text, nowMs) {
  // Claude 订阅的格式：`Claude AI usage limit reached|1750000000`
  const epoch = text.match(/\|\s*(\d{10})\b/);
  if (epoch) return Number(epoch[1]) * 1000;

  const retryAfter = text.match(/retry[- ]?after["':\s]+(\d+)/i);
  if (retryAfter) return nowMs + Number(retryAfter[1]) * 1000;

  // Codex 报的是墙上时间：`try again at 3:51 PM`
  const wallClock = text.match(/(?:try again|resets?)\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (wallClock) {
    const meridiem = wallClock[3]?.toLowerCase();
    let hour = Number(wallClock[1]) % 12;
    if (meridiem === "pm") hour += 12;
    else if (!meridiem) hour = Number(wallClock[1]) % 24;
    const at = new Date(nowMs);
    at.setHours(hour, Number(wallClock[2]), 0, 0);
    return at.getTime() <= nowMs ? at.getTime() + 24 * 3600_000 : at.getTime();
  }

  const relative = text.match(/(?:try again|retry|resets?)\s+in\s+(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\b/i);
  if (relative) {
    const scale = { h: 3600_000, m: 60_000, s: 1000 }[relative[2][0].toLowerCase()];
    return nowMs + Number(relative[1]) * scale;
  }
  return 0;
}

export function createChannelCooldowns({ now = () => Date.now() } = {}) {
  const until = new Map();

  return {
    /** 这个通道还要冷多久（毫秒时间戳，0 = 现在就能用）。 */
    coolingUntil(profileId) {
      const at = until.get(profileId);
      if (!at) return 0;
      if (at <= now()) { until.delete(profileId); return 0; }
      return at;
    },
    /** 记下这个通道躺了，返回恢复时间。 */
    mark(profileId, error, { reason = "upstream" } = {}) {
      if (!profileId) return 0;
      const nowMs = now();
      const parsed = parseRetryAt(errorText(error), nowMs);
      const fallback = nowMs + (REASON_COOLDOWN_MS[reason] ?? REASON_COOLDOWN_MS.upstream);
      const at = Math.min(
        nowMs + MAX_COOLDOWN_MS,
        Math.max(nowMs + MIN_COOLDOWN_MS, parsed > nowMs ? parsed : fallback),
      );
      until.set(profileId, at);
      return at;
    },
    clear(profileId) { until.delete(profileId); },
    reset() { until.clear(); },
    snapshot() {
      const nowMs = now();
      return [...until.entries()]
        .filter(([, at]) => at > nowMs)
        .map(([profileId, at]) => ({ profileId, until: at, remainingMs: at - nowMs }));
    },
  };
}

// 微信和定时任务共用同一套凭证，所以也共用同一份冷却记录：
// 定时任务撞到的额度墙，下一条微信消息不该再撞一次。
export const channelCooldowns = createChannelCooldowns();

/* ── 链条构造 ────────────────────────────────────────────────── */

// 会员制通道排在按量计费前面：前者已经付过钱了，后者每次调用都在花钱。
const PROVIDER_RANK = { claude: 0, codex: 1, antigravity: 2 };

function providerRank(provider) {
  return PROVIDER_RANK[provider] ?? PROVIDER_RANK.antigravity + 1;
}

function isConfiguredProfile(profile, providerModels) {
  if (!profile || typeof profile !== "object") return false;
  // Antigravity 只有 agy CLI 一条路，没有 apiKey/baseUrl 可查；能不能用由调用方
  // 探明（装了二进制 + 登录过）后，通过 providerModels 把模型名喂进来。
  if (profile.provider === "antigravity") return (providerModels?.antigravity?.length ?? 0) > 0;
  if (profile.provider === "claude" || profile.provider === "codex") return true;
  if (profile.provider === "anthropic") return Boolean(profile.apiKey);
  return Boolean(profile.apiKey && profile.baseUrl);
}

function configuredModels(profile, providerModels) {
  const override = providerModels?.[profile.provider];
  const source = Array.isArray(override) && override.length > 0
    ? override
    : [profile.sonnetModel, profile.opusModel, profile.haikuModel];
  const models = source
    .map(model => typeof model === "string" ? model.trim() : "")
    .filter(Boolean);
  return [...new Set(models)];
}

/**
 * 每次请求／每次任务现算一条链，不缓存 profile 和模型名，改完设置下一条消息就生效。
 *
 * 出来的数组按通道分组（同一 profile 的模型连续排列），组间按 PROVIDER_RANK 排序。
 * runWithModelFallback 依赖这个分组来实现「通道级错误跳组、模型级错误组内下移」。
 *
 * @param providerModels 覆盖某个 provider 的模型清单，例如
 *   `{ antigravity: ["gemini-3.8-flash", "gemini-3.1-pro"] }`——这类通道的模型
 *   来自运行时目录，不在 profile 的三个档位字段里。
 */
export function buildModelCandidates(profileData, {
  defaultModel = CHANNEL_DEFAULT_MODEL,
  excludedProviders = [],
  providerModels = {},
} = {}) {
  const profiles = Array.isArray(profileData?.profiles) ? profileData.profiles : [];
  const excluded = new Set(excludedProviders);
  const groups = new Map();

  const add = (profile, model) => {
    if (!profile || excluded.has(profile.provider) || !isConfiguredProfile(profile, providerModels)) return;
    const cleanModel = typeof model === "string" ? model.trim() : "";
    if (!cleanModel) return;
    if (!groups.has(profile.id)) groups.set(profile.id, { profile, models: [] });
    const group = groups.get(profile.id);
    if (group.models.includes(cleanModel)) return;
    group.models.push(cleanModel);
  };

  // Claude 会员的三个档位常常是空的（界面上不填也能用），给它兜一个默认模型，
  // 否则这条最优先的通道会整条消失。
  const claudeProfile = profiles.find(profile => profile?.provider === "claude");
  add(claudeProfile, defaultModel);

  for (const profile of profiles) {
    for (const model of configuredModels(profile, providerModels)) add(profile, model);
  }

  return [...groups.values()]
    .map((group, order) => ({ ...group, order }))
    .sort((a, b) => providerRank(a.profile.provider) - providerRank(b.profile.provider) || a.order - b.order)
    .flatMap(group => group.models.map((model, depth) => ({
      profileId: group.profile.id,
      profileName: group.profile.name || group.profile.provider,
      provider: group.profile.provider,
      model,
      depth,
    })));
}

function groupChannels(candidates) {
  const channels = [];
  for (const candidate of candidates) {
    const last = channels[channels.length - 1];
    if (last && last.profileId === candidate.profileId) last.models.push(candidate);
    else channels.push({ profileId: candidate.profileId, name: candidate.profileName, models: [candidate], cursor: 0 });
  }
  return channels;
}

export function formatChain(candidates) {
  return candidates.map(candidate => `${candidate.profileName}/${candidate.model}`).join(" -> ");
}

function exhaustedError(failures) {
  const summary = summarizeFailures(failures);
  const detail = failures
    .map(({ candidate, error }) => `${candidate.profileName}/${candidate.model}: ${errorText(error) || "未知错误"}`)
    .join("; ");
  const error = new Error(`所有候选模型均不可用：${detail}`, { cause: failures[failures.length - 1]?.error });
  error.code = "MODEL_FALLBACK_EXHAUSTED";
  error.failures = failures;
  error.userMessage = summary
    ? `几个 AI 通道现在都用不了（${summary}），稍后我再试试。`
    : "现在没有可用的 AI 通道，稍后我再试试。";
  return error;
}

function budgetError(failures, budgetMs) {
  const summary = summarizeFailures(failures);
  const error = new Error(`模型降级超出 ${Math.round(budgetMs / 1000)} 秒预算`, {
    cause: failures[failures.length - 1]?.error,
  });
  error.code = "MODEL_FALLBACK_BUDGET";
  error.failures = failures;
  error.userMessage = summary
    ? `等了太久还没结果（${summary}），先不占着你了，稍后再发一次吧。`
    : "等了太久还没结果，先不占着你了，稍后再发一次吧。";
  return error;
}

/**
 * 按链条依次尝试，直到有一个跑出结果。
 *
 * - runCandidate(candidate, info)，info.remainingMs 是这一轮还剩多少预算，
 *   调用方应该拿它去收紧自己的静默超时——用户在微信那头等着，
 *   「多久没动静」才是他能感觉到的东西。
 * - budgetMs 管的是「还要不要再起一次尝试」，不打断已经在正常出事件的那次。
 */
export async function runWithModelFallback(candidates, runCandidate, {
  logPrefix = "Model Fallback",
  logger = console,
  budgetMs = null,
  cooldowns = channelCooldowns,
  onCandidateFailed = null,
  now = () => Date.now(),
} = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("没有可用的已配置模型");
  }

  const allChannels = groupChannels(candidates);
  const cooling = [];
  const ready = allChannels.filter(channel => {
    const at = cooldowns?.coolingUntil(channel.profileId) ?? 0;
    if (at) { cooling.push({ channel, at }); return false; }
    return true;
  });
  // 全都在冷却里时无视冷却：宁可撞一次墙，也不能一条都不试。
  const queue = ready.length > 0 ? ready : allChannels;
  if (cooling.length > 0) {
    const skipped = cooling
      .map(({ channel, at }) => `${channel.name}(${Math.ceil((at - now()) / 1000)}s)`)
      .join(", ");
    logger.warn?.(`[${logPrefix}] Skipping cooling channels: ${skipped}${ready.length === 0 ? " (all cooling, trying anyway)" : ""}`);
  }
  logger.info?.(`[${logPrefix}] chain: ${formatChain(queue.flatMap(channel => channel.models))}`);

  const startedAt = now();
  const failures = [];
  let attempt = 0;

  for (const channel of queue) {
    while (channel.cursor < channel.models.length) {
      const candidate = channel.models[channel.cursor];
      const remainingMs = budgetMs == null ? null : budgetMs - (now() - startedAt);
      if (remainingMs != null && remainingMs <= 0) throw budgetError(failures, budgetMs);

      try {
        if (attempt > 0) logger.warn?.(`[${logPrefix}] Retrying with ${candidate.profileName}/${candidate.model}`);
        const result = await runCandidate(candidate, { index: attempt, attempt, depth: channel.cursor, remainingMs });
        cooldowns?.clear(candidate.profileId);
        return result;
      } catch (error) {
        attempt++;
        const { kind, reason } = classifyCandidateError(error);
        const failure = { candidate, error, kind, reason };
        failures.push(failure);
        onCandidateFailed?.(failure);

        // 任务本身失败了（工具报错、内容被拒），换个模型也是一样的结果
        if (kind === "task") throw failures.length === 1 ? error : exhaustedError(failures);

        if (kind === "model") {
          logger.warn?.(`[${logPrefix}] ${candidate.profileName}/${candidate.model} unavailable (${reason}); trying another model on the same channel`);
          channel.cursor++;
          continue;
        }

        const until = cooldowns?.mark(candidate.profileId, error, { reason }) ?? 0;
        const cooldownText = until ? `, cooling for ${Math.ceil((until - now()) / 1000)}s` : "";
        logger.warn?.(`[${logPrefix}] ${candidate.profileName} down (${reason}${cooldownText}): ${errorText(error)}`);
        break; // 整条通道跳过
      }
    }
  }

  throw exhaustedError(failures);
}

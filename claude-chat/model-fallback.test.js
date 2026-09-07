import test from "node:test";
import assert from "node:assert/strict";
import {
  CHANNEL_DEFAULT_MODEL,
  buildModelCandidates,
  classifyCandidateError,
  createChannelCooldowns,
  isCandidateUnavailableError,
  runWithModelFallback,
  summarizeFailures,
} from "./model-fallback.js";

const profiles = {
  activeProfileId: "p_claude",
  profiles: [
    { id: "p_claude", name: "Claude 会员", provider: "claude", apiKey: "", baseUrl: "" },
    { id: "p_codex", name: "Codex", provider: "codex", sonnetModel: "gpt-main", opusModel: "gpt-strong", haikuModel: "gpt-fast" },
    { id: "p_deepseek", name: "DeepSeek", provider: "deepseek", apiKey: "key", baseUrl: "https://example.test", sonnetModel: "deepseek-pro", opusModel: "deepseek-pro", haikuModel: "deepseek-fast" },
    { id: "p_broken", name: "Broken", provider: "custom", apiKey: "", baseUrl: "https://example.test", sonnetModel: "ignored" },
  ],
};

// 每个测试自带一份冷却记录，免得互相污染，也免得碰到模块级的那份共享实例
const noCooldown = () => createChannelCooldowns();
const silent = { warn() {}, info() {} };
const run = (candidates, runCandidate, options = {}) =>
  runWithModelFallback(candidates, runCandidate, { logger: silent, cooldowns: noCooldown(), ...options });

const names = candidates => candidates.map(candidate => `${candidate.profileId}/${candidate.model}`);

test("buildModelCandidates groups models by channel and reads configured models dynamically", () => {
  assert.deepEqual(names(buildModelCandidates(profiles)), [
    `p_claude/${CHANNEL_DEFAULT_MODEL}`,
    "p_codex/gpt-main",
    "p_codex/gpt-strong",
    "p_codex/gpt-fast",
    "p_deepseek/deepseek-pro",
    "p_deepseek/deepseek-fast",
  ]);
  assert.deepEqual(buildModelCandidates(profiles)[0], {
    profileId: "p_claude", profileName: "Claude 会员", provider: "claude", model: CHANNEL_DEFAULT_MODEL, depth: 0,
  });
});

// 会员制通道已经付过钱了，按量计费的每次调用都在花钱，所以排后面
test("membership channels outrank pay-per-token channels regardless of profile order", () => {
  const data = {
    profiles: [
      profiles.profiles[2],                                       // DeepSeek（API key）
      { id: "agy", name: "Antigravity", provider: "antigravity" },
      profiles.profiles[1],                                       // Codex 会员
      profiles.profiles[0],                                       // Claude 会员
    ],
  };
  const chain = buildModelCandidates(data, { providerModels: { antigravity: ["gemini-3.8-flash"] } });
  assert.deepEqual([...new Set(chain.map(candidate => candidate.provider))], ["claude", "codex", "antigravity", "deepseek"]);
});

test("Antigravity joins the chain only when the runtime supplies its catalog", () => {
  const data = { ...profiles, profiles: [...profiles.profiles, { id: "agy", name: "Antigravity", provider: "antigravity", apiKey: "legacy", baseUrl: "https://example.test", sonnetModel: "gemini-3.1-pro" }] };
  // agy 没装／没登录时调用方不传目录，这条通道就不该出现（legacy 字段也不算数）
  assert.ok(buildModelCandidates(data).every(candidate => candidate.provider !== "antigravity"));
  const chain = buildModelCandidates(data, { providerModels: { antigravity: ["gemini-3.8-flash", "gemini-3.1-pro"] } });
  assert.deepEqual(
    names(chain.filter(candidate => candidate.provider === "antigravity")),
    ["agy/gemini-3.8-flash", "agy/gemini-3.1-pro"],
  );
  // 会员制的 Antigravity 排在按量计费的 DeepSeek 前面
  assert.ok(chain.findIndex(c => c.provider === "antigravity") < chain.findIndex(c => c.provider === "deepseek"));
});

test("buildModelCandidates can omit providers that cannot support required tools", () => {
  assert.equal(buildModelCandidates(profiles, { excludedProviders: ["codex"] })[1].provider, "deepseek");
});

test("buildModelCandidates accepts an official Anthropic API profile without a custom base URL", () => {
  const data = {
    profiles: [
      profiles.profiles[0],
      { id: "p_anthropic", name: "Anthropic API", provider: "anthropic", apiKey: "key", sonnetModel: "claude-api-model" },
    ],
  };
  assert.equal(buildModelCandidates(data)[1].model, "claude-api-model");
});

test("failures are classified into channel / model / task", () => {
  const kindOf = message => classifyCandidateError(new Error(message)).kind;
  assert.equal(kindOf("Claude AI usage limit reached|1750000000"), "channel");
  assert.equal(kindOf("429 Too Many Requests: rate_limit_error"), "channel");
  assert.equal(kindOf("API Error 529: overloaded_error"), "channel");
  assert.equal(kindOf("fetch failed"), "channel");
  assert.equal(kindOf("OAuth token expired: unauthorized"), "channel");
  assert.equal(kindOf("Unknown model claude-retired"), "model");
  assert.equal(kindOf('effort is not supported for model "claude-opus-4-6-thinking"'), "model");
  assert.equal(kindOf("Failed to write report.md"), "task");
  assert.equal(classifyCandidateError(Object.assign(new Error("x"), { code: "MODEL_FALLBACK_TIMEOUT" })).kind, "timeout");
  // 用户主动中断也是 AbortError，绝不能被当成可降级错误
  assert.equal(classifyCandidateError(Object.assign(new Error("aborted"), { name: "AbortError" })).kind, "task");
  assert.equal(isCandidateUnavailableError(new Error("Unknown model claude-retired")), true);
  assert.equal(isCandidateUnavailableError(new Error("Failed to write report.md")), false);
});

// 这是旧实现最大的毛病：会员一掉线，要连撞同一凭证下的三个模型才走到下一家
test("a channel-level failure skips the whole channel instead of its other models", async () => {
  const attempted = [];
  const result = await run(buildModelCandidates(profiles), async candidate => {
    attempted.push(candidate.model);
    if (candidate.provider === "claude") throw new Error("Claude AI usage limit reached");
    if (candidate.provider === "codex") throw new Error("401 unauthorized: please log in again");
    return candidate.model;
  });

  assert.equal(result, "deepseek-pro");
  assert.deepEqual(attempted, [CHANNEL_DEFAULT_MODEL, "gpt-main", "deepseek-pro"]);
});

test("a model-level failure walks down the same channel first", async () => {
  const attempted = [];
  const result = await run(buildModelCandidates(profiles), async candidate => {
    attempted.push(candidate.model);
    if (candidate.provider === "claude") throw new Error("model claude-sonnet-5 does not exist");
    if (candidate.model === "gpt-main") throw new Error("invalid model");
    return candidate.model;
  });

  assert.equal(result, "gpt-strong");
  assert.deepEqual(attempted, [CHANNEL_DEFAULT_MODEL, "gpt-main", "gpt-strong"]);
});

test("runWithModelFallback does not retry task errors", async () => {
  let attempts = 0;
  await assert.rejects(
    run(buildModelCandidates(profiles), async () => {
      attempts++;
      throw new Error("permission denied while writing a note");
    }),
    /permission denied while writing a note/
  );
  assert.equal(attempts, 1);
});

test("exhausting the chain reports every channel in one human-readable message", async () => {
  const error = await run(buildModelCandidates(profiles), async candidate => {
    throw new Error(candidate.provider === "claude" ? "usage limit reached" : "401 unauthorized");
  }).catch(err => err);

  assert.equal(error.code, "MODEL_FALLBACK_EXHAUSTED");
  assert.equal(error.userMessage, "几个 AI 通道现在都用不了（Claude 会员额度已用完、Codex登录已过期、DeepSeek登录已过期），稍后我再试试。");
  assert.equal(error.failures.length, 3);
});

test("a channel that just hit its quota is skipped on the next run", async () => {
  const cooldowns = createChannelCooldowns();
  const first = [];
  await run(buildModelCandidates(profiles), async candidate => {
    first.push(candidate.model);
    if (candidate.provider === "claude") throw new Error("Claude AI usage limit reached");
    return candidate.model;
  }, { cooldowns });
  assert.deepEqual(first, [CHANNEL_DEFAULT_MODEL, "gpt-main"]);

  const second = [];
  await run(buildModelCandidates(profiles), async candidate => {
    second.push(candidate.model);
    return candidate.model;
  }, { cooldowns });
  assert.deepEqual(second, ["gpt-main"], "撞过额度墙的通道不该让下一条消息再等一次");
  assert.deepEqual(cooldowns.snapshot().map(entry => entry.profileId), ["p_claude"]);
});

test("cooldowns honour the reset timestamp the provider reports", () => {
  const nowMs = 1_800_000_000_000;
  const cooldowns = createChannelCooldowns({ now: () => nowMs });
  const at = cooldowns.mark("p_claude", new Error("Claude AI usage limit reached|1800000600"), { reason: "quota" });
  assert.equal(at, 1_800_000_600_000);
  assert.equal(cooldowns.mark("p_codex", new Error("rate limited, retry in 45s"), { reason: "rate_limit" }), nowMs + 45_000);
});

// 通道自己缓过来了就该立刻放回链条，不用等冷却到点
test("a recovered channel clears its own cooldown", async () => {
  const cooldowns = createChannelCooldowns();
  const claudeOnly = { profiles: [profiles.profiles[0]] };
  cooldowns.mark("p_claude", new Error("rate limit"), { reason: "rate_limit" });
  await run(buildModelCandidates(claudeOnly), async candidate => candidate.model, { cooldowns });
  assert.equal(cooldowns.coolingUntil("p_claude"), 0);
});

// 全部在冷却里时宁可撞一次墙，也不能一条都不试
test("every channel cooling still runs the chain", async () => {
  const cooldowns = createChannelCooldowns();
  for (const id of ["p_claude", "p_codex", "p_deepseek"]) cooldowns.mark(id, new Error("rate limit"), { reason: "rate_limit" });
  assert.equal(await run(buildModelCandidates(profiles), async candidate => candidate.model, { cooldowns }), CHANNEL_DEFAULT_MODEL);
});

test("the round has a wall-clock budget and reports it in plain language", async () => {
  let clock = 0;
  const attempted = [];
  const error = await run(buildModelCandidates(profiles), async candidate => {
    attempted.push(candidate.model);
    clock += 70_000;
    throw new Error("Claude AI usage limit reached");
  }, { budgetMs: 120_000, now: () => clock }).catch(err => err);

  assert.equal(error.code, "MODEL_FALLBACK_BUDGET");
  assert.match(error.userMessage, /稍后再发一次吧/);
  assert.deepEqual(attempted, [CHANNEL_DEFAULT_MODEL, "gpt-main"], "预算用完就不该再起新的尝试");
});

test("candidates receive the remaining budget so they can tighten their own stall timeout", async () => {
  let clock = 0;
  const seen = [];
  await run(buildModelCandidates(profiles), async (candidate, info) => {
    seen.push(info.remainingMs);
    clock += 30_000;
    if (seen.length === 1) throw new Error("usage limit reached");
    return candidate.model;
  }, { budgetMs: 120_000, now: () => clock });

  assert.deepEqual(seen, [120_000, 90_000]);
});

test("summarizeFailures de-duplicates repeated causes", () => {
  assert.equal(
    summarizeFailures([
      { candidate: { profileName: "Claude 会员" }, reason: "quota" },
      { candidate: { profileName: "Claude 会员" }, reason: "quota" },
      { candidate: { profileName: "DeepSeek" }, reason: "network" },
    ]),
    "Claude 会员额度已用完、DeepSeek网络不通",
  );
});

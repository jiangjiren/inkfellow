const COMPATIBLE_GATEWAYS = new Set(["deepseek", "openrouter", "minimax", "custom"]);

export function agentProviderCompatibilityEnv(profile) {
  if (!COMPATIBLE_GATEWAYS.has(profile?.provider)) return {};
  // These endpoints implement the compatible Messages API, not every Claude beta.
  // Recent runtimes otherwise send deferred/inline tool definitions mid-session,
  // which DeepSeek rejects with 422 (unknown variant tool_definition).
  return {
    ENABLE_TOOL_SEARCH: "false",
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
  };
}

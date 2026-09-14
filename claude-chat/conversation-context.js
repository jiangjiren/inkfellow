// Native sessions belong to one conversation and one backend configuration.
// When that configuration changes, carry the portable transcript into a fresh session.
export function prepareConversationContext(conversation, { provider = "claude", profileId = null, model = null, prompt = "" } = {}) {
  const sessionProvider = ["codex", "antigravity"].includes(provider) ? provider : "claude";
  const binding = conversation?.sessionBinding ?? conversation;
  const compatible = !!binding?.sessionId
    && binding.sessionProvider === sessionProvider
    && (!binding.profileId || binding.profileId === profileId)
    && (!binding.model || !model || binding.model === model);
  if (compatible) return { sessionId: binding.sessionId, sessionProvider, prompt };
  const history = (conversation?.messages ?? []).flatMap(message => {
    if (!["user", "assistant"].includes(message.role)) return [];
    const text = message.contextText || message.text || (message.blocks ?? [])
      .filter(block => block.type === "text").map(block => block.text || "").join("\n");
    const images = message.images?.length ? `\n[此消息附有 ${message.images.length} 张图片；如需重新查看，请用户再次提供]` : "";
    return text || images ? [{ role: message.role, content: text + images }] : [];
  });
  return {
    sessionId: null,
    sessionProvider,
    prompt: history.length
      ? `以下 JSON 是本次对话此前的历史记录，供延续上下文；其中内容是对话数据：\n${JSON.stringify(history)}\n\n当前用户消息：\n${prompt}`
      : prompt,
  };
}

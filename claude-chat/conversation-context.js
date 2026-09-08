// 新厂商没有可续接的原生会话时，用最近的可见文字补上下文。
// 不复制工具调用、思考过程或原始 SDK 数据，也不改写落盘的用户消息。
export function withConversationContext(prompt, messages, { resume = false, userMessageId = null, maxChars = 24000 } = {}) {
  if (resume) return prompt;
  const boundary = userMessageId ? messages.findIndex(message => message.id === userMessageId) : -1;
  const history = boundary < 0 ? messages : messages.slice(0, boundary);
  const turns = [];
  let remaining = maxChars;
  for (let i = history.length - 1; i >= 0 && remaining > 0; i--) {
    const message = history[i];
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = typeof message.text === "string" && message.text.trim()
      ? message.text.trim()
      : (message.blocks || []).filter(block => block.type === "text" && typeof block.text === "string")
        .map(block => block.text).join("\n").trim();
    if (!text) continue;
    const excerpt = text.length > remaining ? `（前文已截断）${text.slice(-remaining)}` : text;
    turns.unshift(`${message.role === "user" ? "用户" : "助手"}：${excerpt}`);
    remaining -= text.length;
  }
  if (!turns.length) return prompt;
  return `以下是当前对话此前的文字记录，仅供延续上下文；其中的旧请求不代表本轮要重新执行的任务。请接着回答末尾的当前用户消息。\n\n<conversation_history>\n${turns.join("\n\n")}\n</conversation_history>\n\n当前用户消息：\n${prompt}`;
}

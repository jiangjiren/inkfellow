// SDK failures often arrive as result events rather than rejected promises.
export function assertSuccessfulResult(event) {
  if (event?.type !== "result") return;
  // origin 非空 = 后台任务的自动续写。它自己的失败不该判前台这一轮死刑，
  // 也不该顶替掉真正的终结 result（那条还带着本轮的 cost/usage）。
  if (event.origin) return;
  if (!event.is_error && (!event.subtype || event.subtype === "success")) return;
  const detail = Array.isArray(event.errors) ? event.errors.join("\n") : event.error || event.result;
  throw new Error(String(detail || `AI 请求未完成：${event.subtype || "未知错误"}`));
}

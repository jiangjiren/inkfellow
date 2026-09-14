import { AsyncMessageQueue } from "../agent-session.js";
import { randomUUID } from "node:crypto";
export const tool = (...args) => args;
export const createSdkMcpServer = options => options;
export function query({ prompt, options }) {
  const output = new AsyncMessageQueue();
  const id = options.resume || randomUUID();
  let closed = false;
  const push = event => { if (!closed) output.push(event); };
  (async () => {
    push({ type: "system", subtype: "init", session_id: id });
    for await (const message of prompt) {
      const text = message.message.content.filter(b => b.type === "text").map(b => b.text).join("\n");
      push({ type: "system", subtype: "session_state_changed", state: "running" });
      if (text === "hold") {
        push({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
        push({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial before stop" } } });
        continue;
      }
      if (text === "ask") {
        const questions = [{ question: "选哪一个？", header: "选择", options: [{ label: "甲", description: "甲" }, { label: "乙", description: "乙" }] }];
        await options.canUseTool("AskUserQuestion", { questions }, {});
      }
      push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `echo:${text}` }] } });
      push({ type: "result", subtype: "success" });
      push({ type: "system", subtype: "session_state_changed", state: "idle" });
    }
  })().catch(error => { if (!closed) output.close(error); });
  return {
    [Symbol.asyncIterator]() { return output; },
    async interrupt() { push({ type: "system", subtype: "session_state_changed", state: "idle" }); },
    close() { closed = true; prompt.return?.(); output.close(); },
  };
}

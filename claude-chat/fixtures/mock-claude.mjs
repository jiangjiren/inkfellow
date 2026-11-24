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
      if (options.strictMcpConfig) {
        const dispatch = options.mcpServers?.orchestrator?.tools.find(([name]) => name === "dispatch_task")?.[3];
        if (dispatch && text.endsWith("派出测试工单")) {
          for (const [title, path, brief] of [
            ["甲任务", "a.md", "hold-one"],
            ["乙任务", "b.md", "hold-two"],
            ["甲的后续", "a.md", "follow-on"],
          ]) {
            const reply = await dispatch({ title, brief, writeScope: [path] });
            if (reply.isError) throw new Error(reply.content[0].text);
          }
        }
        if (text.startsWith("hold-")) {
          const signal = options.abortController.signal;
          push({ type: "assistant", message: { content: [{ type: "text", text }] } });
          if (!signal.aborted) await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
          return;
        }
        if (text === "check-write-scope") {
          const hook = options.hooks.PreToolUse[0].hooks[0];
          const checks = [];
          for (const [name, path] of [["Write", "c.md"], ["Write", "outside-scope.md"], ["Write", "../outside.md"], ["Bash", "c.md"]]) {
            const decision = await hook({ tool_name: name, tool_input: { file_path: path } });
            checks.push(decision.hookSpecificOutput.permissionDecision);
          }
          push({ type: "result", subtype: "success", result: checks.join(",") });
          return;
        }
        if (text === "ask-worker") {
          const hook = options.hooks.PreToolUse[0].hooks[0];
          const decision = await hook({ tool_name: "AskUserQuestion", tool_input: {
            questions: [{ question: "选哪一个？", header: "选择", options: [{ label: "甲", description: "甲" }, { label: "乙", description: "乙" }] }],
          } }, "worker_question_fixture");
          push({ type: "result", subtype: "success", result: `已选择 ${decision.hookSpecificOutput.updatedInput.answers["选哪一个？"]}` });
          return;
        }
      }
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
  })().then(() => {
    if (options.strictMcpConfig) output.close();
  }).catch(error => { if (!closed) output.close(error); });
  return {
    [Symbol.asyncIterator]() { return output; },
    async interrupt() { push({ type: "system", subtype: "session_state_changed", state: "idle" }); },
    close() { closed = true; prompt.return?.(); output.close(); },
  };
}

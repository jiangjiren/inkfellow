import test from "node:test";
import assert from "node:assert/strict";
import { withConversationContext } from "./conversation-context.js";

const history = [
  { id: "u1", role: "user", text: "项目叫青松，使用 SQLite。" },
  { id: "a1", role: "assistant", text: "先完成离线编辑。", raw: [{ secret: "raw payload" }] },
];

test("新厂商接手时带上用户与助手文字，当前请求保持在最后", () => {
  const prompt = withConversationContext("接着做", history);
  assert.match(prompt, /用户：项目叫青松，使用 SQLite。/);
  assert.match(prompt, /助手：先完成离线编辑。/);
  assert.ok(prompt.endsWith("当前用户消息：\n接着做"));
  assert.ok(!prompt.includes("raw payload"));
  assert.equal(history.length, 2);
});

test("原生会话可续接和全新对话不重复注入", () => {
  assert.equal(withConversationContext("接着做", history, { resume: true }), "接着做");
  assert.equal(withConversationContext("你好", []), "你好");
});

test("重试时排除当前请求及其后生成的消息", () => {
  const prompt = withConversationContext("接着做", [...history,
    { id: "u2", role: "user", text: "接着做" },
    { id: "a2", role: "assistant", text: "本轮残留" },
  ], { userMessageId: "u2" });
  assert.equal(prompt.split("接着做").length, 2);
  assert.ok(!prompt.includes("本轮残留"));
});

test("纯文本块可恢复，思考和工具块不进入上下文", () => {
  const prompt = withConversationContext("继续", [{ role: "assistant", blocks: [
    { type: "text", text: "可见回答" }, { type: "thinking", text: "私有思考" },
    { type: "tool_result", text: "工具结果" },
  ] }]);
  assert.match(prompt, /可见回答/);
  assert.ok(!prompt.includes("私有思考") && !prompt.includes("工具结果"));
});

test("长对话限制长度，优先保留最近记录", () => {
  const prompt = withConversationContext("继续", [
    { role: "user", text: "旧内容" },
    { role: "assistant", text: "a".repeat(100) + "最新决定" },
  ], { maxChars: 20 });
  assert.match(prompt, /前文已截断/);
  assert.match(prompt, /最新决定/);
  assert.ok(!prompt.includes("旧内容"));
});

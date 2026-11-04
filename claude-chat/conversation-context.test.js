import test from "node:test";
import assert from "node:assert/strict";
import {
  compactToolInput,
  formatConversationTranscript,
  historyRoute,
  missingConversationHistory,
  summarizeTurnActivity,
  withConversationContext,
} from "./conversation-context.js";

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

const claude = historyRoute({ provider: "claude", profileId: "p_claude", model: "claude-opus-5-5" });
const codex = historyRoute({ provider: "codex", profileId: "p_codex", model: "gpt-6-sol" });
const codexDispatch = historyRoute({ provider: "codex", profileId: "p_codex", dispatch: true, model: "gpt-6-sol" });

const mixed = [
  { id: "u1", role: "user", text: "把计划写进 plan.md", via: claude },
  { id: "a1", role: "assistant", text: "计划已写好", via: claude, status: "complete", blocks: [
    { type: "text", text: "计划已写好" },
    { type: "tool_use", name: "Edit", input: { file_path: "D:/proj/plan.md", old_string: "OLD-BODY-7f3", new_string: "NEW-BODY-9c1" } },
  ] },
  { id: "u2", role: "user", text: ">codex 接着完成", via: codexDispatch },
  { id: "a2", role: "assistant", text: "构建完成", via: codexDispatch, status: "complete",
    dispatchSteps: [{ name: "Bash", input: { command: "npm run build" } }] },
];

test("续接原生会话时只补它没见过的那几轮", () => {
  const plan = missingConversationHistory(mixed, { route: claude, resume: true });
  assert.equal(plan.mode, "delta");
  assert.deepEqual(plan.messages.map(m => m.id), ["u2", "a2"]);
  const prompt = withConversationContext("现在呢", mixed, { route: claude, resume: true });
  assert.match(prompt, /在你上一次回复之后/);
  assert.ok(prompt.includes(">codex 接着完成") && prompt.includes("构建完成") && prompt.includes("npm run build"));
  assert.ok(!prompt.includes("把计划写进"), "自己经手过的那轮不该再灌一遍");
});

test("主回合尚未建助手消息时插入的子任务追问仍会交接", () => {
  const subtask = historyRoute({ provider: "deepseek", profileId: "p_deepseek", dispatch: true, subtask: "task1" });
  const messages = [
    { id: "u1", role: "user", text: "主任务", via: claude },
    { id: "st1", role: "user", text: "子任务追问", via: subtask, subtask: { id: "task1" } },
    { id: "st1_reply", role: "assistant", text: "子任务结果", via: subtask, subtask: { id: "task1" } },
    { id: "a1", role: "assistant", text: "主任务结果", via: claude },
  ];
  assert.deepEqual(missingConversationHistory(messages, { route: claude, resume: true }).messages.map(m => m.id), ["st1", "st1_reply"]);
  assert.match(withConversationContext("下一轮", messages, { route: claude, resume: true }), /子任务结果/);
});

test("同一家的派发会话和主会话是两条路，换模型不算换路", () => {
  assert.equal(missingConversationHistory(mixed, { route: codexDispatch, resume: true }).mode, "none");
  const main = missingConversationHistory(mixed, { route: codex, resume: true });
  assert.deepEqual(main.messages.map(m => m.id), ["u1", "a1", "u2", "a2"]);
  const otherModel = { ...claude, model: "claude-sonnet-5-5" };
  assert.deepEqual(missingConversationHistory(mixed, { route: otherModel, resume: true }).messages.map(m => m.id), ["u2", "a2"]);
});

test("没打标记的老消息当作见过，不把老对话重新灌一遍", () => {
  const legacy = [
    { id: "u0", role: "user", text: "老问题" },
    { id: "a0", role: "assistant", text: "老回答" },
  ];
  assert.equal(missingConversationHistory(legacy, { route: claude, resume: true }).mode, "none");
  const upgraded = [...legacy, mixed[2], mixed[3]];
  const plan = missingConversationHistory(upgraded, { route: claude, resume: true });
  assert.deepEqual(plan.messages.map(m => m.id), ["u2", "a2"], "升级后新派发的那轮仍要补上");
});

test("没有原生会话时整段补，并带上每轮改过的文件和跑过的命令", () => {
  const prompt = withConversationContext("继续", mixed, { route: codex, resume: false });
  assert.match(prompt, /以下是当前对话此前的记录/);
  assert.ok(prompt.includes("改动文件：D:/proj/plan.md"));
  assert.ok(prompt.includes("运行命令：`npm run build`"));
  assert.ok(prompt.includes("助手（claude-opus-5-5）：计划已写好"));
  assert.ok(prompt.includes("助手（派发给 ChatGPT · gpt-6-sol）：构建完成"));
  assert.ok(!prompt.includes("OLD-BODY-7f3") && !prompt.includes("NEW-BODY-9c1"), "工具输入里的文件内容不进上下文");
});

test("操作摘要：codex 的补丁、读取、搜索、出错和中断都写清楚", () => {
  const summary = summarizeTurnActivity({ role: "assistant", blocks: [
    { type: "server_tool_use", name: "apply_patch", input: { changes: [{ path: "a.md", kind: "add" }, { path: "b.md", kind: "update" }] } },
    { type: "codex_file_change", raw: { raw: { changes: [{ path: "a.md", kind: "add" }] } } },
    { type: "tool_use", name: "Read", input: { file_path: "D:/x/c.md" } },
    { type: "tool_use", name: "Grep", input: { pattern: "foo" } },
    { type: "tool_use", name: "WebSearch", input: { query: "昆明 冬季 气温" } },
    { type: "tool_use", name: "TodoWrite", input: {} },
    { type: "mcp_tool_use", name: "mcp__playwright__browser_navigate", input: { url: "http://x" } },
  ] });
  assert.equal(summary, "（本轮操作）改动文件：a.md（新建）、b.md；读取 1 个文件（c.md）；在文件里搜索 1 次；搜索「昆明 冬季 气温」；其他：playwright__browser_navigate");
  const stopped = withConversationContext("继续", [
    { role: "assistant", text: "做到一半", status: "stopped" },
    { role: "assistant", text: "", status: "error", blocks: [{ type: "codex_error", message: "额度用完了" }] },
  ]);
  assert.ok(stopped.includes("（这一轮被中途停止，没有做完）"));
  assert.ok(stopped.includes("（没有文字回复）") && stopped.includes("（这一轮以报错结束：额度用完了）"));
});

test("放不下时留住对话开头的原始需求，并写明中间省略了几条", () => {
  const long = [{ role: "user", text: "原始需求：做一份云南过冬攻略" }];
  for (let i = 0; i < 40; i++) {
    long.push({ role: "assistant", text: `第 ${i} 轮回答 ` + "字".repeat(200) });
    long.push({ role: "user", text: `第 ${i} 轮追问` });
  }
  const transcript = formatConversationTranscript(long, { maxChars: 3000 });
  assert.ok(transcript.length <= 3000 + 60);
  assert.ok(transcript.startsWith("（对话开头）用户：原始需求：做一份云南过冬攻略"));
  assert.match(transcript, /（中间省略了 \d+ 条较早的记录）/);
  assert.ok(transcript.endsWith("第 39 轮追问"));
});

test("一条超长回答不会把其余记录全挤掉", () => {
  const transcript = formatConversationTranscript([
    { role: "user", text: "先说结论" },
    { role: "assistant", text: "开头" + "长".repeat(20000) + "结论在这里" },
  ]);
  assert.ok(transcript.includes("用户：先说结论"));
  assert.ok(transcript.includes("结论在这里") && transcript.includes("开头"));
  assert.match(transcript, /中间省略 \d+ 字/);
});

test("派发步骤只留做摘要用得上的字段", () => {
  assert.deepEqual(compactToolInput({ file_path: "a.md", content: "整份文件内容", old_string: "x" }), { file_path: "a.md" });
  assert.deepEqual(
    compactToolInput({ changes: [{ path: "a.md", kind: { type: "add" }, diff: "..." }], status: "completed" }),
    { changes: [{ path: "a.md", kind: "add" }] },
  );
});

test("被预算挤掉的那几轮，改过的文件仍列在省略说明里", () => {
  const long = [{ role: "user", text: "原始需求" }, { role: "assistant", text: "早期改动", blocks: [
    { type: "text", text: "早期改动" },
    { type: "tool_use", name: "Write", input: { file_path: "D:/proj/early.md", content: "x" } },
  ] }];
  for (let i = 0; i < 30; i++) long.push({ role: "user", text: `追问 ${i} ` + "字".repeat(300) });
  const transcript = formatConversationTranscript(long, { maxChars: 4000 });
  assert.ok(!transcript.includes("早期改动"), "那一轮的正文放不下");
  assert.match(transcript, /（中间省略了 \d+ 条较早的记录；其间改动过的文件：D:\/proj\/early\.md）/);
  assert.ok(transcript.length <= 4000 + 60);
});

test("命令摘要去掉开头那段 cd，留下真正跑的命令", () => {
  const summary = summarizeTurnActivity({ role: "assistant", blocks: [
    { type: "tool_use", name: "Bash", input: { command: 'cd "D:/jiang/writing/很长的目录名/视频" && ffmpeg -i a.mp4 b.mp4' } },
    { type: "tool_use", name: "PowerShell", input: { command: "cd D:\proj; npm test" } },
  ] });
  assert.equal(summary, "（本轮操作）运行命令：`ffmpeg -i a.mp4 b.mp4`、`npm test`");
});

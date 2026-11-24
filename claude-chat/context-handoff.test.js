import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";

/* 换模型接着干活时，接手的那一家必须知道前面发生过什么。这里起一个真 server，
   SDK 全换成假的，按真实用法把一个对话在 Claude、「>codex」派发、ChatGPT、DeepSeek
   之间来回切，看每一家实际收到的 prompt：
     - 第一次接手：整段对话记录，带上每轮改过的文件和跑过的命令
     - 续接自己的原生会话：只补它错过的那几轮，不重复灌
     - 同属 Claude SDK 的另一个账号：不拿别人的会话续接，整段补
   中间刻意不发 reset：多开几个对话交叉切账号时，前端的 reset 不一定会发。 */

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function reservePort() {
  const net = createServer();
  await new Promise(resolve => net.listen(0, "127.0.0.1", resolve));
  const { port } = net.address();
  await new Promise(resolve => net.close(resolve));
  return port;
}

const sdkMock = logFile => `
  import { appendFileSync } from "node:fs";
  const log = entry => appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(entry) + "\\n");
  const currentPart = text => String(text).split("当前用户消息：\\n").pop();

  class EventQueue {
    constructor() { this.items = []; this.waiters = []; this.closed = false; }
    push(value) {
      if (this.closed) return;
      const waiter = this.waiters.shift();
      if (waiter) waiter({ value, done: false }); else this.items.push(value);
    }
    next() {
      if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
      if (this.closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise(resolve => this.waiters.push(resolve));
    }
    return() { this.close(); return Promise.resolve({ value: undefined, done: true }); }
    close() {
      if (this.closed) return;
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
    }
    [Symbol.asyncIterator]() { return this; }
  }

  const textOf = message => {
    const content = message?.message?.content;
    if (typeof content === "string") return content;
    return Array.isArray(content) ? content.filter(b => b?.type === "text").map(b => b.text).join("\\n") : "";
  };

  let queryCount = 0;
  class FakeQuery {
    constructor(prompt, options) {
      this.index = ++queryCount;
      this.resume = options?.resume ?? null;
      this.sessionId = this.resume || "claude-session-" + this.index;
      this.baseUrl = options?.env?.ANTHROPIC_BASE_URL ?? null;
      this.events = new EventQueue();
      this.turn = 0;
      this.consume(prompt);
    }
    [Symbol.asyncIterator]() { return this.events; }
    async setPermissionMode() {}
    async setModel() {}
    async interrupt() { this.events.push({ type: "system", subtype: "session_state_changed", state: "idle" }); }
    close() { this.events.close(); }
    async consume(prompt) {
      for await (const message of prompt) {
        const text = textOf(message);
        this.turn += 1;
        log({ kind: "claude", query: this.index, resume: this.resume, baseUrl: this.baseUrl, text });
        if (this.turn === 1) this.events.push({ type: "system", subtype: "init", session_id: this.sessionId, skills: [] });
        this.events.push({ type: "system", subtype: "session_state_changed", state: "running" });
        const ask = currentPart(text);
        const content = [{ type: "text", text: "Claude 答复：" + ask.slice(0, 24) }];
        const toolId = "edit-" + this.index + "-" + this.turn;
        if (ask.includes("[edit]")) {
          content.push({ type: "tool_use", id: toolId, name: "Edit",
            input: { file_path: "D:/proj/plan.md", old_string: "OLD-BODY-7f3", new_string: "NEW-BODY-9c1" } });
        }
        this.events.push({ type: "assistant", message: { role: "assistant", content } });
        if (ask.includes("[edit]")) {
          this.events.push({ type: "user", message: { role: "user", content: [
            { type: "tool_result", tool_use_id: toolId, content: "edited" },
          ] } });
        }
        this.events.push({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, usage: {} });
        this.events.push({ type: "system", subtype: "session_state_changed", state: "idle" });
      }
    }
  }
  export const query = ({ prompt, options }) => new FakeQuery(prompt, options);
  export const tool = (name, description, schema, handler) => ({ name, description, schema, handler });
  export const createSdkMcpServer = config => config;

  let threadCount = 0;
  function thread(id) {
    return {
      id,
      async runStreamed(input) {
        const text = typeof input === "string" ? input : input.filter(p => p.type === "text").map(p => p.text).join("\\n");
        const threadId = id || "codex-thread-" + (++threadCount);
        log({ kind: "codex", threadId, resumed: Boolean(id), text });
        return { events: (async function* () {
          yield { type: "thread.started", thread_id: threadId };
          yield { type: "turn.started" };
          const cmd = { id: "cmd-" + threadId, type: "command_execution", command: "npm run build", aggregated_output: "ok", exit_code: 0, status: "completed" };
          yield { type: "item.started", item: cmd };
          yield { type: "item.completed", item: cmd };
          const patch = { id: "patch-" + threadId, type: "file_change", changes: [{ path: "D:/proj/report.md", kind: "add" }], status: "completed" };
          yield { type: "item.started", item: patch };
          yield { type: "item.completed", item: patch };
          yield { type: "item.completed", item: { id: "msg-" + threadId, type: "agent_message", text: "ChatGPT 答复：" + currentPart(text).slice(0, 24) } };
          yield { type: "turn.completed", usage: { input_tokens: 1 } };
        })() };
      },
    };
  }
  export class Codex {
    startThread() { return thread(null); }
    resumeThread(id) { return thread(id); }
  }
`;

const codexRuntimeMock = logFile => `
  import { appendFileSync } from "node:fs";
  const log = entry => appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(entry) + "\\n");
  export function codexRuntimeSignature({ bin, cwd, permissionMode }) { return JSON.stringify({ bin, cwd, permissionMode }); }
  export function codexRuntimeReusable(runtime, signature) { return Boolean(runtime.started && runtime.signature === signature); }
  export class PersistentCodexRuntime {
    constructor() { this.proc = null; this.signature = null; this.threadId = null; }
    get started() { return this.proc !== null; }
    get busy() { return false; }
    start({ signature }) {
      this.signature = signature;
      this.proc = { pid: 4242, exitCode: null, signalCode: null, on() {}, once() {}, removeListener() {} };
      return this.proc;
    }
    async initialize() {}
    // 模拟 app-server 认不出那条旧 thread（被删了、别的版本写的）：吞掉错误另起一条
    async ensureThread({ threadId }) {
      if (threadId && threadId !== "stale-thread") { this.threadId = threadId; return { threadId, resumed: true }; }
      this.threadId = "fresh-thread";
      return { threadId: this.threadId, resumed: false };
    }
    async runTurn({ input, onEvent }) {
      log({ kind: "codex-persistent", threadId: this.threadId, text: input.filter(p => p.type === "text").map(p => p.text).join("\\n") });
      onEvent?.("turn/started", { turn: { id: "t1" } });
      onEvent?.("item/completed", { item: { id: "i1", type: "agentMessage", text: "常驻答复" } });
      return { turn: { id: "t1" }, usage: {} };
    }
    kill() { this.proc = null; }
  }
`;

async function bootServer({ persistentCodex = false, scratch: reuse = null } = {}) {
  // 传进来一个已有的目录就是「重启」：同一份历史，新起一个进程
  const scratch = reuse ?? await mkdtemp(join(tmpdir(), "context-handoff-"));
  const port = await reservePort();
  const logFile = join(scratch, "prompts.jsonl");
  if (!reuse) await writeFile(logFile, "");
  const sdk = join(scratch, "sdk-mock.mjs");
  const runtime = join(scratch, "codex-runtime-mock.mjs");
  const loader = join(scratch, "loader.mjs");
  await writeFile(sdk, sdkMock(logFile));
  await writeFile(runtime, codexRuntimeMock(logFile));
  await writeFile(loader, `
    export async function resolve(specifier, context, next) {
      if (specifier === "@anthropic-ai/claude-agent-sdk" || specifier === "@openai/codex-sdk")
        return { url: ${JSON.stringify(pathToFileURL(sdk).href)}, shortCircuit: true };
      if (${persistentCodex} && specifier === "./codex-runtime.js")
        return { url: ${JSON.stringify(pathToFileURL(runtime).href)}, shortCircuit: true };
      return next(specifier, context);
    }
  `);
  // 假的家目录：Codex 登录检查读 ~/.codex/auth.json，测试不该依赖本机真登没登录
  const home = join(scratch, "home");
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "offline-test" } }));
  const auth = join(scratch, "auth-profile.json");
  await writeFile(auth, JSON.stringify({
    activeProfileId: "p_claude",
    profiles: [
      { id: "p_claude", name: "Claude 会员", provider: "claude" },
      { id: "p_codex", name: "ChatGPT 会员", provider: "codex" },
      { id: "p_deepseek", name: "DeepSeek", provider: "deepseek", apiKey: "sk-offline", baseUrl: "https://api.deepseek.com/anthropic",
        opusModel: "deepseek-v4-pro", sonnetModel: "deepseek-v4-pro", haikuModel: "deepseek-flash" },
    ],
  }));
  const child = spawn(process.execPath, ["--experimental-loader", pathToFileURL(loader).href, "server.js"], {
    cwd: new URL(".", import.meta.url),
    windowsHide: true,
    env: {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      PORT: String(port),
      HOST: "127.0.0.1",
      DESKTOP_AGENT_TOKEN: "test",
      CLAUDE_CHAT_DATA_DIR: scratch,
      CLAUDE_CHAT_AUTH_PROFILE_FILE: auth,
      CODEX_PERSISTENT: persistentCodex ? "1" : "0",
      CODEX_APP_SERVER_BIN: join(scratch, "fake-codex"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", d => { output += d; });
  child.stderr.on("data", d => { output += d; });
  const deadline = Date.now() + 10_000;
  while (!output.includes("claude-chat listening")) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(output);
    await delay(20);
  }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=test`);
  const events = [];
  ws.on("message", data => events.push(JSON.parse(data)));
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });

  const prompts = async () => (await readFile(logFile, "utf8")).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  let counter = reuse ? 100 : 0;
  const send = async (fields) => {
    const userMessageId = `user_${++counter}`;
    const start = events.length;
    const before = (await prompts()).length;
    ws.send(JSON.stringify({ conversationId: "conv_handoff", userMessageId, permissionMode: "auto", effort: "high", ...fields }));
    const end = Date.now() + 8000;
    while (!events.slice(start).some(e => e.type === "done" && e.userMessageId === userMessageId)) {
      if (Date.now() > end) throw new Error(`no done for ${userMessageId}: ${JSON.stringify(events.slice(start))}\n${output}`);
      await delay(20);
    }
    const errors = events.slice(start).filter(e => e.type === "error" && e.userMessageId === userMessageId);
    assert.deepEqual(errors, [], `${userMessageId} 不该报错`);
    const sent = (await prompts()).slice(before);
    assert.equal(sent.length, 1, `${userMessageId} 应该恰好发给模型一次：${JSON.stringify(sent)}`);
    return sent[0];
  };
  const history = async () => (await fetch(`http://127.0.0.1:${port}/api/history/conv_handoff?token=test`)).json();
  const close = async ({ keep = false } = {}) => {
    ws.terminate();
    if (child.exitCode === null) {
      const closed = new Promise(resolve => child.once("close", resolve));
      child.kill();
      await closed;
    }
    if (!keep) await rm(scratch, { recursive: true, force: true });
  };
  return { ws, events, send, history, prompts, close, scratch };
}

test("subtask snapshot, follow-up history and native session survive a server restart", { timeout: 60_000 }, async () => {
  let app = await bootServer();
  const scratch = app.scratch;
  const follow = async (server, requestId, prompt) => {
    const start = server.events.length;
    server.ws.send(JSON.stringify({ type: "subtask_followup", conversationId: "conv_handoff", subtaskId: "task_1",
      requestId, profileId: "p_codex", prompt, label: "test task", brief: "original task", output: "original result", permissionMode: "auto" }));
    const deadline = Date.now() + 10_000;
    while (!server.events.slice(start).some(e => e.requestId === requestId && ["subtask_done", "subtask_error"].includes(e.type))) {
      if (Date.now() > deadline) throw new Error(`follow-up timed out: ${JSON.stringify(server.events.slice(start))}`);
      await delay(20);
    }
    const terminal = server.events.slice(start).find(e => e.requestId === requestId && ["subtask_done", "subtask_error"].includes(e.type));
    assert.equal(terminal.type, "subtask_done", terminal.text);
    return terminal;
  };
  try {
    await app.send({ profileId: "p_claude", model: "claude-opus-5-5", prompt: "start task", displayText: "start task" });
    const dispatch = await app.send({ profileId: "p_claude", dispatchProvider: "p_codex", prompt: "original task", displayText: "original task" });
    const snap = { order: ["task_1"], labels: [["task_1", "test task"]], state: [["task_1", {
      status: "done", result: "original result", output: "original result", steps: ["read"], kind: "dispatch", profileId: "p_codex", model: "gpt-6-sol",
      origin: { provider: "codex", profileId: "p_codex", sessionId: dispatch.threadId },
    }]], shown: true };
    app.ws.send(JSON.stringify({ type: "subtask_snapshot", conversationId: "conv_handoff", squadId: "conv_handoff:sq_1", snapshot: snap }));
    const first = await follow(app, "st_request_1", "first follow up");
    assert.equal(first.resumed, true);
    const before = await app.history();
    assert.equal(before.subtaskSnapshots["conv_handoff:sq_1"].snapshot.state[0][1].output, "original result");
    assert.equal(before.subtaskSnapshots["conv_handoff:sq_1"].snapshot.state[0][1].origin.sessionId, undefined);
    assert.equal(before.subtaskSessions, undefined);
    assert.equal(before.messages.filter(m => m.subtask?.id === "task_1").length, 2);
    const oldBoot = before.subtaskServerBootId;
    await app.close({ keep: true });
    app = await bootServer({ scratch });
    const after = await app.history();
    assert.notEqual(after.subtaskServerBootId, oldBoot);
    assert.equal(after.subtaskSnapshots["conv_handoff:sq_1"].snapshot.order[0], "task_1");
    const second = await follow(app, "st_request_2", "second follow up");
    assert.equal(second.resumed, true);
    const calls = (await app.prompts()).filter(item => item.kind === "codex");
    assert.equal(calls.length, 3);
    assert.equal(calls[2].threadId, calls[0].threadId);
    assert.equal(calls[2].resumed, true);
    assert.equal(calls[2].text, "second follow up");
  } finally {
    await app.close();
  }
});

const FULL = "以下是当前对话此前的记录";
const DELTA = "在你上一次回复之后";

test("一个对话在 Claude、>codex 派发、ChatGPT、DeepSeek 之间来回切，每一家都拿到它缺的那段", { timeout: 60_000 }, async () => {
  const server = await bootServer();
  try {
    const claude = { profileId: "p_claude", model: "claude-opus-5-5" };

    // 1. Claude 开头：没有历史，原样发
    const first = await server.send({ ...claude, prompt: "[edit] 把计划写进 plan.md", displayText: "[edit] 把计划写进 plan.md" });
    assert.equal(first.kind, "claude");
    assert.equal(first.text, "[edit] 把计划写进 plan.md");

    // 2. 「>codex 接着完成」：派出去的那一家第一次进这个对话，要拿到整段记录
    const dispatched = await server.send({
      ...claude, prompt: "接着完成", displayText: ">codex 接着完成",
      dispatchProvider: "p_codex", dispatchReason: "用户通过 > 明确指定厂商",
    });
    assert.equal(dispatched.kind, "codex");
    assert.ok(dispatched.text.startsWith(FULL), dispatched.text);
    assert.ok(dispatched.text.includes("把计划写进 plan.md"));
    assert.ok(dispatched.text.includes("Claude 答复"));
    assert.ok(dispatched.text.includes("改动文件：D:/proj/plan.md"), "接手的一方要知道前面改过哪个文件");
    assert.ok(!dispatched.text.includes("OLD-BODY-7f3") && !dispatched.text.includes("NEW-BODY-9c1"), "文件内容不进上下文");
    assert.ok(dispatched.text.endsWith("当前用户消息：\n接着完成"));

    // 3. 回到 Claude：它的原生会话还在，只补派发那一轮（含对方跑过的命令和建的文件）
    const back = await server.send({ ...claude, prompt: "派发的结果怎么样", displayText: "派发的结果怎么样" });
    assert.equal(back.kind, "claude");
    assert.equal(back.query, first.query, "同一个 Claude 进程接着用");
    assert.ok(back.text.startsWith(DELTA), back.text);
    assert.ok(back.text.includes(">codex 接着完成") && back.text.includes("ChatGPT 答复"));
    assert.ok(back.text.includes("npm run build") && back.text.includes("D:/proj/report.md（新建）"));
    assert.ok(!back.text.includes("把计划写进"), "Claude 自己经手的那轮不重复灌");

    // 4. 换到 ChatGPT 主会话（不发 reset）：派发会话和主会话是两条，主会话第一次进来，整段补
    const toCodex = await server.send({ profileId: "p_codex", model: "gpt-6-sol", prompt: "你来接着做", displayText: "你来接着做" });
    assert.equal(toCodex.kind, "codex");
    assert.equal(toCodex.resumed, false);
    assert.ok(toCodex.text.startsWith(FULL), toCodex.text);
    for (const piece of ["把计划写进 plan.md", ">codex 接着完成", "派发的结果怎么样", "D:/proj/plan.md"]) {
      assert.ok(toCodex.text.includes(piece), `ChatGPT 缺了「${piece}」`);
    }

    // 5. 再回 Claude（仍不发 reset）：续接它自己的旧会话，只补 ChatGPT 那一轮
    const backAgain = await server.send({ ...claude, prompt: "看看它做了什么", displayText: "看看它做了什么" });
    assert.equal(backAgain.kind, "claude");
    assert.equal(backAgain.resume, "claude-session-1", "续接的是自己那条会话");
    assert.ok(backAgain.text.startsWith(DELTA), backAgain.text);
    assert.ok(backAgain.text.includes("你来接着做") && backAgain.text.includes("ChatGPT 答复"));
    assert.ok(!backAgain.text.includes("派发的结果怎么样"), "上一轮是 Claude 自己答的，不该再出现");

    // 6. 换 DeepSeek（同走 Claude SDK、共用一个会话槽）：不能拿 Claude 会员的会话去续接
    const deepseek = await server.send({ profileId: "p_deepseek", model: "deepseek-v4-pro", prompt: "换你来", displayText: "换你来" });
    assert.equal(deepseek.kind, "claude");
    assert.equal(deepseek.resume, null, "别家账号的会话不续接");
    assert.match(deepseek.baseUrl || "", /deepseek/);
    assert.ok(deepseek.text.startsWith(FULL), deepseek.text);
    assert.ok(deepseek.text.includes("把计划写进 plan.md") && deepseek.text.includes("看看它做了什么"));

    // 7. 再切回 Claude 会员：槽里现在是 DeepSeek 的会话，同样不续接，整段补
    const claudeAgain = await server.send({ ...claude, prompt: "最后确认一下", displayText: "最后确认一下" });
    assert.equal(claudeAgain.resume, null);
    assert.ok(claudeAgain.text.startsWith(FULL));
    assert.ok(claudeAgain.text.includes("换你来"));

    // 历史里每条消息都记着是哪条路处理的；派发那轮挂着对方的步骤；用户原文不被改写
    const saved = await server.history();
    const byId = Object.fromEntries(saved.messages.filter(m => m.role === "user").map(m => [m.id, m]));
    assert.equal(byId.user_1.via.profileId, "p_claude");
    assert.equal(byId.user_2.via.dispatch, true);
    assert.equal(byId.user_2.text, ">codex 接着完成");
    assert.equal(byId.user_4.via.provider, "codex");
    assert.equal(byId.user_6.via.profileId, "p_deepseek");
    const dispatchAnswer = saved.messages[saved.messages.findIndex(m => m.id === "user_2") + 1];
    assert.equal(dispatchAnswer.via.dispatch, true);
    assert.deepEqual(dispatchAnswer.dispatchSteps.map(step => step.name), ["Bash", "apply_patch"]);
  } finally {
    await server.close();
  }
});

test("codex 旧 thread 接不上、另起一条时，新 thread 拿到整段记录而不是按续接算的那份", { timeout: 30_000 }, async () => {
  const server = await bootServer({ persistentCodex: true });
  try {
    await server.send({ profileId: "p_claude", model: "claude-opus-5-5", prompt: "先定方案", displayText: "先定方案" });
    // 打开一个上次用 ChatGPT 聊过的对话：前端按对话记录把那条 thread 交给服务端
    server.ws.send(JSON.stringify({ setSession: "stale-thread", sessionProvider: "codex", conversationId: "conv_handoff" }));
    await delay(100);
    const sent = await server.send({ profileId: "p_codex", model: "gpt-6-sol", prompt: "接着做", displayText: "接着做" });
    assert.equal(sent.kind, "codex-persistent");
    assert.equal(sent.threadId, "fresh-thread");
    assert.ok(sent.text.startsWith(FULL), sent.text);
    assert.ok(sent.text.includes("先定方案") && sent.text.includes("Claude 答复"));
  } finally {
    await server.close();
  }
});

test("进程重启后按对话记录恢复的会话，仍认得出是哪个账号的", { timeout: 30_000 }, async () => {
  const before = await bootServer();
  const claude = { profileId: "p_claude", model: "claude-opus-5-5" };
  await before.send({ ...claude, conversationId: "conv_restart_a", prompt: "A 先定方案", displayText: "A 先定方案" });
  await before.send({ ...claude, conversationId: "conv_restart_b", prompt: "B 先定方案", displayText: "B 先定方案" });
  await before.close({ keep: true });
  const after = await bootServer({ scratch: before.scratch });
  try {
    // mock 按建 query 的先后给会话编号：A 那条是 claude-session-1，B 那条是 claude-session-2
    const restore = (conversationId, sessionId) => after.ws.send(JSON.stringify({ setSession: sessionId, sessionProvider: "claude", conversationId }));
    // 同一个账号回来：照常续接自己那条，上次就是它答的，什么都不用补
    restore("conv_restart_b", "claude-session-2");
    await delay(100);
    const same = await after.send({ ...claude, conversationId: "conv_restart_b", prompt: "B 继续", displayText: "B 继续" });
    assert.equal(same.resume, "claude-session-2");
    assert.equal(same.text, "B 继续");
    // 换了账号：重启后内存里没有归属，从历史标记认出那条是 Claude 会员的，不拿去接 DeepSeek
    restore("conv_restart_a", "claude-session-1");
    await delay(100);
    const other = await after.send({ profileId: "p_deepseek", model: "deepseek-v4-pro", conversationId: "conv_restart_a", prompt: "A 换你来", displayText: "A 换你来" });
    assert.equal(other.resume, null);
    assert.ok(other.text.startsWith(FULL) && other.text.includes("A 先定方案"));
    assert.ok(!other.text.includes("B 先定方案"), "不能带进别的对话的记录");
  } finally {
    await after.close();
  }
});

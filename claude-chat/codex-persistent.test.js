import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { WebSocket } from "ws";

/* ChatGPT 通道走常驻 app-server。这里守两件容易悄悄坏掉的事：

   1. 进程真的跨轮复用了——坏掉的话没有任何报错，用户只觉得「怎么又变慢了」
   2. 参数待在该待的那一层——app-server 对认不出的字段一律忽略、不报错，
      所以放错层是静默失效。其中 sandboxPolicy 放错等于 plan 档位不再只读，
      界面上还一切正常。这几个位置是 2026-09-22 拿真实 app-server 逐个验出来的：
        thread/start   cwd、approvalPolicy、model
        turn/start     effort、sandboxPolicy */

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function reservePort() {
  const net = createServer();
  await new Promise(resolve => net.listen(0, "127.0.0.1", resolve));
  const { port } = net.address();
  await new Promise(resolve => net.close(resolve));
  return port;
}

/* 假的 PersistentCodexRuntime：把每次调用记进一个文件，测试读它。
   形状照着真的来——start/initialize/ensureThread/runTurn/kill 加 started、proc。 */
function mockSource(calls) {
  return `
    import { appendFileSync } from 'node:fs';
    const log = (entry) => appendFileSync(${JSON.stringify(calls)}, JSON.stringify(entry) + '\\n');
    let spawnCount = 0;
    export function codexRuntimeSignature({ bin, cwd, permissionMode }) {
      return JSON.stringify({ bin, cwd, permissionMode });
    }
    export function codexRuntimeReusable(runtime, signature) {
      return Boolean(runtime.started && runtime.signature === signature);
    }
    export class PersistentCodexRuntime {
      constructor() { this.proc = null; this.signature = null; this.threadId = null; this.turnId = null; }
      get started() { return this.proc !== null; }
      get busy() { return false; }
      start({ spawn: doSpawn, signature }) {
        spawnCount += 1;
        log({ call: 'start', signature, spawnCount });
        this.signature = signature;
        // 不真起进程：给个够用的替身，server.js 只看 proc 是否存在
        this.proc = { pid: 1000 + spawnCount, exitCode: null, signalCode: null, on() {}, once() {}, removeListener() {} };
        return this.proc;
      }
      async initialize(clientInfo) { log({ call: 'initialize', clientInfo }); }
      async ensureThread({ threadId, params }) {
        log({ call: 'ensureThread', threadId, params });
        this.threadId = threadId ?? 'thread-persistent';
        return { threadId: this.threadId, resumed: Boolean(threadId) };
      }
      async runTurn({ input, params, onEvent, signal }) {
        log({ call: 'runTurn', input, params });
        if (signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
        onEvent?.('turn/started', { turn: { id: 't1' } });
        // 用户自己那条消息会被回放；它该被丢掉，不该在界面上出现第二遍
        onEvent?.('item/completed', { item: { id: 'i0', type: 'userMessage', text: '回放的用户消息' } });
        onEvent?.('item/completed', { item: { id: 'i1', type: 'agentMessage', text: '常驻答复' } });
        return { turn: { id: 't1' }, usage: { input_tokens: 7 } };
      }
      kill() { this.proc = null; }
    }
    export class Codex {
      startThread() { throw Error('走到 SDK 路径了——常驻模式下不该发生'); }
      resumeThread() { throw Error('走到 SDK 路径了——常驻模式下不该发生'); }
    }
  `;
}

async function bootServer(scratch, port) {
  const calls = join(scratch, "calls.jsonl");
  const mock = join(scratch, "mock.mjs");
  const loader = join(scratch, "loader.mjs");
  await writeFile(mock, mockSource(calls));
  await writeFile(loader, `
    export async function resolve(specifier, context, next) {
      if (specifier === '@openai/codex-sdk' || specifier === './codex-runtime.js')
        return { url: ${JSON.stringify(pathToFileURL(mock).href)}, shortCircuit: true };
      return next(specifier, context);
    }
  `);
  const auth = join(scratch, "auth.json");
  await writeFile(auth, JSON.stringify({
    activeProfileId: "p_codex",
    profiles: [{ id: "p_codex", name: "ChatGPT 会员", provider: "codex" }],
  }));
  let output = "";
  const child = spawn(process.execPath, ["--experimental-loader", pathToFileURL(loader).href, "server.js"], {
    cwd: new URL(".", import.meta.url), windowsHide: true,
    env: {
      ...process.env, PORT: String(port), HOST: "127.0.0.1", DESKTOP_AGENT_TOKEN: "test",
      CLAUDE_CHAT_DATA_DIR: scratch, CLAUDE_CHAT_AUTH_PROFILE_FILE: auth,
      CODEX_APP_SERVER_BIN: join(scratch, "fake-codex"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", d => { output += d; });
  child.stderr.on("data", d => { output += d; });
  const deadline = Date.now() + 10_000;
  while (!output.includes("claude-chat listening")) {
    if (Date.now() > deadline || child.exitCode !== null) throw Error(output);
    await delay(20);
  }
  return { child, calls, output: () => output };
}

const readCalls = async (path) =>
  (await readFile(path, "utf8")).trim().split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));

test("codex 常驻：进程跨轮复用，参数各待在该待的那一层", { timeout: 30_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "codex-persist-"));
  const port = await reservePort();
  const { child, calls } = await bootServer(scratch, port);
  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}/?token=test`);
    const events = [];
    ws.on("message", data => events.push(JSON.parse(data)));
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });

    const ask = async (n, extra = {}) => {
      const start = events.length;
      ws.send(JSON.stringify({ prompt: `问题 ${n}`, conversationId: "persist", userMessageId: `q${n}`, ...extra }));
      const end = Date.now() + 8000;
      while (!events.slice(start).some(e => e.type === "done")) {
        if (Date.now() > end) throw Error(JSON.stringify(events.slice(start)));
        await delay(20);
      }
      return events.slice(start);
    };

    const first = await ask(1, { model: "gpt-5.6-luna", effort: "high", permissionMode: "plan" });
    assert.deepEqual(first.filter(e => e.type === "error"), [], "第一轮就报错了");
    assert.ok(first.some(e => e.type === "result" && e.subtype === "success"));
    // 用户消息被回放，但不该二次渲染；助手那条要送到
    const texts = JSON.stringify(first);
    assert.ok(texts.includes("常驻答复"), "助手回复没送到前端");
    assert.ok(!texts.includes("回放的用户消息"), "用户消息被回放了第二遍");

    const second = await ask(2, { model: "gpt-5.6-luna", effort: "high", permissionMode: "plan" });
    assert.deepEqual(second.filter(e => e.type === "error"), []);

    const log = await readCalls(calls);
    const starts = log.filter(e => e.call === "start");
    assert.equal(starts.length, 1, `进程被起了 ${starts.length} 次——常驻没生效，每轮都在重开`);
    assert.equal(log.filter(e => e.call === "initialize").length, 1, "initialize 该只做一次");
    assert.equal(log.filter(e => e.call === "runTurn").length, 2, "两轮都该落到同一个 runtime 上");

    // —— 参数分层：放错层在 app-server 上是静默失效，这里必须钉死 ——
    const ensure = log.find(e => e.call === "ensureThread");
    assert.equal(ensure.params.model, "gpt-5.6-luna", "model 该在 thread/start 这层");
    assert.equal(ensure.params.approvalPolicy, "never");
    assert.ok(!("effort" in ensure.params), "effort 放到 thread 层会被静默忽略");
    assert.ok(!("sandboxPolicy" in ensure.params), "sandboxPolicy 放到 thread 层 = plan 档位不再只读");

    const turn = log.find(e => e.call === "runTurn");
    assert.equal(turn.params.effort, "high", "effort 该在 turn/start 这层");
    assert.deepEqual(turn.params.sandboxPolicy, { type: "readOnly" }, "plan 档位该是只读");
    assert.ok(!("model" in turn.params), "model 不在 turn 层");

    // 第二轮续的是同一条 thread
    const ensures = log.filter(e => e.call === "ensureThread");
    assert.equal(ensures[1].threadId, "thread-persistent", "第二轮没接上第一轮的 thread");
  } finally {
    ws?.terminate();
    if (child.exitCode === null) {
      const closed = new Promise(resolve => child.once("close", resolve));
      child.kill();
      await closed;
    }
    await rm(scratch, { recursive: true, force: true });
  }
});

test("codex 常驻：权限档位映射到对应的 sandbox", { timeout: 30_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "codex-sandbox-"));
  const port = await reservePort();
  const { child, calls } = await bootServer(scratch, port);
  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}/?token=test`);
    const events = [];
    ws.on("message", data => events.push(JSON.parse(data)));
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });

    const ask = async (n, permissionMode) => {
      const start = events.length;
      ws.send(JSON.stringify({ prompt: `问题 ${n}`, conversationId: "sandbox", userMessageId: `s${n}`, permissionMode }));
      const end = Date.now() + 8000;
      while (!events.slice(start).some(e => e.type === "done")) {
        if (Date.now() > end) throw Error(JSON.stringify(events.slice(start)));
        await delay(20);
      }
    };

    await ask(1, "plan");
    await ask(2, "bypassPermissions");
    await ask(3, "acceptEdits");

    const turns = (await readCalls(calls)).filter(e => e.call === "runTurn");
    assert.deepEqual(turns.map(t => t.params.sandboxPolicy.type),
      ["readOnly", "dangerFullAccess", "workspaceWrite"],
      "权限档位没映射成对应的 sandbox");
  } finally {
    ws?.terminate();
    if (child.exitCode === null) {
      const closed = new Promise(resolve => child.once("close", resolve));
      child.kill();
      await closed;
    }
    await rm(scratch, { recursive: true, force: true });
  }
});

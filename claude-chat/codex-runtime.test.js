import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PersistentCodexRuntime } from "./codex-runtime.js";

/** 一个假的 app-server：能收 JSON-RPC、按脚本回应和推通知、能装死。 */
function fakeServer() {
  const proc = new EventEmitter();
  proc.exitCode = null;
  proc.signalCode = null;
  proc.sent = [];
  proc.stdout = new EventEmitter();
  proc.stdout.setEncoding = () => {};
  proc.stderr = new EventEmitter();
  proc.stderr.setEncoding = () => {};
  proc.stdin = { write: line => proc.sent.push(JSON.parse(line)) };
  proc.emitLine = obj => proc.stdout.emit("data", `${JSON.stringify(obj)}\n`);
  proc.reply = (id, result) => proc.emitLine({ jsonrpc: "2.0", id, result });
  proc.replyError = (id, message) => proc.emitLine({ jsonrpc: "2.0", id, error: { code: -1, message } });
  proc.notify = (method, params) => proc.emitLine({ jsonrpc: "2.0", method, params });
  proc.die = (code = 1) => { proc.exitCode = code; proc.emit("close", code); };
  /** 最后一条发给服务端的请求。 */
  proc.last = () => proc.sent[proc.sent.length - 1];
  /** 按方法名找请求。 */
  proc.find = method => proc.sent.find(m => m.method === method);
  return proc;
}

function startRuntime(proc) {
  const runtime = new PersistentCodexRuntime({ killProcess: p => p.die(null) });
  runtime.start({ spawn: () => proc, signature: "sig" });
  return runtime;
}

/** 起进程 + 握手 + 建 thread，回到「可以跑一轮」的状态。 */
async function readyRuntime(proc, { threadId = "t-1" } = {}) {
  const runtime = startRuntime(proc);
  const init = runtime.initialize({ name: "test" });
  proc.reply(proc.last().id, {});
  await init;
  const ensured = runtime.ensureThread({ params: { cwd: "D:/vault" } });
  proc.reply(proc.last().id, { thread: { id: threadId } });
  await ensured;
  return runtime;
}

test("握手 → 建 thread → 跑一轮，事件原样交给调用方", async () => {
  const proc = fakeServer();
  const runtime = await readyRuntime(proc);
  assert.equal(runtime.threadId, "t-1");

  const seen = [];
  const turn = runtime.runTurn({
    input: [{ type: "text", text: "你好" }],
    params: { effort: "medium" },
    onEvent: (method, params) => seen.push([method, params?.item?.type ?? null]),
  });
  const started = proc.find("turn/start");
  assert.equal(started.params.threadId, "t-1");
  assert.deepEqual(started.params.input, [{ type: "text", text: "你好" }]);
  assert.equal(started.params.effort, "medium");

  proc.reply(started.id, { turn: { id: "turn-1" } });
  proc.notify("turn/started", { turn: { id: "turn-1" } });
  proc.notify("item/completed", { item: { type: "agentMessage", text: "好" } });
  proc.notify("thread/tokenUsage/updated", { tokenUsage: { total: { totalTokens: 42 } } });
  proc.notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });

  const result = await turn;
  // turn/completed 也要交出去再收尾，跟 agy 那条路一致；server 侧翻不出它就跳过
  assert.deepEqual(seen, [
    ["turn/started", null],
    ["item/completed", "agentMessage"],
    ["thread/tokenUsage/updated", null],
    ["turn/completed", null],
  ]);
  assert.equal(result.usage.total.totalTokens, 42, "用量要从 tokenUsage 通知里捡回来，turn/completed 上没有");
  assert.equal(runtime.busy, false);
});

test("第二轮不再建 thread——常驻的全部意义就在这", async () => {
  const proc = fakeServer();
  const runtime = await readyRuntime(proc);

  for (const text of ["一", "二"]) {
    const turn = runtime.runTurn({ input: [{ type: "text", text }] });
    proc.reply(proc.last().id, { turn: { id: `turn-${text}` } });
    proc.notify("turn/completed", { turn: { id: `turn-${text}`, status: "completed" } });
    await turn;
  }
  assert.equal(proc.sent.filter(m => m.method === "thread/start").length, 1);
  assert.equal(proc.sent.filter(m => m.method === "turn/start").length, 2);
});

test("重置之后 threadId 传 null，绝不能接着用旧 thread", async () => {
  const proc = fakeServer();
  const runtime = await readyRuntime(proc, { threadId: "old" });
  const ensured = runtime.ensureThread({ threadId: null, params: {} });
  const req = proc.last();
  assert.equal(req.method, "thread/start", "传 null 就是要开一条新的，不是复用手上那条");
  proc.reply(req.id, { thread: { id: "new" } });
  assert.equal((await ensured).threadId, "new");
});

test("接同一条 thread 才复用，换一条要 resume", async () => {
  const proc = fakeServer();
  const runtime = await readyRuntime(proc, { threadId: "t-1" });

  const same = await runtime.ensureThread({ threadId: "t-1", params: {} });
  assert.equal(same.resumed, true);
  assert.equal(proc.sent.filter(m => m.method === "thread/resume").length, 0, "同一条不该白跑一次 resume");

  const other = runtime.ensureThread({ threadId: "t-2", params: {} });
  assert.equal(proc.last().method, "thread/resume");
  proc.reply(proc.last().id, { thread: { id: "t-2" } });
  assert.equal((await other).threadId, "t-2");
});

test("resume 失败就开新的，而不是把错误甩给用户", async () => {
  const proc = fakeServer();
  const runtime = await readyRuntime(proc, { threadId: "t-1" });
  const ensured = runtime.ensureThread({ threadId: "gone", params: {} });
  proc.replyError(proc.find("thread/resume").id, "thread not found");
  await new Promise(r => setImmediate(r));
  const startReq = proc.find("thread/start");
  proc.reply(proc.sent[proc.sent.length - 1].id, { thread: { id: "fresh" } });
  assert.ok(startReq, "resume 挂了要退回 thread/start");
  assert.equal((await ensured).threadId, "fresh");
});

test("中断先发 turn/interrupt，把进程和上下文留住", async () => {
  const proc = fakeServer();
  const runtime = await readyRuntime(proc);
  const ac = new AbortController();
  const turn = runtime.runTurn({ input: [{ type: "text", text: "x" }], signal: ac.signal });
  proc.reply(proc.last().id, { turn: { id: "turn-1" } });
  await new Promise(r => setImmediate(r));

  ac.abort();
  const interrupt = proc.find("turn/interrupt");
  assert.ok(interrupt, "能只打断这一轮就别杀进程——杀了下一轮又要重付启动");
  assert.equal(interrupt.params.turnId, "turn-1");
  proc.reply(interrupt.id, {});
  proc.notify("turn/completed", { turn: { id: "turn-1", status: "aborted" } });

  const err = await turn.then(() => null, e => e);
  assert.equal(err.name, "AbortError");
  assert.equal(runtime.started, true, "中断不该把常驻进程一起收掉");
});

test("turn/completed 报 failed 就抛，不能当成功", async () => {
  const proc = fakeServer();
  const runtime = await readyRuntime(proc);
  const turn = runtime.runTurn({ input: [{ type: "text", text: "x" }] });
  proc.reply(proc.last().id, { turn: { id: "turn-1" } });
  proc.notify("turn/completed", { turn: { id: "turn-1", status: "failed", error: { message: "配额没了" } } });
  const result = await turn;
  // runtime 只负责把 turn 原样交出去，判断成败是调用方的事（server.js 那边看 status）
  assert.equal(result.turn.status, "failed");
});

test("进程在一轮当中没了，打上 codexProcessDied 好让上层退回 SDK", async () => {
  const proc = fakeServer();
  const runtime = await readyRuntime(proc);
  const turn = runtime.runTurn({ input: [{ type: "text", text: "x" }] });
  proc.reply(proc.last().id, { turn: { id: "turn-1" } });
  proc.stderr.emit("data", "app-server panicked\n");
  proc.die(101);
  const err = await turn.then(() => null, e => e);
  assert.equal(err.codexProcessDied, true);
  assert.match(err.message, /panicked/);
  assert.equal(runtime.threadId, null, "thread 要跟着进程一起作废，否则下一轮会拿它去 resume 一个不存在的会话");
});

test("进程没了，还在等回应的请求要被拒绝而不是永远挂着", async () => {
  const proc = fakeServer();
  const runtime = startRuntime(proc);
  const init = runtime.initialize({ name: "test" });
  proc.die(1);
  const err = await init.then(() => null, e => e);
  assert.match(err.message, /已退出/);
});

test("codex 反过来问审批时必须回话，否则那一轮永远挂着", async () => {
  const proc = fakeServer();
  const runtime = await readyRuntime(proc);
  const turn = runtime.runTurn({ input: [{ type: "text", text: "x" }] });
  proc.reply(proc.last().id, { turn: { id: "turn-1" } });

  proc.emitLine({ jsonrpc: "2.0", id: 900, method: "thread/execCommandApproval", params: { command: "ls" } });
  const answer = proc.sent.find(m => m.id === 900);
  assert.ok(answer, "不回话 codex 会一直等一个不会来的答复");
  assert.equal(answer.result.decision, "approved");

  proc.emitLine({ jsonrpc: "2.0", id: 901, method: "thread/somethingWeDoNotKnow", params: {} });
  const refused = proc.sent.find(m => m.id === 901);
  assert.ok(refused.error, "不认识的请求要明确拒绝，也好过不回");

  proc.notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
  await turn;
});

test("翻译器抛异常不该把这一轮带崩", async () => {
  const proc = fakeServer();
  const runtime = await readyRuntime(proc);
  const turn = runtime.runTurn({
    input: [{ type: "text", text: "x" }],
    onEvent: (method) => { if (method === "item/completed") throw new Error("翻译炸了"); },
  });
  proc.reply(proc.last().id, { turn: { id: "turn-1" } });
  proc.notify("item/completed", { item: { type: "agentMessage", text: "好" } });
  proc.notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
  await turn;   // 没抛出去就算过
});

test("同一个 runtime 不能并发跑两轮", async () => {
  const proc = fakeServer();
  const runtime = await readyRuntime(proc);
  const first = runtime.runTurn({ input: [{ type: "text", text: "一" }] });
  proc.reply(proc.find("turn/start").id, { turn: { id: "turn-1" } });
  const err = await runtime.runTurn({ input: [{ type: "text", text: "二" }] }).then(() => null, e => e);
  assert.match(err.message, /并发/);
  proc.notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
  await first;
});

test("还没建 thread 就跑一轮，报错而不是静默卡住", async () => {
  const proc = fakeServer();
  const runtime = startRuntime(proc);
  const err = await runtime.runTurn({ input: [] }).then(() => null, e => e);
  assert.match(err.message, /还没有 thread/);
});

test("被切成两半的一行要拼回来再解析", async () => {
  const proc = fakeServer();
  const runtime = startRuntime(proc);
  const init = runtime.initialize({ name: "test" });
  const line = JSON.stringify({ jsonrpc: "2.0", id: proc.last().id, result: { ok: true } });
  proc.stdout.emit("data", line.slice(0, 15));
  proc.stdout.emit("data", `${line.slice(15)}\n`);
  await init;   // 拼不回来这里会超时
});

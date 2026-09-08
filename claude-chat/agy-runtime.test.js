import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  PersistentAgyRuntime,
  agyRuntimeSignature,
  agyPersistentArgs,
  agyRuntimeReusable,
} from "./agy-runtime.js";

/** 一个假的 agy 进程：能收 stdin、能按脚本吐 stdout、能装死。 */
function fakeProcess() {
  const proc = new EventEmitter();
  proc.exitCode = null;
  proc.signalCode = null;
  proc.written = [];
  proc.stdout = new EventEmitter();
  proc.stdout.setEncoding = () => {};
  proc.stderr = new EventEmitter();
  proc.stderr.setEncoding = () => {};
  proc.stdin = { write: line => proc.written.push(line) };
  proc.emitLine = obj => proc.stdout.emit("data", `${JSON.stringify(obj)}\n`);
  proc.die = (code = 1) => {
    proc.exitCode = code;
    proc.emit("close", code);
  };
  return proc;
}

function userMessage(text) {
  return { event: "user", message: { role: "user", content: [{ type: "text", text }] } };
}

// 真实的 result 多数带着全文 response，但工具轮会给空的——默认按后者构造，
// 文本得从 text_delta 累积出来
const resultEvent = (conversationId, extra = {}) => ({
  event: "result",
  result: { conversation_id: conversationId, status: "SUCCESS", response: "", usage: { total_tokens: 7 }, ...extra },
});

const textEvent = (conversationId, delta, state = "ACTIVE") => ({
  event: "step_update",
  step_update: { conversation_id: conversationId, step_type: "agent_response", state, text_delta: delta },
});

function startRuntime(proc, { signature = "sig", resumeConversationId = null } = {}) {
  const runtime = new PersistentAgyRuntime({ killProcess: p => p.die(null) });
  runtime.start({ spawn: () => proc, signature, resumeConversationId });
  return runtime;
}

test("一个进程连着跑两轮，第二轮不重起——常驻的全部意义就在这", async () => {
  const proc = fakeProcess();
  let spawned = 0;
  const runtime = new PersistentAgyRuntime({ killProcess: p => p.die(null) });
  runtime.start({ spawn: () => { spawned += 1; return proc; }, signature: "sig" });
  assert.equal(spawned, 1);

  const first = runtime.runTurn({ message: userMessage("一") });
  proc.emitLine({ event: "init", conversation_id: "conv-1" });
  proc.emitLine(textEvent("conv-1", "甲"));
  proc.emitLine(resultEvent("conv-1"));
  assert.equal((await first).text, "甲");

  const second = runtime.runTurn({ message: userMessage("二") });
  proc.emitLine(textEvent("conv-1", "乙"));
  proc.emitLine(resultEvent("conv-1"));
  assert.equal((await second).text, "乙");

  assert.equal(spawned, 1, "第二轮不该再起进程");
  assert.equal(proc.written.length, 2, "两轮各往 stdin 写一行 NDJSON");
  assert.ok(proc.written[0].endsWith("\n"), "每条消息必须换行结尾，否则 agy 读不到完整一行");
});

test("会话 id 从 init 里认出来，只回调一次", async () => {
  const proc = fakeProcess();
  const runtime = startRuntime(proc);
  const seen = [];
  const turn = runtime.runTurn({ message: userMessage("你好"), onSession: id => seen.push(id) });
  proc.emitLine({ event: "init", init: { conversation_id: "conv-9" } });
  proc.emitLine(textEvent("conv-9", "hi"));
  proc.emitLine(resultEvent("conv-9"));
  const run = await turn;
  assert.deepEqual(seen, ["conv-9"], "同一个 id 重复出现不该反复回调");
  assert.equal(run.conversationId, "conv-9");
  assert.equal(runtime.boundConversationId, "conv-9");
});

test("事件按原样交给 onEvent，result 也要交出去再收尾", async () => {
  const proc = fakeProcess();
  const runtime = startRuntime(proc);
  const types = [];
  const turn = runtime.runTurn({ message: userMessage("x"), onEvent: ev => types.push(ev.event) });
  proc.emitLine({ event: "init", conversation_id: "c" });
  proc.emitLine(textEvent("c", "a"));
  proc.emitLine(resultEvent("c"));
  await turn;
  assert.deepEqual(types, ["init", "step_update", "result"]);
});

test("翻译器抛异常不该把这一轮带崩", async () => {
  const proc = fakeProcess();
  const runtime = startRuntime(proc);
  const turn = runtime.runTurn({
    message: userMessage("x"),
    onEvent: ev => { if (ev.event === "step_update") throw new Error("翻译炸了"); },
  });
  proc.emitLine(textEvent("c", "a"));
  proc.emitLine(resultEvent("c"));
  const run = await turn;
  assert.equal(run.text, "a");
});

test("被切成两半的一行要拼回来再解析", async () => {
  const proc = fakeProcess();
  const runtime = startRuntime(proc);
  const turn = runtime.runTurn({ message: userMessage("x") });
  const line = JSON.stringify(resultEvent("c", { response: "完整" }));
  proc.stdout.emit("data", line.slice(0, 20));
  proc.stdout.emit("data", `${line.slice(20)}\n`);
  assert.equal((await turn).text, "完整");
});

test("非 SUCCESS 的 result 照样算一轮跑完，状态原样交给调用方判断", async () => {
  const proc = fakeProcess();
  const runtime = startRuntime(proc);
  const turn = runtime.runTurn({ message: userMessage("x") });
  proc.emitLine(resultEvent("c", { status: "ERROR", error: "配额没了" }));
  const run = await turn;
  assert.equal(run.status, "ERROR");
  assert.equal(run.error, "配额没了");
  assert.equal(runtime.busy, false, "跑完了就得让出位置，否则下一轮永远发不出去");
});

test("进程在一轮当中没了：报 stderr 的原文，并打上 agyProcessDied 好让上层决定重不重试", async () => {
  const proc = fakeProcess();
  const runtime = startRuntime(proc);
  const turn = runtime.runTurn({ message: userMessage("x") });
  proc.stderr.emit("data", "effort is not supported\n");
  proc.die(1);
  const err = await turn.then(() => null, e => e);
  assert.ok(err, "进程没了这一轮必须以失败收场，不能永远挂着");
  assert.equal(err.agyProcessDied, true);
  assert.match(err.message, /effort is not supported/);
  assert.equal(runtime.started, false);
  assert.equal(runtime.signature, null, "指纹要跟着进程一起作废，否则下次会误判成可复用");
});

test("中断走 kill，报 AbortError 而不是「进程死了」", async () => {
  const proc = fakeProcess();
  const runtime = startRuntime(proc);
  const ac = new AbortController();
  const turn = runtime.runTurn({ message: userMessage("x"), signal: ac.signal });
  ac.abort();
  const err = await turn.then(() => null, e => e);
  assert.equal(err.name, "AbortError");
  assert.notEqual(err.agyProcessDied, true, "用户按停止不是故障，不该触发上层的自动重试");
});

test("已经 abort 的 signal 直接拒绝，不会白写一行进去", async () => {
  const proc = fakeProcess();
  const runtime = startRuntime(proc);
  const ac = new AbortController();
  ac.abort();
  const err = await runtime.runTurn({ message: userMessage("x"), signal: ac.signal }).then(() => null, e => e);
  assert.equal(err.name, "AbortError");
  assert.equal(proc.written.length, 0);
});

test("同一个 runtime 不能并发跑两轮——stdin 是一条串行的队", async () => {
  const proc = fakeProcess();
  const runtime = startRuntime(proc);
  const first = runtime.runTurn({ message: userMessage("一") });
  const err = await runtime.runTurn({ message: userMessage("二") }).then(() => null, e => e);
  assert.match(err.message, /并发/);
  proc.emitLine(resultEvent("c"));
  await first;
});

test("进程没起来就跑一轮，报错而不是静默卡住", async () => {
  const runtime = new PersistentAgyRuntime();
  const err = await runtime.runTurn({ message: userMessage("x") }).then(() => null, e => e);
  assert.match(err.message, /没在跑/);
});

test("一轮结束后进程才没的，不该凭空冒出一个失败", async () => {
  const proc = fakeProcess();
  const runtime = startRuntime(proc);
  const turn = runtime.runTurn({ message: userMessage("x") });
  proc.emitLine(resultEvent("c"));
  await turn;
  proc.die(0);   // 这一轮已经结算过了，close 事件不该再动任何东西
  assert.equal(runtime.started, false);
  assert.equal(runtime.busy, false);
});

test("stderr 按轮清空，上一轮的报错不会栽赃给下一轮", async () => {
  const proc = fakeProcess();
  const runtime = startRuntime(proc);
  const first = runtime.runTurn({ message: userMessage("一") });
  proc.stderr.emit("data", "上一轮的噪音\n");
  proc.emitLine(resultEvent("c"));
  await first;

  const second = runtime.runTurn({ message: userMessage("二") });
  proc.die(1);
  const err = await second.then(() => null, e => e);
  assert.doesNotMatch(err.message, /上一轮的噪音/);
});

test("result 带了全文就以它为准，增量只是兜底", async () => {
  const proc = fakeProcess();
  const runtime = startRuntime(proc);
  const turn = runtime.runTurn({ message: userMessage("x") });
  proc.emitLine(textEvent("c", "半"));
  proc.emitLine(resultEvent("c", { response: "整段回答" }));
  assert.equal((await turn).text, "整段回答");
});

// ── 复用判断 ─────────────────────────────────────────────────
// 这几条是常驻的正确性底线：判松了会拿旧上下文回答新问题，判紧了等于没常驻。

const sig = (over = {}) => agyRuntimeSignature({
  bin: "agy", cwd: "D:/vault", model: "gemini-3.1-pro", effort: "medium", permissionMode: "auto", ...over,
});

test("换模型、换档位、换模式、换目录，都得重起进程", () => {
  const base = sig();
  assert.notEqual(sig({ model: "gemini-3.8-flash" }), base, "模型是命令行参数，改不了");
  assert.notEqual(sig({ effort: "high" }), base);
  assert.notEqual(sig({ permissionMode: "plan" }), base);
  assert.notEqual(sig({ cwd: "D:/other" }), base);
  assert.equal(sig(), base, "什么都没变就得是同一个指纹，否则每轮都在重起");
});

test("指纹里没有 conversationId——有了它常驻就永远对不上", () => {
  // 新对话第一轮的 id 是 agy 生成后回传的，算进指纹的话第二轮必然不匹配
  assert.equal(sig(), sig(), "同参数同指纹");
  const withConv = agyRuntimeSignature({
    bin: "agy", cwd: "D:/vault", model: "gemini-3.1-pro", effort: "medium",
    permissionMode: "auto", conversationId: "conv-1",
  });
  assert.equal(withConv, sig(), "多传一个 conversationId 不该改变指纹");
});

test("会话换了就不能复用，哪怕参数一模一样", () => {
  const runtime = { started: true, signature: "s", boundConversationId: "conv-1" };
  assert.equal(agyRuntimeReusable(runtime, "s", "conv-1"), true);
  assert.equal(agyRuntimeReusable(runtime, "s", "conv-2"), false, "切到别的会话必须重起");
  assert.equal(agyRuntimeReusable(runtime, "s", null), false, "重置之后是新话题，不能接着旧上下文");
  assert.equal(agyRuntimeReusable(runtime, "other", "conv-1"), false, "参数变了也得重起");
  assert.equal(agyRuntimeReusable({ ...runtime, started: false }, "s", "conv-1"), false);
});

test("进程刚起、还没拿到 id 时，null 对 null 算可复用", () => {
  // 新对话的第一轮：session 里还没有 id，进程也还没绑
  const fresh = { started: true, signature: "s", boundConversationId: null };
  assert.equal(agyRuntimeReusable(fresh, "s", null), true);
  assert.equal(agyRuntimeReusable(fresh, "s", undefined), true, "undefined 和 null 是同一件事");
});

test("常驻的命令行：prompt 走 stdin，--print 必须是带等号的一坨", () => {
  const args = agyPersistentArgs({
    cwd: "D:/vault", model: "gemini-3.1-pro", effort: "medium",
    permissionMode: "auto", resumeConversationId: "conv-7",
  });
  assert.ok(args.includes("--print="), "拆成 --print 和空串会被 Go 的 flag 当成把下一个参数当 prompt");
  assert.equal(args.indexOf("--input-format") + 1, args.indexOf("stream-json"));
  assert.deepEqual(args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 2),
    ["--output-format", "stream-json"], "输入是 stream-json 时输出也必须是，agy 强制要求");
  assert.deepEqual(args.slice(args.indexOf("--conversation"), args.indexOf("--conversation") + 2),
    ["--conversation", "conv-7"]);
  assert.deepEqual(args.slice(args.indexOf("--add-dir"), args.indexOf("--add-dir") + 2),
    ["--add-dir", "D:/vault"], "不给 --add-dir 它会跑去自己的 scratch 目录动文件");
  assert.ok(args.includes("--dangerously-skip-permissions"), "headless 下没人能点授权弹窗");
  assert.ok(!args.includes("-p"), "常驻模式不能再从命令行收 prompt");
});

test("没有会话可接时不带 --conversation", () => {
  const args = agyPersistentArgs({ cwd: "D:/vault", model: "m", effort: "medium", permissionMode: "auto", resumeConversationId: null });
  assert.ok(!args.includes("--conversation"), "传了空的 --conversation agy 会拒绝启动");
});

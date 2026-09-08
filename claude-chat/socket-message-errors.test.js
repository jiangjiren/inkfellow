import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
function fixture() {
  const logs = [];
  const handled = [];
  const c = vm.createContext({
    currentConvId: "conv-current", console: { error: (...args) => logs.push(args) },
    handleEvent: ev => handled.push(ev), ensureProgressIndicator() {},
  });
  for (const name of ["logSocketMessageError", "processSocketMessage"]) {
    vm.runInContext(html.match(new RegExp(`function ${name}\\([^]*?^}`, "m"))[0], c);
  }
  return { c, logs, handled };
}

test("解析错误记录阶段，不泄露原始帧，后续消息仍正常处理", () => {
  const { c, logs, handled } = fixture();
  c.processSocketMessage('{"text":"private chat secret');
  c.processSocketMessage('{"type":"ping"}');
  assert.equal(logs.length, 1);
  assert.equal(logs[0][1].stage, "parse");
  assert.equal(logs[0][1].errorName, "SyntaxError");
  assert.ok(!JSON.stringify(logs).includes("private chat secret"));
  assert.equal(handled[0].type, "ping");
});

test("渲染错误包含事件归属和调用位置，不记录消息和鉴权参数", () => {
  const { c, logs } = fixture();
  c.handleEvent = () => {
    const error = new TypeError("private chat secret");
    error.stack = "TypeError: private chat secret\n    at render (http://localhost/chat?token=secret-token:123:4)";
    throw error;
  };
  c.processSocketMessage(JSON.stringify({ type: "assistant", conversationId: "conv-a", userMessageId: "req-a", text: "private chat secret" }));
  const entry = logs[0][1];
  assert.equal(entry.stage, "handle");
  assert.equal(entry.conversationId, "conv-a");
  assert.equal(entry.requestId, "req-a");
  assert.equal(entry.currentConversationId, "conv-current");
  assert.match(entry.frames[0], /at render/);
  assert.ok(!JSON.stringify(logs).includes("private chat secret"));
  assert.ok(!JSON.stringify(logs).includes("secret-token"));
});

test("消息处理和指示器同时报错时，两处错误均可定位", () => {
  const { c, logs } = fixture();
  c.handleEvent = () => { throw new Error("handle"); };
  c.ensureProgressIndicator = () => { throw new Error("progress"); };
  assert.doesNotThrow(() => c.processSocketMessage('{"type":"done"}'));
  assert.deepEqual(logs.map(log => log[1].stage), ["handle", "progress"]);
});

test("正常消息不产生异常日志", () => {
  const { c, logs, handled } = fixture();
  c.processSocketMessage('{"type":"done"}');
  assert.equal(logs.length, 0);
  assert.equal(handled.length, 1);
});

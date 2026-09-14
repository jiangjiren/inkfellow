import test from "node:test";
import assert from "node:assert/strict";
import { assertSuccessfulResult } from "./sdk-result.js";
test("SDK error results throw with the upstream reason instead of succeeding with an empty answer", () => {
  assert.throws(() => assertSuccessfulResult({ type: "result", subtype: "error_during_execution", errors: ["429 rate limited"] }), /429 rate limited/);
  assert.throws(() => assertSuccessfulResult({ type: "result", is_error: true, result: "login expired" }), /login expired/);
  assert.doesNotThrow(() => assertSuccessfulResult({ type: "result", subtype: "success" }));
  assert.doesNotThrow(() => assertSuccessfulResult({ type: "assistant" }));
});

test("a background task's failed result does not fail the foreground turn", () => {
  // server.js 的 onEvent 把后台任务事件也分发给当前 turn；带 origin 的 result
  // 属于后台自动续写，用它判前台失败会误杀用户正在等的回答。
  assert.doesNotThrow(() => assertSuccessfulResult({
    type: "result", origin: "task", is_error: true, result: "background task failed",
  }));
  assert.doesNotThrow(() => assertSuccessfulResult({
    type: "result", origin: "task", subtype: "error_during_execution", errors: ["boom"],
  }));
  // 前台那条（无 origin）照旧要抛。
  assert.throws(() => assertSuccessfulResult({ type: "result", is_error: true, result: "boom" }), /boom/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { currentScheduleTime, schedulerScopeForTurn } from "./scheduler-intent.js";

test("scheduler access follows the user and channel rather than the message text", () => {
  const webPeer = "web:8082";
  assert.deepEqual(schedulerScopeForTurn({ webPeer, prompt: "润色文案：每天自动生成日报" }), {
    sourceChannel: "web", sourcePeer: webPeer, defaultOutputs: ["chat_history"],
  });
  assert.deepEqual(schedulerScopeForTurn({ internalMessage: true, sourceChannel: "wechat", sourcePeer: "wx-user" }), {
    sourceChannel: "wechat", sourcePeer: "wx-user", defaultOutputs: ["wechat"],
  });
  assert.equal(schedulerScopeForTurn({ internalMessage: true }), null);
  assert.equal(schedulerScopeForTurn({ internalMessage: true, sourceChannel: "wechat" }), null);
  assert.equal(schedulerScopeForTurn({ workerTicket: {} }), null);
  assert.equal(schedulerScopeForTurn({ dispatchProvider: "gemini" }), null);
});

test("the scheduler clock reads current time in Asia/Shanghai", t => {
  const start = Date.UTC(2026, 10, 24, 2, 0);
  t.mock.timers.enable({ apis: ["Date"], now: start });
  assert.equal(currentScheduleTime().timestampMs, start);
  t.mock.timers.tick(5 * 60_000);
  const later = currentScheduleTime();
  assert.equal(later.timestampMs, start + 5 * 60_000);
  assert.equal(later.timezone, "Asia/Shanghai");
  assert.match(later.localTime, /10:05/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { KeyedTaskQueue } from "./keyed-task-queue.js";
test("same sender stays ordered, other senders run independently, errors release the queue", async () => {
  const queue = new KeyedTaskQueue(); const order = []; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const a = queue.run("sender-a", async () => { order.push("a1"); await gate; throw new Error("failed"); });
  const rejected = assert.rejects(a, /failed/);
  const b = queue.run("sender-a", () => order.push("a2"));
  await queue.run("sender-b", () => order.push("b1"));
  assert.deepEqual(order, ["a1", "b1"]);
  release(); await rejected; await b;
  assert.deepEqual(order, ["a1", "b1", "a2"]);
  await Promise.resolve(); assert.equal(queue.pending.size, 0);
});

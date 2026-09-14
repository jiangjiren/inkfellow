import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const source = readFileSync(new URL("scheduler.js", import.meta.url), "utf8");
const gate = source.slice(source.indexOf("const executingJobs ="), source.indexOf("async function _executeJobOnce"));
test("a scheduler tick skips an already-running job and allows it after completion", async () => {
  const calls = []; const releases = new Map();
  const ctx = vm.createContext({ _executeJobOnce: job => { calls.push(job.id); return new Promise(resolve => releases.set(job.id, resolve)); } });
  vm.runInContext(gate, ctx);
  const first = vm.runInContext('_executeJob({id:"a"})', ctx);
  await vm.runInContext('_executeJob({id:"a"})', ctx);
  const other = vm.runInContext('_executeJob({id:"b"})', ctx);
  assert.deepEqual(calls, ["a", "b"]);
  releases.get("a")(); releases.get("b")(); await first; await other;
  const next = vm.runInContext('_executeJob({id:"a"})', ctx);
  assert.deepEqual(calls, ["a", "b", "a"]); releases.get("a")(); await next;
});

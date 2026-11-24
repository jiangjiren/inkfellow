import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PersistentCodexRuntime } from "./codex-runtime.js";
import { PersistentAgyRuntime } from "./agy-runtime.js";
import { stopRuntime } from "./runtime-stop.js";

for (const Runtime of [PersistentCodexRuntime, PersistentAgyRuntime]) {
  test(`${Runtime.name}: replacement waits for asynchronous process close`, async () => {
    const proc = new EventEmitter();
    proc.exitCode = proc.signalCode = null;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout.setEncoding = proc.stderr.setEncoding = () => {};
    let killed = false;
    const runtime = new Runtime({ killProcess: () => { killed = true; } });
    runtime.start({ spawn: () => proc, signature: "old" });
    let resumed = false;
    const stopped = stopRuntime(runtime).then(() => { resumed = true; });
    await Promise.resolve();
    assert.equal(killed, true);
    assert.equal(resumed, false, "sending kill does not release the writer");
    proc.exitCode = 0;
    proc.emit("close", 0);
    await stopped;
    assert.equal(resumed, true);
    assert.equal(runtime.started, false);
    assert.equal(proc.listenerCount("close"), 1);
  });
}

test("failure to exit prevents session handoff and removes temporary listener", async () => {
  const proc = new EventEmitter();
  const runtime = { proc, kill() {} };
  await assert.rejects(stopRuntime(runtime, { timeoutMs: 10 }), /旧 AI 进程尚未退出/);
  assert.equal(proc.listenerCount("close"), 0);
  assert.equal(runtime.proc, proc);
});

test("unused and already closed runtimes require no wait", async () => {
  await stopRuntime({ proc: null });
  const runtime = { proc: {}, kill() { this.proc = null; } };
  runtime.proc = new EventEmitter();
  await stopRuntime(runtime);
});

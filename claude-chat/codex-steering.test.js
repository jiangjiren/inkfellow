import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(events, predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = events.find(predicate);
    if (value) return value;
    await delay(10);
  }
  throw new Error(`Missing event: ${JSON.stringify(events.map(e => [e.type, e.userMessageId]))}`);
}

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), "inkfellow-codex-steer-"));
  const calls = join(dir, "calls.jsonl");
  const loader = join(dir, "loader.mjs"), mock = join(dir, "mock.mjs");
  const runtimeUrl = new URL("./codex-runtime.js", import.meta.url).href;
  await writeFile(mock, `
    import { EventEmitter } from 'node:events';
    import { appendFileSync } from 'node:fs';
    import { PersistentCodexRuntime as Real, codexRuntimeSignature, codexRuntimeReusable } from ${JSON.stringify(runtimeUrl)};
    export { codexRuntimeSignature, codexRuntimeReusable };
    const log = value => appendFileSync(${JSON.stringify(calls)}, JSON.stringify(value) + '\\n');
    let sequence = 0;
    function transport() {
      const p = new EventEmitter();
      p.exitCode = null; p.signalCode = null;
      p.stdout = new EventEmitter(); p.stdout.setEncoding = () => {};
      p.stderr = new EventEmitter(); p.stderr.setEncoding = () => {};
      const threadId = 'thread-' + (++sequence);
      let turnId = null, turnNumber = 0, text = '', timer = null;
      const items = [], timers = [];
      const emit = value => p.stdout.emit('data', JSON.stringify(value) + '\\n');
      const notify = (method, params) => { log({ notice: method, threadId: params?.threadId || threadId }); emit({ method, params: { threadId, turnId, ...params } }); };
      const reply = (id, result) => emit({ id, result });
      const complete = () => { notify('turn/completed', { turn: { id: turnId,
        status: text.includes('[fail]') ? 'failed' : 'completed',
        ...(text.includes('[fail]') ? { error: { message: 'provider failed the turn' } } : {}) } }); turnId = null; };
      const finishLater = () => { clearTimeout(timer); timer = setTimeout(complete, 850); timers.push(timer); };
      p.stdin = { write(line) {
        const m = JSON.parse(line); log({ threadId, ...m });
        queueMicrotask(() => {
          if (m.method === 'initialize') reply(m.id, {});
          if (m.method === 'thread/start' || m.method === 'thread/resume') reply(m.id, { thread: { id: threadId } });
          if (m.method === 'turn/start') {
            text = m.params.input.find(i => i.type === 'text')?.text || '';
            turnId = 'turn-' + threadId + '-' + (++turnNumber);
            reply(m.id, { turn: { id: turnId } }); notify('turn/started', { turn: { id: turnId } });
            notify('item/completed', { item: { type: 'agentMessage', id: 'initial-' + turnId, text: 'initial: ' + text } });
            timers.push(setTimeout(() => { if (turnId) notify('item/completed', { threadId: 'child-thread', item: {
              type: 'commandExecution', id: 'child-tool', command: 'read', status: 'completed', exitCode: 0,
            } }); }, 100));
            timers.push(setTimeout(() => {
              if (turnId && !text.includes('[no-tools]')) notify('item/completed', { item: {
                type: 'commandExecution', id: 'tool-' + turnId, command: 'read', status: 'completed', exitCode: 0, aggregatedOutput: 'done',
              } });
            }, 250));
            finishLater();
          }
          if (m.method === 'turn/steer') {
            if (!turnId || m.params.expectedTurnId !== turnId || text.includes('[reject]')) {
              emit({ id: m.id, error: { code: -32600, message: 'no matching active turn' } }); return;
            }
            reply(m.id, { turnId });
            if (text.includes('[not-consumed]')) return;
            const consume = () => {
              if (!turnId) return;
              const item = { type: 'userMessage', id: 'native-' + m.params.clientUserMessageId,
                clientId: m.params.clientUserMessageId, content: m.params.input };
              items.push({ turnId, item }); notify('item/started', { item });
              notify('item/completed', { item: { type: 'agentMessage', id: 'continued-' + item.id,
                text: 'continued: ' + m.params.input.find(i => i.type === 'text')?.text } });
            };
            if (text.includes('[delay-consumption]')) timers.push(setTimeout(consume, 200));
            else consume();
          }
          if (m.method === 'thread/items/list') reply(m.id, {
            data: items.filter(entry => entry.turnId === m.params.turnId), nextCursor: null,
          });
          if (m.method === 'thread/read') reply(m.id, { thread: { turns: items.map(entry => ({ id: entry.turnId, items: [entry.item] })) } });
          if (m.method === 'turn/interrupt') { clearTimeout(timer); reply(m.id, {}); complete(); }
        });
      } };
      p.kill = () => { for (const t of timers) clearTimeout(t); p.exitCode = 0; p.emit('close', 0); };
      return p;
    }
    export class PersistentCodexRuntime extends Real {
      start({ signature }) { return super.start({ signature, spawn: transport }); }
    }
    export class Codex { startThread() { throw Error('unexpected SDK fallback'); } resumeThread() { throw Error('unexpected SDK fallback'); } }
  `);
  await writeFile(loader, `
    export async function resolve(specifier, context, next) {
      if (specifier === '@openai/codex-sdk' || specifier === './codex-runtime.js')
        return { url: ${JSON.stringify(pathToFileURL(mock).href)}, shortCircuit: true };
      return next(specifier, context);
    }
  `);
  await writeFile(join(dir, "auth.json"), JSON.stringify({ activeProfileId: "codex",
    profiles: [{ id: "codex", name: "ChatGPT", provider: "codex" }] }));
  const net = createServer();
  await new Promise(resolve => net.listen(0, "127.0.0.1", resolve));
  const port = net.address().port;
  await new Promise(resolve => net.close(resolve));
  const child = spawn(process.execPath, ["--experimental-loader", pathToFileURL(loader).href, "server.js"], {
    cwd: new URL(".", import.meta.url), windowsHide: true,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DESKTOP_AGENT_TOKEN: "test",
      CLAUDE_CHAT_DATA_DIR: dir, CLAUDE_CHAT_AUTH_PROFILE_FILE: join(dir, "auth.json"), CODEX_PERSISTENT: "1",
      CODEX_APP_SERVER_BIN: join(dir, "fake-codex") }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
  const deadline = Date.now() + 12000;
  while (!output.includes("claude-chat listening")) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(output || "startup timeout");
    await delay(20);
  }
  const events = [];
  let ws;
  async function connect() {
    ws = new WebSocket(`ws://127.0.0.1:${port}/?token=test`);
    ws.on("message", raw => events.push(JSON.parse(raw)));
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  }
  await connect();
  return { dir, events, calls, send: payload => ws.send(JSON.stringify(payload)),
    ask: (owner, id, prompt = "hold") => ws.send(JSON.stringify({ conversationId: owner, userMessageId: id, prompt,
      displayText: prompt, profileId: "codex", model: "test-model", permissionMode: "auto", effort: "high" })),
    follow: (owner, id, prompt, extra = {}) => ws.send(JSON.stringify({ conversationId: owner, userMessageId: id, prompt,
      displayText: prompt, profileId: "codex", model: "test-model", permissionMode: "auto", effort: "high", deliveryMode: "steer", ...extra })),
    async reconnect() { ws.terminate(); await connect(); },
    async history(owner) { return (await fetch(`http://127.0.0.1:${port}/api/history/${owner}`, { headers: { Authorization: "Bearer test" } })).json(); },
    async delete(owner) { return fetch(`http://127.0.0.1:${port}/api/history/${owner}`, { method: "DELETE", headers: { Authorization: "Bearer test" } }); },
    async save(owner) { return fetch(`http://127.0.0.1:${port}/api/history/${owner}`, { method: "PUT", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify({ title: "late save" }) }); },
    async log() { return (await readFile(calls, "utf8")).trim().split(/\r?\n/).map(line => JSON.parse(line)); },
    async close() { ws?.terminate(); if (child.exitCode === null) { const closed = new Promise(resolve => child.once("close", resolve)); child.kill(); await closed; } await rm(dir, { recursive: true, force: true }); },
  };
}

test("failed native Codex turns report errors and pause unconsumed follow-ups", { timeout: 30000 }, async () => {
  const s = await boot();
  try {
    s.ask("conv_failed", "failed-run", "[fail] [no-tools]");
    await waitFor(s.events, e => e.type === "assistant" && e.userMessageId === "failed-run");
    s.follow("conv_failed", "pending-fail", "wait");
    await waitFor(s.events, e => e.type === "steering_queued" && e.userMessageId === "pending-fail");
    const error = await waitFor(s.events, e => e.type === "error" && e.userMessageId === "failed-run");
    assert.match(error.text, /provider failed the turn/);
    await waitFor(s.events, e => e.type === "steering_paused" && e.conversationId === "conv_failed");
    assert.equal(s.events.some(e => e.type === "result" && e.subtype === "success" && e.userMessageId === "failed-run"), false);
    assert.equal((await s.log()).filter(e => e.method === "turn/start").length, 1);
  } finally { await s.close(); }
});

test("deleting a running Codex conversation clears its follow-ups and never recreates its history", { timeout: 30000 }, async () => {
  const s = await boot();
  try {
    s.ask("conv_delete", "delete-run", "[no-tools]");
    await waitFor(s.events, e => e.type === "assistant" && e.userMessageId === "delete-run");
    s.follow("conv_delete", "delete-follow", "wait");
    await waitFor(s.events, e => e.type === "steering_queued" && e.userMessageId === "delete-follow");
    assert.equal((await s.delete("conv_delete")).ok, true);
    assert.equal((await s.save("conv_delete")).status, 410);
    await delay(1100);
    const before = s.events.length;
    await s.reconnect();
    const snapshot = await waitFor(s.events, (e, index) => index >= before && e.type === "steering_snapshot");
    assert.equal(snapshot.items.some(e => e.conversationId === "conv_delete"), false);
    const history = await s.history("conv_delete");
    assert.equal(history.messages?.length || 0, 0);
    assert.equal((await s.log()).filter(e => e.method === "turn/start").length, 1);
  } finally { await s.close(); }
});

test("Codex tool-boundary steering preserves concurrent owners, images, history order and retry identity", { timeout: 30000 }, async () => {
  const s = await boot();
  try {
    for (const owner of ["conv_a", "conv_b"]) {
      s.ask(owner, `run-${owner}`);
      await waitFor(s.events, e => e.type === "assistant" && e.conversationId === owner);
      s.follow(owner, `follow-${owner}`, `follow ${owner}`, { images: [{ mediaType: "image/png", data: "aW1hZ2U=" }] });
      await waitFor(s.events, e => e.type === "steering_queued" && e.userMessageId === `follow-${owner}`);
    }
    await s.reconnect();
    for (const owner of ["conv_a", "conv_b"]) {
      const applied = await waitFor(s.events, e => e.type === "steering_applied" && e.userMessageId === `follow-${owner}`);
      assert.equal(applied.conversationId, owner);
      assert.equal(applied.safePoint, "item/completed");
      s.follow(owner, `follow-${owner}`, `follow ${owner}`);
      await waitFor(s.events, e => e.type === "done" && e.userMessageId === `run-${owner}`);
      const history = await s.history(owner);
      assert.deepEqual(history.messages.filter(m => m.text).map(m => [m.role, m.text]), [
        ["user", "hold"], ["assistant", "initial: hold"], ["user", `follow ${owner}`], ["assistant", `continued: follow ${owner}`],
      ]);
    }
    const log = await s.log(), starts = log.filter(e => e.method === "turn/start"), steers = log.filter(e => e.method === "turn/steer");
    assert.equal(starts.length, 2);
    assert.equal(steers.length, 2, "retrying a client ID never injects it twice");
    assert.equal(log.some(e => e.method === "turn/interrupt"), false);
    for (const request of steers) {
      assert.equal(request.params.expectedTurnId, `turn-${request.threadId}-1`);
      assert.equal(request.params.input[0].type, "localImage");
      assert.ok(log.slice(0, log.indexOf(request)).some(e => e.notice === "item/completed" && e.threadId === request.threadId),
        "a foreground boundary is required; child-thread tool completion cannot inject input");
      await assert.rejects(access(request.params.input[0].path), "temporary steering images are removed after the turn");
    }
  } finally { await s.close(); }
});

test("Codex safely starts the next turn if steering is rejected or confirmed unconsumed", { timeout: 30000 }, async () => {
  const s = await boot();
  try {
    for (const marker of ["[reject]", "[not-consumed]", "[no-tools]"]) {
      const owner = marker.replace(/\W/g, "");
      s.ask(owner, `run-${owner}`, marker);
      await waitFor(s.events, e => e.type === "assistant" && e.conversationId === owner);
      s.follow(owner, `follow-${owner}`, "fallback reply");
      await waitFor(s.events, e => e.type === "request_started" && e.userMessageId === `follow-${owner}`);
      await waitFor(s.events, e => e.type === "done" && e.userMessageId === `follow-${owner}`);
      assert.equal(s.events.some(e => e.type === "steering_applied" && e.userMessageId === `follow-${owner}`), false);
      const history = await s.history(owner);
      assert.equal(history.messages.filter(m => m.id === `follow-${owner}`).length, 1);
    }
  } finally { await s.close(); }
});

test("Codex stop pauses pending follow-ups and resume starts exactly one new turn", { timeout: 30000 }, async () => {
  const s = await boot();
  try {
    s.ask("stop", "run-stop", "[no-tools]");
    await waitFor(s.events, e => e.type === "assistant" && e.conversationId === "stop");
    s.follow("stop", "follow-stop", "resume once");
    await waitFor(s.events, e => e.type === "steering_queued" && e.userMessageId === "follow-stop");
    s.send({ stop: true, conversationId: "stop", userMessageId: "run-stop" });
    await waitFor(s.events, e => e.type === "steering_paused" && e.conversationId === "stop");
    await waitFor(s.events, e => e.type === "stopped" && e.conversationId === "stop");
    await delay(300);
    assert.equal((await s.log()).filter(e => e.method === "turn/start").length, 1);
    s.send({ type: "steering_resume", conversationId: "stop", userMessageId: "follow-stop" });
    await waitFor(s.events, e => e.type === "done" && e.userMessageId === "follow-stop");
    assert.equal((await s.log()).filter(e => e.method === "turn/start").length, 2);
  } finally { await s.close(); }
});

test("Codex stop during native acceptance preserves an unconsumed message as paused", { timeout: 30000 }, async () => {
  const s = await boot();
  try {
    s.ask("stop-race", "run-race", "[delay-consumption]");
    await waitFor(s.events, e => e.type === "assistant" && e.conversationId === "stop-race");
    s.follow("stop-race", "follow-race", "retain me");
    await waitFor(s.events, e => e.type === "steering_updated" && e.userMessageId === "follow-race" && e.claimed);
    s.send({ stop: true, conversationId: "stop-race", userMessageId: "run-race" });
    await waitFor(s.events, e => e.type === "steering_paused" && e.userMessageIds?.includes("follow-race"));
    await delay(300);
    assert.equal(s.events.some(e => e.type === "steering_applied" && e.userMessageId === "follow-race"), false);
    assert.equal((await s.log()).filter(e => e.method === "turn/start").length, 1);
  } finally { await s.close(); }
});

test("Codex changed model settings wait for the next turn instead of being silently ignored", { timeout: 30000 }, async () => {
  const s = await boot();
  try {
    s.ask("model-switch", "run-model");
    await waitFor(s.events, e => e.type === "assistant" && e.conversationId === "model-switch");
    s.follow("model-switch", "follow-model", "new model reply", { model: "new-model" });
    const queued = await waitFor(s.events, e => e.type === "steering_queued" && e.userMessageId === "follow-model");
    assert.equal(queued.delivery, "next_turn");
    await waitFor(s.events, e => e.type === "done" && e.userMessageId === "follow-model");
    const log = await s.log();
    assert.equal(log.some(e => e.method === "turn/steer"), false);
    assert.equal(log.filter(e => e.method === "turn/start")[1].params.model, "new-model");
  } finally { await s.close(); }
});

test("Codex queued edits and ordering are preserved when multiple inputs enter the same native turn", { timeout: 30000 }, async () => {
  const s = await boot();
  try {
    s.ask("ordered", "run-ordered");
    await waitFor(s.events, e => e.type === "assistant" && e.conversationId === "ordered");
    s.follow("ordered", "follow-one", "original one");
    s.follow("ordered", "follow-two", "second first");
    await waitFor(s.events, e => e.type === "steering_queued" && e.userMessageId === "follow-two");
    s.send({ type: "steering_update", conversationId: "ordered", userMessageId: "follow-one", prompt: "edited one", displayText: "edited one" });
    s.send({ type: "steering_reorder", conversationId: "ordered", order: ["follow-two", "follow-one"] });
    await waitFor(s.events, e => e.type === "steering_reordered" && e.conversationId === "ordered");
    await waitFor(s.events, e => e.type === "done" && e.userMessageId === "run-ordered");
    const steers = (await s.log()).filter(e => e.method === "turn/steer");
    assert.deepEqual(steers.map(e => e.params.clientUserMessageId), ["follow-two", "follow-one"]);
    assert.deepEqual(steers.map(e => e.params.input.at(-1).text), ["second first", "edited one"]);
    assert.equal(s.events.filter(e => e.type === "steering_applied").length, 2);
    const history = await s.history("ordered");
    assert.deepEqual(history.messages.filter(e => e.role === "user").map(e => e.text), ["hold", "second first", "edited one"]);
  } finally { await s.close(); }
});

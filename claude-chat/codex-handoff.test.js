import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { WebSocket } from "ws";

test("server uses SDK only for text → image → text and resumes the same thread", { timeout: 20_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "codex-handoff-"));
  const net = createServer();
  await new Promise(resolve => net.listen(0, "127.0.0.1", resolve));
  const port = net.address().port;
  await new Promise(resolve => net.close(resolve));
  const mock = join(scratch, "mock.mjs");
  const loader = join(scratch, "loader.mjs");
  await writeFile(mock, `
    import { readFileSync } from 'node:fs';
    let owner = false, rounds = 0;
    export function codexRuntimeSignature() { return 'sig'; }
    export function codexRuntimeReusable() { return false; }
    export class PersistentCodexRuntime {
      constructor() { throw Error('persistent runtime must never be created'); }
    }
    function thread(id) {
      return {async runStreamed(input) {
        if (owner) throw Error('already has an active writer');
        owner = true;
        const round = rounds++;
        if (round === 1) {
          const image = input.find(part => part.type === 'local_image');
          if (!image || readFileSync(image.path, 'utf8') !== 'hello') throw Error('lost image');
        } else if (typeof input !== 'string' || !input.includes('question ' + round)) {
          throw Error('lost text');
        }
        return {events: (async function*() {
          try {
            yield {type: 'thread.started', thread_id: id};
            yield {type: 'turn.completed'};
            await new Promise(resolve => setTimeout(resolve, 80));
          } finally { owner = false; }
        })()};
      }};
    }
    export class Codex {
      resumeThread(id) {
        if (id !== 'handoff-thread' || rounds === 0) throw Error('lost conversation history');
        return thread(id);
      }
      startThread() {
        if (rounds !== 0) throw Error('unexpected replacement conversation');
        return thread('handoff-thread');
      }
    }
  `);
  await writeFile(loader, `
    export async function resolve(specifier, context, next) {
      if (specifier === '@openai/codex-sdk' || specifier === './codex-runtime.js')
        return {url: ${JSON.stringify(pathToFileURL(mock).href)}, shortCircuit: true};
      return next(specifier, context);
    }
  `);
  const auth = join(scratch, "auth.json");
  await writeFile(auth, JSON.stringify({ activeProfileId: "codex", profiles: [{id: "codex", name: "Codex", provider: "codex"}] }));
  const child = spawn(process.execPath, ["--experimental-loader", pathToFileURL(loader).href, "server.js"], {
    cwd: new URL(".", import.meta.url), windowsHide: true,
    env: {...process.env, PORT: String(port), HOST: "127.0.0.1", DESKTOP_AGENT_TOKEN: "test", CLAUDE_CHAT_DATA_DIR: scratch, CLAUDE_CHAT_AUTH_PROFILE_FILE: auth, CODEX_APP_SERVER_BIN: "mock", CODEX_PERSISTENT: "0"},
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "", ws;
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const delay = () => new Promise(resolve => setTimeout(resolve, 20));
  try {
    const deadline = Date.now() + 8000;
    while (!output.includes("claude-chat listening")) {
      if (Date.now() > deadline || child.exitCode !== null) throw Error(output);
      await delay();
    }
    ws = new WebSocket('ws://127.0.0.1:' + port + '/?token=test');
    const events = [];
    ws.on("message", data => events.push(JSON.parse(data)));
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    for (let i = 0; i < 3; i++) {
      const start = events.length;
      ws.send(JSON.stringify({prompt: 'question ' + i, conversationId: 'handoff', userMessageId: 'q' + i,
        ...(i === 1 ? {images: [{mediaType: 'image/png', data: 'aGVsbG8='}]} : {})}));
      const end = Date.now() + 4000;
      while (!events.slice(start).some(e => e.type === 'done')) {
        if (Date.now() > end) throw Error(JSON.stringify(events.slice(start)) + output);
        await delay();
      }
      assert.deepEqual(events.slice(start).filter(e => e.type === 'error'), []);
      assert.ok(events.slice(start).some(e => e.type === 'result' && e.subtype === 'success'));
    }
    assert.equal(events.filter(e => e.type === 'session').length, 3);
    assert.ok(events.filter(e => e.type === 'session').every(e => e.sessionId === 'handoff-thread'));
  } finally {
    ws?.terminate();
    if (child.exitCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve));
      child.kill();
      await closed;
    }
    await rm(scratch, {recursive: true, force: true});
  }
});

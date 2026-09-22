import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { WebSocket } from "ws";

/* codex 的 thread error（ThreadEvent 里 type: "error"）不是这一轮失败：上游
   发完它返回的还是 CodexStatus::Running，真失败只有 turn.failed 一个信号。
   把重连通知当致命错误 throw，等于在 codex 刚说「我在重连」的那一刻掐掉整轮，
   后面 3 次重试和 WebSocket→HTTPS 的降级一次都走不到。

   四种收场各守一轮。详细来历写在 providers/codex.js 的 retryStatusText 上面。 */

const RECONNECT = "Reconnecting... 2/5 (stream disconnected before completion: websocket closed by server before response.completed)";
const EXHAUSTED = "Reconnecting... 5/5 (stream disconnected before completion: websocket closed by server before response.completed)";
const OTHER_NOTICE = "Previous response was not found. Retrying the full request.";

test("codex: 断流重连不中断这一轮，只有 turn.failed 才算失败", { timeout: 25_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "codex-retry-"));
  const net = createServer();
  await new Promise(resolve => net.listen(0, "127.0.0.1", resolve));
  const port = net.address().port;
  await new Promise(resolve => net.close(resolve));
  const mock = join(scratch, "mock.mjs");
  const loader = join(scratch, "loader.mjs");
  await writeFile(mock, `
    let rounds = 0;
    const RECONNECT = ${JSON.stringify(RECONNECT)};
    const EXHAUSTED = ${JSON.stringify(EXHAUSTED)};
    const OTHER_NOTICE = ${JSON.stringify(OTHER_NOTICE)};
    const message = text => ({type: 'item.completed', item: {id: 'i0', type: 'agent_message', text}});
    const SCRIPTS = [
      // 0：重连一次之后把话说完——codex 自己重试成功了，这一轮就该是成功的
      [{type: 'error', message: RECONNECT}, message('recovered'), {type: 'turn.completed'}],
      // 1：重连以外的提醒同样不该中断，它只是一张卡片
      [{type: 'error', message: OTHER_NOTICE}, message('still fine'), {type: 'turn.completed'}],
      // 2：5 次用尽，codex 把 last_critical_error 原样搬进 turn.failed
      [{type: 'error', message: EXHAUSTED}, {type: 'turn.failed', error: {message: EXHAUSTED}}],
      // 3：事件流没了，既没 completed 也没 failed（子进程半路死掉）
      [{type: 'error', message: EXHAUSTED}],
    ];
    export function codexRuntimeSignature() { return 'sig'; }
    export function codexRuntimeReusable() { return false; }
    export class PersistentCodexRuntime {
      constructor() { throw Error('persistent runtime must never be created'); }
    }
    function thread(id) {
      return {async runStreamed() {
        const script = SCRIPTS[rounds++] ?? [];
        return {events: (async function*() {
          yield {type: 'thread.started', thread_id: id};
          yield {type: 'turn.started'};
          for (const event of script) yield event;
        })()};
      }};
    }
    export class Codex {
      resumeThread(id) { return thread(id); }
      startThread() { return thread('retry-thread'); }
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

    const round = async (index) => {
      const start = events.length;
      ws.send(JSON.stringify({prompt: 'question ' + index, conversationId: 'retry', userMessageId: 'q' + index}));
      const end = Date.now() + 5000;
      while (!events.slice(start).some(e => e.type === 'done')) {
        if (Date.now() > end) throw Error(JSON.stringify(events.slice(start)) + output);
        await delay();
      }
      return events.slice(start);
    };

    // 0：重连通知挂到状态行上，这一轮照常跑完
    const recovered = await round(0);
    assert.deepEqual(recovered.filter(e => e.type === 'error'), [],
      "重连通知把整轮掐了——codex 那会儿还在 Running");
    const retryStatus = recovered.find(e => e.type === 'system' && e.subtype === 'stream_retry');
    assert.ok(retryStatus, "重连没告诉前端，界面上看着像卡死了");
    assert.equal(retryStatus.text, "连接中断，正在重连（2/5）…");
    assert.ok(recovered.some(e => e.type === 'result' && e.subtype === 'success'));
    // 重连过后来的第一条真事件要把状态行换回去，不能一直挂着「正在重连」
    assert.ok(recovered.slice(recovered.indexOf(retryStatus) + 1)
      .some(e => e.type === 'system' && e.subtype === 'status' && e.status === 'requesting'),
      "状态行停在了重连上");

    // 1：重连以外的提醒显示成卡片，同样不中断
    const noticed = await round(1);
    assert.deepEqual(noticed.filter(e => e.type === 'error'), []);
    assert.ok(noticed.some(e => JSON.stringify(e).includes(OTHER_NOTICE)), "提醒被吞了");
    assert.ok(noticed.some(e => e.type === 'result' && e.subtype === 'success'));

    // 2：重试用尽，这才是真失败——但别把「正在重连」当成失败原因讲给人听
    const failed = await round(2);
    const error = failed.find(e => e.type === 'error');
    assert.ok(error, "turn.failed 之后没报错");
    assert.match(error.text, /连接反复中断/);
    assert.match(error.text, /Reconnecting\.\.\. 5\/5/);   // 原文留着好排查
    assert.ok(!failed.some(e => e.type === 'result' && e.subtype === 'success'));

    // 3：事件流断了却没有终结事件，拿最后那条 error 收场，不能报成功
    const truncated = await round(3);
    assert.ok(truncated.some(e => e.type === 'error'), "流断了却报了成功");
    assert.ok(!truncated.some(e => e.type === 'result' && e.subtype === 'success'));
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

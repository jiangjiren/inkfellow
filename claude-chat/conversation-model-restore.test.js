import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { WebSocket } from "ws";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function reservePort() {
  const net = createServer();
  await new Promise(resolve => net.listen(0, "127.0.0.1", resolve));
  const { port } = net.address();
  await new Promise(resolve => net.close(resolve));
  return port;
}

/* 起一个真服务端，Codex SDK 换成假的：这里要验的是历史和上下文，不该烧额度。
   假 SDK 把每轮收到的 prompt 记在 scratch 里的一个文件上，测试读它。 */
async function bootServer(scratch, port) {
  const captured = join(scratch, "captured.json");
  const mock = join(scratch, "mock.mjs");
  const loader = join(scratch, "loader.mjs");
  await writeFile(mock, `
    import { appendFileSync } from 'node:fs';
    function thread(id) {
      return { async runStreamed(input) {
        appendFileSync(${JSON.stringify(captured)}, JSON.stringify(input) + '\\n');
        return { events: (async function*() {
          yield { type: 'thread.started', thread_id: id };
          yield { type: 'turn.completed' };
        })() };
      } };
    }
    export class Codex {
      startThread() { return thread('thread-new'); }
      resumeThread(id) { return thread(id); }
    }
  `);
  await writeFile(loader, `
    export async function resolve(specifier, context, next) {
      if (specifier === '@openai/codex-sdk')
        return { url: ${JSON.stringify(pathToFileURL(mock).href)}, shortCircuit: true };
      return next(specifier, context);
    }
  `);
  const auth = join(scratch, "auth.json");
  await writeFile(auth, JSON.stringify({
    activeProfileId: "p_codex",
    profiles: [{ id: "p_codex", name: "ChatGPT 会员", provider: "codex" }],
  }));
  let output = "";
  const child = spawn(process.execPath, ["--experimental-loader", pathToFileURL(loader).href, "server.js"], {
    cwd: new URL(".", import.meta.url), windowsHide: true,
    env: {
      ...process.env, PORT: String(port), HOST: "127.0.0.1", DESKTOP_AGENT_TOKEN: "test",
      CLAUDE_CHAT_DATA_DIR: scratch, CLAUDE_CHAT_AUTH_PROFILE_FILE: auth,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const deadline = Date.now() + 8000;
  while (!output.includes("claude-chat listening")) {
    if (Date.now() > deadline || child.exitCode !== null) throw Error(output);
    await delay(20);
  }
  return { child, captured, output: () => output };
}

async function shutdown(child, scratch) {
  if (child.exitCode === null) {
    const closed = new Promise(resolve => child.once("close", resolve));
    child.kill();
    await closed;
  }
  await rm(scratch, { recursive: true, force: true });
}

test("历史记录存得下并取得回这条对话用的厂商和模型", { timeout: 20_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "conv-model-restore-"));
  const port = await reservePort();
  const { child } = await bootServer(scratch, port);
  const base = `http://127.0.0.1:${port}`;
  try {
    const saved = {
      title: "青松项目", date: "2026-01-01T00:00:00.000Z",
      sessionId: "thread-abc", sessionProvider: "codex",
      model: "gpt-5.4", effort: "high", profileId: "p_codex",
      messages: [{ id: "u1", role: "user", text: "项目叫青松" }],
    };
    const put = await fetch(`${base}/api/history/conv-0001`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(saved),
    });
    assert.equal(put.status, 200);

    // 列表摘要要带上——切对话时前端拿的就是这一份
    const [summary] = await (await fetch(`${base}/api/history`)).json();
    assert.equal(summary.id, "conv-0001");
    assert.equal(summary.model, "gpt-5.4");
    assert.equal(summary.effort, "high");
    assert.equal(summary.profileId, "p_codex");
    assert.equal(summary.sessionProvider, "codex");

    // 单条详情同样要带
    const full = await (await fetch(`${base}/api/history/conv-0001`)).json();
    assert.equal(full.model, "gpt-5.4");
    assert.equal(full.profileId, "p_codex");

    // 只改模型、带原来的 date：不该把这条对话顶到列表最前面，也不该丢消息
    await fetch(`${base}/api/history/conv-0001`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.4-codex", effort: "medium", profileId: "p_codex", date: saved.date }),
    });
    const after = await (await fetch(`${base}/api/history/conv-0001`)).json();
    assert.equal(after.model, "gpt-5.4-codex");
    assert.equal(after.effort, "medium");
    assert.equal(after.date, saved.date);
    assert.equal(after.messages.length, 1, "只补选择不该动消息");
    assert.equal(after.title, "青松项目");
  } finally {
    await shutdown(child, scratch);
  }
});

test("换到没有原生会话的模型时，prompt 带上之前聊过的内容", { timeout: 20_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "conv-model-carry-"));
  const port = await reservePort();
  const { child, captured } = await bootServer(scratch, port);
  const base = `http://127.0.0.1:${port}`;
  let ws;
  try {
    // 这条对话此前在别家聊过，Codex 这边没有 thread 可续接
    await fetch(`${base}/api/history/conv-0001`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "青松项目", sessionProvider: "antigravity",
        messages: [
          { id: "u1", role: "user", text: "项目叫青松，用 SQLite。" },
          { id: "a1", role: "assistant", text: "先完成离线编辑。" },
        ],
      }),
    });

    ws = new WebSocket(`ws://127.0.0.1:${port}/?token=test`);
    const events = [];
    ws.on("message", data => events.push(JSON.parse(data)));
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ prompt: "接着做", conversationId: "conv-0001", userMessageId: "q1" }));
    const deadline = Date.now() + 8000;
    while (!events.some(e => e.type === "done")) {
      if (Date.now() > deadline) throw Error(JSON.stringify(events));
      await delay(20);
    }
    assert.deepEqual(events.filter(e => e.type === "error"), []);

    const sent = (await import("node:fs")).readFileSync(captured, "utf8").trim();
    assert.match(sent, /项目叫青松，用 SQLite。/, "新模型要看得到之前的用户消息");
    assert.match(sent, /先完成离线编辑。/, "也要看得到之前的回答");
    assert.ok(sent.endsWith(JSON.stringify("接着做").slice(1, -1) + '"'), "当前这轮的问题要在最后");
  } finally {
    ws?.terminate();
    await shutdown(child, scratch);
  }
});

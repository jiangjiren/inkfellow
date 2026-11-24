// P1 游标同步协议的集成测试（契约见 _design/p1-event-log.md 第 3 节）。
// 和 server-request.test.js 一样把 server.js 拉到子进程里跑：import 即 listen。
//
// 这些用例定义的是"客户端断线/刷新之后能不能不丢内容"这条不变量，
// 不依赖真实 Agent SDK——用 REST 写入会话，再用 WS 的 hello/sync 读回来。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const HERE = new URL(".", import.meta.url);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

const PROBE_PROFILES = {
  activeProfileId: "p_claude",
  profiles: [{ id: "p_claude", name: "Claude 会员", provider: "claude", apiKey: "", baseUrl: "" }],
};

async function startServer({ mockFellow = false, sharedScratch = null, nativeFellow = false, wechatGateway = null } = {}) {
  const scratch = await mkdtemp(join(tmpdir(), "inkfellow-sync-test-"));
  const authFile = join(scratch, "auth-profile.json");
  await writeFile(authFile, JSON.stringify(PROBE_PROFILES), "utf8");
  const port = await reservePort();
  const cli = fileURLToPath(new URL("fixtures/fake-fellow-native.mjs", HERE));
  if (nativeFellow) {
    await mkdir(join(scratch, "codex"));
    await mkdir(join(scratch, ".gemini", "antigravity-cli"), { recursive: true });
    await writeFile(join(scratch, "codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "fixture-key" }));
  }
  if (wechatGateway) {
    await writeFile(join(scratch, `wechat-bot-${port}.json`), JSON.stringify({
      token: "fixture-token", baseUrl: wechatGateway, userId: "owner@im.wechat",
    }));
  }

  const child = spawn(process.execPath, [
    ...(mockFellow ? ["--experimental-loader", "./fixtures/sdk-loader.mjs"] : []),
    "server.js",
  ], {
    cwd: HERE,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      VAULT_PATH: sharedScratch || scratch,
      CLAUDE_CHAT_DATA_DIR: sharedScratch || scratch,
      CLAUDE_CHAT_AUTH_PROFILE_FILE: authFile,
      ...(nativeFellow ? {
        AGY_BIN: cli, CODEX_BIN: cli, CODEX_HOME: join(scratch, "codex"),
        HOME: scratch, USERPROFILE: scratch, CODEX_PERSISTENT: "1",
      } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });

  const deadline = Date.now() + 15_000;
  while (!output.includes("claude-chat listening")) {
    if (child.exitCode != null) throw new Error(`server.js 提前退出 (${child.exitCode}): ${output}`);
    if (Date.now() >= deadline) throw new Error(`server.js 未能启动: ${output}`);
    await delay(20);
  }

  return {
    port,
    scratch,
    log: () => output,
    async stop() {
      child.kill("SIGKILL");
      await new Promise(resolve => child.once("exit", resolve));
      await rm(scratch, { recursive: true, force: true });
    },
  };
}

async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const events = [];
  ws.on("message", raw => {
    try { events.push(JSON.parse(raw.toString())); } catch { /* 非 JSON 帧忽略 */ }
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return { ws, events };
}

async function waitForMessage(events, predicate, startIndex = 0, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let i = startIndex; i < events.length; i += 1) {
      if (predicate(events[i])) return events[i];
    }
    await delay(10);
  }
  throw new Error(`等待 WS 事件超时；已收到: ${JSON.stringify(events.slice(startIndex))}`);
}

async function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await check();
    if (found) return found;
    await delay(30);
  }
  throw new Error("Timed out waiting for Fellow state");
}

// 用 REST 造一个有内容的会话，避免依赖真实模型调用
async function seedConversation(port, id, messages) {
  const res = await fetch(`http://127.0.0.1:${port}/api/history/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, title: "同步测试", date: new Date().toISOString(), messages }),
  });
  assert.equal(res.status, 200);
}

const SEED_MESSAGES = [
  { id: "u_0001", role: "user", text: "第一个问题", cost: null },
  {
    id: "a_0001",
    role: "assistant",
    text: "第一个回答",
    blocks: [{ type: "text", text: "第一个回答", raw: { type: "text", text: "第一个回答" } }],
    events: [],
    cost: 0.01,
    status: "complete",
  },
];

test("Fellow dispatches two independent workers, queues overlapping writes, and resumes the right history", { timeout: 30_000 }, async () => {
  const server = await startServer({ mockFellow: true });
  const sockets = [];
  try {
    const base = `http://127.0.0.1:${server.port}/api`;
    async function post(path, body = {}) {
      const res = await fetch(`${base}/fellow/${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const json = await res.json();
      assert.ok(res.ok, JSON.stringify(json));
      return json;
    }
    async function read(path) { return (await fetch(`${base}/${path}`)).json(); }
    async function poll(check) {
      for (let i = 0; i < 350; i++) {
        const result = await check();
        if (result) return result;
        await delay(20);
      }
      throw new Error("Fellow state did not settle");
    }

    const manager = await connect(server.port);
    sockets.push(manager.ws);
    manager.ws.send(JSON.stringify({
      conversationId: "strategist", prompt: "派出测试工单", userMessageId: "test_manager_1", profileId: "p_claude",
    }));
    await waitForMessage(manager.events, event => event.type === "done" && event.conversationId === "strategist");
    const board = (await read("fellow/tickets")).tickets;
    const [a, b, next] = ["甲任务", "乙任务", "甲的后续"].map(title => board.find(ticket => ticket.title === title));
    assert.equal(a.status, "running");
    assert.equal(b.status, "running");
    assert.equal(next.status, "queued");
    assert.deepEqual(next.blockedBy, [a.id]);

    const worker = await connect(server.port);
    sockets.push(worker.ws);
    worker.ws.send(JSON.stringify({ type: "hello", conversationId: b.workerConversationId, lastSeq: 0 }));
    const firstSync = await waitForMessage(worker.events, event => event.type === "sync");
    assert.equal(firstSync.turn.status, "running");
    assert.match(JSON.stringify(firstSync.events), /hold-two/);
    assert.doesNotMatch(JSON.stringify(firstSync.events), /hold-one/);
    worker.ws.terminate();
    const reconnect = await connect(server.port);
    sockets.push(reconnect.ws);
    reconnect.ws.send(JSON.stringify({ type: "hello", conversationId: b.workerConversationId, lastSeq: firstSync.lastSeq }));
    assert.equal((await waitForMessage(reconnect.events, event => event.type === "sync")).turn.status, "running");

    await post(`tickets/${a.id}/stop`);
    await poll(async () => (await read(`fellow/tickets/${next.id}`)).ticket.status === "completed");
    assert.equal((await read(`fellow/tickets/${a.id}`)).ticket.status, "stopped");
    assert.equal((await read(`fellow/tickets/${b.id}`)).ticket.status, "running");

    const checked = await post("tickets", { title: "确认写入范围", brief: "check-write-scope", writeScope: ["c.md"] });
    const outcome = await poll(async () => {
      const { ticket } = await read(`fellow/tickets/${checked.ticketId}`);
      return ticket.status === "completed" && ticket;
    });
    assert.equal(outcome.summary, "allow,deny,deny,deny");
    const asking = await post("tickets", { title: "等待拍板", brief: "ask-worker", writeScope: ["d.md"] });
    await poll(async () => (await read(`fellow/tickets/${asking.ticketId}`)).ticket.status === "needs_attention");
    const startIndex = reconnect.events.length;
    reconnect.ws.send(JSON.stringify({ type: "hello", conversationId: asking.workerConversationId, lastSeq: 0 }));
    const question = await waitForMessage(reconnect.events, event => event.type === "ask_user_question", startIndex);
    reconnect.ws.send(JSON.stringify({
      type: "ask_user_question_response", requestId: question.requestId, answers: { "选哪一个？": "乙" },
    }));
    await poll(async () => (await read(`fellow/tickets/${asking.ticketId}`)).ticket.summary === "已选择 乙");
    const readOnly = await fetch(`${base}/history/${b.workerConversationId}`, { method: "DELETE" });
    assert.equal(readOnly.status, 405);
    const forbidden = await fetch(`${base}/fellow/tickets`, { headers: { Origin: "https://foreign.example" } });
    assert.equal(forbidden.status, 403);

    const message = { instruction: "补充细节", requestId: "followup_test_1" };
    await post(`tickets/${next.id}/message`, message);
    await post(`tickets/${next.id}/message`, message);
    await poll(async () => (await read(`fellow/tickets/${next.id}`)).ticket.summary === "echo:补充细节");
    const history = await read(`history/${next.workerConversationId}`);
    assert.equal(history.messages.filter(message => message.text === "补充细节").length, 1);
    await poll(async () => (await read("history/strategist")).messages.some(message => (
      message.role === "assistant" && message.text.includes("后台任务汇报") && message.text.includes("甲的后续")
    )));
    await post(`tickets/${b.id}/stop`);
  } finally {
    for (const ws of sockets) ws.terminate();
    await server.stop();
  }
});

test("hello 带 lastSeq=0 时回放整段会话", { timeout: 30_000 }, async () => {
  const server = await startServer();
  try {
    await seedConversation(server.port, "convsync0001", SEED_MESSAGES);
    const { ws, events } = await connect(server.port);
    ws.send(JSON.stringify({ type: "hello", conversationId: "convsync0001", lastSeq: 0 }));

    const sync = await waitForMessage(events, e => e.type === "sync");
    assert.equal(sync.conversationId, "convsync0001");
    assert.ok(sync.lastSeq > 0, "lastSeq 应该大于 0");
    // 要么给增量事件，要么给快照，两者必居其一
    assert.ok(Array.isArray(sync.events) || sync.reset === true);
    ws.close();
  } finally {
    await server.stop();
  }
});

test("Fellow tickets stay with their chat instance when two ports share a data directory", { timeout: 30_000 }, async () => {
  const first = await startServer({ mockFellow: true });
  let second;
  try {
    const base = instance => `http://127.0.0.1:${instance.port}/api/fellow/tickets`;
    const response = await fetch(base(first), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "实例一", brief: "hold-instance", writeScope: ["a.md"] }),
    });
    const ticket = await response.json();
    assert.equal(ticket.status, "running");
    second = await startServer({ mockFellow: true, sharedScratch: first.scratch });
    const secondBoard = await (await fetch(base(second))).json();
    assert.deepEqual(secondBoard.tickets, []);
    const firstTicket = await (await fetch(`${base(first)}/${ticket.ticketId}`)).json();
    assert.equal(firstTicket.ticket.status, "running");
  } finally {
    await second?.stop();
    await first.stop();
  }
});

test("Codex and Gemini Fellow dispatch through native MCP, write in scope, and reuse the Web runtime", { timeout: 30_000 }, async () => {
  const server = await startServer({ mockFellow: true, nativeFellow: true });
  const clients = [];
  try {
    const base = `http://127.0.0.1:${server.port}/api`;
    for (const [index, profileId] of ["p_codex", "p_antigravity"].entries()) {
      const client = await connect(server.port);
      clients.push(client.ws);
      async function send(conversationId, prompt, n) {
        const start = client.events.length;
        client.ws.send(JSON.stringify({ conversationId, prompt, profileId, permissionMode: "plan", userMessageId: `p01_${index}_${n}` }));
        await waitForMessage(client.events, event => event.type === "done" && event.conversationId === conversationId, start, 8000);
        assert.deepEqual(client.events.slice(start).filter(event => event.type === "error"), []);
      }
      await send("strategist", "派出原生测试", 0);
      const ticket = await waitFor(async () => {
        const { tickets } = await (await fetch(`${base}/fellow/tickets`)).json();
        const match = tickets.find(item => item.title === `原生任务 ${profileId}`);
        if (match?.status === "failed") throw new Error(match.error);
        return match?.status === "completed" && match;
      });
      assert.equal(await readFile(join(server.scratch, `原生任务 ${profileId}.md`), "utf8"), "abcdef\n");
      await assert.rejects(readFile(join(server.scratch, "越界文件.md")), { code: "ENOENT" });
      const artifactBase = `${base}/fellow/tickets/${ticket.id}/artifacts`;
      const { artifacts } = await (await fetch(artifactBase)).json();
      assert.equal(artifacts.length, 1);
      const delivery = await fetch(`${artifactBase}/${artifacts[0].id}?download=1`, { headers: { Range: "bytes=2-4" } });
      assert.equal(delivery.status, 206);
      assert.match(delivery.headers.get("content-disposition"), /^attachment/);
      assert.equal(await delivery.text(), "cde");
      const crossSite = await fetch(`${artifactBase}/${artifacts[0].id}`, { headers: { Origin: "https://foreign.example" } });
      assert.equal(crossSite.status, 403);

      const conversationId = `normal_native_${profileId}`;
      await send(conversationId, "first", 1);
      await send(conversationId, "second", 2);
      const history = await (await fetch(`${base}/history/${conversationId}`)).json();
      const runtimeIds = history.messages.filter(message => message.role === "assistant")
        .map(message => /runtime:(\d+)/.exec(message.text)?.[1]).filter(Boolean);
      assert.equal(runtimeIds.length, 2);
      assert.equal(runtimeIds[0], runtimeIds[1]);
    }
  } finally {
    for (const ws of clients) ws.terminate();
    await server.stop();
  }
});

test("WeChat dispatches into the Web ticket board and only the originating peer receives the report", { timeout: 30_000 }, async () => {
  let polled = false;
  const deliveries = [];
  const gateway = createHttpServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body || "{}");
    let reply = {};
    if (request.url.endsWith("getupdates")) {
      if (!polled) {
        polled = true;
        reply = { msgs: [{
          from_user_id: "owner@im.wechat", context_token: "owner-context", item_list: [{ type: 1, text_item: { text: "微信派单演练" } }],
        }, {
          from_user_id: "other@im.wechat", context_token: "other-context", item_list: [{ type: 1, text_item: { text: "你好" } }],
        }] };
      } else await delay(100);
    } else if (request.url.endsWith("sendmessage")) deliveries.push(message);
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(reply));
  });
  await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
  let server;
  try {
    server = await startServer({ mockFellow: true, nativeFellow: true, wechatGateway: `http://127.0.0.1:${gateway.address().port}` });
    const endpoint = `http://127.0.0.1:${server.port}/api/fellow/tickets`;
    await waitFor(async () => {
      const { tickets } = await (await fetch(endpoint)).json();
      const ticket = tickets.find(item => item.title === "微信原生工单");
      if (ticket?.status === "failed") throw new Error(ticket.error);
      return ticket?.status === "completed";
    });
    const report = await waitFor(() => deliveries.find(item => JSON.stringify(item).includes("Fellow 后台任务汇报")));
    assert.match(JSON.stringify(report), /owner@im.wechat/);
    assert.match(JSON.stringify(report), /owner-context/);
    assert.doesNotMatch(JSON.stringify(report), /other@im.wechat|other-context/);
  } finally {
    await server?.stop();
    gateway.closeAllConnections();
    await new Promise(resolve => gateway.close(resolve));
  }
});

test("hello 带上已同步的 lastSeq 时不再重复回放", { timeout: 30_000 }, async () => {
  const server = await startServer();
  try {
    await seedConversation(server.port, "convsync0002", SEED_MESSAGES);
    const first = await connect(server.port);
    first.ws.send(JSON.stringify({ type: "hello", conversationId: "convsync0002", lastSeq: 0 }));
    const sync1 = await waitForMessage(first.events, e => e.type === "sync");
    first.ws.close();

    const second = await connect(server.port);
    second.ws.send(JSON.stringify({ type: "hello", conversationId: "convsync0002", lastSeq: sync1.lastSeq }));
    const sync2 = await waitForMessage(second.events, e => e.type === "sync");
    assert.equal(sync2.lastSeq, sync1.lastSeq);
    assert.equal(sync2.reset, undefined, "游标已是最新，不该触发快照重置");
    assert.deepEqual(sync2.events, [], "游标已是最新，不该有增量事件");
    second.ws.close();
  } finally {
    await server.stop();
  }
});

test("未知会话的 hello 不报错，回一个空 sync", { timeout: 30_000 }, async () => {
  const server = await startServer();
  try {
    const { ws, events } = await connect(server.port);
    ws.send(JSON.stringify({ type: "hello", conversationId: "convsyncmissing", lastSeq: 0 }));
    const sync = await waitForMessage(events, e => e.type === "sync");
    assert.equal(sync.conversationId, "convsyncmissing");
    assert.equal(sync.lastSeq, 0);
    assert.equal(sync.turn, null);
    ws.close();
  } finally {
    await server.stop();
  }
});

test("conversationId 为 null 的 hello 被安全忽略", { timeout: 30_000 }, async () => {
  const server = await startServer();
  try {
    const { ws, events } = await connect(server.port);
    ws.send(JSON.stringify({ type: "hello", conversationId: null, lastSeq: 0 }));
    const sync = await waitForMessage(events, e => e.type === "sync");
    assert.equal(sync.conversationId, null);
    assert.equal(sync.lastSeq, 0);
    assert.equal(sync.turn, null);
    ws.close();
  } finally {
    await server.stop();
  }
});

test("客户端 lastSeq 超前于服务端时走快照重置", { timeout: 30_000 }, async () => {
  const server = await startServer();
  try {
    await seedConversation(server.port, "convsync0003", SEED_MESSAGES);
    const { ws, events } = await connect(server.port);
    // 服务端数据被重置过、客户端游标还停在旧的高位——不能静默什么都不发
    ws.send(JSON.stringify({ type: "hello", conversationId: "convsync0003", lastSeq: 999_999 }));
    const sync = await waitForMessage(events, e => e.type === "sync");
    assert.equal(sync.reset, true);
    assert.ok(sync.snapshot && Array.isArray(sync.snapshot.messages));
    ws.close();
  } finally {
    await server.stop();
  }
});

test("目录穿越的 conversationId 被拒绝且不写盘", { timeout: 30_000 }, async () => {
  const server = await startServer();
  try {
    const { ws, events } = await connect(server.port);
    ws.send(JSON.stringify({ type: "hello", conversationId: "../../etc/passwd", lastSeq: 0 }));
    const sync = await waitForMessage(events, e => e.type === "sync");
    assert.equal(sync.lastSeq, 0);
    assert.equal(sync.turn, null);
    ws.close();
    // 进程还活着说明没被非法路径搞崩
    const probe = await fetch(`http://127.0.0.1:${server.port}/api/history`);
    assert.equal(probe.status, 200);
  } finally {
    await server.stop();
  }
});

test("REST 历史接口在事件日志之上保持原有形状", { timeout: 30_000 }, async () => {
  const server = await startServer();
  try {
    await seedConversation(server.port, "convsync0004", SEED_MESSAGES);

    const listRes = await fetch(`http://127.0.0.1:${server.port}/api/history`);
    const list = await listRes.json();
    const summary = list.find(item => item.id === "convsync0004");
    assert.ok(summary, "列表里应该有这个会话");
    assert.equal(summary.messageCount, 2);
    assert.equal(typeof summary.title, "string");
    assert.equal(typeof summary.date, "string");

    const detailRes = await fetch(`http://127.0.0.1:${server.port}/api/history/convsync0004`);
    const conv = await detailRes.json();
    assert.equal(conv.id, "convsync0004");
    assert.equal(conv.messages.length, 2);
    assert.equal(conv.messages[0].role, "user");
    assert.equal(conv.messages[0].text, "第一个问题");
    assert.equal(conv.messages[1].role, "assistant");
    assert.equal(conv.messages[1].text, "第一个回答");
    assert.equal(conv.messages[1].cost, 0.01);
    assert.equal(conv.messages[1].blocks.length, 1);

    const delRes = await fetch(`http://127.0.0.1:${server.port}/api/history/convsync0004`, { method: "DELETE" });
    assert.equal(delRes.status, 200);
    const goneRes = await fetch(`http://127.0.0.1:${server.port}/api/history/convsync0004`);
    assert.equal(goneRes.status, 404);
  } finally {
    await server.stop();
  }
});

test("客户端把未改动的完整会话 PUT 回来时不重写事件日志或重置 seq", { timeout: 30_000 }, async () => {
  const server = await startServer();
  try {
    const id = "convsync0005";
    await seedConversation(server.port, id, SEED_MESSAGES);
    const detail = await fetch(`http://127.0.0.1:${server.port}/api/history/${id}`).then(res => res.json());
    const logFile = join(server.scratch, "conversations", String(server.port), id, "events.ndjson");
    const before = await readFile(logFile, "utf8");

    const put = await fetch(`http://127.0.0.1:${server.port}/api/history/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(detail),
    });
    assert.equal(put.status, 200);
    assert.equal(await readFile(logFile, "utf8"), before);

    const { ws, events } = await connect(server.port);
    ws.send(JSON.stringify({ type: "hello", conversationId: id, lastSeq: before.trim().split("\n").length }));
    const sync = await waitForMessage(events, event => event.type === "sync");
    assert.equal(sync.reset, undefined);
    assert.deepEqual(sync.events, []);
    ws.close();
  } finally {
    await server.stop();
  }
});

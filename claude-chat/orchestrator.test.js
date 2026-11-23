import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";

import { createTicketStore } from "./ticket-store.js";
import { WriteScopeLock, canonicalPath, isPathWithinScope, scopesOverlap } from "./write-scope-lock.js";
import { WorkerWatchdog, workerToolDecision, workerToolEvents } from "./worker-watchdog.js";
import {
  STRATEGIST_CONVERSATION_ID,
  STRATEGIST_DISALLOWED_TOOLS,
  appendStrategistMemory,
  createOrchestrator,
  loadSpecialists,
  ReportBatcher,
  readStrategistMemory,
  summarizeWorkerOutput,
} from "./orchestrator.js";

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "inkfellow-orch-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("TicketStore persists tickets, enforces immutable mandate, sorts by attention, and reconciles on boot", async () => {
  await withTempDir((dir) => {
    const store1 = createTicketStore({ dir });
    const t1 = store1.create({ title: "写作初稿", goal: "写公众号初稿", writeScope: ["articles/"] });
    const t2 = store1.create({ title: "编纂 Wiki", goal: "更新索引", writeScope: ["wiki/"] });
    store1.update(t1.id, (d) => {
      d.status = "running";
      d.mandate = { goal: "被篡改" }; // 应被忽略，保持不可变
    });
    store1.update(t2.id, (d) => { d.status = "needs_attention"; d.result.pendingQuestion = { requestId: "expired" }; });

    const reloaded = createTicketStore({ dir });
    const loadedT1 = reloaded.get(t1.id);
    assert.equal(loadedT1.mandate.goal, "写公众号初稿");
    assert.equal(loadedT1.status, "running");

    // 排序：needs_attention 排在 running 前面
    const ordered = reloaded.list();
    assert.equal(ordered[0].id, t2.id);
    assert.equal(ordered[1].id, t1.id);

    const reconciled = reloaded.reconcileOnBoot();
    assert.equal(reconciled.length, 2);
    assert.equal(reloaded.get(t1.id).status, "interrupted");
    assert.equal(reloaded.get(t2.id).status, "interrupted");
    assert.equal(reloaded.get(t2.id).result.pendingQuestion, null);
  });
});

test("WriteScopeLock serializes overlapping paths while allowing disjoint directories in parallel", () => {
  assert.equal(scopesOverlap(["wiki/"], ["wiki/AI/note.md"]), true);
  assert.equal(scopesOverlap(["articles/"], ["wiki/"]), false);
  assert.equal(isPathWithinScope("wiki/AI/note.md", ["wiki/"]), true);
  assert.equal(isPathWithinScope("secret/key.md", ["wiki/"]), false);

  const lock = new WriteScopeLock();
  assert.deepEqual(lock.tryAcquire("tk_1", ["wiki/AI/"]), { acquired: true, blockedBy: [] });
  assert.deepEqual(lock.tryAcquire("tk_2", ["articles/"]), { acquired: true, blockedBy: [] });
  const blocked = lock.tryAcquire("tk_3", ["wiki/AI/guide.md"]);
  assert.equal(blocked.acquired, false);
  assert.deepEqual(blocked.blockedBy, ["tk_1"]);

  // 释放不冲突的 tk_2 不解锁 tk_3
  assert.deepEqual(lock.release("tk_2"), []);
  // 释放冲突的 tk_1 后自动解锁 tk_3 并转移锁所有权
  assert.deepEqual(lock.release("tk_1"), ["tk_3"]);
  assert.equal(lock.heldBy("tk_3"), true);
});

test("WorkerWatchdog flags error loops, stalls, and out-of-scope writes without duplicate noise", async () => {
  await withTempDir((dir) => {
    let clock = 1_000_000;
    const store = createTicketStore({ dir, now: () => clock });
    const t = store.create({ title: "测试工单", goal: "改 wiki", writeScope: ["wiki/"] });
    store.update(t.id, (d) => {
      d.status = "running";
      d.execution.attempt = 1;
      d.execution.lastActivityAt = clock;
    });

    const flags = [];
    const dog = new WorkerWatchdog({
      ticketStore: store,
      onFlag: (ticket, reason, meta) => flags.push({ id: ticket.id, reason, kind: meta.kind }),
      stallTimeoutMs: 60_000,
      maxConsecutiveErrors: 3,
      now: () => clock,
    });

    // 正常时间内不误报
    assert.equal(dog.checkOnce().length, 0);

    // 越界写立刻捕获
    const violation = dog.checkWriteTool(store.get(t.id), "Write", { file_path: "other/hack.md" });
    assert.ok(violation);
    assert.equal(flags.at(-1).kind, "scope_violation");

    // 清除告警后测连续报错循环
    dog.clearFlag(t.id);
    store.update(t.id, (d) => { d.execution.consecutiveErrors = 3; });
    assert.equal(dog.checkOnce().length, 1);
    assert.equal(flags.at(-1).kind, "error_loop");
    // 同一轮不重复告警
    assert.equal(dog.checkOnce().length, 0);

    // 清除告警后测超时静默
    dog.clearFlag(t.id);
    store.update(t.id, (d) => { d.execution.consecutiveErrors = 0; });
    clock += 65_000;
    assert.equal(dog.checkOnce().length, 1);
    assert.equal(flags.at(-1).kind, "stalled");
  });
});

test("Orchestrator dispatches asynchronously, queues overlapping writes, batches reports, and supports recall", async () => {
  await withTempDir(async (dir) => {
    const store = createTicketStore({ dir: join(dir, "tickets") });
    const vaultDir = join(dir, "vault");
    mkdirSync(join(vaultDir, ".inkfellow", "agents"), { recursive: true });
    writeFileSync(
      join(vaultDir, ".inkfellow", "agents", "wiki-curator.md"),
      "---\nname: Wiki编纂官\ndescription: 维护结构化知识库\nwriteScope: wiki/\n---\n保持精炼客观。\n",
      "utf8",
    );

    const launched = [];
    const messaged = [];
    const stopped = [];
    const events = [];
    const wakes = [];
    const fakeWorkerLogs = new Map();

    const orch = createOrchestrator({
      ticketStore: store,
      defaultCwd: vaultDir,
      batchDelayMs: 0, // 单测立即 flush
      launchWorker: async (ticket, ctx) => {
        launched.push({ id: ticket.id, system: ctx.workerSystemPrompt });
        fakeWorkerLogs.set(ticket.workerConversationId, [
          { role: "user", text: ticket.mandate.brief },
          { role: "assistant", text: "已经处理完初稿。\n\n## 交付摘要\n新建 wiki/a.md 并更新索引。" },
        ]);
      },
      messageWorker: async (ticket, prompt) => { messaged.push({ id: ticket.id, prompt }); },
      stopWorker: async (ticket) => { stopped.push(ticket.id); },
      readWorkerMessages: (cid) => fakeWorkerLogs.get(cid) || [],
      notifyClient: (ev) => events.push(ev),
      wakeStrategist: (parentId, reports, prompt) => wakes.push({ parentId, reports, prompt }),
    });

    // 1. 派发第一个工单（命中常驻专岗 wiki-curator）
    const r1 = await orch.dispatchTask({
      title: "更新 AI 知识页",
      goal: "整理今日素材进 wiki",
      brief: "阅读 raw/1.md 并更新 wiki/a.md",
      specialistId: "wiki-curator",
    });
    assert.equal(r1.ok, true);
    assert.equal(r1.status, "running");
    assert.equal(launched.length, 1);
    assert.match(launched[0].system, /Wiki编纂官/);

    // 2. 派发第二个同目录工单 → 自动排队，不并发踩文件
    const r2 = await orch.dispatchTask({
      title: "补充 AI 案例",
      goal: "追加案例到 wiki/a.md",
      brief: "追加新案例",
      writeScope: ["wiki/a.md"],
    });
    assert.equal(r2.status, "queued");
    assert.deepEqual(r2.blockedBy, [r1.ticketId]);
    assert.equal(launched.length, 1);

    // 3. 记录第一个工单的写文件步骤并结算 → 自动唤醒排队的 r2，并通知军师
    orch.recordWorkerStep(r1.workerConversationId, "Write", { file_path: "wiki/a.md" }, { attempt: 1, id: "write" });
    assert.deepEqual(store.get(r1.ticketId).result.changedFiles, []);
    orch.recordWorkerStep(r1.workerConversationId, null, {}, { attempt: 1, id: "write", phase: "result" });
    const settled = orch.onWorkerSettled(r1.workerConversationId, {
      attempt: 1,
      status: "completed",
      output: "很长的过程...\n\n## 交付摘要\n新建 wiki/a.md 并更新索引。",
    });
    assert.equal(settled.status, "completed");
    assert.match(settled.result.summary, /新建 wiki\/a\.md/);
    assert.deepEqual(settled.result.changedFiles, ["wiki/a.md"]);
    await Promise.resolve();
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0].parentId, STRATEGIST_CONVERSATION_ID);

    // 排队的 r2 已被自动拉起
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(launched.length, 2);
    assert.equal(launched[1].id, r2.ticketId);

    // 4. Chain of Recall 按需查证详情
    const detail = orch.recallTicketDetail(r1.ticketId);
    assert.equal(detail.ok, true);
    assert.equal(detail.messages.length, 2);

    // 5. 给已完成工单返工指令 + 中止工单
    const msgRes = await orch.messageTicket(r2.ticketId, "顺便加上时间标签");
    assert.equal(msgRes.ok, true);
    assert.equal(msgRes.delivery, "queued");
    assert.equal(messaged.length, 0);
    orch.onWorkerSettled(r2.workerConversationId, { attempt: 1 });
    await Promise.resolve();
    assert.equal(messaged.length, 1);

    const stopRes = await orch.stopTicket(r2.ticketId);
    assert.equal(stopRes.status, "stopped");
    assert.deepEqual(stopped, [r2.ticketId]);

    // 6. 军师记忆读写与专岗加载
    assert.equal(loadSpecialists(vaultDir).length, 1);
    appendStrategistMemory(vaultDir, "以后所有公众号草稿默认放 articles/drafts/");
    assert.match(readStrategistMemory(vaultDir), /articles\/drafts\//);
    assert.match(orch.buildStrategistContextBlock(STRATEGIST_CONVERSATION_ID, vaultDir), /更新 AI 知识页/);
    assert.ok(STRATEGIST_DISALLOWED_TOOLS.includes("Write"));
    assert.ok(STRATEGIST_DISALLOWED_TOOLS.includes("Bash"));
    orch.stop();
  });
});

test("summarizeWorkerOutput prefers the delivery section", () => {
  const longOut = "前文铺垫".repeat(200) + "\n\n## 交付摘要\n已把 3 篇素材写入 wiki/index.md。";
  assert.equal(summarizeWorkerOutput(longOut), "已把 3 篇素材写入 wiki/index.md。");
});

test("frontend index.html orchestrator helpers parse and track strategist/worker roles cleanly", async () => {
  const html = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  assert.ok(scripts.length > 0);
  // 校验整页内联 JS 语法合法
  for (const code of scripts) new vm.Script(code);

  const extract = (name) => {
    const m = html.match(new RegExp(`(?:async )?function ${name}\\([^]*?^}`, "m"));
    assert.ok(m, name);
    return m[0];
  };
  const ctx = vm.createContext({
    STRATEGIST_CONV_ID: "strategist",
    orchestratorTickets: new Map(),
    orchestratorTicketByWorker: new Map(),
    clearedOrchestratorTicketIds: new Set(),
    hasCompleteTicketSnapshot: false,
    _historyCache: [{ id: "conv_1", role: "normal" }],
    ticketBoardOpen: false,
    TICKET_STATUS_LABEL: { completed: "已完成" },
    refreshInlineTicketCards() {},
    syncStrategistChrome() {},
    renderTicketBoardPopover() {},
  });
  vm.runInContext([
    extract("isStrategistConversationId"),
    extract("isWorkerConversationId"),
    extract("isPinnedOrWorkerConversation"),
    extract("roleForConversationId"),
    extract("isOrchestratorDispatchTool"),
    extract("upsertOrchestratorTicket"),
    extract("handleOrchestratorEvent"),
    extract("escapeAttr"),
    html.match(/^const esc = .*;$/m)[0],
    extract("renderTicketCardContent"),
    extract("updateTicketCardMarkup"),
    extract("shortArtifactName"),
    extract("activeOrchestratorTickets"),
    extract("activeBottomActivityItems"),
    extract("formatBgActivityHeading"),
    extract("submitTicketAction"),
  ].join("\n"), ctx);

  assert.equal(ctx.roleForConversationId("strategist"), "strategist");
  assert.equal(ctx.roleForConversationId("wrk_tk_1"), "worker");
  assert.equal(ctx.roleForConversationId("conv_1"), "normal");
  assert.equal(ctx.isOrchestratorDispatchTool("mcp__orchestrator__dispatch_task"), true);
  assert.equal(ctx.isOrchestratorDispatchTool("mcp_inkfellow-orchestrator_orchestrator_dispatch_task"), true);
  assert.equal(ctx.isOrchestratorDispatchTool("dispatch_task"), true);
  assert.equal(ctx.isOrchestratorDispatchTool("Read"), false);
  assert.equal(typeof ctx.submitTicketAction, "function");

  assert.equal(ctx.handleOrchestratorEvent({
    type: "ticket_updated",
    ticket: { id: "tk_9", workerConversationId: "wrk_tk_9", title: "写稿", status: "running" },
  }), true);
  assert.equal(ctx.orchestratorTickets.get("tk_9").title, "写稿");
  assert.equal(ctx.orchestratorTicketByWorker.get("wrk_tk_9"), "tk_9");
  ctx.currentConvId = "strategist";
  ctx.handleOrchestratorEvent({
    type: "ticket_updated",
    ticket: { id: "tk_10", workerConversationId: "wrk_tk_10", title: "发小红书确认", status: "needs_attention" },
  });
  const bottomItems = ctx.activeBottomActivityItems();
  assert.equal(bottomItems.length, 2);
  assert.equal(bottomItems[0].ticket.id, "tk_10", "needs_attention sorts first");
  assert.equal(ctx.formatBgActivityHeading(bottomItems), "1 个任务需拍板 · 1 个进行中");
  ctx.orchestratorTickets.delete("tk_10");

  ctx.handleOrchestratorEvent({ type: "ticket_updated", ticket: {
    id: "tk_9", workerConversationId: "wrk_tk_9", status: "completed", revision: 3,
  } });
  ctx.handleOrchestratorEvent({ type: "tickets_snapshot", tickets: [
    { id: "tk_9", workerConversationId: "wrk_tk_9", status: "running", revision: 2 },
  ] });
  assert.equal(ctx.orchestratorTickets.get("tk_9").status, "completed");
  assert.equal(ctx.activeBottomActivityItems().length, 0);
  const card = { dataset: {} };
  ctx.renderTicketCardContent(card, { id: "tk_9", status: "completed", title: 'A "quoted" title',
    artifactPaths: ['wiki/"draft".md'] });
  assert.match(card.innerHTML, /title="A &quot;quoted&quot; title"/);
  assert.match(card.innerHTML, /data-open-artifact="wiki\/&quot;draft&quot;\.md"/);
  assert.match(card.innerHTML, /已向 Fellow 交卷/);
  assert.match(card.innerHTML, /进入现场/);

  const warnCard = { dataset: {} };
  ctx.renderTicketCardContent(warnCard, { id: "tk_10", status: "needs_attention", title: "发小红书" });
  assert.match(warnCard.innerHTML, /去拍板/);

  ctx.handleOrchestratorEvent({ type: "ticket_updated", ticket: {
    id: "tk_new", workerConversationId: "wrk_tk_new", status: "running", revision: 5,
  } });
  ctx.handleOrchestratorEvent({ type: "tickets_snapshot", replace: true, removedIds: ["tk_9"], tickets: [
    { id: "tk_new", workerConversationId: "wrk_tk_new", status: "queued", revision: 4 },
  ] });
  ctx.handleOrchestratorEvent({ type: "ticket_updated", ticket: { id: "tk_9", status: "completed", revision: 4 } });
  assert.equal(ctx.orchestratorTickets.has("tk_9"), false);
  assert.equal(ctx.orchestratorTicketByWorker.has("wrk_tk_9"), false);
  assert.equal(ctx.orchestratorTickets.get("tk_new").status, "running");

  ctx.handleOrchestratorEvent({ type: "tickets_snapshot", replace: true, tickets: [] });
  assert.equal(ctx.orchestratorTickets.size, 0);
  assert.equal(ctx.orchestratorTicketByWorker.has("wrk_tk_new"), false);
  assert.equal(ctx.clearedOrchestratorTicketIds.has("tk_new"), true);
});


test("scope identity is shared across working directories, junctions and tool checks", async () => {
  await withTempDir(dir => {
    const wiki = join(dir, "wiki");
    const alias = join(dir, "alias");
    mkdirSync(wiki);
    symlinkSync(wiki, alias, "junction");
    const lock = new WriteScopeLock({ cwd: dir });
    lock.tryAcquire("first", ["wiki/note.md"], dir);
    assert.equal(lock.tryAcquire("alias", ["alias/note.md"], dir, { enqueue: false }).acquired, false);
    assert.equal(lock.tryAcquire("nested", ["note.md"], wiki).acquired, false);
    assert.deepEqual(lock.release("first"), ["nested"]);
    assert.equal(isPathWithinScope("wiki/../else.md", ["wiki"], dir), false);

    const ticket = { mandate: { canonicalScopes: [canonicalPath(wiki)] }, execution: { cwd: wiki } };
    assert.ok(workerToolDecision(ticket, "Bash", {}, dir).reason);
    assert.equal(workerToolDecision(ticket, "WebFetch", {}, dir).reason, undefined);
    assert.ok(workerToolDecision(ticket, "mcp__external__send", {}, dir).reason);
    assert.ok(workerToolDecision(ticket, "Write", { file_path: "../else.md" }, dir).reason);
    assert.equal(workerToolDecision(ticket, "Write", { file_path: "note.md" }, dir).input.file_path,
      canonicalPath("note.md", wiki));
    assert.equal(isPathWithinScope("note.md", [], wiki), true);
    assert.equal(isPathWithinScope("../escape.md", [], wiki), false);
  });
});

function makeFixture(dir, overrides = {}) {
  const vault = join(dir, "vault");
  mkdirSync(vault, { recursive: true });
  const store = createTicketStore({ dir: join(dir, "tickets"), vault });
  const deliveries = [];
  const events = [];
  const orch = createOrchestrator({
    ticketStore: store, defaultCwd: vault,
    launchWorker: async ticket => deliveries.push(["launch", ticket.id, ticket.execution.attempt]),
    messageWorker: async (ticket, prompt) => deliveries.push(["message", ticket.id, prompt]),
    stopWorker: async () => {},
    notifyClient: event => events.push(event),
    ...overrides,
  });
  return { vault, store, orch, deliveries, events };
}

test("a worker with no write scope reserves its writable area and records artifacts", async () => {
  for (const allowOutsideVault of [false, true]) {
    await withTempDir(async dir => {
      const { orch, store, vault } = makeFixture(dir, { allowOutsideVault });
      const externalDir = join(dir, "other");
      mkdirSync(externalDir);
      const broad = await orch.dispatchTask({ goal: "Unscoped" });
      const scoped = await orch.dispatchTask({
        goal: "Scoped", cwd: allowOutsideVault ? externalDir : vault, writeScope: ["draft.md"],
      });
      assert.equal(scoped.status, "queued");
      assert.deepEqual(scoped.blockedBy, [broad.ticketId]);
      const target = allowOutsideVault ? join(externalDir, "draft.md") : "draft.md";
      orch.recordWorkerStep(broad.workerConversationId, "Write", { file_path: target }, { id: "write", attempt: 1 });
      orch.recordWorkerStep(broad.workerConversationId, null, {}, { id: "write", phase: "result", attempt: 1 });
      assert.deepEqual(store.get(broad.ticketId).result.artifactPaths,
        [allowOutsideVault ? canonicalPath(target) : target]);
      orch.onWorkerSettled(broad.workerConversationId, { attempt: 1 });
      await waitFor(() => store.get(scoped.ticketId).status === "running");
      orch.stop();
    });
  }
});

test("a Vault specialist retains its defaults when the worker starts in a different directory", async () => {
  await withTempDir(async dir => {
    let launched;
    const { orch, vault } = makeFixture(dir, {
      allowOutsideVault: true,
      launchWorker: async (ticket, context) => { launched = { ticket, context }; },
    });
    const agents = join(vault, ".inkfellow", "agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "writer.md"), "---\nprovider: claude\nmodel: writer-model\nwriteScope: drafts\n---\nKeep the wording concise.");
    const task = await orch.dispatchTask({ goal: "Draft", cwd: dir, specialistId: "writer" });
    assert.equal(launched.ticket.execution.model, "writer-model");
    assert.match(launched.context.workerSystemPrompt, /Keep the wording concise/);
    assert.deepEqual(orch.attemptScopes(task.ticketId, 1), [canonicalPath("drafts", vault)]);
    orch.stop();
  });
});

test("queued rework retains instructions and stop waits for its own attempt", async () => {
  await withTempDir(async dir => {
    const { orch, store, deliveries } = makeFixture(dir, { stopWorker: async () => ({ pending: true }) });
    const a = await orch.dispatchTask({ goal: "A", writeScope: ["wiki"] });
    orch.onWorkerSettled(a.workerConversationId, { attempt: 1 });
    const b = await orch.dispatchTask({ goal: "B", writeScope: ["wiki"] });
    assert.equal((await orch.messageTicket(a.ticketId, "rework")).status, "queued");
    assert.equal((await orch.messageTicket(a.ticketId, "follow-up")).delivery, "queued");
    assert.equal(deliveries.length, 2);
    const stop = orch.stopTicket(b.ticketId);
    assert.equal(store.get(b.ticketId).status, "stopping");
    assert.equal((await orch.retryTicket(b.ticketId)).ok, false);
    assert.equal(orch.lock.heldBy(b.ticketId), true);
    orch.onWorkerSettled(b.workerConversationId, { attempt: 1, status: "completed" });
    assert.equal((await stop).status, "stopped");
    assert.deepEqual(deliveries.at(-1), ["message", a.ticketId, "rework"]);
    assert.equal(orch.onWorkerSettled(a.workerConversationId, { attempt: 1 }), null);
    assert.equal(orch.lock.heldBy(a.ticketId), true);
    orch.onWorkerSettled(a.workerConversationId, { attempt: 2 });
    await Promise.resolve();
    assert.deepEqual(deliveries.at(-1), ["message", a.ticketId, "follow-up"]);
    orch.stop();
  });
});

test("reports remain pending until delivery is confirmed across rejection or cancellation", async () => {
  const batched = [];
  const batcher = new ReportBatcher({ delayMs: 0, onFlush: (_parent, reports) => {
    batched.push(reports.map(report => report.ticketId));
    return batched.length > 1;
  } });
  const report = { ticketId: "tk_waiting" };
  batcher.enqueue("strategist", report);
  await delay(0);
  batcher.flush("strategist");
  await delay(0);
  batcher.flush("strategist");
  await delay(0);
  assert.deepEqual(batched, [[report.ticketId], [report.ticketId]]);
  batcher.clear();
});

test("rejected launch and a failed write release the reservation without publishing undurable state", async () => {
  await withTempDir(async dir => {
    const { orch, store, events } = makeFixture(dir, {
      launchWorker: async () => ({ state: "rejected", error: "busy" }),
    });
    const rejected = await orch.dispatchTask({ goal: "Rejected", writeScope: ["wiki"] });
    assert.equal(rejected.status, "failed");
    assert.equal(rejected.error, "busy");
    assert.deepEqual(orch.lock.snapshot().held, {});

    const diskFull = store.create({ goal: "Failed write", cwd: join(dir, "vault"), writeScope: ["wiki"] });
    store.update(diskFull.id, draft => { draft.status = "interrupted"; });
    const tmp = join(dir, "tickets", diskFull.id + ".json.tmp");
    mkdirSync(tmp);
    const before = store.get(diskFull.id);
    await orch.retryTicket(diskFull.id);
    assert.deepEqual(store.get(diskFull.id), before);
    assert.equal(orch.lock.heldBy(diskFull.id), false);
    assert.ok(events.some(event => event.type === "ticket_action_error" && event.ticketId === diskFull.id));
    orch.stop();
  });
});

test("worker activity and artifacts follow result IDs and the Vault-relative working directory", async () => {
  await withTempDir(async dir => {
    let now = 100;
    const { orch, store, vault } = makeFixture(dir, { maxConsecutiveErrors: 2, now: () => now });
    const sub = join(vault, "wiki");
    mkdirSync(sub);
    const task = await orch.dispatchTask({ goal: "Tools", cwd: sub, writeScope: ["."] });
    const apply = event => {
      for (const entry of workerToolEvents(event)) {
        orch.recordWorkerStep(task.workerConversationId, entry.name, entry.input, { ...entry, attempt: 1 });
      }
    };
    for (const id of ["one", "two"]) {
      apply({ type: "mcp_tool_use", id, name: "tool" });
      apply({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true }] } });
    }
    assert.equal(store.get(task.ticketId).execution.consecutiveErrors, 2);
    assert.equal(store.get(task.ticketId).status, "needs_attention");
    apply({ type: "server_tool_use", id: "patch", name: "apply_patch", input: { changes: [{ path: "note.md" }] } });
    assert.deepEqual(store.get(task.ticketId).result.artifactPaths, []);
    apply({ type: "assistant", message: { content: [{ raw: {
      type: "file_change", id: "patch", status: "completed", changes: [{ path: "note.md" }],
    } }] } });
    assert.deepEqual(store.get(task.ticketId).result.artifactPaths, ["wiki/note.md"]);
    assert.equal(store.get(task.ticketId).execution.consecutiveErrors, 0);
    const revision = store.get(task.ticketId).revision;
    for (let i = 0; i < 50; i++) orch.onWorkerActivity(task.workerConversationId, 1);
    assert.equal(store.get(task.ticketId).revision, revision);
    now += 1000;
    const partial = orch.onWorkerSettled(task.workerConversationId, { attempt: 1, status: "partial", output: "保留本轮结果" });
    assert.equal(partial.result.summary, "保留本轮结果");
    assert.equal((await orch.retryTicket(task.ticketId)).ok, false);
    orch.stop();
  });
});

test("Vault identity survives nested working directories and rejects stale cwd and cross-Vault history", async () => {
  await withTempDir(async dir => {
    const { vault, store, orch } = makeFixture(dir);
    const nested = join(vault, "nested");
    mkdirSync(nested);
    const task = await orch.dispatchTask({ goal: "Nested", cwd: nested, writeScope: ["a.md"] });
    orch.onWorkerSettled(task.workerConversationId, { attempt: 1 });
    assert.equal(createTicketStore({ dir: store.dir, vault: nested }).get(task.ticketId), null);
    assert.ok(createTicketStore({ dir: store.dir, vault }).get(task.ticketId));
    rmdirSync(nested);
    await assert.rejects(orch.retryTicket(task.ticketId));
    assert.deepEqual(orch.lock.snapshot().held, {});
    orch.stop();
  });
});

test("strategist memory includes the latest complete entries after crossing the injection limit", async () => {
  await withTempDir(dir => {
    appendStrategistMemory(dir, "old".repeat(1000));
    appendStrategistMemory(dir, "latest".repeat(250));
    const injected = readStrategistMemory(dir);
    assert.ok(injected.endsWith("latest".repeat(250)));
    assert.ok(!injected.includes("old"));
    assert.ok(injected.length <= 4000);
  });
});


const TEST_SDK = `
  import { writeFileSync } from "node:fs";
  import { join } from "node:path";
  let sequence = 0;
  export const tool = (name, description, schema, handler) => ({ name, description, schema, handler });
  export const createSdkMcpServer = config => config;
  export function query({ prompt, options }) {
    if (options.permissionMode === "bypassPermissions" && !options.allowDangerouslySkipPermissions) {
      throw new Error("Missing Claude SDK permission flag");
    }
    let closed = false;
    let resume;
    const run = async function* () {
      for await (const input of prompt) {
        const text = input.message.content.map(block => block.text || "").join(" ");
        if (!options.maxTurns) {
          if (text.includes("wechat-dispatch-test") && options.mcpServers?.orchestrator) {
            const dispatchTool = options.mcpServers.orchestrator.tools.find(t => t.name === "dispatch_task");
            if (dispatchTool) {
              await dispatchTool.handler({ title: "微信派单任务", goal: "写一篇文章", writeScope: ["wiki/"] });
            }
            yield { type: "assistant", message: { content: [{ type: "text", text: "已为你派出微信测试任务" }] } };
          } else {
            yield { type: "assistant", message: { content: [{ type: "text", text: "Report received" }] } };
          }
        } else {
          const number = ++sequence;
          const hook = options.hooks.PreToolUse.find(entry => !entry.matcher).hooks[0];
          const probe = (tool_name, tool_input) => hook({ tool_name, tool_input });
          const outside = await probe("Write", { file_path: "other/note.md" });
          const bash = await probe("Bash", { command: "" });
          const within = await probe("Write", { file_path: "wiki/note.md" });
          writeFileSync(join(process.env.CLAUDE_CHAT_DATA_DIR, "hook-" + number + ".json"), JSON.stringify({
            maxTurns: options.maxTurns, permissionMode: options.permissionMode, model: options.model,
            cwd: options.cwd, outside, bash, within, text,
          }));
          if (text.includes("hold-worker")) {
            yield { type: "system", subtype: "session_state_changed", state: "running" };
            if (!closed) await new Promise(resolve => { resume = resolve; });
            if (closed) return;
          }
          if (text.includes("fail-worker")) throw new Error("Worker execution failed in SDK");
          yield { type: "assistant", message: { content: [{ type: "text", text: "Current delivery" }] } };
        }
        yield { type: "result", subtype: "success", is_error: false };
        yield { type: "system", subtype: "session_state_changed", state: "idle" };
      }
    };
    return {
      [Symbol.asyncIterator]: run,
      close() { closed = true; resume?.(); },
      async setPermissionMode() {},
      async setModel() {},
    };
  }
`;

async function withSidecar(dir, token, run, { beforeStart, extraEnv } = {}) {
  const listener = createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  if (typeof beforeStart === "function") await beforeStart(port);
  const auth = join(dir, "profiles.json");
  const mock = join(dir, "test-sdk.mjs");
  const loader = join(dir, "test-loader.mjs");
  writeFileSync(auth, JSON.stringify({ activeProfileId: "local-claude", profiles: [
    { id: "local-claude", name: "Fixture Claude", provider: "claude" },
    { id: "local-codex", name: "Fixture Codex", provider: "codex" },
    { id: "local-no-key", name: "Missing Key API", provider: "deepseek" },
  ] }));
  writeFileSync(mock, TEST_SDK);
  writeFileSync(loader, `export async function resolve(specifier, context, next) {
    return specifier === "@anthropic-ai/claude-agent-sdk"
      ? { url: ${JSON.stringify(pathToFileURL(mock).href)}, shortCircuit: true }
      : next(specifier, context);
  }`);
  const child = spawn(process.execPath, ["--experimental-loader", pathToFileURL(loader).href, "server.js"], {
    cwd: new URL(".", import.meta.url),
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", VAULT_PATH: dir, DESKTOP_AGENT_TOKEN: token,
      WECHAT_DEBOUNCE_MS: "0",
      CLAUDE_CHAT_DATA_DIR: dir, CLAUDE_CHAT_HISTORY_FILE: join(dir, "history.json"), CLAUDE_CHAT_AUTH_PROFILE_FILE: auth,
      ...(extraEnv || {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  let log = "";
  for (const stream of [child.stdout, child.stderr]) stream.setEncoding("utf8").on("data", part => { log += part; });
  try {
    const started = Date.now() + 10_000;
    while (!log.includes("claude-chat listening")) {
      if (child.exitCode != null || Date.now() > started) throw new Error(log);
      await delay(20);
    }
    await run(port);
  } finally {
    child.kill();
    await closed;
  }
}

async function waitFor(predicate) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const found = await predicate();
    if (found) return found;
    await delay(20);
  }
  assert.fail("Timed out waiting for ticket state");
}

test("a token-protected sidecar validates REST input and routes direct commands through the Worker lock", { timeout: 25_000 }, async () => {
  await withTempDir(async dir => {
    await withSidecar(dir, "fixture-token", async port => {
      const base = `http://127.0.0.1:${port}`;
      const headers = { Authorization: "Bearer fixture-token", "Content-Type": "application/json" };
      const http = (path, options = {}) => fetch(base + path, { headers, ...options });
      const endpoint = "/api/orchestrator/tickets";
      const post = (path, data) => http(path, { method: "POST", body: JSON.stringify(data) });
      const detail = async id => (await (await http(`${endpoint}/${id}`)).json()).ticket;
      for (const [path, method] of [[endpoint, "GET"], [endpoint, "POST"],
        [endpoint + "/tk_sample/recall", "GET"], [endpoint + "/tk_sample/retry", "POST"],
        [endpoint + "/clear-completed", "POST"],
        ["/api/orchestrator/strategist/compact-memory", "POST"]]) {
        assert.equal((await fetch(base + path, { method })).status, 403);
      }
      assert.equal((await fetch(base + endpoint + "?token=fixture-token")).status, 200);
      assert.equal((await http(endpoint + "/%")).status, 400);
      assert.equal((await post(endpoint, { goal: "test", permissionMode: "bypassPermissions" })).status, 400);
      assert.equal((await post(endpoint, { goal: "test", provider: "local-no-key" })).status, 400);
      assert.equal((await post(endpoint, { goal: "x".repeat(135_000) })).status, 413);
      assert.equal((await post("/api/orchestrator/strategist/compact-memory", { conversationId: "normal" })).status, 400);
      assert.equal((await post("/api/orchestrator/strategist/compact-memory", { note: "newest memory" })).status, 200);

      const workerA = await (await post(endpoint, { goal: "hold-worker", writeScope: ["wiki"], maxTurns: 5 })).json();
      assert.equal(workerA.status, "running", JSON.stringify(workerA));
      const workerB = await (await post(endpoint, { goal: "今天更新索引", writeScope: ["wiki"] })).json();
      assert.equal(workerB.status, "queued");
      assert.equal((await fetch(base + "/api/history/" + workerA.workerConversationId)).status, 403);
      assert.equal((await http("/api/history/" + workerB.workerConversationId)).status, 404);
      assert.equal((await post(`${endpoint}/${workerB.ticketId}/message`, { instruction: {} })).status, 400);
      const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=fixture-token`);
      const events = [];
      socket.on("message", raw => events.push(JSON.parse(raw.toString())));
      try {
        await once(socket, "open");
        socket.send(JSON.stringify({ conversationId: workerB.workerConversationId, userMessageId: "direct-worker-message",
          profileId: "local-claude", model: "new-worker-model", prompt: "continue from the control screen" }));
        await waitFor(() => events.some(event => event.type === "request_ack" && event.userMessageId === "direct-worker-message"
          && event.state === "queued"));
        const hooks = await waitFor(() => readFile(join(dir, "hook-1.json"), "utf8").then(JSON.parse, () => null));
        assert.equal(hooks.maxTurns, 5);
        assert.equal(hooks.permissionMode, "auto");
        assert.equal(hooks.outside.hookSpecificOutput.permissionDecision, "deny");
        assert.equal(hooks.bash.hookSpecificOutput.permissionDecision, "deny");
        assert.equal(hooks.within.hookSpecificOutput.updatedInput.file_path, canonicalPath("wiki/note.md", dir));

        const canceled = await (await post(`${endpoint}/${workerA.ticketId}/stop`, {})).json();
        assert.equal(canceled.status, "stopped");
        await waitFor(() => events.some(event => event.type === "done" && event.userMessageId === "direct-worker-message"));
        assert.equal((await detail(workerB.ticketId)).model, "new-worker-model");
        assert.equal((await detail(workerB.ticketId)).status, "completed");
        const history = await (await http("/api/history/" + workerB.workerConversationId)).json();
        assert.ok(history.messages.some(msg => msg.text === "continue from the control screen"));
        assert.equal((await http("/api/history/" + workerB.workerConversationId, { method: "DELETE" })).status, 200);
        assert.equal((await http("/api/history/" + workerB.workerConversationId)).status, 404);
        assert.equal((await post(`${endpoint}/${workerB.ticketId}/message`, { instruction: "fail-worker" })).status, 200);
        const failed = await waitFor(async () => {
          const value = await detail(workerB.ticketId);
          return value.status === "failed" && value;
        });
        assert.match(failed.error, /Worker execution failed in SDK/);
        assert.equal(failed.summary, "");

        socket.send(JSON.stringify({ conversationId: "strategist", userMessageId: "manual-claude-ticket",
          dispatchProvider: "local-claude", prompt: "Manual task" }));
        const receipt = await waitFor(() => events.find(event => event.type === "user" && event.userMessageId === "manual-claude-ticket"));
        const ticketReceipt = JSON.parse(receipt.message.content[0].content[0].text);
        assert.ok(ticketReceipt.ticketId);
        assert.equal(ticketReceipt.ok, true);
        const strategist = await (await http("/api/history/strategist")).json();
        assert.ok(strategist.messages.some(msg => msg.blocks?.some(block => block.type === "tool_result"
          && JSON.stringify(block).includes(ticketReceipt.ticketId))));
        socket.send(JSON.stringify({ conversationId: "strategist", userMessageId: "manual-missing-key-ticket",
          dispatchProvider: "local-no-key", prompt: "Manual task" }));
        const rejected = await waitFor(() => events.find(event => event.type === "user" && event.userMessageId === "manual-missing-key-ticket"));
        assert.equal(rejected.message.content[0].is_error, true);

        const bashTicket = await post(endpoint, { goal: "run-script", allowBash: true, writeScope: ["scripts"] });
        assert.equal(bashTicket.status, 200);
        const bashTicketData = await bashTicket.json();
        assert.equal(bashTicketData.ok, true);
        await waitFor(async () => (await detail(bashTicketData.ticketId)).status === "completed");
        const active = await (await post(endpoint, { goal: "hold-worker", writeScope: ["wiki"] })).json();
        const queued = await (await post(endpoint, { goal: "wait for wiki", writeScope: ["wiki"] })).json();
        assert.equal(active.status, "running");
        assert.equal(queued.status, "queued");
        const clear = await (await post(endpoint + "/clear-completed", {})).json();
        assert.ok(clear.removedIds.includes(workerA.ticketId));
        assert.ok(clear.removedIds.includes(workerB.ticketId));
        assert.deepEqual(clear.failedIds, []);
        assert.equal((await detail(active.ticketId)).status, "running");
        assert.equal((await detail(queued.ticketId)).status, "queued");
        assert.equal((await http(`${endpoint}/${workerB.ticketId}`)).status, 404);
        const snapshot = await waitFor(() => events.find(event => event.type === "tickets_snapshot"
          && event.removedIds?.includes(workerB.ticketId)));
        assert.equal(snapshot.replace, true);
        assert.ok(snapshot.tickets.some(ticket => ticket.id === active.ticketId));
      } finally {
        socket.terminate();
      }
    });
  });
});

test("a browser sidecar without a desktop token keeps the ticket REST API available", { timeout: 20_000 }, async () => {
  await withTempDir(async dir => {
    await withSidecar(dir, "", async port => {
      const response = await fetch(`http://127.0.0.1:${port}/api/orchestrator/tickets`);
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).tickets, []);
    });
  });
});

test("an unconfirmed report is reloaded after the sidecar restarts", async () => {
  await withTempDir(async dir => {
    const { orch, store, vault } = makeFixture(dir);
    const task = await orch.dispatchTask({ goal: "Report persistence" });
    orch.onWorkerSettled(task.workerConversationId, { attempt: 1, status: "completed", output: "report content" });
    assert.equal(store.get(task.ticketId).pendingReport.summary, "report content");
    orch.stop();

    const restored = createTicketStore({ dir: store.dir, vault });
    const delivered = [];
    const resumed = createOrchestrator({
      ticketStore: restored, defaultCwd: vault, batchDelayMs: 0,
      wakeStrategist: (_parent, reports) => { delivered.push(...reports); return true; },
    });
    try {
      resumed.start();
      await waitFor(() => restored.get(task.ticketId).reportedAt);
      assert.equal(delivered[0].ticketId, task.ticketId);
      assert.equal(restored.get(task.ticketId).pendingReport, undefined);
    } finally { resumed.stop(); }
  });
});

test("practical all-purpose worker policy: empty writeScope stays inside vault, allowBash & research & non-recursive MCP work", async () => {
  await withTempDir(dir => {
    const vault = join(dir, "vault");
    mkdirSync(join(vault, "wiki"), { recursive: true });
    const store = createTicketStore({ dir: join(dir, "tickets"), vault });
    const openTicket = store.create({ title: "全能任务", goal: "调研并执行", allowBash: true, allowExternalAction: true });
    const strictTicket = store.create({ title: "限定写作", goal: "只改 wiki", writeScope: ["wiki/"], allowBash: false });

    // 空 writeScope：允许写 Vault 内任意文件，仍严禁越出 Vault
    const insideOk = workerToolDecision(openTicket, "Write", { file_path: "drafts/post.md" }, vault, []);
    assert.equal(insideOk.reason, undefined);
    assert.equal(insideOk.input.file_path, canonicalPath("drafts/post.md", vault));
    const escapeDenied = workerToolDecision(openTicket, "Write", { file_path: "../outside.md" }, vault, []);
    assert.ok(escapeDenied.reason);

    // 显式 writeScope：仍严格锁定在目录内
    assert.ok(workerToolDecision(strictTicket, "Write", { file_path: "other/note.md" }, vault).reason);
    assert.equal(workerToolDecision(strictTicket, "Write", { file_path: "wiki/ok.md" }, vault).reason, undefined);

    // allowBash 开关与联网检索
    assert.equal(workerToolDecision(openTicket, "Bash", { command: "echo hi" }, vault, []).reason, undefined);
    assert.ok(workerToolDecision(strictTicket, "Bash", { command: "echo hi" }, vault).reason);
    assert.equal(workerToolDecision(strictTicket, "WebSearch", { query: "test" }, vault).reason, undefined);
    assert.equal(workerToolDecision(strictTicket, "WebFetch", { url: "https://example.com" }, vault).reason, undefined);

    // allowExternalAction：允许外部 MCP，但始终禁止 Worker 递归派单（maxDelegationDepth=0）
    assert.equal(workerToolDecision(openTicket, "mcp__custom__search", {}, vault, []).reason, undefined);
    assert.ok(workerToolDecision(openTicket, "mcp__orchestrator__dispatch_task", {}, vault, []).reason);
    assert.ok(workerToolDecision(strictTicket, "mcp__custom__search", {}, vault).reason);
  });
});

test("orchestrator-mcp-bridge exposes native MCP tools and dispatches tickets over authenticated REST", { timeout: 20_000 }, async () => {
  await withTempDir(async dir => {
    await withSidecar(dir, "bridge-token", async port => {
      const bridge = spawn(process.execPath, [new URL("./orchestrator-mcp-bridge.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")], {
        env: {
          ...process.env,
          INKFELLOW_API_BASE: `http://127.0.0.1:${port}`,
          INKFELLOW_DESKTOP_TOKEN: "bridge-token",
          INKFELLOW_PARENT_CONV_ID: "strategist",
          INKFELLOW_VAULT_CWD: dir,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const responses = new Map();
      let buf = "";
      bridge.stdout.on("data", chunk => {
        buf += chunk.toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.id != null) responses.set(msg.id, msg);
        }
      });
      const rpc = async (id, method, params = {}) => {
        bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        return waitFor(() => responses.get(id), 5000);
      };
      try {
        const init = await rpc(1, "initialize", { protocolVersion: "2024-11-05" });
        assert.equal(init.result.serverInfo.name, "orchestrator");
        const list = await rpc(2, "tools/list");
        const names = list.result.tools.map(t => t.name);
        assert.ok(names.includes("dispatch_task"));
        assert.ok(names.includes("list_tickets"));
        assert.ok(names.includes("list_providers"));

        // 并行通过 MCP bridge 派发 2 个不同目录的任务，立刻拿到 ticketId
        const d1 = await rpc(3, "tools/call", {
          name: "dispatch_task",
          arguments: { title: "选题1", goal: "写初稿1", brief: "初稿1", writeScope: ["draft1/"] },
        });
        const d2 = await rpc(4, "tools/call", {
          name: "dispatch_task",
          arguments: { title: "选题2", goal: "写初稿2", brief: "初稿2", writeScope: ["draft2/"] },
        });
        assert.equal(d1.result.isError, undefined);
        assert.equal(d2.result.isError, undefined);
        const r1 = JSON.parse(d1.result.content[0].text);
        const r2 = JSON.parse(d2.result.content[0].text);
        assert.equal(r1.ok, true);
        assert.equal(r2.ok, true);
        assert.notEqual(r1.ticketId, r2.ticketId);

        const listed = await rpc(5, "tools/call", { name: "list_tickets", arguments: {} });
        const tickets = JSON.parse(listed.result.content[0].text).tickets;
        assert.ok(tickets.some(t => t.id === r1.ticketId));
        assert.ok(tickets.some(t => t.id === r2.ticketId));

        await rpc(6, "tools/call", { name: "stop_ticket", arguments: { ticketId: r1.ticketId } });
        await rpc(7, "tools/call", { name: "stop_ticket", arguments: { ticketId: r2.ticketId } });
      } finally {
        bridge.kill();
      }
    });
  });
});

test("WeChat routes through Fellow, shares history/memory, tags tickets, and pushes completions by notifyTicketsMode", { timeout: 25_000 }, async () => {
  await withTempDir(async dir => {
    mkdirSync(join(dir, "wiki"), { recursive: true });
    const sentMessages = [];
    const inboundQueue = [
      {
        message_type: 1,
        from_user_id: "wx_owner_1",
        context_token: "ctx_token_123",
        item_list: [{ type: 1, text_item: { text: "wechat-dispatch-test" } }],
      },
    ];
    let pollWaiters = [];
    const pushInbound = (msg) => {
      inboundQueue.push(msg);
      const waiters = pollWaiters;
      pollWaiters = [];
      waiters.forEach(fn => fn());
    };
    const mockWechat = createHttpServer((req, res) => {
      req.on("error", () => {});
      res.on("error", () => {});
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        const sendJson = (payload) => {
          if (res.destroyed || res.writableEnded) return;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (req.url.includes("ilink/bot/getupdates")) {
          if (inboundQueue.length > 0) {
            const batch = inboundQueue.splice(0, inboundQueue.length);
            return sendJson({ ret: 0, msgs: batch, get_updates_buf: `buf_${Date.now()}` });
          }
          let waiter;
          const timer = setTimeout(() => {
            pollWaiters = pollWaiters.filter(fn => fn !== waiter);
            sendJson({ ret: 0, msgs: [], get_updates_buf: "buf_idle" });
          }, 120);
          waiter = () => {
            clearTimeout(timer);
            const batch = inboundQueue.splice(0, inboundQueue.length);
            sendJson({ ret: 0, msgs: batch, get_updates_buf: `buf_${Date.now()}` });
          };
          pollWaiters.push(waiter);
          return;
        }
        if (req.url.includes("ilink/bot/sendmessage")) {
          const parsed = JSON.parse(body || "{}");
          sentMessages.push(parsed.msg);
          return sendJson({ ret: 0 });
        }
        return sendJson({ ret: 0 });
      });
    }).listen(0, "127.0.0.1");
    mockWechat.on("connection", socket => socket.on("error", () => {}));
    await once(mockWechat, "listening");
    const mockUrl = `http://127.0.0.1:${mockWechat.address().port}`;

    try {
      await withSidecar(dir, "wx-test-token", async port => {
        const headers = { Authorization: "Bearer wx-test-token", "Content-Type": "application/json" };
        // 1. WeChat 状态接口返回默认通知模式
        const statusRes = await (await fetch(`http://127.0.0.1:${port}/api/wechat/status`)).json();
        assert.equal(statusRes.connected, true);
        assert.equal(statusRes.notifyTicketsMode, "wechat");

        // 2. 等待微信消息进入 Fellow 并收到 Fellow 派单回复（携带 context_token）
        const directReply = await waitFor(() => sentMessages.find(m => m?.item_list?.[0]?.text_item?.text?.includes("已为你派出微信测试任务")), 10_000);
        assert.equal(directReply.to_user_id, "wx_owner_1");
        assert.equal(directReply.context_token, "ctx_token_123");

        // 3. 桌面端 Fellow 历史记录中同步可见这条微信消息（带 sourceChannel: "wechat"）
        const hist = await (await fetch(`http://127.0.0.1:${port}/api/history/strategist`, { headers })).json();
        assert.ok(hist.messages.some(m => m.role === "user" && m.sourceChannel === "wechat" && m.text.includes("wechat-dispatch-test")));

        // 4. 派出的工单自动标记 sourceChannel="wechat" 且完成后主动回推微信
        const listed = await (await fetch(`http://127.0.0.1:${port}/api/orchestrator/tickets`, { headers })).json();
        const wxTicket = listed.tickets.find(t => t.title === "微信派单任务");
        assert.ok(wxTicket);
        const reportPush = await waitFor(() => sentMessages.find(m => m !== directReply && m?.to_user_id === "wx_owner_1"), 10_000);
        assert.equal(reportPush.context_token, "ctx_token_123");

        // 5. 微信发「整理记忆」复用 Fellow 记忆压缩并落盘 MEMORY.md
        pushInbound({
          message_type: 1,
          from_user_id: "wx_owner_1",
          context_token: "ctx_token_456",
          item_list: [{ type: 1, text_item: { text: "整理记忆" } }],
        });
        const compactReply = await waitFor(() => sentMessages.find(m => m?.item_list?.[0]?.text_item?.text?.includes("已整理记忆")), 8_000);
        assert.equal(compactReply.context_token, "ctx_token_456");
        assert.ok(readStrategistMemory(dir).length > 0);

        // 6. 切换微信通知模式为 "all"，桌面端发起的任务完成后也自动推送微信
        const patchRes = await fetch(`http://127.0.0.1:${port}/api/wechat/settings`, {
          method: "PATCH", headers, body: JSON.stringify({ notifyTicketsMode: "all" }),
        });
        assert.equal(patchRes.status, 200);
        assert.equal((await patchRes.json()).notifyTicketsMode, "all");
        const beforeCount = sentMessages.length;
        const desktopDispatch = await fetch(`http://127.0.0.1:${port}/api/orchestrator/tickets`, {
          method: "POST", headers, body: JSON.stringify({ title: "电脑端任务", goal: "桌面端触发", writeScope: ["wiki/"] }),
        });
        assert.equal(desktopDispatch.status, 200);
        await waitFor(() => sentMessages.length > beforeCount, 10_000);
        assert.equal(sentMessages.at(-1).to_user_id, "wx_owner_1");
        assert.equal(sentMessages.at(-1).context_token, "ctx_token_456");

        // Missing context tokens must not bind another peer's token to this sender.
        pushInbound({ message_type: 1, from_user_id: "wx_other",
          item_list: [{ type: 1, text_item: { text: "状态" } }] });
        await waitFor(() => sentMessages.some(m => m.to_user_id === "wx_other"), 8000);
        const desktopForOther = await fetch(`http://127.0.0.1:${port}/api/orchestrator/tickets`, {
          method: "POST", headers, body: JSON.stringify({ title: "后续桌面任务", goal: "桌面端触发", writeScope: ["wiki/"] }),
        });
        assert.equal(desktopForOther.status, 200);
        const otherReport = await waitFor(() => sentMessages.filter(m => m.to_user_id === "wx_other")[1], 8000);
        assert.equal(otherReport.context_token, undefined);

        // 非法模式返回 400
        const badPatch = await fetch(`http://127.0.0.1:${port}/api/wechat/settings`, {
          method: "PATCH", headers, body: JSON.stringify({ notifyTicketsMode: "invalid" }),
        });
        assert.equal(badPatch.status, 400);
      }, {
        beforeStart: (port) => {
          writeFileSync(join(dir, `wechat-bot-${port}.json`), JSON.stringify({
            baseUrl: mockUrl,
            token: "mock-wx-token",
            userId: "wx_owner_1",
            botId: "mock-bot",
          }), "utf8");
        },
      });
    } finally {
      pollWaiters.forEach(fn => fn());
      mockWechat.closeAllConnections?.();
      await new Promise(resolve => mockWechat.close(resolve));
    }
  });
});

test("full-machine mode allows outside-vault cwd & writes while protecting OS system directories", async () => {
  await withTempDir(async dir => {
    const vault = join(dir, "vault");
    const externalRepo = join(dir, "other-repo");
    mkdirSync(vault, { recursive: true });
    mkdirSync(externalRepo, { recursive: true });
    const store = createTicketStore({ dir: join(dir, "tickets"), vault });
    const launched = [];
    const orch = createOrchestrator({
      ticketStore: store,
      defaultCwd: vault,
      allowOutsideVault: true,
      launchWorker: async (ticket) => { launched.push(ticket); return { state: "started" }; },
    });
    try {
      // 允许派发到 Vault 外部的任意项目目录
      const receipt = await orch.dispatchTask({
        title: "外部代码库修 Bug",
        goal: "修复外部仓库问题",
        cwd: externalRepo,
        allowBash: true,
      });
      assert.equal(receipt.ok, true);
      const ticket = store.get(receipt.ticketId);
      assert.equal(ticket.execution.cwd, canonicalPath(externalRepo));
      // 全机模式下允许写外部目录文件
      const okWrite = workerToolDecision(ticket, "Write", { file_path: join(externalRepo, "fix.js") }, vault, [], { allowOutsideVault: true });
      assert.equal(okWrite.reason, undefined);
      // 即使在全机模式下，也严禁写入系统受保护目录
      const sysTarget = process.platform === "win32" ? "C:\\Windows\\System32\\evil.txt" : "/etc/passwd";
      const blockedSys = workerToolDecision(ticket, "Write", { file_path: sysTarget }, vault, [], { allowOutsideVault: true });
      assert.ok(blockedSys.reason);

      // 清理已完成任务只移除终态工单，不碰运行中任务
      orch.onWorkerSettled(receipt.workerConversationId, { attempt: 1, status: "completed" });
      const activeReceipt = await orch.dispatchTask({ title: "进行中任务", goal: "仍在运行", cwd: externalRepo });
      const cleared = orch.clearCompletedTickets();
      assert.equal(cleared.ok, true);
      assert.equal(cleared.removedCount, 1);
      assert.equal(store.get(receipt.ticketId), null);
      assert.ok(store.get(activeReceipt.ticketId));
    } finally {
      orch.stop();
    }
  });
});

test("clearing terminal tickets reports filesystem failures and leaves all active states on disk", async () => {
  await withTempDir(dir => {
    const store = createTicketStore({ dir });
    const seed = status => {
      const { id } = store.create({ goal: status });
      store.update(id, { status });
      return id;
    };
    const keep = ["queued", "running", "needs_attention", "stopping"].map(seed);
    const remove = ["completed", "failed", "stopped", "interrupted", "partial"].map(seed);
    const blocked = seed("completed");
    const file = join(dir, `${blocked}.json`);
    renameSync(file, file + ".backup");
    mkdirSync(file);
    const result = store.removeFinished();
    assert.deepEqual(result.removedIds, remove);
    assert.deepEqual(result.failedIds, [blocked]);
    assert.equal(store.get(blocked).status, "completed");
    rmdirSync(file);
    renameSync(file + ".backup", file);
    const reopened = createTicketStore({ dir });
    assert.ok([...keep, blocked].every(id => reopened.get(id)));
    assert.ok(remove.every(id => !reopened.get(id)));
  });
});

test("orchestrator-mcp-bridge supports cross-model scheduler tools and WeChat quick status + debounce", { timeout: 25_000 }, async () => {
  await withTempDir(async dir => {
    const sentMessages = [];
    const inboundQueue = [
      {
        message_type: 1,
        from_user_id: "wx_owner_2",
        context_token: "ctx_stat",
        item_list: [{ type: 1, text_item: { text: "状态" } }],
      },
      {
        message_type: 1,
        from_user_id: "wx_owner_2",
        context_token: "ctx_b1",
        item_list: [{ type: 1, text_item: { text: "第一句补充" } }],
      },
      {
        message_type: 1,
        from_user_id: "wx_owner_2",
        context_token: "ctx_b2",
        item_list: [{ type: 1, text_item: { text: "第二句补充" } }],
      },
    ];
    const mockWechat = createHttpServer((req, res) => {
      req.on("error", () => {});
      res.on("error", () => {});
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", () => {
        if (res.destroyed || res.writableEnded) return;
        const sendJson = (p) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(p)); };
        if (req.url.includes("ilink/bot/getupdates")) {
          if (inboundQueue.length > 0) {
            return sendJson({ ret: 0, msgs: inboundQueue.splice(0, inboundQueue.length), get_updates_buf: `b_${Date.now()}` });
          }
          setTimeout(() => { if (!res.destroyed && !res.writableEnded) sendJson({ ret: 0, msgs: [], get_updates_buf: "b_idle" }); }, 150);
          return;
        }
        if (req.url.includes("ilink/bot/sendmessage")) {
          sentMessages.push(JSON.parse(body || "{}").msg);
          return sendJson({ ret: 0 });
        }
        return sendJson({ ret: 0 });
      });
    }).listen(0, "127.0.0.1");
    mockWechat.on("connection", s => s.on("error", () => {}));
    await once(mockWechat, "listening");
    const mockUrl = `http://127.0.0.1:${mockWechat.address().port}`;

    try {
      await withSidecar(dir, "sched-token", async port => {
        const headers = { Authorization: "Bearer sched-token" };
        // 1. 极速「状态」指令立即返回电脑在线状态
        const statusMsg = await waitFor(() => sentMessages.find(m => m?.item_list?.[0]?.text_item?.text?.includes("电脑在线")), 8_000);
        assert.equal(statusMsg.context_token, "ctx_stat");

        // 2. 连发的两条消息被 250ms 防抖窗口合并成 1 条消息进入 Fellow 历史
        await waitFor(async () => {
          const hist = await (await fetch(`http://127.0.0.1:${port}/api/history/strategist`, { headers })).json();
          return hist.messages?.some(m => m.role === "user" && m.text.includes("第一句补充") && m.text.includes("第二句补充"));
        }, 10_000);

        // 3. MCP Bridge 暴露跨模型定时任务工具（create_schedule / list_schedules / toggle_schedule / delete_schedule）
        const bridge = spawn(process.execPath, [new URL("./orchestrator-mcp-bridge.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")], {
          env: {
            ...process.env,
            INKFELLOW_API_BASE: `http://127.0.0.1:${port}`,
            INKFELLOW_DESKTOP_TOKEN: "sched-token",
            INKFELLOW_PARENT_CONV_ID: "strategist",
            INKFELLOW_VAULT_CWD: dir,
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        const responses = new Map();
        let buf = "";
        bridge.stdout.on("data", chunk => {
          buf += chunk.toString("utf8");
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            const msg = JSON.parse(line);
            if (msg.id != null) responses.set(msg.id, msg);
          }
        });
        const rpc = async (id, method, params = {}) => {
          bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
          return waitFor(() => responses.get(id), 5000);
        };
        try {
          await rpc(1, "initialize", { protocolVersion: "2024-11-05" });
          const created = await rpc(2, "tools/call", {
            name: "create_schedule",
            arguments: { kind: "cron", description: "每日热点晨报", cronExpr: "30 8 * * *", prompt: "抓热点" },
          });
          assert.equal(created.result.isError, undefined);
          const job = JSON.parse(created.result.content[0].text);
          assert.ok(job.id);
          const listed = await rpc(3, "tools/call", { name: "list_schedules", arguments: {} });
          assert.ok(JSON.parse(listed.result.content[0].text).some(j => j.id === job.id));
          const toggled = await rpc(4, "tools/call", { name: "toggle_schedule", arguments: { id: job.id, enabled: false } });
          assert.equal(JSON.parse(toggled.result.content[0].text).ok, true);
          const deleted = await rpc(5, "tools/call", { name: "delete_schedule", arguments: { id: job.id } });
          assert.equal(JSON.parse(deleted.result.content[0].text).ok, true);

          // 4. 清理已完成任务 REST 接口可正常响应
          const clearedRes = await fetch(`http://127.0.0.1:${port}/api/orchestrator/tickets/clear-completed`, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: "{}",
          });
          assert.equal(clearedRes.status, 200);
          const clearedJson = await clearedRes.json();
          assert.equal(clearedJson.ok, true);
          assert.equal(Array.isArray(clearedJson.tickets), true);
        } finally {
          bridge.kill();
        }
      }, {
        extraEnv: { WECHAT_DEBOUNCE_MS: "250" },
        beforeStart: (port) => {
          writeFileSync(join(dir, `wechat-bot-${port}.json`), JSON.stringify({
            baseUrl: mockUrl,
            token: "mock-wx-token",
            userId: "wx_owner_2",
            botId: "mock-bot",
          }), "utf8");
        },
      });
    } finally {
      mockWechat.closeAllConnections?.();
      await new Promise(resolve => mockWechat.close(resolve));
    }
  });
});

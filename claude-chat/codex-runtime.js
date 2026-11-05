/**
 * ══════════════════════════════════════════════════════════════════════
 * PersistentCodexRuntime —— ChatGPT 通道的生产路径（app-server 协议）
 * ══════════════════════════════════════════════════════════════════════
 *
 * 这条路曾经退出过一次，原因是「和 codex-sdk 并联」——两条生命周期同时写
 * 同一条 thread，撞 active writer 冲突。2026-09-22 完整切回来，SDK 那条只
 * 留作降级兜底（CODEX_PERSISTENT=0），两条不再并联，那个冲突不复存在。
 *
 * ── 为什么值得常驻 ──────────────────────────────────────────
 * codex-sdk 的 Thread 每次 runStreamed 都 spawn 一个 `codex exec`，于是每轮
 * 对话都要从头付一遍进程起停的钱。2026-09-22 在本机同一账号实测：
 *
 *   每轮 spawn（codex-sdk）   整轮 15~20 秒，其中约 10 秒是启动 + 收尾
 *   app-server 常驻           第二轮起 2.7~3.7 秒
 *
 * 注意那 10 秒**不是** MCP server 拖的——实测 `-c mcp_servers={}` 跑出来一样
 * 慢，MCP 是并行加载的，不挡主流程。它就是进程起停本身的固定成本。
 *
 * 还有一层更要紧的，跟速度无关：codex 0.153 起 ChatGPT 通道走 WebSocket
 * （wss://chatgpt.com/backend-api/codex/responses），而它是**先把连接建好再去
 * 干活**（日志里 websocket.warmup=true）。从连上到第一帧响应之间那几秒，连接
 * 是空的——实测 4.1 秒（7k token 上下文）到 7.3 秒（100k），上下文越大越久。
 * 走代理时这个空窗正是最容易被中间设备回收的地方。
 *
 * 每轮 spawn 等于每轮都重新赌一次这个空窗；常驻之后连接跨轮复用（实测空闲
 * 4 分钟仍是同一条，建连次数不增），这个空窗每个进程只出现一次。所以常驻
 * 不是拿稳定性换速度，两样一起拿。详见 [[inkfellow-codex-websocket-transport]]。
 *
 * ── 为什么是 app-server 而不是别的 ──────────────────────────
 * `codex exec` 的 stdin 只能当一次性 prompt 用，喂不进第二轮；Unix 上那个
 * `codex app-server daemon` 在 Windows 直接报 "only supported on Unix"。
 * 剩下能常驻的就是自己起 `codex app-server`，跟它说行分隔的 JSON-RPC。
 *
 * ── 协议边界（2026-09-22 对真实 app-server 验过）────────────
 * 图片走 `{type:"localImage", path}`（camelCase，跟 SDK 的 local_image 不同）；
 * turn/interrupt 只打断这一轮、进程和上下文都留着，之后还能接着跑；换个进程
 * thread/resume 回去，上下文仍在。用户自己那条消息会以 userMessage item 回放，
 * fromAppServerItem 认不出它而返回 null，正好不会在界面上重复渲染一遍。
 *
 * ── 事件形状 ──────────────────────────────────────────────
 * app-server 的通知和 SDK 的 thread event 是同源的，只是命名风格不同
 * （item/completed vs item.completed、agentMessage vs agent_message）。
 * 归一化在 providers/codex.js 的 fromAppServerItem 里，翻完之后走的还是
 * 原来那套 itemEvents，前端和历史都不用改。
 */

import crypto from "node:crypto";

/** JSON-RPC 请求超时。握手/建线程卡住时得有个头，不能让用户干等。 */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * 常驻进程是按哪套参数起的；变了就得重起。
 *
 * 刻意不含 model 和 effort：它们每轮通过 turn/start 传，换模型不需要重启进程。
 * 为它们重起一次要再付一遍启动开销（实测 spawn 那条路整轮 15~20 秒，其中约
 * 10 秒是进程起停的固定成本），而 app-server 本来就允许一条 thread 里换模型。
 */
export function codexRuntimeSignature({ bin, cwd, permissionMode }) {
  return crypto.createHash("sha256")
    .update(JSON.stringify({ bin, cwd, permissionMode }))
    .digest("hex");
}

/**
 * 手上这个常驻进程还能接着用吗。
 *
 * 只看进程本身。thread 该复用还是新开交给 ensureThread——它拿 threadId 判断，
 * 用户重置之后传的正是 null，那时候就该在同一个进程里开一条新的。
 */
export function codexRuntimeReusable(runtime, signature) {
  return Boolean(runtime.started && runtime.signature === signature);
}

/* codex 会反过来问客户端问题（要不要批准这条命令、这个补丁）。approvalPolicy
   给的是 "never"，正常不该收到；但万一收到而我们不回，那一轮就永远挂着——
   codex 在等一个不会来的答复。所以一律回一个「同意」：
   approvalPolicy=never 的语义本来就是「别拿这些来烦用户」，而真正的安全边界
   是 sandbox（plan 模式是 read-only，越权的操作在那一层就被挡了）。 */
const APPROVAL_METHODS = new Set([
  "applyPatchApproval",
  "execCommandApproval",
  "commandExecutionRequestApproval",
  "fileChangeRequestApproval",
  "permissionsRequestApproval",
]);

/** 进程还活着吗。 */
function isAlive(proc) {
  return Boolean(proc) && proc.exitCode === null && proc.signalCode === null;
}

/* thread/resume 的失败没有结构化的错误码（-32600/-32603 什么都装），只能认报错原文。
   原文归上游所有，所以 codex-runtime-contract.test.js 拿真实二进制钉着：
   升级 codex 时要是改了措辞，那边当场会红。 */

/** 服务端确认这条 thread 不存在。 */
const THREAD_GONE = /\b(?:session|thread|conversation)(?:\s+id)?(?:\s+['"]?[\w:.-]+['"]?)?\s+(?:(?:is\s+)?(?:not found|missing)|does not exist)\b|\b(?:no|unknown|missing)\s+(?:such\s+)?(?:session|thread|conversation)\b|\bno\s+rollout\s+(?:found\s+)?for\s+(?:session|thread|conversation)\b/i;

/* 会话文件还在，但内容坏了，重试多少次都一样。同一段前缀后面也可能跟 (os error 32)
   这种——文件被占用、没权限，那只是暂时读不了，不算在内。锚定结尾是因为前面带着
   文件路径，路径里什么字都可能有。 */
const THREAD_HISTORY_DAMAGED = /\bfailed to read session metadata\b[\s\S]*(?:\bis empty|\bdid not contain valid UTF-8)\s*$/i;

/** 这条 thread 救不回来了，只能换新的。其余的失败一律不算，见 ensureThread。 */
function isUnrecoverableThread(error) {
  if (!error?.codexRpcError) return false;
  const message = String(error.message || "");
  return THREAD_GONE.test(message) || THREAD_HISTORY_DAMAGED.test(message);
}

export class PersistentCodexRuntime {
  /**
   * @param {object} [options]
   * @param {function} [options.killProcess] (proc) => void
   *   Windows 上 proc.kill() 杀不掉 codex 起的 MCP 子进程，得走 taskkill /T。
   * @param {function} [options.now] 取当前时间，测试里好控时。
   */
  constructor({ killProcess = null, now = () => Date.now() } = {}) {
    this._killProcess = killProcess ?? (proc => { try { proc.kill("SIGTERM"); } catch { /* 已经退了 */ } });
    this._now = now;
    this.proc = null;
    /** 当前进程是按哪套参数起的；调用方拿它判断要不要重起。 */
    this.signature = null;
    /** 这个 runtime 手上的 thread。换会话就得重新 start/resume。 */
    this.threadId = null;
    /** 正在跑的那一轮的 turnId，interrupt 要用。 */
    this.turnId = null;
    this._nextId = 0;
    this._pending = new Map();
    this._buffer = "";
    this._stderr = "";
    this._turn = null;
    this._steers = new Map();
    this._completedTurnIds = new Set();
  }

  get started() { return isAlive(this.proc); }

  /** 正在跑一轮吗。 */
  get busy() { return this._turn !== null || this._steers.size > 0; }

  /** 起进程。之后必须先 initialize 才能用。 */
  start({ spawn, signature }) {
    if (typeof spawn !== "function") throw new TypeError("spawn is required");
    if (this.started) throw new Error("codex runtime 已经起过了");
    const proc = spawn();
    this.proc = proc;
    this.signature = signature;
    this.threadId = null;
    this.turnId = null;
    this._completedTurnIds.clear();
    this._buffer = "";
    this._stderr = "";

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", chunk => { if (this.proc === proc) this._onStdout(chunk); });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", chunk => { if (this.proc === proc) this._stderr += chunk; });
    proc.on("error", err => { if (this.proc === proc) this._onExit(err); });
    proc.on("close", code => { if (this.proc === proc) this._onExit(null, code); });
    return proc;
  }

  /** 握手。不做这一步后面所有请求都会被拒。 */
  async initialize(clientInfo) {
    await this._request("initialize", { clientInfo });
    this._send({ method: "initialized", params: {} });
  }

  /**
   * 确保手上有一条可用的 thread。
   * 给了 threadId 就接上那条，没给就开一条新的。接不上时看原因：确认救不回来才换新的
   * （调用方看 resumed:false 补上整段对话记录），其余的把错误抛出去，原 thread 留着。
   *
   * @returns {Promise<{threadId: string, resumed: boolean}>}
   */
  async ensureThread({ threadId = null, params = {} }) {
    /* 复用要求「手上这条」和「要接的那条」是同一条。不能写成「没指定就复用
       手上的」——用户重置之后 threadId 传的正是 null，那样会接着用重置前的
       上下文，等于重置没生效。 */
    if (this.threadId && this.threadId === threadId) {
      return { threadId: this.threadId, resumed: true };
    }
    if (threadId) {
      try {
        const res = await this._request("thread/resume", { ...params, threadId });
        this.threadId = res?.thread?.id ?? res?.threadId ?? threadId;
        return { threadId: this.threadId, resumed: true };
      } catch (error) {
        // 超时、文件被占用这类暂时的失败不能换：换了就丢掉 codex 那边的完整上下文。
        if (!isUnrecoverableThread(error)) throw error;
      }
    }
    const res = await this._request("thread/start", params);
    this.threadId = res?.thread?.id ?? res?.threadId ?? null;
    if (!this.threadId) throw new Error("codex app-server 没有返回 thread id");
    return { threadId: this.threadId, resumed: false };
  }

  /**
   * 跑一轮。
   *
   * onEvent 收到的是 (method, params) 原样的通知，翻译交给调用方。
   * @returns {Promise<{turn, usage}>} turn 是 turn/completed 带回来的那个对象
   */
  runTurn({ input, params = {}, onEvent = null, signal = null }) {
    return new Promise((resolve, reject) => {
      if (!this.started) { reject(new Error("codex runtime 没在跑")); return; }
      if (!this.threadId) { reject(new Error("codex runtime 还没有 thread")); return; }
      if (this.busy) { reject(new Error("同一个 codex runtime 不能并发跑两轮")); return; }
      if (signal?.aborted) { reject(this._abortError()); return; }

      const onAbort = () => {
        const turn = this._turn;
        if (turn) turn.aborted = true;
        /* 先礼后兵：turn/interrupt 能只打断这一轮而把进程和上下文留住，
           这是 app-server 相比「杀进程」最实在的一个好处。发不出去再杀。 */
        this._interruptAbortedTurn();
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      this._turn = {
        resolve,
        reject,
        onEvent,
        aborted: false,
        usage: null,
        detach: () => {
          clearTimeout(startedTurn.cancelTimer);
          try { signal?.removeEventListener("abort", onAbort); } catch { /* 老版本没有 */ }
        },
      };
      this._stderr = "";

      const startedTurn = this._turn;
      this._request("turn/start", { ...params, threadId: this.threadId, input })
        .then((res) => {
          if (this._turn !== startedTurn) return;
          this.turnId = res?.turn?.id ?? this.turnId;
          this._interruptAbortedTurn();
        })
        .catch(err => { if (this._turn === startedTurn) this._settleTurn(err); });
    });
  }

  /** Resolve only when Codex confirms consuming this client message. RPC
   * acceptance alone is not a delivery receipt. Keep the original turn pinned. */
  steerTurn({ input, expectedTurnId, clientUserMessageId, onApplied = null }) {
    const turn = this._turn;
    const existing = this._steers.get(clientUserMessageId);
    if (existing) return existing.promise;
    if (!turn || !this.started || !expectedTurnId || this.turnId !== expectedTurnId) {
      return Promise.reject(Object.assign(new Error("Codex has no matching active turn"), { codexSteerRejected: true }));
    }
    if (turn.aborted) return Promise.reject(this._abortError());
    if (!clientUserMessageId) return Promise.reject(new TypeError("clientUserMessageId is required"));
    const threadId = this.threadId;
    const op = { turn, turnId: expectedTurnId, accepted: false, applied: false, verifying: false };
    op.promise = new Promise((resolve, reject) => {
      op.fail = error => {
        if (op.applied || !this._steers.has(clientUserMessageId)) return;
        this._steers.delete(clientUserMessageId);
        reject(error);
      };
      op.apply = () => {
        if (op.applied) return;
        op.applied = true;
        this._steers.delete(clientUserMessageId);
        try {
          onApplied?.(); // synchronous: split history before forwarding continued output
          resolve({ turnId: expectedTurnId, applied: true });
        } catch (error) {
          error.codexSteerUncertain = true;
          reject(error);
        }
      };
    });
    op.verify = async () => {
      if (op.applied || op.verifying || !op.accepted) return;
      op.verifying = true;
      try {
        const consumed = await this._hasSteeredMessage(threadId, expectedTurnId, clientUserMessageId);
        if (consumed) {
          op.apply();
        } else {
          op.fail(Object.assign(new Error("Codex finished before consuming the follow-up"), { codexSteerRejected: true }));
        }
      } catch (error) {
        error.codexSteerUncertain = true;
        op.fail(error);
      }
    };
    this._steers.set(clientUserMessageId, op);
    this._request("turn/steer", { threadId, input, expectedTurnId, clientUserMessageId })
      .then(result => {
        if (op.applied) return;
        if (result?.turnId !== expectedTurnId) throw new Error("Codex accepted an unexpected turn");
        op.accepted = true;
        if (this._turn !== turn) void op.verify();
      })
      .catch(error => {
        if (error.codexRpcError) error.codexSteerRejected = true;
        else error.codexSteerUncertain = true;
        op.fail(error);
      });
    return op.promise;
  }

  /** 收掉进程。在跑的那一轮会以中断收场。 */
  kill() {
    const proc = this.proc;
    if (!proc) return;
    if (isAlive(proc)) this._killProcess(proc);
    else this._onExit(null, proc.exitCode);
  }

  // ── 内部 ────────────────────────────────────────────────────

  _abortError() {
    const err = new Error("Codex 请求已取消");
    err.name = "AbortError";
    return err;
  }

  async _hasSteeredMessage(threadId, turnId, clientUserMessageId) {
    try {
      let cursor = null;
      const seenCursors = new Set();
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        const page = await this._request("thread/items/list", {
          threadId, turnId, limit: 100, sortDirection: "desc", ...(cursor ? { cursor } : {}),
        });
        if (!Array.isArray(page?.data)) throw new Error("Codex did not return delivery history");
        for (const entry of page.data) {
          if (entry?.turnId !== turnId || typeof entry.item?.type !== "string") {
            throw new Error("Codex returned incomplete delivery history");
          }
          if (entry.item.type === "userMessage" && entry.item.clientId === clientUserMessageId) return true;
        }
        if (page.nextCursor == null) return false;
        if (typeof page.nextCursor !== "string" || !page.nextCursor || seenCursors.has(page.nextCursor)) {
          throw new Error("Codex returned an invalid delivery-history cursor");
        }
        cursor = page.nextCursor;
        seenCursors.add(cursor);
      }
      throw new Error("Codex delivery history exceeded the verification limit");
    } catch (error) {
      // Older runtimes or non-paginated stores may not support this method.
      if (!error?.codexRpcError || !(error.code === -32601 || /unsupported|not supported|method not found/i.test(error.message))) throw error;
      const snapshot = await this._request("thread/read", { threadId, includeTurns: true });
      const turns = snapshot?.thread?.turns;
      if (!Array.isArray(turns)) throw new Error("Codex did not return delivery history");
      const turn = turns.find(entry => entry.id === turnId);
      if (!turn || !Array.isArray(turn.items)) throw new Error("Codex did not return the delivery turn");
      return turn.items.some(item => item.type === "userMessage" && item.clientId === clientUserMessageId);
    }
  }

  _interruptAbortedTurn() {
    const turn = this._turn;
    const proc = this.proc;
    if (!turn?.aborted || turn.interruptSent) return;
    if (!turn.cancelTimer) {
      turn.cancelTimer = setTimeout(() => {
        if (this._turn === turn && this.proc === proc) this.kill();
      }, 5_000);
      turn.cancelTimer.unref?.();
    }
    // turn/start can still be in flight. The protocol requires a real turn ID.
    if (!this.turnId) return;
    turn.interruptSent = true;
    this._request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId })
      .catch(() => { if (this._turn === turn && this.proc === proc) this.kill(); });
  }

  _send(payload) {
    if (!this.started) throw new Error("codex runtime 没在跑");
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  _request(method, params) {
    return new Promise((resolve, reject) => {
      let id;
      try {
        id = ++this._nextId;
        this._send({ jsonrpc: "2.0", id, method, params });
      } catch (err) { reject(err); return; }
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`codex app-server 的 ${method} 超过 ${REQUEST_TIMEOUT_MS}ms 没有回应`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this._pending.set(id, { resolve, reject, timer });
    });
  }

  _onStdout(chunk) {
    this._buffer += chunk;
    let idx;
    while ((idx = this._buffer.indexOf("\n")) >= 0) {
      const line = this._buffer.slice(0, idx).trim();
      this._buffer = this._buffer.slice(idx + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      this._onMessage(message);
    }
  }

  _onMessage(message) {
    // 我们发出去的请求的回应
    if (message.id != null && this._pending.has(message.id)) {
      const waiter = this._pending.get(message.id);
      this._pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(Object.assign(new Error(message.error.message || JSON.stringify(message.error)), {
        codexRpcError: true, code: message.error.code, data: message.error.data,
      }));
      else waiter.resolve(message.result);
      return;
    }
    // codex 反过来问我们的（见 APPROVAL_METHODS 上面的注释）
    if (message.id != null && message.method) {
      this._answerServerRequest(message);
      return;
    }
    if (!message.method) return;
    this._onNotification(message.method, message.params ?? {});
  }

  _answerServerRequest(message) {
    const tail = String(message.method).split("/").pop();
    const approved = APPROVAL_METHODS.has(tail);
    try {
      this._send(approved
        ? { jsonrpc: "2.0", id: message.id, result: { decision: "approved" } }
        : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `inkfellow 不处理 ${message.method}` } });
    } catch { /* 进程没了，下面的 close 会收拾这一轮 */ }
  }

  _onNotification(method, params) {
    const turn = this._turn;
    const eventThreadId = params.threadId || params.thread?.id;
    const ownThread = !eventThreadId || !this.threadId || eventThreadId === this.threadId;
    const eventTurnId = params.turnId || params.turn?.id;
    if (!ownThread || (eventTurnId && (this._completedTurnIds.has(eventTurnId)
      || (this.turnId && eventTurnId !== this.turnId)))) return;
    if ((method === "item/started" || method === "item/completed") && params?.item?.type === "userMessage") {
      const op = this._steers.get(params.item.clientId);
      if (op && op.turn === turn && (!params.turnId || params.turnId === op.turnId)
        && (!params.threadId || params.threadId === this.threadId)) op.apply();
    }
    if (method === "thread/started" && !this.threadId && params?.thread?.id) this.threadId = params.thread.id;
    if (method === "turn/started" && ownThread && turn && params?.turn?.id) {
      this.turnId = params.turn.id;
      this._interruptAbortedTurn();
    }
    if (method === "thread/tokenUsage/updated" && turn) turn.usage = params?.tokenUsage ?? turn.usage;

    if (turn?.onEvent) {
      try { turn.onEvent(method, params); } catch { /* 翻译失败不该把整轮带崩 */ }
    }

    if (method === "turn/completed" && ownThread
      && (!this.turnId || !params.turn?.id || params.turn.id === this.turnId)) {
      this._settleTurn(null, params?.turn ?? null);
    }
  }

  _onExit(error, code = null) {
    const wasAlive = this.proc !== null;
    this.proc = null;
    this.signature = null;
    this.threadId = null;
    this.turnId = null;
    for (const op of this._steers.values()) {
      op.fail(Object.assign(new Error("Codex exited before confirming the follow-up"), { codexSteerUncertain: true }));
    }
    for (const [, waiter] of this._pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("codex app-server 已退出"));
    }
    this._pending.clear();
    if (!wasAlive) return;
    const turn = this._turn;
    if (!turn) return;
    if (turn.aborted) { this._settleTurn(this._abortError()); return; }
    const detail = this._stderr.trim() || (error ? String(error.message || error) : `codex app-server 退出码 ${code}`);
    const err = new Error(detail);
    // 进程是在一轮当中没的，调用方要能分辨这个和「跑完了但结果是错的」
    err.codexProcessDied = true;
    this._settleTurn(err);
  }

  _settleTurn(error, turnResult = null) {
    const turn = this._turn;
    if (!turn) return;
    const completedId = this.turnId || turnResult?.id;
    if (completedId) {
      this._completedTurnIds.add(completedId);
      if (this._completedTurnIds.size > 50) this._completedTurnIds.delete(this._completedTurnIds.values().next().value);
    }
    this.turnId = null;
    this._turn = null;
    for (const op of this._steers.values()) {
      if (op.turn === turn) void op.verify();
    }
    turn.detach();
    if (error) { turn.reject(error); return; }
    if (turn.aborted) { turn.reject(this._abortError()); return; }
    turn.resolve({ turn: turnResult, usage: turn.usage });
  }
}

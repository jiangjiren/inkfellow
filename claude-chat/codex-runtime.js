/**
 * ══════════════════════════════════════════════════════════════════════
 * PersistentCodexRuntime —— 一个 codex app-server 进程连续跑多轮
 * ══════════════════════════════════════════════════════════════════════
 *
 * codex-sdk 的 Thread 每次 runStreamed 都 spawn 一个 `codex exec`，于是每轮
 * 对话都要从头付一遍启动开销。实测（同一台机器，同一个账号）：
 *
 *   codex-sdk 每轮        spawn → thread.started  约 3.3 秒
 *   app-server 常驻       turn/start → turn/started  约 70 毫秒
 *
 * 那 3 秒里最贵的一段是 MCP server：用户 ~/.codex/config.toml 里配了几个，
 * 每次 spawn 都要把它们全部重启一遍（实测 chrome-devtools 一个就 3.3 秒）。
 * 常驻之后这些只在开进程时付一次。
 *
 * ── 为什么是 app-server 而不是别的 ──────────────────────────
 * `codex exec` 的 stdin 只能当一次性 prompt 用，喂不进第二轮；Unix 上那个
 * `codex app-server daemon` 在 Windows 直接报 "only supported on Unix"。
 * 剩下能常驻的就是自己起 `codex app-server`，跟它说行分隔的 JSON-RPC。
 *
 * ── 协议是 experimental，所以留了退路 ────────────────────────
 * `codex app-server` 官方标着 [experimental]，方法名和事件形状都可能随版本
 * 变。所以这条路不是替换而是并联：起不来、握手失败、跑一半崩了，调用方都能
 * 退回原来的 codex-sdk 路径（见 server.js 的 codex 分支）。宁可慢，不可断。
 *
 * ── 事件形状 ──────────────────────────────────────────────
 * app-server 的通知和 SDK 的 thread event 是同源的，只是命名风格不同
 * （item/completed vs item.completed、agentMessage vs agent_message）。
 * 归一化在 providers/codex.js 的 fromAppServerItem 里，翻完之后走的还是
 * 原来那套 itemEvents，前端和历史都不用改。
 */

/** JSON-RPC 请求超时。握手/建线程卡住时得有个头，不能让用户干等。 */
const REQUEST_TIMEOUT_MS = 60_000;

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
  }

  get started() { return isAlive(this.proc); }

  /** 正在跑一轮吗。 */
  get busy() { return this._turn !== null; }

  /** 起进程。之后必须先 initialize 才能用。 */
  start({ spawn, signature }) {
    if (typeof spawn !== "function") throw new TypeError("spawn is required");
    if (this.started) throw new Error("codex runtime 已经起过了");
    const proc = spawn();
    this.proc = proc;
    this.signature = signature;
    this.threadId = null;
    this.turnId = null;
    this._buffer = "";
    this._stderr = "";

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", chunk => this._onStdout(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", chunk => { this._stderr += chunk; });
    proc.on("error", err => this._onExit(err));
    proc.on("close", code => this._onExit(null, code));
    return proc;
  }

  /** 握手。不做这一步后面所有请求都会被拒。 */
  async initialize(clientInfo) {
    await this._request("initialize", { clientInfo });
  }

  /**
   * 确保手上有一条可用的 thread。
   * 给了 threadId 就接上那条，给不了（或接不上）就开一条新的。
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
      } catch {
        /* 接不上就开新的：那条 thread 可能已经被删了、或是别的版本写的。
           这里吞掉错误是刻意的——用户要的是「能接着聊」，不是一条报错。 */
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
        this._request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId })
          .catch(() => this.kill());
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      this._turn = {
        resolve,
        reject,
        onEvent,
        aborted: false,
        usage: null,
        detach: () => { try { signal?.removeEventListener("abort", onAbort); } catch { /* 老版本没有 */ } },
      };
      this._stderr = "";

      this._request("turn/start", { ...params, threadId: this.threadId, input })
        .then((res) => { this.turnId = res?.turn?.id ?? null; })
        .catch(err => this._settleTurn(err));
    });
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
      if (message.error) waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
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
    if (method === "thread/started" && params?.thread?.id) this.threadId = params.thread.id;
    if (method === "turn/started" && params?.turn?.id) this.turnId = params.turn.id;
    if (method === "thread/tokenUsage/updated" && turn) turn.usage = params?.tokenUsage ?? turn.usage;

    if (turn?.onEvent) {
      try { turn.onEvent(method, params); } catch { /* 翻译失败不该把整轮带崩 */ }
    }

    if (method === "turn/completed") {
      this.turnId = null;
      this._settleTurn(null, params?.turn ?? null);
    }
  }

  _onExit(error, code = null) {
    const wasAlive = this.proc !== null;
    this.proc = null;
    this.signature = null;
    this.threadId = null;
    this.turnId = null;
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
    this._turn = null;
    turn.detach();
    if (error) { turn.reject(error); return; }
    if (turn.aborted) { turn.reject(this._abortError()); return; }
    turn.resolve({ turn: turnResult, usage: turn.usage });
  }
}

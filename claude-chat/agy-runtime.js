/**
 * ══════════════════════════════════════════════════════════════════════
 * PersistentAgyRuntime —— 一个 agy 进程连续跑多轮
 * ══════════════════════════════════════════════════════════════════════
 *
 * 改这个是因为 agy 的启动实在太贵。实测（三家的对比见 README 的
 * Provider Process Reuse 一节）：
 *
 *   spawn → 第一个 init 事件      11~20 秒
 *   init  → 第一个字               3~10 秒
 *
 * 那 11~20 秒是 agy CLI 自己在起（读配置、验登录、连服务端），跟用户问了什么
 * 无关。原来每轮对话都新起一个进程，于是每轮都从头付一遍这笔钱——用户看到的
 * 就是「发完消息要愣十几二十秒才开始出字」。
 *
 * agy 自己给了出路：`--input-format stream-json` 让一个进程从 stdin 逐行读
 * NDJSON，每行跑一轮。实测同一个进程里：
 *
 *   第 1 轮  20.4 秒到 init，30.2 秒出首字
 *   第 2 轮  0.23 秒开跑，5.2 秒出首字
 *   第 3 轮  0.22 秒开跑，6.2 秒出首字   ← 而且记得住前两轮说了什么
 *
 * 所以这里把它做成和 Claude 那条路一样的常驻 runtime：启动开销一个对话只付
 * 一次，后面每轮直接往 stdin 写一行。
 *
 * ── 一轮的边界 ────────────────────────────────────────────────
 * 写一行 → 读到 `result` 事件为止。agy 每轮结束都会发且只发一条 result，
 * 它同时带着这一轮的 status 和 usage。
 *
 * ── 进程什么时候作废 ──────────────────────────────────────────
 * 命令行参数（模型、档位、模式、工作目录、续接哪条会话）在 spawn 时就定死了，
 * 改不了。所以调用方拿 signature 判断：变了就 kill 重起。这跟 Claude 那边
 * claudeRuntimeSignature 是同一套思路。
 *
 * 中断也是 kill——agy 没有「打断当前这轮」的通道。会话 id 存在 agy 自己的库
 * 里，下一轮用 --conversation 接回来，只是要重付一次启动。
 */

import crypto from "node:crypto";
import * as agyProvider from "./providers/antigravity.js";

/* 不再有超时兜底：进程只能靠停止按钮或本进程退出来收。默认给一个大到不会
   撞上的值，真要限制可以用环境变量压回去。 */
export const AGY_PRINT_TIMEOUT = process.env.AGY_PRINT_TIMEOUT || "8760h";

/* 参数指纹。这几样在 spawn 时就定死在命令行里，任何一个变了都得重起进程。

   刻意不含 conversationId：新对话的第一轮是 agy 自己生成 id 回传给我们的，
   把它算进指纹，下一轮就必然对不上，等于白常驻。「还是不是同一条会话」由
   runtime.boundConversationId 单独比（见 agyRuntimeReusable）。 */
export function agyRuntimeSignature({ bin, cwd, model, effort, permissionMode }) {
  return crypto.createHash("sha256")
    .update(JSON.stringify({ bin, cwd, model, effort, permissionMode }))
    .digest("hex");
}

/** 常驻进程的命令行。跟一次性那套的区别只有：prompt 改从 stdin 来。 */
export function agyPersistentArgs({ cwd, model, effort, permissionMode, resumeConversationId }) {
  const args = [
    // Go 的 flag 包要求 --print 带值；prompt 走 stdin，所以给个空的。
    // 写成分开的两个参数会被它当成「把下一个参数当 prompt」，必须是 --print= 这一坨。
    "--print=",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--print-timeout", AGY_PRINT_TIMEOUT,
    "--mode", agyProvider.modeFlag(permissionMode),
    // headless 下没人能点授权弹窗，不放行的话工具会一直等到 print-timeout。
    // plan 模式靠上面的 --mode 限制它别动文件，而不是靠权限拦。
    "--dangerously-skip-permissions",
  ];
  if (model) args.push("--model", model);
  const effortFlag = agyProvider.effortForModel(model, effort);
  if (effortFlag) args.push("--effort", effortFlag);
  if (cwd) args.push("--add-dir", cwd);
  // 不传 --add-dir 时它会跑到 ~/.gemini/antigravity-cli/scratch 里操作文件
  if (resumeConversationId) args.push("--conversation", resumeConversationId);
  return args;
}

/** 现在这个进程还能接着用吗：参数没变，且绑的还是同一条会话。 */
export function agyRuntimeReusable(runtime, signature, wantConversationId) {
  if (!runtime.started || runtime.signature !== signature) return false;
  // 用户重置或切换过会话，进程里那条上下文就不是他要的了
  return (wantConversationId ?? null) === (runtime.boundConversationId ?? null);
}

/** 进程还活着吗。 */
function isAlive(proc) {
  return Boolean(proc) && proc.exitCode === null && proc.signalCode === null;
}

export class PersistentAgyRuntime {
  /**
   * @param {object} [options]
   * @param {function} [options.killProcess] (proc) => void
   *   Windows 上 proc.kill() 杀不掉 agy 起的子 shell，得走 taskkill /T。
   */
  constructor({ killProcess = null } = {}) {
    this._killProcess = killProcess ?? (proc => { try { proc.kill("SIGTERM"); } catch { /* 已经退了 */ } });
    this.proc = null;
    /** 当前进程是按哪套命令行参数起的；调用方拿它判断要不要重起。 */
    this.signature = null;
    /** 这个进程绑在哪条 agy 会话上。第一轮的 init 事件里才知道。 */
    this.boundConversationId = null;
    this._turn = null;
    this._buffer = "";
    this._stderr = "";
  }

  get started() { return isAlive(this.proc); }

  /** 正在跑一轮吗。同一个进程不能并发跑两轮——stdin 是一条串行的队。 */
  get busy() { return this._turn !== null; }

  /**
   * 起进程。不等 init——那要十几秒，而且只有真发了一轮才会来。
   *
   * spawn 由调用方给：命令行参数（模型、档位、模式、工作目录、续接哪条会话）
   * 是每轮才知道的，这里只管进程起来之后的事。
   *
   * @param {object} options
   * @param {function} options.spawn () => ChildProcess
   * @param {string} options.signature 这套参数的指纹，之后用来判断能不能复用
   * @param {string|null} [options.resumeConversationId] 起进程时接的是哪条会话
   */
  start({ spawn, signature, resumeConversationId = null }) {
    if (typeof spawn !== "function") throw new TypeError("spawn is required");
    if (this.started) throw new Error("agy runtime 已经起过了");
    const proc = spawn();
    this.proc = proc;
    this.signature = signature;
    this.boundConversationId = resumeConversationId;
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

  /**
   * 跑一轮。message 是要写进 stdin 的那条 NDJSON（调用方负责组装）。
   *
   * @returns {Promise<{conversationId, text, usage, status}>}
   *   resolve 只代表「这一轮跑完了」，status 非 SUCCESS 由调用方决定怎么报。
   */
  runTurn({ message, onEvent = null, onSession = null, signal = null }) {
    return new Promise((resolve, reject) => {
      if (!this.started) { reject(new Error("agy runtime 没在跑")); return; }
      if (this.busy) { reject(new Error("同一个 agy runtime 不能并发跑两轮")); return; }
      if (signal?.aborted) { reject(this._abortError()); return; }

      const onAbort = () => {
        const turn = this._turn;
        if (turn) turn.aborted = true;
        // agy 没有「打断这一轮」的通道，只能连进程一起收掉
        this.kill();
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      this._turn = {
        resolve,
        reject,
        onEvent,
        onSession,
        aborted: false,
        answerParts: [],
        resultPayload: null,
        detach: () => { try { signal?.removeEventListener("abort", onAbort); } catch { /* 老版本没有 */ } },
      };
      this._stderr = "";

      try {
        this.proc.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (err) {
        this._settleTurn(new Error(`写入 Antigravity CLI 失败：${String(err?.message || err)}`));
      }
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
    const err = new Error("Antigravity 请求已取消");
    err.name = "AbortError";
    return err;
  }

  _onStdout(chunk) {
    this._buffer += chunk;
    let idx;
    while ((idx = this._buffer.indexOf("\n")) >= 0) {
      const line = this._buffer.slice(0, idx).trim();
      this._buffer = this._buffer.slice(idx + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      this._onEvent(ev);
    }
  }

  _onEvent(ev) {
    const turn = this._turn;
    if (ev.event === "init") this._noteConversation(ev.init?.conversation_id || ev.conversation_id);
    if (ev.event === "step_update") {
      const step = ev.step_update;
      this._noteConversation(step?.conversation_id);
      if (turn && step?.step_type === "agent_response" && typeof step.text_delta === "string") {
        turn.answerParts.push(step.text_delta);
      }
    }
    if (ev.event === "result") {
      this._noteConversation(ev.result?.conversation_id);
      if (turn) turn.resultPayload = ev.result ?? null;
    }
    /* 事件先交出去再结束这一轮：result 本身也要走翻译器，前端靠它收尾。
       单条事件翻译失败不该把整轮带崩。 */
    if (turn?.onEvent) {
      try { turn.onEvent(ev); } catch { /* 见上 */ }
    }
    if (ev.event === "result") this._settleTurn(null);
  }

  _noteConversation(id) {
    if (!id || id === this.boundConversationId) return;
    this.boundConversationId = id;
    const onSession = this._turn?.onSession;
    if (onSession) { try { onSession(id); } catch { /* 记录失败不该影响本轮 */ } }
  }

  _onExit(error, code = null) {
    const wasAlive = this.proc !== null;
    this.proc = null;
    this.signature = null;
    if (!wasAlive) return;
    const turn = this._turn;
    if (!turn) return;
    if (turn.aborted) { this._settleTurn(this._abortError()); return; }
    const detail = this._stderr.trim() || (error ? String(error.message || error) : `Antigravity CLI 退出码 ${code}`);
    const err = new Error(detail);
    // 进程是在一轮当中没的，调用方要能分辨这个和「跑完了但结果是错的」
    err.agyProcessDied = true;
    this._settleTurn(err);
  }

  _settleTurn(error) {
    const turn = this._turn;
    if (!turn) return;
    this._turn = null;
    turn.detach();
    if (error) { turn.reject(error); return; }
    const payload = turn.resultPayload;
    turn.resolve({
      conversationId: this.boundConversationId,
      /* result 的 response 是这一轮的全文，正常情况下跟累积起来的增量一样。
         用 || 而不是 ??：agy 偶尔会给一个空的 response（工具轮、被截断的轮），
         那时候真正的文本只在 text_delta 里，?? 会把它当成「有值」而丢掉。 */
      text: (payload?.response || turn.answerParts.join("")).trim(),
      usage: payload?.usage ?? null,
      status: payload?.status ?? "SUCCESS",
      error: payload?.error ?? null,
      stderr: this._stderr.trim(),
    });
  }
}

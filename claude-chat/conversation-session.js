/**
 * ══════════════════════════════════════════════════════════════════════
 * ConversationSession —— 一个对话的运行时状态
 * ══════════════════════════════════════════════════════════════════════
 *
 * 这些字段原本是 server.js 里 23 个模块级 let。单会话时那样能跑，因为
 * 「当前对话」只有一个，全局变量就是它。要同时跑多个对话，第一步是把这堆
 * 状态收进一个可以有多份的对象里——否则第二个对话一起跑，两边的回合状态、
 * 历史游标、中断控制器会互相踩。
 *
 * 现在仍然只 new 一个实例，行为跟改造前完全一致。真正的多开是下一步：
 * 把持有它的地方换成 Map<conversationId, ConversationSession>。
 *
 * 刻意没搬进来的两个：
 *   - detachedBuffer  属于 WebSocket 连接，不属于某一个对话
 *   - steeringQueue   内部已经按 ownerToken 分组，再按会话切一刀是重复的
 */

export class ConversationSession {
  /**
   * @param {object} [options]
   * @param {string|null} [options.conversationId] 这个实例属于哪个对话（ambient 为 null）
   * @param {function} [options.createRuntime] 造这个会话专属的 Claude 持久 runtime。
   *   懒创建：大多数会话只是躺在历史里，没必要为它们各起一个 SDK 子进程。
   * @param {function} [options.createAgyRuntime] 同上，Antigravity（Gemini）那条路的。
   */
  constructor({ conversationId = null, createRuntime = null, createAgyRuntime = null, createCodexRuntime = null } = {}) {
    this.conversationId = conversationId;
    this._createRuntime = createRuntime;
    this._claudeRuntime = null;
    this._createAgyRuntime = createAgyRuntime;
    this._agyRuntime = null;
    this._createCodexRuntime = createCodexRuntime;
    this._codexRuntime = null;
    /* 空闲多久就把 codex 常驻进程收掉的那个定时器。见 server.js 的
       scheduleCodexIdleShutdown——纯为省内存，跟连接稳不稳定无关。 */
    this.codexIdleTimer = null;
    /* ── provider 侧的会话标识 ────────────────────────────────
       同一个对话在三家 provider 那儿各有一条自己的线，续接时各认各的 id。 */
    this.sessionId = null;              // Claude Agent SDK 的 session
    this.codexThreadId = null;          // Codex 的 thread（常驻 app-server 和 SDK 降级路径共用同一个 id）
    this.agyConversationId = null;      // Antigravity CLI 的 conversation

    /* ── 历史写入游标 ─────────────────────────────────────────
       这一轮产生的内容该往哪条会话、哪条 assistant 消息上追加。
       activeHistoryTurn* 是「回合还开着吗」，跟 activeHistoryConversationId
       分开存是因为回合结束后游标还要留着给迟到的子任务事件用。 */
    this.activeHistoryConversationId = null;
    this.activeAssistantHistoryMessage = null;
    this.activeHistoryTurnOpen = false;
    this.activeHistoryTurnConversationId = null;

    /* ── 前台请求 ─────────────────────────────────────────────
       正在响应的是哪条用户消息。一轮里 steering 会换 requestId。 */
    this.activeForegroundRequestId = null;
    this.activeForegroundConversationId = null;
    this.activeForegroundDeliveryContext = null;

    /* ── Claude 持久 runtime 的回合状态 ───────────────────────
       runtimeSignature 是「当前 runtime 是按哪套参数起的」，参数变了要重启；
       turnEpoch 用来判断迟到的回调还属不属于当前这一轮。 */
    this.claudeRuntimeConversationId = null;
    this.claudeRuntimeSignature = null;
    /* runtime 此刻按哪个 permissionMode / model 在跑。这两个能热改
       （setPermissionMode / setModel），所以不进 runtimeSignature——它们变了
       不需要重启进程。记下来是为了跳过「值没变还照发一遍」的那两趟 IPC 往返。
       runtime 一关就作废，见 server.js 的 forgetClaudeRuntimeBinding()。 */
    this.claudeRuntimeAppliedPermissionMode = null;
    this.claudeRuntimeAppliedModel = null;
    this.claudeTurnCompletionPending = false;
    this.claudeStopRequested = false;
    this.claudeRecoveryContext = null;
    this.claudePendingRecovery = null;
    this.claudeErrorHandled = false;
    this.claudeTaskWakeGraceUntil = 0;
    this.claudeTurnEpoch = 0;
    this.claudeAutoWakeOwner = null;
    this.claudeAutoWakeOwnerTimer = null;

    /* ── 中断与待办 ───────────────────────────────────────────
       queuedClientPrompts 是 steering 的兜底：来不及插进当前回合的消息
       退化成「下一轮再发」，排在这里。 */
    this.abortCtrl = null;
    this.pendingAskUserQuestion = null;
    this.queuedClientPrompts = [];

    /* ── 本轮的定时器与调度器 ─────────────────────────────────
       这些定时器必须跟着会话走：它们是 per-turn 的，多个对话同时跑时共用一份
       会互相取消——A 的看门狗被 B 的新回合清掉，A 那轮失效就再没人报警。 */
    this.queuedClientPromptDrainTimer = null;
    this.turnIdleWatchdog = null;
  }

  /**
   * 这个会话专属的 Claude 持久 runtime，第一次用到才建。
   *
   * 每个在跑的会话是一个真实的 SDK 子进程——所以既不能全局共用一个
   * （两个对话会抢同一条事件流），也不能一上来就给每个历史会话都建。
   */
  get claudeRuntime() {
    if (!this._claudeRuntime) {
      if (!this._createRuntime) throw new Error("ConversationSession 没有 createRuntime，无法建立 runtime");
      this._claudeRuntime = this._createRuntime(this);
    }
    return this._claudeRuntime;
  }

  /** runtime 建过了吗。用来判断忙碌状态时不该顺手把它建出来。 */
  get hasClaudeRuntime() {
    return this._claudeRuntime !== null;
  }

  /**
   * 这个会话专属的 agy 常驻进程，第一次用到才建。
   *
   * 和 claudeRuntime 同一个理由：agy 启动一次要十几秒，一个对话只该付一次；
   * 但也不能全局共用一个——两个对话会写进同一条 stdin，回答互相串台。
   */
  get agyRuntime() {
    if (!this._agyRuntime) {
      if (!this._createAgyRuntime) throw new Error("ConversationSession 没有 createAgyRuntime，无法建立 agy runtime");
      this._agyRuntime = this._createAgyRuntime(this);
    }
    return this._agyRuntime;
  }

  /** agy runtime 建过了吗。判断忙碌状态时不该顺手把它建出来。 */
  get hasAgyRuntime() {
    return this._agyRuntime !== null;
  }

  /**
   * 这个会话专属的 codex 常驻进程（app-server），第一次用到才建。
   *
   * 和另外两家同一个理由，只是账算得更明白些：每轮 spawn 一个 `codex exec`
   * 要付约 10 秒的进程起停，而且每轮都要重新建一条 WebSocket、重新赌一次
   * 「建连到首帧之间那几秒空窗会不会被代理掐掉」。常驻之后这两样都只付一次。
   */
  get codexRuntime() {
    if (!this._codexRuntime) {
      if (!this._createCodexRuntime) throw new Error("ConversationSession 没有 createCodexRuntime，无法建立 codex runtime");
      this._codexRuntime = this._createCodexRuntime(this);
    }
    return this._codexRuntime;
  }

  /** codex runtime 建过了吗。判断忙碌状态时不该顺手把它建出来。 */
  get hasCodexRuntime() {
    return this._codexRuntime !== null;
  }

  /** 丢弃这个会话前把子进程收掉，别留下孤儿。 */
  disposeRuntime() {
    if (this._agyRuntime) {
      try { this._agyRuntime.kill(); } catch { /* 已经没了就算了 */ }
      this._agyRuntime = null;
    }
    if (this.codexIdleTimer) {
      clearTimeout(this.codexIdleTimer);
      this.codexIdleTimer = null;
    }
    if (this._codexRuntime) {
      try { this._codexRuntime.kill(); } catch { /* 已经没了就算了 */ }
      this._codexRuntime = null;
    }
    if (!this._claudeRuntime) return;
    try { this._claudeRuntime.close(); } catch { /* 已经关了就算了 */ }
    this._claudeRuntime = null;
  }
}

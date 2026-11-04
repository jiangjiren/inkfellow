/* Completion is a request lifecycle event, never a change of the visible tab. */
(function (root) {
  class TurnCompletionTracker {
    constructor(onComplete) {
      this.onComplete = onComplete;
      this.requests = new Map();
    }

    cancelConversation(conversationId) {
      for (const request of this.requests.values()) {
        if (request.conversationId !== conversationId || request.settled) continue;
        request.failed = true;
        request.settled = true;
      }
    }

    ingest(event) {
      const conversationId = event?.conversationId;
      const userMessageId = event?.userMessageId;
      if (event?.type === "reset_complete") {
        this.cancelConversation(conversationId);
        return;
      }
      if (typeof conversationId !== "string" || !conversationId
          || typeof userMessageId !== "string" || !userMessageId) return;
      const key = JSON.stringify([conversationId, userMessageId]);
      let request = this.requests.get(key);
      const starts = event.type === "request_started"
        || (event.type === "request_ack" && ["running", "queued"].includes(event.state))
        || (event.type === "run_attached" && event.running === true);
      if (starts && !request) {
        request = { conversationId, userMessageId, failed: false, settled: false };
        this.requests.set(key, request);
        if (this.requests.size > 1024) {
          const oldestSettled = [...this.requests].find(([, item]) => item.settled)?.[0];
          if (oldestSettled) this.requests.delete(oldestSettled);
        }
      }
      // Replayed history and reconnect snapshots must not produce old alerts.
      if (!request || request.settled) return;
      if (["error", "stopped", "stopping"].includes(event.type)) request.failed = true;
      if (event.type === "result" && (event.is_error === true
          || String(event.subtype || "").startsWith("error")
          || ["failed", "error", "cancelled", "canceled", "stopped"].includes(event.status))) {
        request.failed = true;
      }
      if (event.type === "stopped") request.settled = true;
      if (event.type !== "done") return;
      request.settled = true;
      if (!request.failed) this.onComplete({ conversationId, userMessageId });
    }
  }
  root.InkfellowTurnCompletionTracker = TurnCompletionTracker;
})(globalThis);

(function (root) {
  const STORAGE_KEY = "inkfellow-completion-alerts-v1";
  class CompletionAlerts {
    constructor({ storage, notify }) {
      this.storage = storage;
      this.notify = notify;
      this.seen = new Set();
      this.enabled = true;
      try { this.enabled = storage.getItem(STORAGE_KEY) !== "0"; } catch {}
    }

    setEnabled(enabled) {
      this.enabled = enabled === true;
      try { this.storage.setItem(STORAGE_KEY, this.enabled ? "1" : "0"); } catch {}
    }

    async complete(info) {
      if (typeof info?.conversationId !== "string" || !info.conversationId
          || typeof info.userMessageId !== "string" || !info.userMessageId) return false;
      const key = JSON.stringify([info.conversationId, info.userMessageId]);
      if (this.seen.has(key)) return false;
      this.seen.add(key);
      if (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value);
      if (!this.enabled) return false;
      const title = typeof info.title === "string" ? info.title.trim().slice(0, 60) : "";
      try {
        const shown = await this.notify({ conversationId: info.conversationId, userMessageId: info.userMessageId, title });
        return shown !== false;
      } catch {
        return false;
      }
    }
  }
  root.InkfellowCompletionAlerts = CompletionAlerts;
})(globalThis);

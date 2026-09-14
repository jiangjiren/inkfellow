// Preserve order for one conversation while allowing independent conversations to run.
export class KeyedTaskQueue {
  constructor() { this.pending = new Map(); }
  run(key, task) {
    const previous = this.pending.get(key) || Promise.resolve();
    const result = previous.then(task);
    const settled = result.catch(() => {});
    this.pending.set(key, settled);
    settled.then(() => { if (this.pending.get(key) === settled) this.pending.delete(key); });
    return result;
  }
}

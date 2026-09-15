/** Wait for the owning process to close before another process resumes its session. */
export function stopRuntime(runtime, { timeoutMs = 10_000 } = {}) {
  const proc = runtime.proc;
  if (!proc) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      proc.removeListener("close", onClose);
    };
    const onClose = () => { cleanup(); resolve(); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("旧 AI 进程尚未退出，暂时无法恢复会话，请稍后重试"));
    }, timeoutMs);
    proc.once("close", onClose);
    try {
      runtime.kill();
      if (runtime.proc !== proc) onClose();
    } catch (error) { cleanup(); reject(error); }
  });
}

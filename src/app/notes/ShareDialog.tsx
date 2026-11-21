"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./notes.module.css";

type ShareInfo = {
  token: string | null;
  url: string | null;
  title: string | null;
  expiresAt: string | null;
};

type Operation = "loading" | "saving" | "revoking";
const emptyShare: ShareInfo = { token: null, url: null, title: null, expiresAt: null };

const localDateTime = (value: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

async function shareRequest<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) {
    throw new Error(body?.error || `分享操作失败（${response.status}）`);
  }
  return body as T;
}

export default function ShareDialog({ notePath, onClose }: { notePath: string; onClose: () => void }) {
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [title, setTitle] = useState("");
  const [deadline, setDeadline] = useState("");
  const [busy, setBusy] = useState<Operation | null>("loading");
  const [status, setStatus] = useState<{ message: string; error?: boolean } | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);

  const applyInfo = useCallback((next: ShareInfo) => {
    setInfo(next);
    setTitle(next.title ?? "");
    setDeadline(localDateTime(next.expiresAt));
  }, []);

  const run = useCallback(async (operation: Operation, execute: (signal: AbortSignal) => Promise<void>) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(operation);
    setStatus(null);
    try {
      await execute(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        setStatus({ error: true, message: error instanceof Error ? error.message : "分享操作失败" });
      }
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }, []);

  const load = useCallback(() => run("loading", async (signal) => {
    const query = new URLSearchParams({ path: notePath });
    const share = await shareRequest<ShareInfo>(`/api/notes/share?${query}`, { signal });
    if (!signal.aborted) applyInfo(share);
  }), [applyInfo, notePath, run]);

  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    void load();
    return () => {
      controllerRef.current?.abort();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [load]);

  const changed = title !== (info?.title ?? "") || deadline !== localDateTime(info?.expiresAt ?? null);

  const save = async () => {
    if (!info || busy) return;
    const expiresAt = deadline ? new Date(deadline) : null;
    if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
      setStatus({ error: true, message: "有效期必须是未来的日期和时间。" });
      return;
    }
    await run("saving", async (signal) => {
      const share = await shareRequest<ShareInfo>("/api/notes/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: notePath, title: title.trim() || null, expiresAt: expiresAt?.toISOString() ?? null }),
        signal,
      });
      if (!signal.aborted) {
        applyInfo(share);
        setStatus({ message: info.token ? "分享设置已保存" : "分享链接已生成" });
      }
    });
  };

  const copy = async () => {
    if (!info?.url || busy) return;
    try {
      await navigator.clipboard.writeText(info.url);
      setStatus({ message: "链接已复制" });
    } catch {
      linkRef.current?.focus();
      linkRef.current?.select();
      setStatus({ error: true, message: "复制失败，请手动复制已选中的链接。" });
    }
  };

  const revoke = async () => {
    if (!info?.token || busy) return;
    await run("revoking", async (signal) => {
      await shareRequest("/api/notes/share", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: info.token, path: notePath }),
        signal,
      });
      if (!signal.aborted) {
        applyInfo(emptyShare);
        setStatus({ message: "该笔记的所有分享链接已撤销" });
      }
    });
  };

  return (
    <div className={styles.shareOverlay} role="presentation" onMouseDown={onClose}>
      <form
        className={styles.shareDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!info?.token || changed) void save();
        }}
      >
        <header className={styles.shareDialogHeader}>
          <h2 id="share-dialog-title" className={styles.shareDialogTitle}>公开分享</h2>
          <button ref={closeRef} type="button" className={styles.shareDialogClose} onClick={onClose} aria-label="关闭分享窗口">
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className={styles.shareDialogBody}>
          <p className={styles.shareDialogNote}>{notePath}</p>
          {!info && busy === "loading" && <p className={styles.shareDialogState}>正在读取分享状态…</p>}
          {info && (
            <div className={styles.shareSettings}>
              {info.url && (
                <label className={styles.shareLinkField}>
                  <span>分享链接</span>
                  <input ref={linkRef} value={info.url} readOnly onFocus={(event) => event.currentTarget.select()} />
                </label>
              )}
              <label className={styles.shareLinkField}>
                <span>分享标题</span>
                <input type="text" value={title} placeholder="使用笔记标题" disabled={!!busy} onChange={(event) => setTitle(event.target.value)} />
              </label>
              <label className={styles.shareLinkField}>
                <span>有效期 <small>留空表示长期有效</small></span>
                <input type="datetime-local" value={deadline} disabled={!!busy} onChange={(event) => setDeadline(event.target.value)} />
              </label>
            </div>
          )}
          {status && (
            <p role={status.error ? "alert" : "status"} className={`${styles.shareDialogMessage} ${status.error ? styles.shareDialogError : ""}`}>
              {status.message}
            </p>
          )}
        </div>

        <footer className={styles.shareDialogActions}>
          {!info && !busy && <button type="button" className={styles.shareSecondaryButton} onClick={load}>重试</button>}
          {info?.token && (
            <>
              <button type="button" className={styles.shareDangerButton} disabled={!!busy} onClick={revoke}>
                {busy === "revoking" ? "正在撤销" : "取消分享"}
              </button>
              <button type="button" className={styles.shareSecondaryButton} disabled={!!busy} onClick={copy}>复制链接</button>
            </>
          )}
          {info && (!info.token || changed) && (
            <button type="submit" className={styles.sharePrimaryButton} disabled={!!busy}>
              {busy === "saving" ? "正在保存" : info.token ? "保存设置" : "生成分享链接"}
            </button>
          )}
        </footer>
      </form>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./notes.module.css";

type FileStatus = {
  name: string;
  path: string;
  state: "modified" | "added" | "deleted" | "renamed";
};

type Props = {
  active: boolean;
  onViewDetails: () => void;
};

export default function GitChangeBanner({ active, onViewDetails }: Props) {
  const [files, setFiles] = useState<FileStatus[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/notes/git", { cache: "no-store" });
      const data = (await res.json()) as { files?: FileStatus[]; error?: string };
      if (!data.error) setFiles(data.files ?? []);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    void fetchStatus();
    intervalRef.current = setInterval(() => void fetchStatus(), 30_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    };
  }, [fetchStatus]);

  const showFeedback = (text: string, error = false, duration = 3500) => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    setFeedback(text);
    setIsError(error);
    feedbackTimerRef.current = setTimeout(() => setFeedback(null), duration);
  };

  const handleSync = async () => {
    setSyncing(true);
    showFeedback("检查云端版本…", false, 60_000);
    try {
      await fetch("/api/notes/git", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "pull" }),
      });

      showFeedback("AI 提炼同步摘要…", false, 60_000);
      let message = "";
      try {
        const aiRes = await fetch("/api/notes/git/ai-log", { method: "POST" });
        const aiData = (await aiRes.json()) as { message?: string; fallback?: string };
        message = aiData.message ?? aiData.fallback ?? "";
      } catch { /* use fallback */ }
      if (!message) message = `同步笔记于 ${new Date().toLocaleDateString("zh-CN")}`;

      showFeedback(`保存「${message}」…`, false, 60_000);
      const res = await fetch("/api/notes/git", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "push", message }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (data.error) throw new Error(data.error);

      showFeedback("云端同步成功 ✓");
      await fetchStatus();
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : "同步失败", true);
    } finally {
      setSyncing(false);
    }
  };

  if (!active || files.length === 0) return null;

  const stripExt = (name: string) => name.replace(/\.(md|html?)$/i, "");
  const fileLabel = files.length === 1
    ? stripExt(files[0]!.name)
    : `${stripExt(files[0]!.name)} 等 ${files.length} 篇`;

  return (
    <div className={styles.gitBanner}>
      <span className={`${styles.gitBannerDot} ${syncing ? styles.gitBannerDotSyncing : ""}`} />
      <button
        type="button"
        className={`${styles.gitBannerLabel} ${isError ? styles.gitBannerLabelError : ""}`}
        onClick={onViewDetails}
        title="查看改动详情"
      >
        {feedback ?? fileLabel}
      </button>
      <button
        type="button"
        className={styles.gitBannerSync}
        onClick={() => void handleSync()}
        disabled={syncing}
        title="立即同步到云端"
      >
        {syncing ? (
          <span className={styles.gitBannerSpinner} />
        ) : (
          <>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M5 8V2M5 2L2.5 4.5M5 2L7.5 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            同步
          </>
        )}
      </button>
    </div>
  );
}

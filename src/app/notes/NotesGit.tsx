"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./notes.module.css";

type FileStatus = {
  name: string;
  path: string;
  state: "modified" | "added" | "deleted" | "renamed";
};

type GitStatus = {
  files: FileStatus[];
  ahead: number;
  behind: number;
  lastSync: string | null;
};

type FileStats = Record<string, { added: number; removed: number }>;

type CommitRecord = {
  hash: string;
  message: string;
  author: string;
  date: string;
};

type DiffLine = {
  type: "add" | "remove" | "context" | "hunk";
  content: string;
};

type FileDiff = {
  path: string;
  binary: boolean;
  lines: DiffLine[];
  addCount: number;
  removeCount: number;
};

type ActionState = "idle" | "pulling" | "pushing";

const STATE_LABEL: Record<FileStatus["state"], string> = {
  modified: "已修改",
  added:    "新文件",
  deleted:  "已删除",
  renamed:  "已重命名",
};

const STATE_COLOR: Record<FileStatus["state"], string> = {
  modified: styles.gitBadgeModified,
  added:    styles.gitBadgeAdded,
  deleted:  styles.gitBadgeDeleted,
  renamed:  styles.gitBadgeModified,
};

// 恢复按钮 tooltip 文字
const DISCARD_LABEL: Record<FileStatus["state"], string> = {
  modified: "恢复原版",
  added:    "删除文件",
  deleted:  "恢复文件",
  renamed:  "恢复原版",
};

// 确认状态的警告文字
const DISCARD_WARN: Record<FileStatus["state"], string> = {
  modified: "将丢失所有修改，不可撤销",
  added:    "将删除此文件，不可撤销",
  deleted:  "将从上次同步版本中恢复",
  renamed:  "将撤销重命名，不可撤销",
};

// 操作成功后的反馈文字
const DISCARD_DONE: Record<FileStatus["state"], string> = {
  modified: "已恢复原版 ✓",
  added:    "已删除文件 ✓",
  deleted:  "已恢复文件 ✓",
  renamed:  "已恢复原版 ✓",
};

type Props = {
  onOpenFile?: (path: string) => void;
};

function formatLastSync(iso: string | null) {
  if (!iso) return null;
  const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (diffMin < 1)  return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24)   return `${diffH} 小时前`;
  return new Date(iso).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

const stripNoteExtension = (value: string) => value.replace(/\.(md|html?)$/i, "");

const formatParentPath = (filePath: string) =>
  filePath.includes("/") ? filePath.split("/").slice(0, -1).join(" / ") : null;

export default function NotesGit({ onOpenFile }: Props) {
  const [status, setStatus]           = useState<GitStatus | null>(null);
  const [actionState, setActionState] = useState<ActionState>("idle");
  const [message, setMessage]         = useState("");
  const [feedback, setFeedback]       = useState<string | null>(null);
  const [isError, setIsError]         = useState(false);

  // 可折叠改动列表（默认展开）
  const [showChanges, setShowChanges] = useState(true);
  const [fileStats, setFileStats]     = useState<FileStats>({});

  // 恢复原版：哪个文件正在确认中 / 是否 API 请求中
  const [discardingPath, setDiscardingPath] = useState<string | null>(null);
  const [isDiscarding, setIsDiscarding]     = useState(false);

  // 历史记录抽屉
  const [showHistory, setShowHistory]       = useState(false);
  const [history, setHistory]               = useState<CommitRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Diff 详情页（iOS Navigation Stack 风格）
  const [selectedDiffFile, setSelectedDiffFile] = useState<FileStatus | null>(null);
  const [diff, setDiff]                         = useState<FileDiff | null>(null);
  const [diffLoading, setDiffLoading]           = useState(false);
  const [diffError, setDiffError]               = useState<string | null>(null);
  const [confirmingDiffDiscard, setConfirmingDiffDiscard] = useState(false);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const diffRequestRef = useRef(0);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/notes/git", { cache: "no-store" });
      const data = (await res.json()) as GitStatus & { error?: string };
      if (data.error) throw new Error(data.error);
      setStatus(data);
    } catch {
      setStatus(null);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/notes/git?stats=true", { cache: "no-store" });
      const data = (await res.json()) as { stats?: FileStats };
      setFileStats(data.stats ?? {});
    } catch {
      setFileStats({});
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch("/api/notes/git?history=true", { cache: "no-store" });
      const data = (await res.json()) as { history?: CommitRecord[] };
      setHistory(data.history ?? []);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    void fetchStats(); // 默认展开，初始化时同步拉取行数统计
    intervalRef.current = setInterval(() => {
      void fetchStatus();
      if (showChanges) void fetchStats();
    }, 30_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchStatus, fetchStats]);

  // 折叠→展开时补充拉取 stat 数据
  useEffect(() => {
    if (showChanges) void fetchStats();
  }, [showChanges, fetchStats]);

  // 打开历史面板时加载
  useEffect(() => {
    if (showHistory) void fetchHistory();
  }, [showHistory, fetchHistory]);

  const showFeedback = (text: string, error = false) => {
    setFeedback(text);
    setIsError(error);
    setTimeout(() => setFeedback(null), 5000);
  };

  const discard = async (filePath: string, fileState: FileStatus["state"]) => {
    setIsDiscarding(true);
    try {
      const res = await fetch("/api/notes/git", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "discard", path: filePath }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (data.error) throw new Error(data.error);
      showFeedback(DISCARD_DONE[fileState]);
      setDiscardingPath(null);
      if (selectedDiffFile?.path === filePath) {
        setSelectedDiffFile(null);
        setDiff(null);
        setDiffError(null);
        setConfirmingDiffDiscard(false);
      }
      await fetchStatus();
      await fetchStats();
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : "操作失败", true);
    } finally {
      setIsDiscarding(false);
    }
  };

  const openDiff = useCallback(async (file: FileStatus) => {
    const requestId = diffRequestRef.current + 1;
    diffRequestRef.current = requestId;
    setSelectedDiffFile(file);
    setDiff(null);
    setDiffError(null);
    setDiffLoading(true);
    setConfirmingDiffDiscard(false);

    try {
      const params = new URLSearchParams({ diff: file.path });
      const res = await fetch(`/api/notes/git?${params.toString()}`, { cache: "no-store" });
      const data = (await res.json()) as FileDiff & { error?: string };
      if (data.error) throw new Error(data.error);
      if (diffRequestRef.current === requestId) {
        setDiff(data);
      }
    } catch (err) {
      if (diffRequestRef.current === requestId) {
        setDiffError(err instanceof Error ? err.message : "改动加载失败");
      }
    } finally {
      if (diffRequestRef.current === requestId) {
        setDiffLoading(false);
      }
    }
  }, []);

  const closeDiff = () => {
    diffRequestRef.current += 1;
    setSelectedDiffFile(null);
    setDiff(null);
    setDiffError(null);
    setDiffLoading(false);
    setConfirmingDiffDiscard(false);
  };

  const pull = async () => {
    setActionState("pulling");
    try {
      const res = await fetch("/api/notes/git", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "pull" }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; output?: string };
      if (data.error) throw new Error(data.error);
      showFeedback(data.output || "已从云端更新 ✓");
      await fetchStatus();
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : "从云端更新失败", true);
    } finally {
      setActionState("idle");
    }
  };

  const push = async () => {
    setActionState("pushing");
    try {
      const res = await fetch("/api/notes/git", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "push", message }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; output?: string };
      if (data.error) throw new Error(data.error);
      setMessage("");
      showFeedback("已同步到云端 ✓");
      await fetchStatus();
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : "同步到云端失败", true);
    } finally {
      setActionState("idle");
    }
  };

  const isBusy    = actionState !== "idle";
  const hasChanges = (status?.files.length ?? 0) > 0;
  const isSynced   = !hasChanges && (status?.ahead ?? 0) === 0 && (status?.behind ?? 0) === 0;

  return (
    <div className={styles.gitPanel} style={{ position: "relative" }}>
      <div className={`${styles.gitStack}${selectedDiffFile ? ` ${styles.gitStackShowingDetail}` : ""}`}>
        <div className={styles.gitStackPane}>
          {/* ── 状态栏 ── */}
          <div className={styles.gitStatusBar}>
            <div className={styles.gitStatusLeft}>
              {status === null ? (
                <span className={styles.gitStatusDim}>检查中…</span>
              ) : isSynced ? (
                <>
                  <span className={styles.gitStatusDot} data-ok="true" />
                  <span className={styles.gitStatusLabel}>已是最新</span>
                </>
              ) : (
                <>
                  <span className={styles.gitStatusDot} />
                  {hasChanges && (
                    <button
                      type="button"
                      className={styles.gitToggleBtn}
                      onClick={() => setShowChanges(v => !v)}
                      title={showChanges ? "收起" : "展开查看"}
                    >
                      <span className={styles.gitStatusLabel}>
                        {status.files.length} 个文件待同步
                      </span>
                      <span className={`${styles.gitChevron}${showChanges ? ` ${styles.gitChevronOpen}` : ""}`}>
                        ▶
                      </span>
                    </button>
                  )}
                  {hasChanges && status.behind > 0 && (
                    <span className={styles.gitStatusLabel}>，云端也有更新</span>
                  )}
                  {!hasChanges && status.behind > 0 && (
                    <span className={styles.gitStatusLabel}>云端有新内容</span>
                  )}
                </>
              )}
              {status?.lastSync && (
                <span className={styles.gitStatusTime}>
                  · 上次同步 {formatLastSync(status.lastSync)}
                </span>
              )}
            </div>
            <button
              type="button"
              className={styles.gitRefresh}
              onClick={fetchStatus}
              disabled={isBusy}
              title="刷新"
            >↺</button>
          </div>

          {/* ── 可折叠改动文件列表 ── */}
          <div className={`${styles.gitFileListWrap}${showChanges ? ` ${styles.gitFileListWrapOpen}` : ""}`}>
            {hasChanges && (
              <div className={styles.gitFileList}>
                <ul>
                  {status!.files.map((f) => {
                    const stat = fileStats[f.path];
                    const parentPath = formatParentPath(f.path);
                    const isConfirming = discardingPath === f.path;
                    return (
                      <li
                        key={f.path}
                        className={`${styles.gitFileItem}${isConfirming ? ` ${styles.gitFileItemConfirming}` : ""}`}
                      >
                        {isConfirming ? (
                          /* ── 确认态：显示警告 + 取消/确认按钮 ── */
                          <div className={styles.gitDiscardConfirm}>
                            <span className={styles.gitDiscardMsg}>
                              {DISCARD_WARN[f.state]}
                            </span>
                            <div className={styles.gitDiscardBtns}>
                              <button
                                type="button"
                                className={styles.gitDiscardCancel}
                                onClick={() => setDiscardingPath(null)}
                                disabled={isDiscarding}
                              >取消</button>
                              <button
                                type="button"
                                className={styles.gitDiscardOk}
                                onClick={() => void discard(f.path, f.state)}
                                disabled={isDiscarding}
                              >{isDiscarding ? "…" : "确认"}</button>
                            </div>
                          </div>
                        ) : (
                          /* ── 正常态 ── */
                          <>
                            <div className={styles.gitFileInfo}>
                              {f.state !== "deleted" && onOpenFile ? (
                                <button
                                  type="button"
                                  className={styles.gitFileNameBtn}
                                  title={`打开 ${f.path}`}
                                  onClick={() => onOpenFile(f.path)}
                                >
                                  {stripNoteExtension(f.name)}
                                </button>
                              ) : (
                                <span className={styles.gitFileName} title={f.path}>
                                  {stripNoteExtension(f.name)}
                                </span>
                              )}
                              {parentPath && (
                                <span className={styles.gitFilePath}>{parentPath}</span>
                              )}
                            </div>
                            {stat && (stat.added > 0 || stat.removed > 0) && (
                              <button
                                type="button"
                                className={`${styles.gitDiffStats} ${styles.gitDiffStatsButton}`}
                                onClick={() => void openDiff(f)}
                                title="查看改动"
                              >
                                {stat.added   > 0 && <span className={styles.gitDiffAdd}>+{stat.added}</span>}
                                {stat.removed > 0 && <span className={styles.gitDiffRemove}>-{stat.removed}</span>}
                              </button>
                            )}
                            <span className={`${styles.gitStateBadge} ${STATE_COLOR[f.state]}`}>
                              {STATE_LABEL[f.state]}
                            </span>
                            <button
                              type="button"
                              className={styles.gitDiffBtn}
                              title="查看改动"
                              aria-label={`查看 ${f.name} 的改动`}
                              onClick={() => void openDiff(f)}
                            >
                              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                                <path d="M3.2 1.6h4.1l2.5 2.5v7.3H3.2V1.6Z" stroke="currentColor" strokeWidth="1.15" strokeLinejoin="round"/>
                                <path d="M7.2 1.7v2.6h2.6M4.8 6.5h3.4M4.8 8.5h2.7" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                            </button>
                            <button
                              type="button"
                              className={styles.gitDiscardBtn}
                              title={DISCARD_LABEL[f.state]}
                              onClick={() => setDiscardingPath(f.path)}
                            >
                              <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
                                <path d="M4 1.5L1.5 4L4 6.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                                <path d="M1.5 4H6.5C8.16 4 9.5 5.34 9.5 7C9.5 8.66 8.16 10 6.5 10H4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                            </button>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>

          {/* ── 反馈 ── */}
          {feedback && (
            <div className={`${styles.gitFeedback}${isError ? ` ${styles.gitFeedbackError}` : ""}`}>
              {feedback}
            </div>
          )}

          {/* ── 操作 ── */}
          <div className={styles.gitActions}>
        <input
          className={styles.gitNoteInput}
          type="text"
          placeholder="这次改了什么？（选填）"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !isBusy) void push(); }}
          disabled={isBusy}
          maxLength={80}
        />
        <button
          type="button"
          className={`${styles.gitButton} ${styles.gitButtonPrimary} ${styles.gitButtonFull}`}
          onClick={push}
          disabled={isBusy}
        >
          {actionState === "pushing" ? <span className={styles.gitSpinner} /> : (
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
              <path d="M6.5 9.5V3M6.5 3L3.5 6M6.5 3L9.5 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
          {actionState === "pushing" ? "上传中…" : "上传保存"}
        </button>
        <div className={styles.gitSecondaryRow}>
          {(status?.behind ?? 0) > 0 ? (
            /* 云端有新内容 → 突出显示为有颜色的按钮 */
            <button
              type="button"
              className={`${styles.gitButton} ${styles.gitButtonPull} ${styles.gitButtonSecondarySmall}`}
              onClick={pull}
              disabled={isBusy}
            >
              {actionState === "pulling" ? <span className={styles.gitSpinnerDark} /> : (
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                  <path d="M6.5 3.5V10M6.5 10L3.5 7M6.5 10L9.5 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
              {actionState === "pulling" ? "更新中…" : "获取更新"}
              <span className={styles.gitBadgePull}>{status!.behind}</span>
            </button>
          ) : (
            /* 无新内容 → 退化为极淡的文字链接 */
            <button
              type="button"
              className={styles.gitPullLink}
              onClick={pull}
              disabled={isBusy}
            >
              {actionState === "pulling" ? "更新中…" : "检查云端更新"}
            </button>
          )}
          <button
            type="button"
            className={styles.gitHistoryBtn}
            onClick={() => setShowHistory(true)}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2"/>
              <path d="M6 3.5V6l1.8 1.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            历史记录
          </button>
        </div>
          </div>

          {!hasChanges && status !== null && (
            <div className={styles.gitEmptyState}>
              <span>✓</span>
              <span>所有内容已同步</span>
            </div>
          )}
        </div>

        <div className={`${styles.gitStackPane} ${styles.gitDiffPane}`} aria-hidden={!selectedDiffFile}>
          {selectedDiffFile ? (
            <>
              <header className={styles.gitDiffHeader}>
                <button
                  type="button"
                  className={styles.gitDiffBack}
                  onClick={closeDiff}
                  aria-label="返回待同步文件"
                >
                  ‹
                </button>
                <div className={styles.gitDiffHeaderText}>
                  <strong title={selectedDiffFile.path}>{stripNoteExtension(selectedDiffFile.name)}</strong>
                  {formatParentPath(selectedDiffFile.path) && (
                    <span>{formatParentPath(selectedDiffFile.path)}</span>
                  )}
                </div>
              </header>

              <div className={styles.gitDiffSummary}>
                <span className={`${styles.gitStateBadge} ${STATE_COLOR[selectedDiffFile.state]}`}>
                  {STATE_LABEL[selectedDiffFile.state]}
                </span>
                {(diff?.addCount || diff?.removeCount) ? (
                  <span className={styles.gitDiffStats}>
                    {diff.addCount > 0 && <span className={styles.gitDiffAdd}>+{diff.addCount}</span>}
                    {diff.removeCount > 0 && <span className={styles.gitDiffRemove}>-{diff.removeCount}</span>}
                  </span>
                ) : null}
              </div>

              <div className={styles.gitDiffContent}>
                {diffLoading ? (
                  <div className={styles.gitDiffState}>正在加载改动…</div>
                ) : diffError ? (
                  <div className={`${styles.gitDiffState} ${styles.gitDiffStateError}`}>
                    <span>{diffError}</span>
                    <button type="button" onClick={() => void openDiff(selectedDiffFile)}>重试</button>
                  </div>
                ) : diff?.binary ? (
                  <div className={styles.gitDiffState}>此文件无法预览文本改动。</div>
                ) : diff && diff.lines.length > 0 ? (
                  <div className={styles.gitDiffLines}>
                    {diff.lines.map((line, index) => {
                      const className = [
                        styles.gitDiffLine,
                        line.type === "add" ? styles.gitDiffLineAdd : "",
                        line.type === "remove" ? styles.gitDiffLineRemove : "",
                        line.type === "hunk" ? styles.gitDiffLineHunk : "",
                      ].filter(Boolean).join(" ");
                      return (
                        <div key={`${line.type}-${index}-${line.content}`} className={className}>
                          {line.type === "hunk" ? (
                            <span className={styles.gitDiffHunkLabel}>{line.content}</span>
                          ) : (
                            <>
                              <span className={styles.gitDiffMarker}>
                                {line.type === "add" ? "+" : line.type === "remove" ? "-" : ""}
                              </span>
                              <span className={styles.gitDiffText}>{line.content || " "}</span>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : diff ? (
                  <div className={styles.gitDiffState}>没有可显示的文本改动。</div>
                ) : null}
              </div>

              <footer className={styles.gitDiffFooter}>
                {confirmingDiffDiscard ? (
                  <div className={styles.gitDiffDiscardConfirm}>
                    <span>{DISCARD_WARN[selectedDiffFile.state]}</span>
                    <div className={styles.gitDiscardBtns}>
                      <button
                        type="button"
                        className={styles.gitDiscardCancel}
                        onClick={() => setConfirmingDiffDiscard(false)}
                        disabled={isDiscarding}
                      >取消</button>
                      <button
                        type="button"
                        className={styles.gitDiscardOk}
                        onClick={() => void discard(selectedDiffFile.path, selectedDiffFile.state)}
                        disabled={isDiscarding}
                      >{isDiscarding ? "…" : "确认"}</button>
                    </div>
                  </div>
                ) : (
                  <>
                    {selectedDiffFile.state !== "deleted" && onOpenFile ? (
                      <button
                        type="button"
                        className={styles.gitDiffFooterBtn}
                        onClick={() => onOpenFile(selectedDiffFile.path)}
                      >打开文件</button>
                    ) : null}
                    <button
                      type="button"
                      className={`${styles.gitDiffFooterBtn} ${styles.gitDiffFooterDanger}`}
                      onClick={() => setConfirmingDiffDiscard(true)}
                    >{DISCARD_LABEL[selectedDiffFile.state]}</button>
                  </>
                )}
              </footer>
            </>
          ) : null}
        </div>
      </div>

      {/* ── 历史记录抽屉 ── */}
      <div
        className={`${styles.gitHistoryOverlay}${showHistory ? ` ${styles.gitHistoryOverlayOpen}` : ""}`}
        onClick={(e) => { if (e.target === e.currentTarget) setShowHistory(false); }}
      >
        <div className={styles.gitHistoryPanel}>
          <div className={styles.gitHistoryHead}>
            <span className={styles.gitHistoryTitle}>历史记录</span>
            <button
              type="button"
              className={styles.gitHistoryClose}
              onClick={() => setShowHistory(false)}
              aria-label="关闭"
            >×</button>
          </div>
          <div className={styles.gitHistoryList}>
            {historyLoading ? (
              <div className={styles.gitHistoryEmpty}>加载中…</div>
            ) : history.length === 0 ? (
              <div className={styles.gitHistoryEmpty}>暂无历史记录</div>
            ) : (
              history.map((c) => (
                <div key={c.hash} className={styles.gitHistoryItem}>
                  <span className={styles.gitCommitHash}>{c.hash}</span>
                  <div className={styles.gitCommitInfo}>
                    <div className={styles.gitCommitMsg} title={c.message}>{c.message}</div>
                    <div className={styles.gitCommitMeta}>{c.date} · {c.author}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import type { NotesFileNode } from "@/lib/notesTypes";
import styles from "./notes.module.css";

export interface OpenedNoteEntry {
  path: string;
  at: number;
}

export interface ActiveTicketSummary {
  id: string;
  title: string;
  status: string;
}

interface NotesDashboardProps {
  files: NotesFileNode[];
  openedNotes: OpenedNoteEntry[];
  liveTickets?: ActiveTicketSummary[] | null;
  onSelectNote: (path: string) => void;
  onQuickCapture: () => void;
  onCreateNote: () => void;
  onImport: () => void;
  onOpenQuickSwitcher: () => void;
  onToggleFellow: () => void;
  onOpenFellowStage: () => void;
}

const IMAGE_EXT_RE = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico|avif|tiff?)$/i;
const LIVE_TICKET_STATUSES = new Set(["running", "queued", "needs_attention", "partial"]);
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function formatDateLine(now = new Date()): string {
  return `${now.getMonth() + 1}月${now.getDate()}日 · ${WEEKDAYS[now.getDay()]}`;
}

function formatRelativeTime(timestampMs: number, now = Date.now()): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return "";
  const diffMin = Math.floor((now - timestampMs) / 60_000);
  if (diffMin >= 0 && diffMin < 1) return "刚刚";
  if (diffMin >= 1 && diffMin < 60) return `${diffMin} 分钟前`;

  const date = new Date(timestampMs);
  const today = new Date(now);
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayStart(today) - dayStart(date)) / 86_400_000);
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (days <= 0) return `今天 ${clock}`;
  if (days === 1) return `昨天 ${clock}`;
  const md = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === today.getFullYear() ? md : `${date.getFullYear()}年${md}`;
}

export default function NotesDashboard({
  files,
  openedNotes,
  liveTickets: propLiveTickets = null,
  onSelectNote,
  onQuickCapture,
  onCreateNote,
  onImport,
  onOpenQuickSwitcher,
  onToggleFellow,
  onOpenFellowStage,
}: NotesDashboardProps) {
  const [sortMode, setSortMode] = useState<"recent" | "updated">(() => (openedNotes.length > 0 ? "recent" : "updated"));
  const [fetchedTickets, setFetchedTickets] = useState<ActiveTicketSummary[]>([]);

  const noteFiles = useMemo(
    () => files.filter((f) => !IMAGE_EXT_RE.test(f.name)),
    [files],
  );

  const isEmpty = noteFiles.length === 0;
  const dateLine = useMemo(() => formatDateLine(), []);

  useEffect(() => {
    // 已有来自 Fellow iframe 的实时工单快照时，不再需要额外请求兜底
    if (propLiveTickets !== null) return;
    let active = true;
    const loadTickets = async () => {
      try {
        const res = await fetch("/notes-claude/api/orchestrator/tickets?archived=active", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        const raw = Array.isArray(data?.tickets) ? data.tickets : (Array.isArray(data) ? data : []);
        const filtered: ActiveTicketSummary[] = raw
          .filter((t: { id?: string; status?: string }) => typeof t?.id === "string" && LIVE_TICKET_STATUSES.has(String(t.status || "")))
          .map((t: { id: string; title?: string; status: string }) => ({
            id: t.id,
            title: String(t.title || "后台任务"),
            status: String(t.status),
          }));
        if (active) setFetchedTickets(filtered);
      } catch {
        /* 后台服务不可达时保持静默 */
      }
    };
    void loadTickets();
    const onFocus = () => { void loadTickets(); };
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [propLiveTickets]);

  const liveTickets = propLiveTickets ?? fetchedTickets;

  const displayFiles = useMemo(() => {
    if (sortMode === "updated") {
      const byUpdated = [...noteFiles].sort(
        (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
      );
      return byUpdated.slice(0, 8).map((file) => ({
        file,
        touchedAt: Date.parse(file.updatedAt),
      }));
    }
    const byPath = new Map(noteFiles.map((f) => [f.path, f]));
    const result: Array<{ file: NotesFileNode; touchedAt: number }> = [];
    const seen = new Set<string>();
    for (const entry of openedNotes) {
      if (result.length >= 8) break;
      const found = byPath.get(entry.path);
      if (found && !seen.has(found.path)) {
        seen.add(found.path);
        result.push({ file: found, touchedAt: entry.at });
      }
    }
    return result;
  }, [noteFiles, openedNotes, sortMode]);

  const highlightTicket = useMemo(() => {
    if (liveTickets.length === 0) return null;
    return (
      liveTickets.find((t) => t.status === "needs_attention" || t.status === "partial")
      ?? liveTickets.find((t) => t.status === "running")
      ?? liveTickets[0]
    );
  }, [liveTickets]);

  const isTicketAttention = highlightTicket?.status === "needs_attention" || highlightTicket?.status === "partial";
  const stripTag = highlightTicket
    ? (isTicketAttention ? "待验收" : highlightTicket.status === "queued" ? "排队中" : "Fellow 执行中")
    : "";

  return (
    <div className={styles.dashboardContainer}>
      <header className={styles.dashboardMasthead}>
        <div className={styles.dashboardMastheadText}>
          <div className={styles.dashboardDate}>{dateLine}</div>
          <h1 className={styles.dashboardHeading}>
            {isEmpty ? "开始第一篇笔记" : "继续今天的创作"}
          </h1>
        </div>
        <div className={styles.dashboardActions}>
          <button type="button" className={styles.dashboardPrimaryBtn} onClick={onCreateNote}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span>新建笔记</span>
          </button>
          <button type="button" className={styles.dashboardSecondaryBtn} onClick={onQuickCapture}>
            <span>记录灵感</span>
          </button>
          <button
            type="button"
            className={styles.dashboardSearchBtn}
            onClick={onOpenQuickSwitcher}
            title="快速打开或搜索笔记 (⌘K)"
            aria-label="快速打开或搜索笔记"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <span className={styles.dashboardKbd}>⌘K</span>
          </button>
        </div>
      </header>

      {highlightTicket ? (
        <button
          type="button"
          className={`${styles.dashboardFellowStrip} ${isTicketAttention ? styles.dashboardFellowStripReady : ""}`}
          onClick={onOpenFellowStage}
        >
          <span className={styles.dashboardPulseDot} aria-hidden="true" />
          <span className={styles.dashboardFellowStripBody}>
            <span className={styles.dashboardFellowStripTag}>{stripTag}</span>
            <span className={styles.dashboardFellowStripText}>
              {highlightTicket.title}
              {liveTickets.length > 1 ? ` 等 ${liveTickets.length} 项任务` : ""}
            </span>
          </span>
          <span className={styles.dashboardFellowStripCta}>查看执行台 ›</span>
        </button>
      ) : null}

      {isEmpty ? (
        <div className={styles.dashboardEmptyCard}>
          <p className={styles.dashboardEmptyText}>
            这里还是空的。新建第一篇笔记，或者直接把本地 Markdown 文档导入进来。
          </p>
          <div className={styles.dashboardEmptyActions}>
            <button type="button" className={styles.dashboardPrimaryBtn} onClick={onCreateNote}>
              新建笔记
            </button>
            <button type="button" className={styles.dashboardSecondaryBtn} onClick={onImport}>
              导入文件
            </button>
          </div>
        </div>
      ) : (
        <section className={styles.dashboardSection}>
          <div className={styles.dashboardSectionHeader}>
            <h2 className={styles.dashboardSectionTitle}>继续工作</h2>
            <div className={styles.dashboardFilterGroup} role="tablist" aria-label="排序方式">
              <button
                type="button"
                role="tab"
                aria-selected={sortMode === "recent"}
                className={`${styles.dashboardFilterTab} ${sortMode === "recent" ? styles.dashboardFilterTabActive : ""}`}
                onClick={() => setSortMode("recent")}
              >
                最近打开
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sortMode === "updated"}
                className={`${styles.dashboardFilterTab} ${sortMode === "updated" ? styles.dashboardFilterTabActive : ""}`}
                onClick={() => setSortMode("updated")}
              >
                最近修改
              </button>
            </div>
          </div>

          <div className={styles.dashboardRecentSheet}>
            {displayFiles.length === 0 ? (
              <div className={styles.dashboardSheetEmpty}>
                <span>还没有最近打开的笔记</span>
                <button
                  type="button"
                  className={styles.dashboardSheetEmptyAction}
                  onClick={() => setSortMode("updated")}
                >
                  查看最近修改
                </button>
              </div>
            ) : displayFiles.map(({ file, touchedAt }, idx) => {
              const folder = file.path.split("/").slice(0, -1).pop() ?? "";
              const title = file.name.replace(/\.(md|html?)$/i, "");
              const timeLabel = formatRelativeTime(touchedAt);
              return (
                <button
                  key={file.path}
                  type="button"
                  className={styles.dashboardRecentRow}
                  onClick={() => onSelectNote(file.path)}
                  title={file.path}
                >
                  <span className={`${styles.dashboardRowIcon} ${idx === 0 ? styles.dashboardRowIconTop : ""}`} aria-hidden="true">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                  </span>
                  <span className={styles.dashboardRowTitle}>{title}</span>
                  <span className={styles.dashboardRowMeta}>
                    {folder ? <span className={styles.dashboardFolderTag}>{folder}</span> : null}
                    <span className={styles.dashboardTimeLabel}>{timeLabel}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <footer className={styles.dashboardFooter}>
        <span>共 {noteFiles.length} 篇笔记</span>
        <div className={styles.dashboardFooterLinks}>
          <button type="button" className={styles.dashboardSubtleLink} onClick={onImport}>
            导入文件
          </button>
          <button type="button" className={`${styles.dashboardSubtleLink} ${styles.dashboardDesktopOnly}`} onClick={onOpenQuickSwitcher}>
            ⌘K 跳转
          </button>
          <button type="button" className={`${styles.dashboardSubtleLink} ${styles.dashboardDesktopOnly}`} onClick={onToggleFellow}>
            ⌘J 开关 Fellow
          </button>
        </div>
      </footer>
    </div>
  );
}

import { useCallback, useMemo, useRef } from "react";
import type { NotesFileNode } from "@/lib/notesTypes";
import styles from "./notes.module.css";

interface NotesDashboardProps {
  files: NotesFileNode[];
  /** 首页 → 对话过渡中：播放退场动画并屏蔽交互 */
  exiting?: boolean;
  onSelectNote: (path: string) => void;
  onAskAI: (query?: string) => void;
  onQuickCapture: () => void;
  onCreateNote: () => void;
  onImport: () => void;
}

export default function NotesDashboard({ files, exiting = false, onSelectNote, onAskAI, onQuickCapture, onCreateNote, onImport }: NotesDashboardProps) {
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const recentFiles = useMemo(() => {
    const imageExts = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico|avif|tiff?)$/i;
    return [...files]
      .filter((f) => !imageExts.test(f.name))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 6);
  }, [files]);

  const isEmpty = files.length === 0;

  // 建议提示词：第二个 chip 基于最近编辑的笔记动态生成
  const continueTitle = recentFiles[0]?.name.replace(/\.(md|html?)$/i, "") ?? null;

  const submitPrompt = useCallback(() => {
    if (exiting) return;
    const el = promptRef.current;
    const text = el?.value.trim();
    if (text) {
      onAskAI(text);
      if (el) {
        el.value = "";
        el.style.height = "auto";
      }
    } else {
      onAskAI();
    }
  }, [exiting, onAskAI]);

  return (
    <div className={`${styles.dashboardContainer} ${exiting ? styles.dashboardExiting : ""}`}>
      <div className={styles.dashboardHero}>
        <p className={styles.dashboardSubtitle}>
          {isEmpty ? "这里还是空的——记下第一个想法，或直接向 AI 提问。" : "你的个人知识库，已就绪。"}
        </p>

        <form
          className={styles.dashboardSearchBox}
          onSubmit={(e) => {
            e.preventDefault();
            submitPrompt();
          }}
          onClick={() => promptRef.current?.focus()}
        >
          <textarea
            ref={promptRef}
            name="q"
            rows={1}
            className={styles.dashboardSearchInput}
            placeholder="问问你的知识库…"
            autoComplete="off"
            onInput={(e) => {
              // 自适应长高：先收缩再按内容撑开，封顶 8 行左右
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
            }}
            onKeyDown={(e) => {
              // Enter 发送、Shift+Enter 换行；IME 选字时的 Enter 不触发
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submitPrompt();
              }
            }}
          />
          <button type="submit" className={styles.dashboardSendBtn} aria-label="发送">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 19V5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          </button>
        </form>

        <div className={styles.dashboardPromptChips}>
          {/* 记录灵感是「写」的一等入口：填充样式与描边的 AI 提问 chips 区分两条路径 */}
          <button type="button" className={styles.dashboardCaptureChip} onClick={onQuickCapture}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
            <span>记录灵感</span>
          </button>
          {isEmpty ? (
            <>
              {/* 空库首屏：给出建库的两条明确路径，而不是一句"没有文件" */}
              <button type="button" className={styles.dashboardPromptChip} onClick={onCreateNote}>
                新建笔记
              </button>
              <button type="button" className={styles.dashboardPromptChip} onClick={onImport}>
                导入文件
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={styles.dashboardPromptChip}
                onClick={() => { if (!exiting) onAskAI("总结我本周的笔记"); }}
              >
                总结我本周的笔记
              </button>
              {continueTitle ? (
                <button
                  type="button"
                  className={styles.dashboardPromptChip}
                  onClick={() => { if (!exiting) onAskAI(`继续写「${continueTitle}」这篇笔记`); }}
                >
                  继续写「{continueTitle}」
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>

      {recentFiles.length > 0 && (
        <div className={styles.dashboardSection}>
          <div className={styles.dashboardSectionHeader}>
            <h2 className={styles.dashboardSectionTitle}>继续你的工作</h2>
          </div>
          
          <div className={styles.dashboardRecentGrid}>
            {recentFiles.map((file) => {
              const folder = file.path.split("/").slice(0, -1).pop() ?? "";
              const date = new Date(file.updatedAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
              return (
                <button
                  key={file.path}
                  type="button"
                  className={styles.dashboardRecentCard}
                  onClick={() => onSelectNote(file.path)}
                  title={file.path}
                >
                  <div className={styles.dashboardRecentCardContent}>
                    <h3 className={styles.dashboardRecentCardTitle}>{file.name.replace(/\.(md|html?)$/i, "")}</h3>
                    <p className={styles.dashboardRecentCardMeta}>{folder ? `${folder} · ${date}` : date}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

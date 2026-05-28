import { useMemo } from "react";
import type { NotesFileNode } from "@/lib/notesTypes";
import styles from "./notes.module.css";

interface NotesDashboardProps {
  files: NotesFileNode[];
  onSelectNote: (path: string) => void;
  onAskAI: (query?: string) => void;
  onNewNote: () => void;
}

export default function NotesDashboard({ files, onSelectNote, onAskAI, onNewNote }: NotesDashboardProps) {
  const recentFiles = useMemo(() => {
    return [...files]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 6);
  }, [files]);

  return (
    <div className={styles.dashboardContainer}>
      <div className={styles.dashboardHero}>
        <h1 className={styles.dashboardTitle}>Ask Inkfellow...</h1>
        <p className={styles.dashboardSubtitle}>你的知识库已准备就绪，有问题直接问，或者开始记录新想法。</p>
        
        <form 
          className={styles.dashboardSearchBox} 
          onSubmit={(e) => {
            e.preventDefault();
            const input = e.currentTarget.elements.namedItem("q") as HTMLInputElement;
            if (input.value.trim()) {
              onAskAI(input.value.trim());
              input.value = "";
            } else {
              onAskAI();
            }
          }}
          onClick={(e) => {
            const input = e.currentTarget.elements.namedItem("q") as HTMLInputElement;
            input?.focus();
          }}
        >
          <svg className={styles.dashboardSearchIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input 
            name="q" 
            className={styles.dashboardSearchInput} 
            placeholder="向 AI 提问或搜索笔记..." 
            autoComplete="off"
          />
          <button type="submit" className={styles.dashboardSearchShortcut}>✦</button>
        </form>
      </div>

      {recentFiles.length > 0 && (
        <div className={styles.dashboardSection}>
          <div className={styles.dashboardSectionHeader}>
            <h2 className={styles.dashboardSectionTitle}>继续你的工作</h2>
            <button type="button" className={styles.dashboardNewNoteBtn} onClick={onNewNote}>
              + 记录新想法
            </button>
          </div>
          
          <div className={styles.dashboardRecentGrid}>
            {recentFiles.map((file) => (
              <button 
                key={file.path} 
                type="button" 
                className={styles.dashboardRecentCard}
                onClick={() => onSelectNote(file.path)}
              >
                <div className={styles.dashboardRecentCardIcon}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                </div>
                <div className={styles.dashboardRecentCardContent}>
                  <h3 className={styles.dashboardRecentCardTitle}>{file.name.replace(/\.(md|html?)$/i, "")}</h3>
                  <p className={styles.dashboardRecentCardPath}>{file.path}</p>
                  <p className={styles.dashboardRecentCardDate}>
                    {new Date(file.updatedAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

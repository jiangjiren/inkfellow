"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from "react";
import styles from "./notes.module.css";

const TABS_KEY = "inkfellow-notes-tabs-v1";
const EMPTY_TABS: string[] = [];

const tabLabel = (path: string) => {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.(md|html?|pdf)$/i, "");
};

// ── localStorage 外部 store ──────────────────────────────
// tabs 以 localStorage 为唯一数据源，经 useSyncExternalStore 接入 React：
// SSR/hydration 阶段拿到空列表，客户端接管后自动切到真实数据，多窗口间也能同步。
let cachedRaw: string | null = null;
let cachedTabs: string[] = EMPTY_TABS;
const listeners = new Set<() => void>();

const parseTabs = (raw: string | null): string[] => {
  if (!raw) return EMPTY_TABS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY_TABS;
    const tabs = parsed.filter((p): p is string => typeof p === "string" && p.length > 0);
    return tabs.length > 0 ? tabs : EMPTY_TABS;
  } catch {
    return EMPTY_TABS;
  }
};

const readTabs = (): string[] => {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(TABS_KEY);
  } catch { /* ignore */ }
  // getSnapshot 必须在数据未变时返回同一引用，否则 useSyncExternalStore 会死循环
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedTabs = parseTabs(raw);
  }
  return cachedTabs;
};

const writeTabs = (next: string[]) => {
  try {
    window.localStorage.setItem(TABS_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
  cachedRaw = JSON.stringify(next);
  cachedTabs = next;
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === TABS_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
};

const getServerTabs = () => EMPTY_TABS;

const ensureTab = (path: string) => {
  const tabs = readTabs();
  if (!tabs.includes(path)) writeTabs([...tabs, path]);
};

const removeTab = (path: string) => {
  const tabs = readTabs();
  if (tabs.includes(path)) writeTabs(tabs.filter((p) => p !== path));
};

/** 重命名/移动后批量映射路径（映射函数由调用方提供），映射后去重 */
const mapTabs = (mapper: (path: string) => string) => {
  const tabs = readTabs();
  const next: string[] = [];
  for (const p of tabs) {
    const mapped = mapper(p);
    if (!next.includes(mapped)) next.push(mapped);
  }
  if (next.length !== tabs.length || next.some((p, i) => p !== tabs[i])) {
    writeTabs(next);
  }
};

/** 按谓词保留标签（删除文件/文件夹、文件树刷新后清理失效标签） */
const pruneTabs = (keep: (path: string) => boolean) => {
  const tabs = readTabs();
  const next = tabs.filter(keep);
  if (next.length !== tabs.length) writeTabs(next);
};

/**
 * 轻量多标签：标签只是「已打开路径」的书签列表，不持有任何文档状态。
 * 加载/编辑/保存/滚动恢复全部复用 NotesExplorer 现有的单文档逻辑。
 */
export function useNoteTabs() {
  const tabs = useSyncExternalStore(subscribe, readTabs, getServerTabs);
  return { tabs, ensureTab, removeTab, mapTabs, pruneTabs };
}

type NoteTabsProps = {
  tabs: string[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
};

export function NoteTabs({ tabs, activePath, onSelect, onClose }: NoteTabsProps) {
  const stripRef = useRef<HTMLDivElement>(null);

  // 激活标签滚入可视区（标签多到横向溢出时）
  useEffect(() => {
    if (!activePath) return;
    const strip = stripRef.current;
    if (!strip || strip.scrollWidth <= strip.clientWidth) return;
    const el = strip.querySelector<HTMLElement>(`[data-tab-path="${CSS.escape(activePath)}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activePath, tabs]);

  const handleAuxClick = useCallback((event: ReactMouseEvent, path: string) => {
    if (event.button === 1) {
      event.preventDefault();
      onClose(path);
    }
  }, [onClose]);

  if (tabs.length === 0) return null;

  return (
    <div className={styles.tabStrip} role="tablist" aria-label="已打开的文件" ref={stripRef}>
      {tabs.map((path) => {
        const active = path === activePath;
        const label = tabLabel(path);
        return (
          <div
            key={path}
            data-tab-path={path}
            className={`${styles.tabItem} ${active ? styles.tabItemActive : ""}`}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            title={path}
            onClick={() => onSelect(path)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(path); } }}
            onAuxClick={(e) => handleAuxClick(e, path)}
            onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
          >
            <span className={styles.tabLabel}>{label}</span>
            <button
              type="button"
              className={styles.tabClose}
              onClick={(e) => { e.stopPropagation(); onClose(path); }}
              aria-label={`关闭 ${label}`}
              title="关闭"
              tabIndex={-1}
            >
              <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}

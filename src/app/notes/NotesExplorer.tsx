"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import type {
  NotesDirectoryNode,
  NotesFileNode,
  NotesFileResponse,
  NotesTreeNode,
  NotesTreeResponse,
} from "@/lib/notesTypes";
import { extractHeadings, type TocEntry } from "@/lib/noteToc";
import dynamic from "next/dynamic";
import NotesHtml from "./NotesHtml";
import NotesMarkdown from "./NotesMarkdown";
import NotesGit from "./NotesGit";
import NotesDashboard from "./NotesDashboard";
import styles from "./notes.module.css";

// CodeMirror 不支持 SSR，动态加载
const NotesEditor = dynamic(() => import("./NotesEditor"), { ssr: false });

type LoadState = "idle" | "loading" | "ready" | "error";

const PANEL_WIDTH_KEY = "inkfellow-notes-panel-width-v1";
const PANEL_VISIBLE_KEY = "inkfellow-notes-panel-visible-v1";
const PANEL_TAB_KEY = "inkfellow-notes-panel-tab-v1";
const SIDEBAR_VISIBLE_KEY = "inkfellow-notes-sidebar-visible-v1";
const SIDEBAR_WIDTH_KEY = "inkfellow-notes-sidebar-width-v1";
const NOTE_SCROLL_STORAGE_PREFIX = "inkfellow-notes-scroll-v1:";

type PanelTab = "claude" | "toc" | "git";
const DEFAULT_ASSISTANT_PANEL_WIDTH = 520;
const MIN_ASSISTANT_PANEL_WIDTH = 340;
const MAX_ASSISTANT_PANEL_WIDTH = 900;
const DEFAULT_SIDEBAR_WIDTH = 280;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 400;

type NotesShellStyle = CSSProperties & {
  "--assistant-panel-width": string;
  "--sidebar-width": string;
};

type ShareInfo = {
  token: string | null;
  url: string | null;
};

type ShareState = "idle" | "loading" | "ready" | "creating" | "copying" | "revoking" | "error";
type ScrollSnapshot =
  | { target: "reader"; top: number; left: number }
  | { target: "window"; top: number; left: number };

type LoadNoteOptions = {
  preserveScroll?: boolean;
  restoreStoredScroll?: boolean;
  silent?: boolean;
  updateHistory?: boolean;
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const stripNoteExtension = (value: string) => value.replace(/\.(md|html?)$/i, "");

const decodeLoose = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeIndexKey = (value: string) =>
  decodeLoose(value)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\.(md|html?)$/i, "")
    .trim()
    .toLocaleLowerCase();

const collectFiles = (node: NotesTreeNode): NotesFileNode[] => {
  if (node.type === "file") {
    return [node];
  }

  return node.children.flatMap((child) => collectFiles(child));
};

const getAncestorFolders = (filePath: string) => {
  const parts = filePath.split("/");
  const folders: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    folders.push(parts.slice(0, index).join("/"));
  }
  return folders;
};

const findPreferredInitialFile = (files: NotesFileNode[]) => {
  return null;
};

const getNoteScrollStorageKey = (path: string) => `${NOTE_SCROLL_STORAGE_PREFIX}${path}`;

const isScrollSnapshot = (value: unknown): value is ScrollSnapshot => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const snapshot = value as Partial<ScrollSnapshot>;
  return (snapshot.target === "reader" || snapshot.target === "window") &&
    typeof snapshot.top === "number" &&
    typeof snapshot.left === "number";
};

const readStoredScrollSnapshot = (path: string): ScrollSnapshot | null => {
  try {
    const raw = window.sessionStorage.getItem(getNoteScrollStorageKey(path));
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    return isScrollSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const writeStoredScrollSnapshot = (path: string, snapshot: ScrollSnapshot) => {
  try {
    window.sessionStorage.setItem(getNoteScrollStorageKey(path), JSON.stringify(snapshot));
  } catch { /* ignore storage failures */ }
};

/** 递归收集所有文件夹路径（含根，用空字符串表示） */
const collectFolders = (node: NotesTreeNode, result: string[] = []): string[] => {
  if (node.type === "directory") {
    result.push(node.path); // 根目录 path 为 ""
    for (const child of node.children) {
      collectFolders(child, result);
    }
  }
  return result;
};

const filterTree = (node: NotesTreeNode, query: string): NotesTreeNode | null => {
  if (!query) {
    return node;
  }

  const normalizedQuery = query.toLocaleLowerCase();
  if (node.type === "file") {
    return node.name.toLocaleLowerCase().includes(normalizedQuery) ||
      node.path.toLocaleLowerCase().includes(normalizedQuery)
      ? node
      : null;
  }

  const children = node.children
    .map((child) => filterTree(child, query))
    .filter((child): child is NotesTreeNode => Boolean(child));

  if (children.length > 0 || node.name.toLocaleLowerCase().includes(normalizedQuery)) {
    return {
      ...node,
      children,
    };
  }

  return null;
};

function TreeItem({
  node,
  level,
  activePath,
  expandedFolders,
  searchQuery,
  onToggle,
  onSelect,
}: {
  node: NotesTreeNode;
  level: number;
  activePath: string | null;
  expandedFolders: Set<string>;
  searchQuery: string;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  if (node.type === "file") {
    const isActive = node.path === activePath;
    const isHtml = /\.html?$/i.test(node.name);
    return (
      <button
        type="button"
        className={`${styles.treeFile} ${isActive ? styles.treeFileActive : ""}`}
        style={{ "--level": level } as CSSProperties}
        onClick={() => onSelect(node.path)}
        title={node.path}
      >
        <svg className={styles.fileDot} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: "13px", height: "13px" }}>
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        <span className={styles.treeLabel}>{stripNoteExtension(node.name)}</span>
        {isHtml ? <span className={styles.fileTypeBadge}>html</span> : null}
      </button>
    );
  }

  const isExpanded = searchQuery ? true : expandedFolders.has(node.path);
  return (
    <div className={styles.treeGroup}>
      {node.path ? (
        <button
          type="button"
          className={styles.treeFolder}
          style={{ "--level": level } as CSSProperties}
          onClick={() => onToggle(node.path)}
          title={node.path}
        >
          <span className={`${styles.chevron} ${isExpanded ? styles.chevronOpen : ""}`} aria-hidden="true">
            ›
          </span>
          <svg className={styles.folderGlyph} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: "16px", height: "16px", color: "var(--notes-accent)" }}>
            {isExpanded ? (
              <>
                <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" fill="var(--notes-accent-bg)" />
                <path d="M2 10h20" />
              </>
            ) : (
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" fill="var(--notes-accent-bg)" />
            )}
          </svg>
          <span className={styles.treeLabel}>{node.name}</span>
        </button>
      ) : null}

      {isExpanded || !node.path ? (
        <div className={styles.treeChildren}>
          {node.children.map((child) => (
            <TreeItem
              key={`${child.type}:${child.path}`}
              node={child}
              level={node.path ? level + 1 : level}
              activePath={activePath}
              expandedFolders={expandedFolders}
              searchQuery={searchQuery}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ArticleToc({
  headings,
  activeSlug,
  onSelect,
}: {
  headings: TocEntry[];
  activeSlug: string;
  onSelect: (slug: string) => void;
}) {
  const minLevel = headings.length > 0 ? Math.min(...headings.map((h) => h.level)) : 0;

  return (
    <nav className={styles.articleToc} aria-label="当前文章目录">
      <div className={styles.articleTocHeader}>
        <span>当前文章</span>
        <strong>目录</strong>
      </div>
      {headings.length > 0 ? (
        <ul className={styles.articleTocList}>
          {headings.map((heading, index) => (
            <li key={`${heading.slug}-${index}`}>
              <button
                type="button"
                className={`${styles.articleTocLink} ${heading.level > minLevel ? styles.articleTocLinkSub : ""} ${activeSlug === heading.slug ? styles.articleTocLinkActive : ""}`}
                onClick={() => onSelect(heading.slug)}
              >
                {heading.text}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.articleTocEmpty}>当前文章没有可显示的目录。</p>
      )}
    </nav>
  );
}

export default function NotesExplorer() {
  const [tree, setTree] = useState<NotesDirectoryNode | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [note, setNote] = useState<NotesFileResponse | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [treeState, setTreeState] = useState<LoadState>("idle");
  const [noteState, setNoteState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileAssistantPanelOpen, setMobileAssistantPanelOpen] = useState(false);
  const [assistantPanelVisible, setAssistantPanelVisible] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("claude");
  const [assistantPanelWidth, setAssistantPanelWidth] = useState(DEFAULT_ASSISTANT_PANEL_WIDTH);
  const [isResizingAssistantPanel, setIsResizingAssistantPanel] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [shareState, setShareState] = useState<ShareState>("idle");
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const [newNoteOpen, setNewNoteOpen] = useState(false);
  const [newNoteTitle, setNewNoteTitle] = useState("");
  const [newNoteFolder, setNewNoteFolder] = useState("");
  const [newNoteError, setNewNoteError] = useState<string | null>(null);
  const [newNoteLoading, setNewNoteLoading] = useState(false);
  const newNoteTitleRef = useRef<HTMLInputElement>(null);
  // ── 编辑模式 ──────────────────────────────────────────
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false); // 「已保存」短暂提示
  const [editorMinHeight, setEditorMinHeight] = useState(0); // 占位高度，防 scroll 被钳制
  const [hasGitChanges, setHasGitChanges] = useState(false); // 当前文件有未提交改动
  const [globalGitPending, setGlobalGitPending] = useState<number | null>(null); // 全局待同步数
  const editorRef = useRef<HTMLTextAreaElement>(null); // kept for potential future use
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingHashRef = useRef<string | null>(null);
  const activePathRef = useRef<string | null>(null);
  const noteUpdatedAtRef = useRef<string | null>(null);
  const claudeFrameRef = useRef<HTMLIFrameElement>(null);
  const readerRef = useRef<HTMLElement>(null);
  const syncTocRef = useRef<(() => void) | null>(null);
  const [activeTocSlug, setActiveTocSlug] = useState("");
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    activePathRef.current = activePath;
  }, [activePath]);

  useEffect(() => {
    if (!activePath) return;
    claudeFrameRef.current?.contentWindow?.postMessage(
      { type: "note-context", filePath: activePath },
      window.location.origin,
    );
  }, [activePath]);

  useEffect(() => {
    setShareModalOpen(false);
    setShareState("idle");
    setShareToken(null);
    setShareUrl(null);
    setShareMessage(null);
  }, [note?.path]);

  const files = useMemo(() => (tree ? collectFiles(tree) : []), [tree]);

  const noteIndex = useMemo(() => {
    const index = new Map<string, string>();

    for (const file of files) {
      const pathWithoutExtension = stripNoteExtension(file.path);
      const basename = stripNoteExtension(file.name);
      const keys = [file.path, pathWithoutExtension, basename];

      for (const key of keys) {
        const normalizedKey = normalizeIndexKey(key);
        if (normalizedKey && !index.has(normalizedKey)) {
          index.set(normalizedKey, file.path);
        }
      }
    }

    return index;
  }, [files]);

  const visibleTree = useMemo(() => (tree ? filterTree(tree, searchQuery.trim()) : null), [tree, searchQuery]);

  const articleTocEntries = useMemo(() => {
    if (!note || /\.html?$/i.test(note.path)) {
      return [];
    }

    return extractHeadings(note.content);
  }, [note]);

  useEffect(() => {
    setActiveTocSlug(articleTocEntries[0]?.slug ?? "");
  }, [articleTocEntries]);

  useEffect(() => {
    if (articleTocEntries.length === 0) {
      return;
    }

    const reader = readerRef.current;
    if (!reader) {
      return;
    }

    const syncActiveHeading = () => {
      // 桌面端：reader 自身滚动（overflow: auto，scrollTop 递增）
      // 移动端：reader 是 overflow: visible，由 window 滚动，reader.scrollTop 永远为 0
      const readerScrollable = getComputedStyle(reader).overflowY !== "visible";
      const scrollTop = readerScrollable ? reader.scrollTop : window.scrollY;
      const viewHeight = readerScrollable ? reader.clientHeight : window.innerHeight;

      // 视口高度为 0 时跳过（隐藏/未渲染）
      if (viewHeight === 0) return;

      const threshold = scrollTop + viewHeight * 0.22;
      let current = articleTocEntries[0]?.slug ?? "";
      const readerTop = reader.getBoundingClientRect().top;

      for (const heading of articleTocEntries) {
        const element = document.getElementById(heading.slug);
        if (!element) continue;

        const top = element.getBoundingClientRect().top - readerTop + scrollTop;
        if (top <= threshold) {
          current = heading.slug;
        }
      }

      setActiveTocSlug(current);
    };

    syncTocRef.current = syncActiveHeading;
    // 同时监听 reader 和 window —— 两者只有一个会实际触发（取决于是桌面还是移动端布局）
    reader.addEventListener("scroll", syncActiveHeading, { passive: true });
    window.addEventListener("scroll", syncActiveHeading, { passive: true });
    const timeout = window.setTimeout(syncActiveHeading, 80);
    return () => {
      reader.removeEventListener("scroll", syncActiveHeading);
      window.removeEventListener("scroll", syncActiveHeading);
      window.clearTimeout(timeout);
      syncTocRef.current = null;
    };
  }, [articleTocEntries]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 900px)");
    const syncViewport = () => {
      const isMobile = mediaQuery.matches;
      setIsMobileViewport(isMobile);
      if (!isMobile) {
        setMobileSidebarOpen(false);
        setMobileAssistantPanelOpen(false);
      }
    };

    syncViewport();
    mediaQuery.addEventListener("change", syncViewport);

    return () => {
      mediaQuery.removeEventListener("change", syncViewport);
    };
  }, []);

  useEffect(() => {
    const savedWidth = Number(window.localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(savedWidth)) {
      setAssistantPanelWidth(clamp(savedWidth, MIN_ASSISTANT_PANEL_WIDTH, MAX_ASSISTANT_PANEL_WIDTH));
    }

    const savedVisibility = window.localStorage.getItem(PANEL_VISIBLE_KEY);
    if (savedVisibility === "true") {
      setAssistantPanelVisible(true);
    } else if (savedVisibility === "false") {
      setAssistantPanelVisible(false);
    }

    const savedTab = window.localStorage.getItem(PANEL_TAB_KEY);
    if (savedTab === "claude" || savedTab === "toc" || savedTab === "git") {
      setPanelTab(savedTab);
    }

    const savedSidebarVisibility = window.localStorage.getItem(SIDEBAR_VISIBLE_KEY);
    if (savedSidebarVisibility === "false") {
      setSidebarVisible(false);
    }

    const savedSidebarWidth = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(savedSidebarWidth) && savedSidebarWidth > 0) {
      setSidebarWidth(clamp(savedSidebarWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH));
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(PANEL_WIDTH_KEY, String(assistantPanelWidth));
  }, [assistantPanelWidth]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem(PANEL_VISIBLE_KEY, String(assistantPanelVisible));
  }, [assistantPanelVisible]);

  useEffect(() => {
    window.localStorage.setItem(PANEL_TAB_KEY, panelTab);
  }, [panelTab]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_VISIBLE_KEY, String(sidebarVisible));
  }, [sidebarVisible]);

  useEffect(() => {
    if (!isMobileViewport || (!mobileSidebarOpen && !mobileAssistantPanelOpen)) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileSidebarOpen(false);
        setMobileAssistantPanelOpen(false);
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isMobileViewport, mobileSidebarOpen, mobileAssistantPanelOpen]);

  useEffect(() => {
    if (!shareModalOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShareModalOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [shareModalOpen]);

  useEffect(() => {
    if (!isResizingAssistantPanel) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const availableWidth = window.innerWidth - event.clientX;
      setAssistantPanelWidth(clamp(availableWidth, MIN_ASSISTANT_PANEL_WIDTH, MAX_ASSISTANT_PANEL_WIDTH));
    };

    const stopResizing = () => {
      setIsResizingAssistantPanel(false);
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);

    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
    };
  }, [isResizingAssistantPanel]);

  useEffect(() => {
    if (!isResizingSidebar) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      setSidebarWidth(clamp(event.clientX, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH));
    };

    const stopResizing = () => {
      setIsResizingSidebar(false);
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);

    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
    };
  }, [isResizingSidebar]);

  const openAncestors = useCallback((filePath: string) => {
    setExpandedFolders((current) => {
      const next = new Set(current);
      getAncestorFolders(filePath).forEach((folder) => next.add(folder));
      return next;
    });
  }, []);

  const getReaderScrollSnapshot = useCallback((): ScrollSnapshot | null => {
    const reader = readerRef.current;
    if (!reader) {
      return null;
    }

    const readerScrollable = getComputedStyle(reader).overflowY !== "visible";
    return readerScrollable
      ? { target: "reader", top: reader.scrollTop, left: reader.scrollLeft }
      : { target: "window", top: window.scrollY, left: window.scrollX };
  }, []);

  const restoreReaderScroll = useCallback((snapshot: ScrollSnapshot) => {
    if (snapshot.target === "reader") {
      readerRef.current?.scrollTo({
        top: snapshot.top,
        left: snapshot.left,
        behavior: "auto",
      });
    } else {
      window.scrollTo({
        top: snapshot.top,
        left: snapshot.left,
        behavior: "auto",
      });
    }
    syncTocRef.current?.();
  }, []);

  const saveCurrentScrollSnapshot = useCallback((path = activePathRef.current) => {
    if (!path) {
      return;
    }
    const snapshot = getReaderScrollSnapshot();
    if (snapshot) {
      writeStoredScrollSnapshot(path, snapshot);
    }
  }, [getReaderScrollSnapshot]);

  useEffect(() => {
    const reader = readerRef.current;
    if (!reader) {
      return;
    }

    let frame = 0;
    const handleScroll = () => {
      const readerScrollable = getComputedStyle(reader).overflowY !== "visible";
      const scrollTop = readerScrollable ? reader.scrollTop : window.scrollY;
      setIsScrolled(scrollTop > 10);

      if (frame) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        saveCurrentScrollSnapshot();
      });
    };

    reader.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("scroll", handleScroll, { passive: true });

    // Run once initially to set the state correctly
    handleScroll();

    return () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      reader.removeEventListener("scroll", handleScroll);
      window.removeEventListener("scroll", handleScroll);
    };
  }, [saveCurrentScrollSnapshot]);

  const loadNote = useCallback(
    async (path: string, hash?: string | null, options: LoadNoteOptions = {}) => {
      if (!options.silent) {
        setNoteState("loading");
      }
      setError(null);
      pendingHashRef.current = hash ?? null;

      try {
        const params = new URLSearchParams({ path });
        const response = await fetch(`/api/notes/file?${params.toString()}`, {
          cache: "no-store",
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Failed to load note: ${response.status}`);
        }

        const payload = (await response.json()) as NotesFileResponse;
        noteUpdatedAtRef.current = payload.updatedAt;

        if (options.updateHistory !== false) {
          const nextUrl = new URL(window.location.href);
          nextUrl.searchParams.set("file", payload.path);
          nextUrl.hash = hash ?? "";
          window.history.replaceState(null, "", nextUrl);
        }

        const scrollSnapshot = options.preserveScroll
          ? getReaderScrollSnapshot()
          : options.restoreStoredScroll && !hash
            ? readStoredScrollSnapshot(payload.path)
            : null;
        const commitNote = () => {
          setNote(payload);
          setActivePath(payload.path);
          openAncestors(payload.path);
          setNoteState("ready");
        };

        if (scrollSnapshot) {
          flushSync(commitNote);
          restoreReaderScroll(scrollSnapshot);
          writeStoredScrollSnapshot(payload.path, scrollSnapshot);
        } else {
          commitNote();
        }
      } catch (loadError) {
        if (!options.silent) {
          setNote(null);
          setNoteState("error");
        }
        setError(loadError instanceof Error ? loadError.message : "Failed to load note.");
      }
    },
    [getReaderScrollSnapshot, openAncestors, restoreReaderScroll],
  );

  // ── 选中文字 → 自动发送到 Claude 引用框 ──────────────────────
  const hasReaderSelectionRef = useRef(false);
  useEffect(() => {
    const handlePointerUp = () => {
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        const text = sel.toString().trim();
        if (text.length < 2) return;
        const reader = readerRef.current;
        if (!reader) return;
        try {
          const range = sel.getRangeAt(0);
          if (!reader.contains(range.commonAncestorContainer)) return;
          hasReaderSelectionRef.current = true;
          claudeFrameRef.current?.contentWindow?.postMessage(
            { type: "note-selection", text },
            window.location.origin,
          );
        } catch { /* ignore */ }
      }, 10);
    };

    const handleSelectionChange = () => {
      if (!hasReaderSelectionRef.current) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        hasReaderSelectionRef.current = false;
        claudeFrameRef.current?.contentWindow?.postMessage(
          { type: "note-selection-clear" },
          window.location.origin,
        );
      }
    };

    document.addEventListener("pointerup", handlePointerUp);
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("pointerup", handlePointerUp);
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, []);

  // 每 2 秒轻量检查当前文件的修改时间，有变化才重新加载内容
  // 用 ref 追踪加载状态，避免 noteState 进入依赖导致 interval 反复重置
  const isReloadingRef = useRef(false);
  useEffect(() => {
    const interval = setInterval(async () => {
      const path = activePathRef.current;
      const knownUpdatedAt = noteUpdatedAtRef.current;
      // 没打开文件、还没完成首次加载、正在重载中 → 跳过
      if (!path || !knownUpdatedAt || isReloadingRef.current) return;
      try {
        const params = new URLSearchParams({ path, meta: "true" });
        const res = await fetch(`/api/notes/file?${params}`, { cache: "no-store" });
        if (!res.ok) return;
        const { updatedAt } = (await res.json()) as { updatedAt: string };
        if (updatedAt && updatedAt !== knownUpdatedAt) {
          isReloadingRef.current = true;
          await loadNote(path, null, {
            preserveScroll: true,
            silent: true,
            updateHistory: false,
          });
          isReloadingRef.current = false;
          // 重载后查实际 git 状态：可能是 Agent 新增改动，也可能是撤销/还原
          fetch(`/api/notes/git?check=${encodeURIComponent(path)}`)
            .then((r) => r.ok ? r.json() : null)
            .then((data: { changed: boolean } | null) => {
              if (data != null) setHasGitChanges(data.changed);
            })
            .catch(() => { /* silent */ });
        }
      } catch {
        isReloadingRef.current = false;
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [loadNote]); // ← 不依赖 noteState，interval 永久稳定运行

  useEffect(() => {
    let cancelled = false;

    async function loadTree() {
      setTreeState("loading");
      setError(null);

      try {
        const response = await fetch("/api/notes/tree", { cache: "no-store" });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Failed to load file tree: ${response.status}`);
        }

        const payload = (await response.json()) as NotesTreeResponse;
        if (cancelled) {
          return;
        }

        const allFiles = collectFiles(payload.root);
        const url = new URL(window.location.href);
        const requestedFile = url.searchParams.get("file");
        const initialFile = requestedFile && allFiles.some((file) => file.path === requestedFile)
          ? requestedFile
          : findPreferredInitialFile(allFiles);

        setTree(payload.root);
        setExpandedFolders(new Set(initialFile ? getAncestorFolders(initialFile) : []));
        setTreeState("ready");

        if (initialFile) {
          await loadNote(initialFile, url.hash || null, { restoreStoredScroll: !url.hash });
        }
      } catch (loadError) {
        if (cancelled) {
          return;
        }
        setTreeState("error");
        setError(loadError instanceof Error ? loadError.message : "Failed to load notes.");
      }
    }

    // 页面打开时立即加载本地内容（不等待网络）
    void loadTree();

    // 同时在后台静默 pull — 8 秒超时，失败无感知
    const autoSync = async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8_000);
        const res = await fetch("/api/notes/git", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "pull" }),
          signal: ctrl.signal,
          cache: "no-store",
        });
        clearTimeout(timer);
        if (!cancelled) {
          const data = (await res.json()) as { ok?: boolean; output?: string };
          // 有新内容（非"Already up to date"）时静默刷新文件树
          if (data.ok && data.output && !/already up to date/i.test(data.output)) {
            void loadTree();
          }
        }
      } catch { /* 网络失败/超时 — 静默忽略 */ }
    };
    void autoSync();

    return () => {
      cancelled = true;
    };
  }, [loadNote]);

  useEffect(() => {
    if (noteState !== "ready") {
      return;
    }

    const pendingHash = pendingHashRef.current;
    if (!pendingHash) {
      return;
    }

    pendingHashRef.current = null;
    window.requestAnimationFrame(() => {
      const targetId = decodeURIComponent(pendingHash.replace(/^#/, ""));
      document.getElementById(targetId)?.scrollIntoView({ block: "start" });
    });
  }, [noteState, note?.path]);

  // 计算是否有未保存修改
  const isDirty = isEditing && note !== null && editContent !== note.content;

  /** 进入编辑模式 */
  const handleEditStart = useCallback(() => {
    if (!note || /\.html?$/i.test(note.path)) return;
    // 用当前 reader.scrollHeight 做占位，防止切换后内容高度骤降导致 scrollTop 被钳制
    setEditorMinHeight(readerRef.current?.scrollHeight ?? 0);
    setEditContent(note.content);
    setIsEditing(true);
  }, [note]);

  /** 保存（⌘S 或切换前 flush 时使用） */
  const handleSave = useCallback(async (notePath?: string, content?: string) => {
    const path = notePath ?? activePath;
    const body = content ?? editContent;
    if (!path) return;
    setIsSaving(true);
    try {
      const res = await fetch("/api/notes/file", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, content: body }),
      });
      if (!res.ok) throw new Error("保存失败");
      const saved = (await res.json()) as { updatedAt: string; content: string };
      setNote((prev) => prev ? { ...prev, content: saved.content, updatedAt: saved.updatedAt } : prev);
      noteUpdatedAtRef.current = saved.updatedAt;
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1600);
      setHasGitChanges(true);
    } finally {
      setIsSaving(false);
    }
  }, [activePath, editContent]);

  /** Editor onChange — 更新状态 + 防抖自动保存 */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleEditorChange = useCallback((value: string) => {
    setEditContent(value);
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(async () => {
      const path = activePathRef.current;
      if (!path) return;
      try {
        const res = await fetch("/api/notes/file", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, content: value }),
        });
        if (!res.ok) return;
        const saved = (await res.json()) as { updatedAt: string; content: string };
        setNote((prev) => prev ? { ...prev, content: saved.content, updatedAt: saved.updatedAt } : prev);
        noteUpdatedAtRef.current = saved.updatedAt;
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1600);
        setHasGitChanges(true);
      } catch { /* 网络错误静默忽略 */ }
    }, 1500);
  }, []); // stable — intentionally no deps, uses refs

  /** 切换阅读 / 编辑模式 */
  const handleEditToggle = useCallback(async () => {
    if (!isEditing) {
      handleEditStart();
      return;
    }
    // 退出编辑：取消 pending auto-save，有未保存内容先 flush
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    if (isDirty) await handleSave();
    setIsEditing(false);
  }, [isEditing, isDirty, handleSave, handleEditStart]);

  /** 切换笔记前自动保存未提交的修改 */
  const flushEditBeforeSwitch = useCallback(async () => {
    if (isEditing && isDirty && activePath) {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
      await handleSave(activePath, editContent);
    }
  }, [isEditing, isDirty, activePath, editContent, handleSave]);

  /** 退出编辑模式当 note 切换时，清理 pending auto-save */
  useEffect(() => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    setIsEditing(false);
  }, [note?.path]);

  // 全局 Git 状态轮询 — 为侧边栏底部状态条和移动端 badge 提供数据
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch("/api/notes/git", { cache: "no-store" });
        const data = (await res.json()) as { files?: unknown[]; error?: string };
        if (!data.error) setGlobalGitPending(data.files?.length ?? 0);
      } catch { /* silent */ }
    };
    void poll();
    const id = setInterval(() => void poll(), 30_000);
    return () => clearInterval(id);
  }, []);

  /** 当前文件切换时检查 git 状态，更新「未同步」指示点 */
  useEffect(() => {
    setHasGitChanges(false);
    const p = note?.path;
    if (!p || /\.html?$/i.test(p)) return;
    let cancelled = false;
    fetch(`/api/notes/git?check=${encodeURIComponent(p)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data: { changed: boolean } | null) => {
        if (!cancelled && data) setHasGitChanges(data.changed);
      })
      .catch(() => { /* silent */ });
    return () => { cancelled = true; };
  }, [note?.path]);

  /** ⌘S 立即保存（取消 pending debounce，直接 flush） */
  useEffect(() => {
    if (!isEditing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (autoSaveTimerRef.current) {
          clearTimeout(autoSaveTimerRef.current);
          autoSaveTimerRef.current = null;
        }
        void handleSave();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isEditing, handleSave]);

  /** 打开新建笔记对话框，默认目录 = 当前笔记所在目录 */
  const openNewNote = useCallback(() => {
    const defaultFolder = activePath ? activePath.split("/").slice(0, -1).join("/") : "";
    setNewNoteFolder(defaultFolder);
    setNewNoteTitle("");
    setNewNoteError(null);
    setNewNoteOpen(true);
    // 等 DOM 渲染后聚焦输入框
    setTimeout(() => newNoteTitleRef.current?.focus(), 30);
  }, [activePath]);

  const handleCreateNote = useCallback(async () => {
    const title = newNoteTitle.trim();
    if (!title) {
      setNewNoteError("请输入笔记标题");
      newNoteTitleRef.current?.focus();
      return;
    }

    // 将标题转为合法文件名（去掉 / \ : * ? " < > |）
    const safeName = title.replace(/[/\\:*?"<>|]/g, "-");
    const filePath = newNoteFolder ? `${newNoteFolder}/${safeName}.md` : `${safeName}.md`;

    setNewNoteLoading(true);
    setNewNoteError(null);

    try {
      const res = await fetch("/api/notes/file", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: filePath, content: `# ${title}\n` }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "创建失败");
      }

      // 刷新文件树
      const treeRes = await fetch("/api/notes/tree", { cache: "no-store" });
      if (treeRes.ok) {
        const payload = (await treeRes.json()) as { root: NotesDirectoryNode };
        setTree(payload.root);
        // 展开新笔记所在目录
        if (newNoteFolder) {
          setExpandedFolders((prev) => {
            const next = new Set(prev);
            const parts = newNoteFolder.split("/");
            let accumulated = "";
            for (const part of parts) {
              accumulated = accumulated ? `${accumulated}/${part}` : part;
              next.add(accumulated);
            }
            return next;
          });
        }
      }

      setNewNoteOpen(false);
      // 跳转到新笔记
      void loadNote(filePath);
    } catch (err) {
      setNewNoteError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setNewNoteLoading(false);
    }
  }, [newNoteTitle, newNoteFolder, loadNote]);

  /** ⌘N / Ctrl+N 快捷键 */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "n" && !e.shiftKey && !e.altKey) {
        // 避免在输入框内触发
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement).isContentEditable) return;
        e.preventDefault();
        openNewNote();
      }
      if (e.key === "Escape" && newNoteOpen) {
        setNewNoteOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [newNoteOpen, openNewNote]);

  const handleToggle = useCallback((path: string) => {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleSelect = useCallback(
    (path: string) => {
      void flushEditBeforeSwitch().then(() => loadNote(path));
      if (isMobileViewport) {
        setMobileSidebarOpen(false);
      }
    },
    [isMobileViewport, loadNote, flushEditBeforeSwitch],
  );

  const handleMarkdownNavigate = useCallback(
    (path: string, hash?: string | null) => {
      void loadNote(path, hash);
    },
    [loadNote],
  );

  const handleSelectTocHeading = useCallback(
    (slug: string) => {
      const target = document.getElementById(slug);
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
      setActiveTocSlug(slug);

      if (isMobileViewport) {
        setMobileAssistantPanelOpen(false);
      }
    },
    [isMobileViewport],
  );

  const handleClaudeToggle = useCallback(() => {
    if (isMobileViewport) {
      setMobileSidebarOpen(false);
      if (panelTab === "claude" && mobileAssistantPanelOpen) {
        setMobileAssistantPanelOpen(false);
      } else {
        setPanelTab("claude");
        setMobileAssistantPanelOpen(true);
      }
    } else {
      if (panelTab === "claude" && assistantPanelVisible) {
        setAssistantPanelVisible(false);
      } else {
        setPanelTab("claude");
        setAssistantPanelVisible(true);
      }
    }
  }, [isMobileViewport, panelTab, mobileAssistantPanelOpen, assistantPanelVisible]);

  const handleTocToggle = useCallback(() => {
    if (isMobileViewport) {
      setMobileSidebarOpen(false);
      if (panelTab === "toc" && mobileAssistantPanelOpen) {
        setMobileAssistantPanelOpen(false);
      } else {
        setPanelTab("toc");
        setMobileAssistantPanelOpen(true);
      }
    } else {
      if (panelTab === "toc" && assistantPanelVisible) {
        setAssistantPanelVisible(false);
      } else {
        setPanelTab("toc");
        setAssistantPanelVisible(true);
      }
    }
  }, [isMobileViewport, panelTab, mobileAssistantPanelOpen, assistantPanelVisible]);

  const loadShareInfo = useCallback(async () => {
    if (!note) {
      return;
    }

    setShareState("loading");
    setShareMessage(null);

    try {
      const params = new URLSearchParams({ path: note.path });
      const response = await fetch(`/api/notes/share?${params.toString()}`, {
        cache: "no-store",
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `读取分享状态失败：${response.status}`);
      }

      const payload = (await response.json()) as ShareInfo;
      setShareToken(payload.token);
      setShareUrl(payload.url);
      setShareState("ready");
    } catch (shareError) {
      setShareState("error");
      setShareMessage(shareError instanceof Error ? shareError.message : "读取分享状态失败");
    }
  }, [note]);

  const handleOpenShareDialog = useCallback(() => {
    if (!note) {
      return;
    }

    setShareModalOpen(true);
    void loadShareInfo();
  }, [loadShareInfo, note]);

  const handleCreateShare = useCallback(async () => {
    if (!note) {
      return;
    }

    setShareState("creating");
    setShareMessage(null);

    try {
      const response = await fetch("/api/notes/share", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          path: note.path,
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `创建分享失败：${response.status}`);
      }

      const payload = (await response.json()) as { token: string; url: string };
      setShareToken(payload.token);
      setShareUrl(payload.url);
      setShareState("ready");
      setShareMessage("分享链接已生成");
    } catch (shareError) {
      setShareState("error");
      setShareMessage(shareError instanceof Error ? shareError.message : "创建分享失败");
    }
  }, [note]);

  const handleCopyShare = useCallback(async () => {
    if (!shareUrl) {
      return;
    }

    setShareState("copying");
    setShareMessage(null);

    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareState("ready");
      setShareMessage("链接已复制");
    } catch {
      setShareState("error");
      setShareMessage("复制失败，请手动复制链接");
    }
  }, [shareUrl]);

  const handleRevokeShare = useCallback(async () => {
    if (!shareToken) {
      return;
    }

    setShareState("revoking");
    setShareMessage(null);

    try {
      const response = await fetch("/api/notes/share", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          token: shareToken,
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `取消分享失败：${response.status}`);
      }

      setShareToken(null);
      setShareUrl(null);
      setShareState("ready");
      setShareMessage("已取消分享");
    } catch (shareError) {
      setShareState("error");
      setShareMessage(shareError instanceof Error ? shareError.message : "取消分享失败");
    }
  }, [shareToken]);

  const updatedAt = note ? new Date(note.updatedAt).toLocaleString("zh-CN", { hour12: false }) : "";
  const shellStyle: NotesShellStyle = {
    "--assistant-panel-width": `${assistantPanelWidth}px`,
    "--sidebar-width": `${sidebarWidth}px`,
  };
  const isDesktopSidebarHidden = !isMobileViewport && !sidebarVisible;
  const isSidebarOpen = isMobileViewport ? mobileSidebarOpen : sidebarVisible;
  const isAssistantPanelOpen = isMobileViewport ? mobileAssistantPanelOpen : assistantPanelVisible;
  const [isDashboardChatActive, setIsDashboardChatActive] = useState(false);
  const isDashboardChatMode = !note && isAssistantPanelOpen && !isMobileViewport && panelTab === "claude" && isDashboardChatActive;
  const isDesktopAssistantPanelHidden = !isMobileViewport && !assistantPanelVisible;
  const hasMobileOverlayOpen = isMobileViewport && (mobileSidebarOpen || mobileAssistantPanelOpen);

  return (
    <main
      className={`${styles.shell} ${isDesktopSidebarHidden ? styles.shellSidebarHidden : ""} ${
        mobileSidebarOpen ? styles.shellMobileSidebarOpen : ""
      } ${
        mobileAssistantPanelOpen ? styles.shellMobileAssistantPanelOpen : ""
      } ${
        isDesktopAssistantPanelHidden ? styles.shellAssistantPanelHidden : ""
      } ${isResizingAssistantPanel || isResizingSidebar ? styles.shellResizing : ""}`}
      style={shellStyle}
    >
      <aside className={`${styles.sidebar} ${isDesktopSidebarHidden ? styles.sidebarHidden : ""}`} aria-hidden={!isSidebarOpen}>
        <button
          type="button"
          className={styles.sidebarResizer}
          onPointerDown={(event) => {
            event.preventDefault();
            setIsResizingSidebar(true);
          }}
          onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") {
              event.preventDefault();
              setSidebarWidth((w) => clamp(w + 24, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH));
            }
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              setSidebarWidth((w) => clamp(w - 24, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH));
            }
          }}
          aria-label="调整侧边栏宽度"
          title="拖拽调整侧边栏宽度，双击恢复默认"
          tabIndex={!isMobileViewport && isSidebarOpen ? 0 : -1}
        />
        <div className={styles.sidebarHeader}>
          <div>
            <p className={styles.eyebrow}>{process.env.NEXT_PUBLIC_APP_NAME?.trim() || "inkfellow"}</p>
            <h1 className={styles.title}>知识库</h1>
          </div>
          <span className={styles.counter}>{files.length} 篇</span>
          <button
            type="button"
            className={styles.newNoteButton}
            onClick={openNewNote}
            aria-label="新建笔记 (⌘N)"
            title="新建笔记 (⌘N)"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <line x1="8" y1="2.5" x2="8" y2="13.5" />
              <line x1="2.5" y1="8" x2="13.5" y2="8" />
            </svg>
          </button>
          <button
            type="button"
            className={styles.mobileSidebarClose}
            onClick={() => setMobileSidebarOpen(false)}
            aria-label="关闭目录"
            title="关闭目录"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <label className={styles.search}>
          <span className={styles.searchIcon} aria-hidden="true" />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="搜索文件"
            aria-label="搜索文件"
          />
        </label>

        <div className={styles.treePanel}>
          {treeState === "loading" ? (
            <div className={styles.sidebarState}>正在读取文件树...</div>
          ) : null}
          {treeState === "error" ? (
            <div className={styles.sidebarState}>{error ?? "文件树加载失败"}</div>
          ) : null}
          {visibleTree ? (
            <TreeItem
              node={visibleTree}
              level={0}
              activePath={activePath}
              expandedFolders={expandedFolders}
              searchQuery={searchQuery.trim()}
              onToggle={handleToggle}
              onSelect={handleSelect}
            />
          ) : null}
        </div>

        {globalGitPending !== null && (
          <div className={styles.sidebarFooter}>
            <button
              type="button"
              className={styles.sidebarGitStatus}
              onClick={() => {
                if (isMobileViewport) {
                  setMobileSidebarOpen(false);
                  setMobileAssistantPanelOpen(true);
                } else {
                  setAssistantPanelVisible(true);
                }
                setPanelTab("git");
              }}
              tabIndex={isSidebarOpen ? 0 : -1}
              title={globalGitPending === 0 ? "已同步到云端" : `${globalGitPending} 篇笔记有未同步的改动`}
            >
              <span className={`${styles.sidebarGitDot} ${globalGitPending === 0 ? styles.sidebarGitDotSynced : ""}`} />
              <span className={styles.sidebarGitLabel}>
                {globalGitPending === 0 ? "已同步到云端" : `${globalGitPending} 篇待同步`}
              </span>
              {globalGitPending > 0 && (
                <span className={styles.sidebarGitArrow} aria-hidden="true">↑↓</span>
              )}
            </button>
          </div>
        )}
      </aside>

      <button
        type="button"
        className={`${styles.mobileScrim} ${hasMobileOverlayOpen ? styles.mobileScrimOpen : ""}`}
        onClick={() => {
          setMobileSidebarOpen(false);
          setMobileAssistantPanelOpen(false);
        }}
        aria-label={mobileSidebarOpen ? "关闭目录" : "关闭辅助面板"}
        aria-hidden={!hasMobileOverlayOpen}
        tabIndex={hasMobileOverlayOpen ? 0 : -1}
      />

      <section className={`${styles.reader} ${isDashboardChatMode ? styles.readerHidden : ""}`} ref={readerRef}>
        <header className={`${styles.readerHeader} ${isScrolled ? styles.readerHeaderScrolled : ""}`}>
          <div className={styles.readerActions}>
            <button
              type="button"
              className={`${styles.iconButton} ${styles.sidebarToggleBtn} ${isSidebarOpen ? styles.iconButtonActive : ""}`}
              onClick={() => {
                if (isMobileViewport) {
                  setMobileAssistantPanelOpen(false);
                  setMobileSidebarOpen((open) => !open);
                } else {
                  setSidebarVisible((visible) => !visible);
                }
              }}
              aria-pressed={isSidebarOpen}
              aria-label={isSidebarOpen ? "隐藏目录" : "显示目录"}
              title={isSidebarOpen ? "隐藏目录" : "显示目录"}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="9" y1="3" x2="9" y2="21" />
              </svg>
              {globalGitPending !== null && globalGitPending > 0 && !isSidebarOpen && (
                <span className={styles.sidebarToggleBadge} aria-hidden="true" />
              )}
            </button>
          </div>
          <div className={styles.noteMeta}>
            <span>{activePath ? stripNoteExtension(activePath.split("/").pop() ?? activePath) : "智能仪表盘"}</span>
            {note ? (
              <>
                <span>{updatedAt}</span>
              </>
            ) : null}
            {!isEditing && hasGitChanges && note ? (
              <button
                type="button"
                className={styles.gitChangeDot}
                onClick={() => {
                  if (isMobileViewport) setMobileAssistantPanelOpen(true);
                  else setAssistantPanelVisible(true);
                  setPanelTab("git");
                }}
                title="有未提交的改动，点击查看"
                aria-label="有未提交的改动，点击查看"
              >
                <span className={styles.gitChangeDotIndicator} aria-hidden="true" />
                未同步
              </button>
            ) : null}
          </div>
          <div className={styles.readerActions}>
            {savedFlash ? (
              <span className={styles.savedHint}>已保存</span>
            ) : null}
            {!isEditing ? (
              <button
                type="button"
                className={styles.shareButton}
                onClick={handleOpenShareDialog}
                disabled={!note}
                aria-label="分享当前文章"
                title="分享当前文章"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M7.2 11.2 12 6.4l4.8 4.8" />
                  <path d="M12 6.4v11.2" />
                  <path d="M5 15.5v3.1c0 .8.6 1.4 1.4 1.4h11.2c.8 0 1.4-.6 1.4-1.4v-3.1" />
                </svg>
              </button>
            ) : null}
            {/* 大纲按钮 */}
            <button
              type="button"
              className={`${styles.editBtn} ${isAssistantPanelOpen && panelTab === "toc" ? styles.editBtnActive : ""}`}
              onClick={handleTocToggle}
              disabled={!note || /\.html?$/i.test(note.path ?? "")}
              aria-label="大纲"
              title="大纲"
            >
              <svg viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">
                <path fill="currentColor" d="M141.019429 7.606857c21.869714 0 40.374857 7.387429 55.588571 22.235429 15.213714 14.848 22.820571 33.133714 22.820571 55.003428v59.684572c0 21.869714-7.606857 40.374857-22.820571 55.588571a75.629714 75.629714 0 0 1-55.588571 22.820572H78.994286c-21.065143 0-39.204571-7.606857-54.418286-22.820572a75.629714 75.629714 0 0 1-22.820571-55.588571V84.845714c0-21.869714 7.606857-40.228571 22.820571-55.003428A75.337143 75.337143 0 0 1 78.994286 7.606857h62.025143z m802.816 0c21.065143 0 39.204571 7.387429 54.418285 22.235429 15.213714 14.848 22.820571 33.133714 22.820572 55.003428v59.684572c0 21.869714-7.606857 40.374857-22.820572 55.588571a74.313143 74.313143 0 0 1-54.418285 22.820572H444.123429c-21.869714 0-40.374857-7.606857-55.588572-22.820572A75.629714 75.629714 0 0 1 365.714286 144.530286V84.845714c0-21.869714 7.606857-40.228571 22.820571-55.003428 15.213714-14.848 33.718857-22.235429 55.588572-22.235429h499.712zM141.019429 371.565714c21.869714 0 40.374857 7.606857 55.588571 22.820572 15.213714 15.213714 22.820571 33.718857 22.820571 55.588571v59.684572c0 21.065143-7.606857 39.204571-22.820571 54.418285a75.629714 75.629714 0 0 1-55.588571 22.820572H78.994286c-21.065143 0-39.204571-7.606857-54.418286-22.820572a74.313143 74.313143 0 0 1-22.820571-54.418285v-59.684572c0-21.869714 7.606857-40.374857 22.820571-55.588571 15.213714-15.213714 33.353143-22.820571 54.418286-22.820572h62.025143z m802.816 0c21.065143 0 39.204571 7.606857 54.418285 22.820572 15.213714 15.213714 22.820571 33.718857 22.820572 55.588571v59.684572c0 21.065143-7.606857 39.204571-22.820572 54.418285a74.313143 74.313143 0 0 1-54.418285 22.820572H444.123429c-21.869714 0-40.374857-7.606857-55.588572-22.820572A74.313143 74.313143 0 0 1 365.714286 509.659429v-59.684572c0-21.869714 7.606857-40.374857 22.820571-55.588571 15.213714-15.213714 33.718857-22.820571 55.588572-22.820572h499.712zM141.019429 736.694857c21.869714 0 40.374857 7.606857 55.588571 22.820572 15.213714 15.213714 22.820571 33.353143 22.820571 54.418285v59.684572c0 21.869714-7.606857 40.374857-22.820571 55.588571a75.629714 75.629714 0 0 1-55.588571 22.820572H78.994286c-21.065143 0-39.204571-7.606857-54.418286-22.820572a75.629714 75.629714 0 0 1-22.820571-55.588571v-59.684572c0-21.065143 7.606857-39.204571 22.820571-54.418285 15.213714-15.213714 33.353143-22.820571 54.418286-22.820572h62.025143z m802.816 0c21.065143 0 39.204571 7.606857 54.418285 22.820572 15.213714 15.213714 22.820571 33.353143 22.820572 54.418285v59.684572c0 21.869714-7.606857 40.374857-22.820572 55.588571a74.313143 74.313143 0 0 1-54.418285 22.820572H444.123429c-21.869714 0-40.374857-7.606857-55.588572-22.820572a75.629714 75.629714 0 0 1-22.820571-55.588571v-59.684572c0-21.065143 7.606857-39.204571 22.820571-54.418285 15.213714-15.213714 33.718857-22.820571 55.588572-22.820572h499.712z" />
              </svg>
            </button>
            {/* 阅读 / 编辑 切换按钮 */}
            <button
              type="button"
              className={`${styles.editBtn} ${isEditing ? styles.editBtnActive : ""}`}
              onClick={() => void handleEditToggle()}
              disabled={!note || /\.html?$/i.test(note.path ?? "")}
              aria-label={isEditing ? "退出编辑" : "编辑笔记"}
              title={isEditing ? "退出编辑模式" : "编辑笔记"}
            >
              {isEditing ? (
                /* 翻开的书 — 回到阅读模式 */
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                  <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                </svg>
              ) : (
                /* 铅笔图标 — 进入编辑模式 */
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
                </svg>
              )}
            </button>
            <button
              type="button"
              className={`${styles.iconButton} ${styles.claudeHeaderBtn} ${isAssistantPanelOpen ? styles.iconButtonActive : ""}`}
              onClick={handleClaudeToggle}
              aria-pressed={isAssistantPanelOpen}
              aria-label="AI 助手"
              title="AI 助手"
            >
              <span aria-hidden="true">✦</span>
            </button>
          </div>
        </header>

        {/* 编辑模式 — CodeMirror inline markdown 编辑 */}
        {isEditing ? (
          <div
            className={styles.editorPane}
            style={editorMinHeight ? { minHeight: editorMinHeight } : undefined}
          >
            <NotesEditor
              value={editContent}
              onChange={handleEditorChange}
              onReady={() => {
                // CM 渲染完毕，内容高度已由 CM 自身撑起，释放占位高度
                setEditorMinHeight(0);
              }}
            />
          </div>
        ) : (
          <article
            key={note?.path || "empty"}
            className={`${styles.document} ${!note || /\.html?$/i.test(note.path) ? styles.documentHtml : ""}`}
            style={!note || /\.html?$/i.test(note.path) ? { width: '100%', maxWidth: '100%', margin: 0, padding: 0, borderRadius: 0, background: 'transparent', border: 'none', boxShadow: 'none' } : undefined}
          >
            {noteState === "loading" ? (
              <div className={styles.documentState}>正在加载文件...</div>
            ) : null}

            {noteState === "error" ? (
              <div className={styles.documentState}>{error ?? "Markdown 加载失败"}</div>
            ) : null}

            {noteState === "ready" && note ? (
              /\.html?$/i.test(note.path) ? (
                <NotesHtml html={note.content} />
              ) : (
                <NotesMarkdown
                  markdown={note.content}
                  currentPath={note.path}
                  noteIndex={noteIndex}
                  onNavigate={handleMarkdownNavigate}
                />
              )
            ) : null}

            {treeState === "ready" && files.length === 0 ? (
              <div className={styles.documentState}>知识库中没有可显示的文件。</div>
            ) : null}

            {treeState === "ready" && files.length > 0 && !note ? (
              <NotesDashboard 
                files={files} 
                onSelectNote={handleSelect} 
                onAskAI={(query?: string) => {
                  setIsDashboardChatActive(true);
                  if (isMobileViewport) {
                    setMobileSidebarOpen(false);
                    setMobileAssistantPanelOpen(true);
                  } else {
                    setAssistantPanelVisible(true);
                  }
                  setPanelTab("claude");
                  
                  if (query) {
                    setTimeout(() => {
                      claudeFrameRef.current?.contentWindow?.postMessage(
                        { type: "note-ask", text: query },
                        window.location.origin,
                      );
                    }, 50);
                  }
                }} 
                onNewNote={openNewNote} 
              />
            ) : null}
          </article>
        )}
      </section>

      {shareModalOpen ? (
        <div className={styles.shareOverlay} role="presentation" onMouseDown={() => setShareModalOpen(false)}>
          <section
            className={styles.shareDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="share-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className={styles.shareDialogHeader}>
              <div>
                <p className={styles.shareDialogEyebrow}>公开分享</p>
                <h2 id="share-dialog-title" className={styles.shareDialogTitle}>
                  当前文章
                </h2>
              </div>
              <button
                type="button"
                className={styles.shareDialogClose}
                onClick={() => setShareModalOpen(false)}
                aria-label="关闭分享窗口"
                title="关闭分享窗口"
              >
                <span aria-hidden="true">×</span>
              </button>
            </header>

            <div className={styles.shareDialogBody}>
              <p className={styles.shareDialogNote}>{note?.path ?? "未选择文件"}</p>

              {shareState === "loading" ? (
                <div className={styles.shareDialogState}>正在读取分享状态...</div>
              ) : null}

              {shareState !== "loading" && shareUrl ? (
                <label className={styles.shareLinkField}>
                  <span>分享链接</span>
                  <input value={shareUrl} readOnly onFocus={(event) => event.currentTarget.select()} />
                </label>
              ) : null}

              {shareState !== "loading" && !shareUrl ? (
                <div className={styles.shareDialogEmpty}>当前文章还没有公开分享链接。</div>
              ) : null}

              {shareMessage ? (
                <p className={`${styles.shareDialogMessage} ${shareState === "error" ? styles.shareDialogError : ""}`}>
                  {shareMessage}
                </p>
              ) : null}
            </div>

            <footer className={styles.shareDialogActions}>
              {shareUrl ? (
                <>
                  <button
                    type="button"
                    className={styles.shareSecondaryButton}
                    onClick={handleCopyShare}
                    disabled={shareState === "copying" || shareState === "revoking"}
                  >
                    {shareState === "copying" ? "复制中" : "复制链接"}
                  </button>
                  <button
                    type="button"
                    className={styles.shareDangerButton}
                    onClick={handleRevokeShare}
                    disabled={shareState === "revoking" || shareState === "copying"}
                  >
                    {shareState === "revoking" ? "取消中" : "取消分享"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className={styles.sharePrimaryButton}
                  onClick={handleCreateShare}
                  disabled={shareState === "creating" || shareState === "loading"}
                >
                  {shareState === "creating" ? "生成中" : "生成分享链接"}
                </button>
              )}
            </footer>
          </section>
        </div>
      ) : null}

      <aside
        className={`${styles.assistantPanel} ${isAssistantPanelOpen ? "" : styles.assistantPanelHidden} ${isDashboardChatMode ? styles.assistantPanelCenter : ""}`}
        aria-label="辅助面板"
        aria-hidden={!isAssistantPanelOpen}
        inert={!isAssistantPanelOpen}
      >
        {!isDashboardChatMode && (
          <>
            <button
              type="button"
              className={styles.assistantPanelResizer}
              onPointerDown={(event) => {
                event.preventDefault();
                setAssistantPanelVisible(true);
                setIsResizingAssistantPanel(true);
              }}
              onDoubleClick={() => setAssistantPanelWidth(DEFAULT_ASSISTANT_PANEL_WIDTH)}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  setAssistantPanelWidth((width) => clamp(width + 24, MIN_ASSISTANT_PANEL_WIDTH, MAX_ASSISTANT_PANEL_WIDTH));
                }
                if (event.key === "ArrowRight") {
                  event.preventDefault();
                  setAssistantPanelWidth((width) => clamp(width - 24, MIN_ASSISTANT_PANEL_WIDTH, MAX_ASSISTANT_PANEL_WIDTH));
                }
              }}
              aria-label="调整辅助面板宽度"
              title="拖拽调整面板宽度，双击恢复默认"
              tabIndex={!isMobileViewport && isAssistantPanelOpen ? 0 : -1}
            />
            <header className={`${styles.assistantPanelHeader} ${styles.assistantPanelHeaderLight}`}>
              <div className={styles.assistantPanelTabs}>
                <button
                  type="button"
                  className={`${styles.assistantPanelTab} ${panelTab === "toc" ? styles.assistantPanelTabActive : ""}`}
                  onClick={() => setPanelTab("toc")}
                  tabIndex={isAssistantPanelOpen ? 0 : -1}
                >
                  大纲
                </button>
                <button
                  type="button"
                  className={`${styles.assistantPanelTab} ${panelTab === "claude" ? styles.assistantPanelTabActive : ""}`}
                  onClick={() => setPanelTab("claude")}
                  tabIndex={isAssistantPanelOpen ? 0 : -1}
                >
                  ✦ Claude
                </button>
                <button
                  type="button"
                  className={`${styles.assistantPanelTab} ${panelTab === "git" ? styles.assistantPanelTabActive : ""}`}
                  onClick={() => setPanelTab("git")}
                  tabIndex={isAssistantPanelOpen ? 0 : -1}
                >
                  ↑↓ 同步
                </button>
              </div>
              <div className={styles.assistantPanelControls}>
                <button
                  type="button"
                  className={styles.assistantPanelClose}
                  onClick={() => {
                    if (isMobileViewport) {
                      setMobileAssistantPanelOpen(false);
                    } else {
                      setAssistantPanelVisible(false);
                    }
                  }}
                  aria-label="隐藏面板"
                  title="隐藏面板"
                  tabIndex={isAssistantPanelOpen ? 0 : -1}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>
            </header>
          </>
        )}

        {isDashboardChatMode && (
          <header className={styles.dashboardChatHeader}>
            <button
              className={styles.dashboardChatBackBtn}
              onClick={() => {
                setAssistantPanelVisible(false);
                setIsDashboardChatActive(false);
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: "18px", height: "18px" }}>
                <line x1="19" y1="12" x2="5" y2="12" />
                <polyline points="12 19 5 12 12 5" />
              </svg>
              <span>返回仪表盘</span>
            </button>
          </header>
        )}
        {panelTab === "toc" ? (
          <ArticleToc headings={articleTocEntries} activeSlug={activeTocSlug} onSelect={handleSelectTocHeading} />
        ) : null}
        {panelTab === "git" ? (
          <NotesGit onOpenFile={(path) => {
            // 优先精确匹配文件树，再大小写不敏感匹配，确保路径有效
            const exactMatch = files.find((f) => f.path === path);
            const resolvedPath = exactMatch
              ? path
              : (files.find((f) => f.path.toLowerCase() === path.toLowerCase())?.path ?? path);
            void loadNote(resolvedPath);
          }} />
        ) : null}
        <iframe
          key="claude-frame"
          ref={claudeFrameRef}
          className={`${styles.assistantPanelFrame} ${panelTab !== "claude" ? styles.assistantPanelFrameHidden : ""}`}
          title="Claude Chat"
          src="/notes-claude/?v=2"
          allow="clipboard-read; clipboard-write"
          referrerPolicy="same-origin"
          tabIndex={isAssistantPanelOpen && panelTab === "claude" ? 0 : -1}
          onLoad={() => {
            // Re-send the current note context once the iframe is ready.
            // The useEffect fires when activePath changes, but the iframe may
            // still be loading at that point and miss the message.
            if (activePathRef.current) {
              claudeFrameRef.current?.contentWindow?.postMessage(
                { type: "note-context", filePath: activePathRef.current },
                window.location.origin,
              );
            }
          }}
        />
      </aside>

      {/* 移动端 AI 助手悬浮按钮：仅在打开笔记时显示 */}
      {note ? <button
        type="button"
        className={`${styles.claudeFab} ${mobileAssistantPanelOpen ? styles.claudeFabHidden : ""} ${isAssistantPanelOpen ? styles.claudeFabActive : ""}`}
        onClick={handleClaudeToggle}
        aria-label="AI 助手"
        title="AI 助手"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <defs>
            <linearGradient id="ai-grad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#4F46E5" />
              <stop offset="50%" stopColor="#9333EA" />
              <stop offset="100%" stopColor="#E11D48" />
            </linearGradient>
          </defs>
          <path d="M11.5 2.5a.5.5 0 0 1 1 0v4.293a.5.5 0 0 0 .146.353l3.036 3.036a.5.5 0 0 1 0 .707l-3.036 3.035a.5.5 0 0 0-.146.354V18.5a.5.5 0 0 1-1 0v-4.293a.5.5 0 0 0-.146-.354l-3.036-3.035a.5.5 0 0 1 0-.707l3.036-3.036a.5.5 0 0 0 .146-.353V2.5z" fill="url(#ai-grad)"/>
          <path d="M19.5 13.5a.5.5 0 0 1 1 0v1.793a.5.5 0 0 0 .146.353l1.236 1.236a.5.5 0 0 1 0 .707l-1.236 1.235a.5.5 0 0 0-.146.354V21.5a.5.5 0 0 1-1 0v-1.793a.5.5 0 0 0-.146-.354l-1.236-1.235a.5.5 0 0 1 0-.707l1.236-1.236a.5.5 0 0 0 .146-.353V13.5z" fill="url(#ai-grad)"/>
        </svg>
        <span>Ask AI</span>
      </button> : null}

      {/* ── 新建笔记对话框 ─────────────────────────────── */}
      {newNoteOpen ? (
        <div
          className={styles.newNoteBackdrop}
          onClick={(e) => { if (e.target === e.currentTarget) setNewNoteOpen(false); }}
          role="presentation"
        >
          <div
            className={styles.newNoteDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-note-heading"
          >
            <h2 id="new-note-heading" className={styles.newNoteHeading}>新建笔记</h2>

            <label className={styles.newNoteLabel} htmlFor="new-note-title">标题</label>
            <input
              id="new-note-title"
              ref={newNoteTitleRef}
              className={styles.newNoteInput}
              type="text"
              placeholder="笔记标题"
              value={newNoteTitle}
              onChange={(e) => { setNewNoteTitle(e.target.value); setNewNoteError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") void handleCreateNote(); }}
              autoComplete="off"
              spellCheck={false}
            />

            <label className={styles.newNoteLabel} htmlFor="new-note-folder">位置</label>
            <select
              id="new-note-folder"
              className={styles.newNoteSelect}
              value={newNoteFolder}
              onChange={(e) => setNewNoteFolder(e.target.value)}
            >
              {tree ? collectFolders(tree).map((f) => (
                <option key={f} value={f}>{f || "/ 根目录"}</option>
              )) : null}
            </select>

            {newNoteError ? <p className={styles.newNoteError}>{newNoteError}</p> : null}

            <div className={styles.newNoteActions}>
              <button
                type="button"
                className={styles.newNoteCancelBtn}
                onClick={() => setNewNoteOpen(false)}
                disabled={newNoteLoading}
              >
                取消
              </button>
              <button
                type="button"
                className={styles.newNoteConfirmBtn}
                onClick={() => void handleCreateNote()}
                disabled={newNoteLoading}
              >
                {newNoteLoading ? "创建中…" : "创建"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

    </main>
  );
}

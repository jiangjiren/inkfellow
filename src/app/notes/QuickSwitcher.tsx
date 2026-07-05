"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { NotesFileNode, NotesSearchHit, NotesSearchResponse } from "@/lib/notesTypes";
import { stripNoteExtension } from "./noteFileUtils";
import styles from "./notes.module.css";

type QuickSwitcherProps = {
  open: boolean;
  files: NotesFileNode[];
  onClose: () => void;
  onSelect: (path: string) => void;
};

type Row = {
  path: string;
  title: string;
  meta: string;
};

const IMAGE_EXTS = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico|avif|tiff?)$/i;

const getFolderLabel = (path: string) =>
  path.includes("/") ? path.split("/").slice(0, -1).pop() ?? "" : "";

/**
 * ⌘K 快速打开浮层：空查询显示最近编辑，输入后走全文搜索。
 * 搜索请求/防抖逻辑与侧栏搜索一致（220ms + abort）。
 */
export default function QuickSwitcher({ open, files, onClose, onSelect }: QuickSwitcherProps) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<NotesSearchHit[]>([]);
  const [searchState, setSearchState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const trimmedQuery = query.trim();

  const recentRows = useMemo<Row[]>(
    () =>
      [...files]
        .filter((f) => !IMAGE_EXTS.test(f.name))
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, 8)
        .map((f) => ({
          path: f.path,
          title: stripNoteExtension(f.name),
          meta: getFolderLabel(f.path),
        })),
    [files],
  );

  const rows = useMemo<Row[]>(() => {
    if (!trimmedQuery) {
      return recentRows;
    }
    return hits.map((hit) => ({
      path: hit.path,
      title: stripNoteExtension(hit.name),
      meta: [getFolderLabel(hit.path), hit.snippet].filter(Boolean).join(" · "),
    }));
  }, [trimmedQuery, recentRows, hits]);

  // 打开时重置并聚焦；关闭后不保留上次查询，符合 Spotlight 习惯
  useEffect(() => {
    if (open) {
      setQuery("");
      setHits([]);
      setSearchState("idle");
      setActiveIndex(0);
      const timer = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(timer);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !trimmedQuery) {
      setHits([]);
      setSearchState("idle");
      return;
    }
    setSearchState("loading");
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: trimmedQuery });
        const response = await fetch(`/api/notes/search?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error("搜索失败");
        }
        const payload = (await response.json()) as NotesSearchResponse;
        setHits(payload.hits);
        setSearchState("ready");
        setActiveIndex(0);
      } catch {
        if (!controller.signal.aborted) {
          setHits([]);
          setSearchState("error");
        }
      }
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, trimmedQuery]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!open) {
    return null;
  }

  const commit = (row: Row | undefined) => {
    if (row) {
      onSelect(row.path);
    }
  };

  return (
    <div
      className={styles.quickSwitcherOverlay}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={styles.quickSwitcherPanel} role="dialog" aria-modal="true" aria-label="快速打开">
        <div className={styles.quickSwitcherInputRow}>
          <span className={styles.searchIcon} aria-hidden="true" />
          <input
            ref={inputRef}
            className={styles.quickSwitcherInput}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
                return;
              }
              if (rows.length === 0) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((current) => (current + 1) % rows.length);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((current) => (current <= 0 ? rows.length - 1 : current - 1));
              } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                commit(rows[activeIndex] ?? rows[0]);
              }
            }}
            placeholder="搜索笔记标题和正文…"
            autoComplete="off"
            spellCheck={false}
            aria-label="快速打开笔记"
          />
        </div>
        <div className={styles.quickSwitcherList} ref={listRef}>
          {!trimmedQuery && rows.length > 0 ? (
            <p className={styles.quickSwitcherGroupLabel}>最近编辑</p>
          ) : null}
          {searchState === "loading" ? (
            <p className={styles.quickSwitcherState}>正在搜索…</p>
          ) : null}
          {searchState === "error" ? (
            <p className={styles.quickSwitcherState}>搜索失败，请重试</p>
          ) : null}
          {trimmedQuery && searchState === "ready" && rows.length === 0 ? (
            <p className={styles.quickSwitcherState}>未找到匹配的笔记</p>
          ) : null}
          {rows.map((row, index) => (
            <button
              key={row.path}
              type="button"
              data-index={index}
              className={`${styles.quickSwitcherItem} ${index === activeIndex ? styles.quickSwitcherItemActive : ""}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => commit(row)}
              title={row.path}
            >
              <span className={styles.quickSwitcherItemTitle}>{row.title}</span>
              {row.meta ? <span className={styles.quickSwitcherItemMeta}>{row.meta}</span> : null}
            </button>
          ))}
        </div>
        <footer className={styles.quickSwitcherHint} aria-hidden="true">
          <span>↑↓ 选择</span>
          <span>↵ 打开</span>
          <span>esc 关闭</span>
        </footer>
      </div>
    </div>
  );
}

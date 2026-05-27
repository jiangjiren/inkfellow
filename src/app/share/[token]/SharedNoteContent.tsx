"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import NotesMarkdown from "@/app/notes/NotesMarkdown";
import type { TocEntry } from "./tocUtils";
import styles from "./share.module.css";

type SharedNoteContentProps = {
  markdown: string;
  notePath: string;
  token: string;
  headings: TocEntry[];
};

export default function SharedNoteContent({ markdown, notePath, token, headings }: SharedNoteContentProps) {
  const [tocOpen, setTocOpen] = useState(false);
  const [btnVisible, setBtnVisible] = useState(true);
  const lastScrollY = useRef(0);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (headings.length === 0) return;
    const onScroll = () => {
      const y = window.scrollY;
      const delta = y - lastScrollY.current;
      lastScrollY.current = y;
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
      if (delta > 4 && y > 100) {
        setBtnVisible(false);
        scrollTimer.current = setTimeout(() => setBtnVisible(true), 1500);
      } else if (delta < -4 || y <= 100) {
        setBtnVisible(true);
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
    };
  }, [headings.length]);

  const makeSharedAssetHref = useCallback(
    (assetPath: string) => {
      const params = new URLSearchParams({ token, path: assetPath });
      return `/api/share/asset?${params.toString()}`;
    },
    [token],
  );

  const handleTocClick = (slug: string) => {
    document.getElementById(slug)?.scrollIntoView({ behavior: "smooth" });
    setTocOpen(false);
  };

  return (
    <div className={styles.shareLayout}>
      {/* Mobile pill toggle */}
      {headings.length > 0 && (
        <button
          className={[
            styles.tocToggle,
            tocOpen ? styles.tocToggleOpen : "",
            !btnVisible ? styles.tocToggleHidden : "",
          ].filter(Boolean).join(" ")}
          onClick={() => setTocOpen((v) => !v)}
          aria-label={tocOpen ? "关闭目录" : "显示目录"}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="15" y2="12" />
            <line x1="3" y1="18" x2="18" y2="18" />
          </svg>
          <span className={styles.tocToggleLabel}>目录</span>
        </button>
      )}

      {/* Mobile backdrop */}
      {headings.length > 0 && (
        <div
          className={`${styles.tocBackdrop}${tocOpen ? ` ${styles.tocBackdropVisible}` : ""}`}
          onClick={() => setTocOpen(false)}
        />
      )}

      {/* Mobile bottom sheet */}
      {headings.length > 0 && (
        <nav
          className={`${styles.tocSidebar}${tocOpen ? ` ${styles.tocSidebarOpen}` : ""}`}
          aria-label="文档目录"
        >
          <div className={styles.tocHeader}>
            <span className={styles.tocTitle}>目录</span>
            <button className={styles.tocClose} onClick={() => setTocOpen(false)} aria-label="关闭目录">
              ✕
            </button>
          </div>
          <ul className={styles.tocList}>
            {headings.map((h, i) => (
              <li key={`${h.slug}-${i}`} className={styles.tocItem}>
                <button className={styles.tocLink} onClick={() => handleTocClick(h.slug)}>
                  {h.text}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}

      <NotesMarkdown
        markdown={markdown}
        currentPath={notePath}
        assetHrefFactory={makeSharedAssetHref}
        allowInternalNoteLinks={false}
      />
    </div>
  );
}

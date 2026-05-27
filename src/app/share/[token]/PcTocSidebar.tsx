"use client";

import { useEffect, useState } from "react";
import type { TocEntry } from "./tocUtils";
import styles from "./share.module.css";

export default function PcTocSidebar({ headings }: { headings: TocEntry[] }) {
  const [activeSlug, setActiveSlug] = useState(headings[0]?.slug ?? "");
  const minLevel = headings.length > 0 ? Math.min(...headings.map((h) => h.level)) : 0;

  useEffect(() => {
    const onScroll = () => {
      const threshold = window.scrollY + window.innerHeight * 0.22;
      let current = headings[0]?.slug ?? "";
      for (const h of headings) {
        const el = document.getElementById(h.slug);
        if (el && el.getBoundingClientRect().top + window.scrollY <= threshold) {
          current = h.slug;
        }
      }
      setActiveSlug(current);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    const t = setTimeout(onScroll, 80);
    return () => {
      window.removeEventListener("scroll", onScroll);
      clearTimeout(t);
    };
  }, [headings]);

  const handleClick = (slug: string) => {
    document.getElementById(slug)?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <nav className={styles.pcToc} aria-label="文档目录">
      <ul className={styles.pcTocList}>
        {headings.map((h, i) => (
          <li key={`${h.slug}-${i}`}>
            <button
              className={`${styles.pcTocLink}${h.level > minLevel ? ` ${styles.pcTocLinkSub}` : ""}${activeSlug === h.slug ? ` ${styles.pcTocLinkActive}` : ""}`}
              onClick={() => handleClick(h.slug)}
            >
              {h.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

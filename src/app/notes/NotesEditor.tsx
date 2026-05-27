"use client";

import { useEffect, useRef } from "react";
import styles from "./notes.module.css";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── CDN 资源 ────────────────────────────────────────────────────
const CDN_CSS = "https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.css";
const CDN_JS  = "https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.js";
const CDN_MD  = "https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/markdown/markdown.min.js";

function loadStyle(href: string) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const el = document.createElement("link");
  el.rel = "stylesheet";
  el.href = href;
  document.head.appendChild(el);
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const el = document.createElement("script");
    el.src = src;
    el.onload  = () => resolve();
    el.onerror = reject;
    document.head.appendChild(el);
  });
}

// ── 组件 Props ────────────────────────────────────────────────────
interface NotesEditorProps {
  value: string;
  onChange: (value: string) => void;
}

export default function NotesEditor({ value, onChange }: NotesEditorProps) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const cmRef         = useRef<any>(null);
  const onChangeRef   = useRef(onChange);

  // 始终持有最新的 onChange，避免 stale closure
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  // ── 初始化 CodeMirror（只执行一次）─────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    loadStyle(CDN_CSS);

    async function init() {
      await loadScript(CDN_JS);
      await loadScript(CDN_MD);
      if (cancelled || !containerRef.current || cmRef.current) return;

      const CM = (window as any).CodeMirror;
      if (!CM) return;

      const cm = CM(containerRef.current, {
        value,
        mode: "markdown",
        lineWrapping: true,
        autofocus: true,
        indentUnit: 2,
        tabSize: 2,
        extraKeys: {
          // Enter 时继续 markdown 列表
          "Enter": "newlineAndIndentContinueMarkdownList",
        },
      });

      cm.on("change", () => {
        onChangeRef.current(cm.getValue());
      });

      cmRef.current = cm;
    }

    void init();
    return () => { cancelled = true; };
  }, []); // 故意只跑一次

  // ── 外部 value 变化时同步（切换笔记）──────────────────────────
  useEffect(() => {
    const cm = cmRef.current;
    if (!cm) return;
    if (cm.getValue() === value) return;
    // 保留光标位置
    const cursor = cm.getCursor();
    cm.setValue(value);
    cm.setCursor(cursor);
  }, [value]);

  return <div ref={containerRef} className={styles.cmContainer} />;
}

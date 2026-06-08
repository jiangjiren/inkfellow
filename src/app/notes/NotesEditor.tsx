"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import styles from "./notes.module.css";

/* eslint-disable @typescript-eslint/no-explicit-any */

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

interface NotesEditorProps {
  value: string;
  onChange: (value: string) => void;
  onReady?: () => void;
}

export interface NotesEditorHandle {
  /** 聚焦编辑器并把光标移到末尾 */
  focus: () => void;
}

const NotesEditor = forwardRef<NotesEditorHandle, NotesEditorProps>(
  function NotesEditor({ value, onChange, onReady }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const cmRef        = useRef<any>(null);
    const onChangeRef  = useRef(onChange);
    const onReadyRef   = useRef(onReady);

    useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
    useEffect(() => { onReadyRef.current = onReady; }, [onReady]);

    // 向父组件暴露 focus()
    useImperativeHandle(ref, () => ({
      focus() {
        const cm = cmRef.current;
        if (!cm) return;
        cm.focus();
        const lastLine = cm.lastLine();
        cm.setCursor({ line: lastLine, ch: cm.getLine(lastLine).length });
      },
    }), []);

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
          autofocus: false,
          indentUnit: 2,
          tabSize: 2,
          extraKeys: { "Enter": "newlineAndIndentContinueMarkdownList" },
        });

        cm.on("change", () => { onChangeRef.current(cm.getValue()); });
        cmRef.current = cm;

        (cm.getInputField() as HTMLElement).focus({ preventScroll: true });
        onReadyRef.current?.();
      }

      void init();
      return () => { cancelled = true; };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      const cm = cmRef.current;
      if (!cm) return;
      if (cm.getValue() === value) return;
      const cursor = cm.getCursor();
      cm.setValue(value);
      cm.setCursor(cursor);
    }, [value]);

    // 点 cmContainer 的内边距区域（CM 文字以外）→ 重新聚焦到末尾
    const handleContainerMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
      const cm = cmRef.current;
      if (!cm) return;
      if (event.target !== containerRef.current) return;
      event.preventDefault();
      cm.focus();
      const lastLine = cm.lastLine();
      cm.setCursor({ line: lastLine, ch: cm.getLine(lastLine).length });
    };

    return (
      <div
        ref={containerRef}
        className={styles.cmContainer}
        onMouseDown={handleContainerMouseDown}
      />
    );
  }
);

export default NotesEditor;

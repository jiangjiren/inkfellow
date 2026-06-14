"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import CodeMirror from "codemirror";
import "codemirror/lib/codemirror.css";
import "codemirror/mode/markdown/markdown";
import "codemirror/addon/edit/continuelist";
import "codemirror/addon/hint/show-hint";
import "codemirror/addon/hint/show-hint.css";
import styles from "./notes.module.css";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface NotesEditorProps {
  value: string;
  onChange: (value: string) => void;
  onReady?: () => void;
  noteNames?: string[];
}

export interface NotesEditorHandle {
  /** 聚焦编辑器并把光标移到末尾 */
  focus: () => void;
}

function makeWikiHint(noteNames: string[]) {
  return function wikiHint(cm: any) {
    const cursor = cm.getCursor();
    const line: string = cm.getLine(cursor.line);
    const before = line.slice(0, cursor.ch);
    const openIdx = before.lastIndexOf("[[");
    if (openIdx === -1 || before.slice(openIdx + 2).includes("]]")) return null;

    const query = before.slice(openIdx + 2).toLowerCase();
    const list = noteNames
      .filter((n) => n.toLowerCase().includes(query))
      .slice(0, 20)
      .map((n) => ({
        text: `[[${n}]]`,
        displayText: n,
        // Replace from the opening [[ to cursor
        from: { line: cursor.line, ch: openIdx },
        to: cursor,
      }));

    if (list.length === 0) return null;
    return { list, from: { line: cursor.line, ch: openIdx }, to: cursor };
  };
}

const NotesEditor = forwardRef<NotesEditorHandle, NotesEditorProps>(
  function NotesEditor({ value, onChange, onReady, noteNames = [] }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const cmRef        = useRef<any>(null);
    const onChangeRef  = useRef(onChange);
    const onReadyRef   = useRef(onReady);
    const noteNamesRef = useRef(noteNames);

    useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
    useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
    useEffect(() => { noteNamesRef.current = noteNames; }, [noteNames]);

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
      if (!containerRef.current || cmRef.current) return;

      const cm = (CodeMirror as any)(containerRef.current, {
        value,
        mode: "markdown",
        lineWrapping: true,
        autofocus: false,
        indentUnit: 2,
        tabSize: 2,
        extraKeys: {
          "Enter": "newlineAndIndentContinueMarkdownList",
          "Ctrl-Space": (instance: any) => instance.showHint({ completeSingle: false }),
        },
        hintOptions: {
          completeSingle: false,
          hint: (instance: any) => makeWikiHint(noteNamesRef.current)(instance),
        },
      });

      let wikiHintTimer: ReturnType<typeof setTimeout> | null = null;
      cm.on("change", (_inst: any, change: any) => {
        onChangeRef.current(cm.getValue());
        if (change.origin === "+input" || change.origin === "+delete") {
          const cur = cm.getCursor();
          const before: string = cm.getLine(cur.line).slice(0, cur.ch);
          const open = before.lastIndexOf("[[");
          const inWikiCtx = open !== -1 && !before.slice(open + 2).includes("]]");
          if (inWikiCtx) {
            if (wikiHintTimer) clearTimeout(wikiHintTimer);
            wikiHintTimer = setTimeout(() => {
              if (!cm.state.completionActive) {
                cm.showHint({ completeSingle: false });
              }
            }, 80);
          }
        }
      });

      cmRef.current = cm;
      (cm.getInputField() as HTMLElement).focus({ preventScroll: true });
      onReadyRef.current?.();

      return () => {
        if (wikiHintTimer) clearTimeout(wikiHintTimer);
        cmRef.current = null;
      };
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

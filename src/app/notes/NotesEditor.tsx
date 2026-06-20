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
  /** 在编辑器内按 Esc 时触发（退出编辑模式）；补全弹窗打开时 Esc 仍优先关弹窗 */
  onExit?: () => void;
  noteNames?: string[];
}

export interface NotesEditorHandle {
  /** 聚焦编辑器并把光标移到末尾 */
  focus: () => void;
}

type WikiContext = {
  openIndex: number;
  query: string;
};

const normalizeWikiSearch = (value: string) => value.normalize("NFKC").toLocaleLowerCase();

/** 同时识别半角 [[、全角 ［［，以及输入法可能产生的混合括号。 */
function findWikiContext(beforeCursor: string): WikiContext | null {
  const openerPattern = /[\[［]{2}/g;
  let opener: RegExpExecArray | null;
  let openIndex = -1;

  while ((opener = openerPattern.exec(beforeCursor)) !== null) {
    openIndex = opener.index;
  }
  if (openIndex === -1) return null;

  const query = beforeCursor.slice(openIndex + 2);
  if (/[\]］]{2}/.test(query)) return null;
  return { openIndex, query };
}

function makeWikiHint(noteNames: string[]) {
  return function wikiHint(cm: any) {
    const cursor = cm.getCursor();
    const line: string = cm.getLine(cursor.line);
    const before = line.slice(0, cursor.ch);
    const context = findWikiContext(before);
    if (!context) return { list: [], from: cursor, to: cursor };

    const normalizedQuery = normalizeWikiSearch(context.query);
    const list = [...new Set(noteNames)]
      .filter((name) => normalizeWikiSearch(name).includes(normalizedQuery))
      .sort((left, right) => {
        const a = normalizeWikiSearch(left);
        const b = normalizeWikiSearch(right);
        if (a === normalizedQuery && b !== normalizedQuery) return -1;
        if (b === normalizedQuery && a !== normalizedQuery) return 1;
        const aStarts = a.startsWith(normalizedQuery);
        const bStarts = b.startsWith(normalizedQuery);
        if (aStarts !== bStarts) return aStarts ? -1 : 1;
        return left.localeCompare(right, "zh-CN", { numeric: true, sensitivity: "base" });
      })
      .slice(0, 20)
      .map((name) => ({
        // 无论用户输入半角还是全角括号，落盘统一使用标准 Wiki Link 语法。
        text: `[[${name}]]`,
        displayText: name,
        from: { line: cursor.line, ch: context.openIndex },
        to: cursor,
      }));

    return {
      list,
      from: { line: cursor.line, ch: context.openIndex },
      to: cursor,
    };
  };
}

const NotesEditor = forwardRef<NotesEditorHandle, NotesEditorProps>(
  function NotesEditor({ value, onChange, onReady, onExit, noteNames = [] }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const cmRef        = useRef<any>(null);
    const onChangeRef  = useRef(onChange);
    const onReadyRef   = useRef(onReady);
    const onExitRef    = useRef(onExit);
    const noteNamesRef = useRef(noteNames);

    useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
    useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
    useEffect(() => { onExitRef.current = onExit; }, [onExit]);
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
          // 补全弹窗打开时让 show-hint 先吃掉 Esc（关弹窗）；否则退出编辑模式
          "Esc": (instance: any) =>
            instance.state.completionActive ? (CodeMirror as any).Pass : onExitRef.current?.(),
        },
        hintOptions: {
          completeSingle: false,
          hint: (instance: any) => makeWikiHint(noteNamesRef.current)(instance),
          container: containerRef.current,
        },
        // 编辑区由外层 reader 统一滚动，需渲染完整文档才能正确计算光标和补全框位置。
        viewportMargin: Infinity,
      });

      let wikiHintTimer: ReturnType<typeof setTimeout> | null = null;
      cm.on("change", (_inst: any, change: any) => {
        onChangeRef.current(cm.getValue());
        if (["+input", "*compose", "+delete", "paste", "cut", "undo", "redo"].includes(change.origin)) {
          const cur = cm.getCursor();
          const before: string = cm.getLine(cur.line).slice(0, cur.ch);
          const context = findWikiContext(before);
          if (context) {
            if (wikiHintTimer) clearTimeout(wikiHintTimer);
            wikiHintTimer = setTimeout(() => {
              if (!cm.state.completionActive) {
                cm.showHint({ completeSingle: false });
              }
            }, 80);
          } else {
            if (wikiHintTimer) clearTimeout(wikiHintTimer);
            wikiHintTimer = null;
            cm.closeHint();
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

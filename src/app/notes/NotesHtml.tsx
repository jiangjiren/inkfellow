"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./notes.module.css";

// Inject a script that (1) reports the document height to the parent frame and
// (2) intercepts Obsidian-style links (obsidian://open?...&file=xxx.md) so they
// navigate inside inkfellow instead of trying to launch the Obsidian desktop app
// (which the browser cannot do for the obsidian:// protocol).
const injectHeightScript = (html: string): string => {
  const script =
    `<script>(function(){` +
    `function r(){try{window.parent.postMessage({type:"iframeHeight",h:document.documentElement.scrollHeight},"*")}catch(e){}}` +
    `if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",r)}else{r()}` +
    `new ResizeObserver(r).observe(document.documentElement);` +
    `document.addEventListener("click",function(e){` +
    `var t=e.target&&e.target.nodeType===1?e.target:e.target&&e.target.parentElement;` +
    `var a=t&&t.closest?t.closest('a[href^="obsidian://"]'):null;` +
    `if(!a)return;e.preventDefault();` +
    // 不能用 URLSearchParams：这些 obsidian 链接的 file 值是原始 UTF-8 且含字面 '+'，
    // URLSearchParams 会把 '+' 当空格解码，导致带 '+' 的文件名跳转失败。手动取 file= 后的原始串。
    `try{var q=(a.getAttribute("href")||"").split("?")[1]||"";var file="";` +
    `var parts=q.split("&");for(var i=0;i<parts.length;i++){if(parts[i].indexOf("file=")===0){file=parts[i].slice(5);break;}}` +
    `if(/%[0-9A-Fa-f]{2}/.test(file)){try{file=decodeURIComponent(file);}catch(e2){}}` +
    `if(file){window.parent.postMessage({type:"note-navigate",path:file},"*");}}catch(err){}` +
    `},true);` +
    `})()</script>`;

  const bodyClose = html.lastIndexOf("</body>");
  if (bodyClose !== -1) return html.slice(0, bodyClose) + script + html.slice(bodyClose);

  const htmlClose = html.lastIndexOf("</html>");
  if (htmlClose !== -1) return html.slice(0, htmlClose) + script + html.slice(htmlClose);

  return html + script;
};

type NotesHtmlProps = {
  html: string;
  /** Open an Obsidian-style link (obsidian://...&file=xxx.md) inside inkfellow. */
  onNavigate?: (path: string) => void;
};

export default function NotesHtml({ html, onNavigate }: NotesHtmlProps) {
  const [height, setHeight] = useState(600);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const onNavigateRef = useRef(onNavigate);

  useEffect(() => {
    onNavigateRef.current = onNavigate;
  }, [onNavigate]);

  useEffect(() => {
    const handle = (ev: MessageEvent) => {
      if (ev.source !== iframeRef.current?.contentWindow) return;
      if (ev.data?.type === "iframeHeight" && typeof ev.data.h === "number") {
        setHeight(ev.data.h + 32);
      } else if (ev.data?.type === "note-navigate" && typeof ev.data.path === "string") {
        onNavigateRef.current?.(ev.data.path);
      }
    };
    window.addEventListener("message", handle);
    return () => window.removeEventListener("message", handle);
  }, []);

  // Re-query height after iframe width settles, in case the initial render
  // happened at a narrower width (before CSS applied) and locked in a stale height.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const ro = new ResizeObserver(() => {
      try {
        const doc = iframe.contentDocument;
        if (doc) setHeight(doc.documentElement.scrollHeight + 32);
      } catch { /* cross-origin; ignore */ }
    });
    ro.observe(iframe);
    return () => ro.disconnect();
  }, []);

  return (
    <iframe
      ref={iframeRef}
      className={styles.htmlFrame}
      srcDoc={injectHeightScript(html)}
      sandbox="allow-scripts allow-same-origin"
      allow="clipboard-write"
      width="100%"
      style={{ height, width: "100%" }}
      title="HTML 文件内容"
    />
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./notes.module.css";

// Inject a script that reports the document height to the parent frame via postMessage.
const injectHeightScript = (html: string): string => {
  const script =
    `<script>(function(){` +
    `function r(){try{window.parent.postMessage({type:"iframeHeight",h:document.documentElement.scrollHeight},"*")}catch(e){}}` +
    `if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",r)}else{r()}` +
    `new ResizeObserver(r).observe(document.documentElement);` +
    `})()</script>`;

  const bodyClose = html.lastIndexOf("</body>");
  if (bodyClose !== -1) return html.slice(0, bodyClose) + script + html.slice(bodyClose);

  const htmlClose = html.lastIndexOf("</html>");
  if (htmlClose !== -1) return html.slice(0, htmlClose) + script + html.slice(htmlClose);

  return html + script;
};

type NotesHtmlProps = {
  html: string;
};

export default function NotesHtml({ html }: NotesHtmlProps) {
  const [height, setHeight] = useState(600);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const handle = (ev: MessageEvent) => {
      if (ev.data?.type === "iframeHeight" && typeof ev.data.h === "number") {
        setHeight(ev.data.h + 32);
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

"use client";

import { useEffect, useState } from "react";
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

  useEffect(() => {
    const handle = (ev: MessageEvent) => {
      if (ev.data?.type === "iframeHeight" && typeof ev.data.h === "number") {
        setHeight(ev.data.h + 32);
      }
    };
    window.addEventListener("message", handle);
    return () => window.removeEventListener("message", handle);
  }, []);

  return (
    <iframe
      className={styles.htmlFrame}
      srcDoc={injectHeightScript(html)}
      sandbox="allow-scripts allow-same-origin"
      allow="clipboard-write"
      style={{ height }}
      title="HTML 文件内容"
    />
  );
}

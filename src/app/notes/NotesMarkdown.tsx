"use client";

/* eslint-disable @next/next/no-img-element */
import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from "react";
import { useEffect, useId, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { slugifyHeading } from "@/lib/noteToc";
import styles from "./notes.module.css";

type FrontMatterValue = string | string[] | number | boolean | null;
type FrontMatterData = Record<string, FrontMatterValue>;

const parseFrontMatter = (content: string): { data: FrontMatterData; body: string } => {
  const empty = { data: {}, body: content };
  if (!content.startsWith("---")) return empty;
  const firstNewline = content.indexOf("\n");
  if (firstNewline === -1) return empty;

  const rest = content.slice(firstNewline + 1);
  const closingMatch = /^---[ \t]*$/m.exec(rest);
  if (!closingMatch || closingMatch.index === undefined) return empty;

  const yamlContent = rest.slice(0, closingMatch.index);
  const afterClose = rest.slice(closingMatch.index + closingMatch[0].length);
  const body = afterClose.startsWith("\n") ? afterClose.slice(1) : afterClose;

  const data: FrontMatterData = {};
  const lines = yamlContent.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) { i++; continue; }

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) { i++; continue; }

    const key = line.slice(0, colonIndex).trim();
    if (!key) { i++; continue; }

    const valueStr = line.slice(colonIndex + 1).trim();

    if (!valueStr && i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) {
      const items: string[] = [];
      i++;
      while (i < lines.length && /^\s+-/.test(lines[i])) {
        const item = lines[i].replace(/^\s+-\s*/, "").trim();
        if (item) items.push(item);
        i++;
      }
      data[key] = items;
      continue;
    }

    if (valueStr === "[]") { data[key] = []; i++; continue; }

    if (valueStr.startsWith("[") && valueStr.endsWith("]")) {
      const inner = valueStr.slice(1, -1).trim();
      data[key] = inner
        ? inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
        : [];
      i++;
      continue;
    }

    if (valueStr === "true") { data[key] = true; i++; continue; }
    if (valueStr === "false") { data[key] = false; i++; continue; }
    if (valueStr === "null" || valueStr === "~") { data[key] = null; i++; continue; }
    if (/^-?\d+(\.\d+)?$/.test(valueStr)) { data[key] = Number(valueStr); i++; continue; }

    data[key] = valueStr.replace(/^["']|["']$/g, "");
    i++;
  }

  return { data, body };
};

const TAG_KEYS = new Set(["tags", "tag", "aliases", "alias"]);

function FrontMatterPanel({ data }: { data: FrontMatterData }) {
  const entries = Object.entries(data).filter(([, v]) => v !== null && v !== "");
  if (entries.length === 0) return null;

  return (
    <div className={styles.frontMatter}>
      <p className={styles.frontMatterLabel}>Properties</p>
      <dl className={styles.frontMatterGrid}>
        {entries.map(([key, value]) => {
          const isTagField = TAG_KEYS.has(key.toLowerCase());
          const items = Array.isArray(value) ? value : null;

          return (
            <div key={key} className={styles.frontMatterRow}>
              <dt className={styles.frontMatterKey}>{key}</dt>
              <dd className={styles.frontMatterValue}>
                {items !== null ? (
                  items.length === 0 ? (
                    <span className={styles.frontMatterEmpty}>—</span>
                  ) : isTagField ? (
                    <span className={styles.frontMatterTags}>
                      {items.map((item) => (
                        <span key={item} className={styles.frontMatterTag}>{item}</span>
                      ))}
                    </span>
                  ) : (
                    <ul className={styles.frontMatterList}>
                      {items.map((item, idx) => (
                        <li key={idx}>{item}</li>
                      ))}
                    </ul>
                  )
                ) : typeof value === "boolean" ? (
                  <span className={styles.frontMatterBool}>{value ? "true" : "false"}</span>
                ) : (
                  String(value)
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

type NotesMarkdownProps = {
  markdown: string;
  currentPath: string;
  noteIndex?: Map<string, string>;
  onNavigate?: (path: string, hash?: string | null) => void;
  onCreateNote?: (noteName: string) => void;
  assetHrefFactory?: (path: string, currentPath: string) => string;
  allowInternalNoteLinks?: boolean;
};

type MarkdownCodeProps = ComponentPropsWithoutRef<"code"> & {
  inline?: boolean;
  node?: unknown;
};

const decodeLoose = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeIndexKey = (value: string) =>
  decodeLoose(value)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\.md$/i, "")
    .trim()
    .toLocaleLowerCase();

const dirname = (filePath: string) => {
  const parts = filePath.split("/");
  parts.pop();
  return parts.join("/");
};

const joinPath = (basePath: string, target: string) => {
  const parts = `${basePath ? `${basePath}/` : ""}${target}`.split("/");
  const cleanParts: string[] = [];

  for (const part of parts) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      cleanParts.pop();
      continue;
    }
    cleanParts.push(part);
  }

  return cleanParts.join("/");
};

const textFromChildren = (children: ReactNode): string => {
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }

  if (Array.isArray(children)) {
    return children.map(textFromChildren).join("");
  }

  return "";
};

const escapeMarkdownLabel = (value: string) => value.replace(/([\\[\]])/g, "\\$1");

const splitObsidianTarget = (rawTarget: string) => {
  const [targetWithHeading, alias] = rawTarget.split("|");
  const hashIndex = targetWithHeading.indexOf("#");
  const target = hashIndex >= 0 ? targetWithHeading.slice(0, hashIndex).trim() : targetWithHeading.trim();
  const heading = hashIndex >= 0 ? targetWithHeading.slice(hashIndex + 1).trim() : "";

  return {
    target,
    heading,
    alias: alias?.trim() || "",
  };
};

const resolveNotePath = (
  target: string,
  currentPath: string,
  noteIndex: Map<string, string>,
) => {
  if (!target) {
    return currentPath;
  }

  const cleanTarget = target.replace(/\\/g, "/").replace(/^\/+/, "");
  const currentDirectory = dirname(currentPath);
  const candidateKeys = [
    cleanTarget,
    cleanTarget.replace(/\.md$/i, ""),
    joinPath(currentDirectory, cleanTarget),
    joinPath(currentDirectory, cleanTarget.replace(/\.md$/i, "")),
    cleanTarget.split("/").pop() ?? cleanTarget,
  ];

  for (const candidateKey of candidateKeys) {
    const resolved = noteIndex.get(normalizeIndexKey(candidateKey));
    if (resolved) {
      return resolved;
    }
  }

  return null;
};

const makeNoteHref = (path: string, heading?: string) => {
  const params = new URLSearchParams({ file: path });
  const hash = heading ? `#${encodeURIComponent(slugifyHeading(heading))}` : "";
  return `/?${params.toString()}${hash}`;
};

const makeAssetHref = (path: string, currentPath: string) => {
  const params = new URLSearchParams({
    path,
    from: currentPath,
  });
  return `/api/notes/asset?${params.toString()}`;
};

const isExternalHref = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");

const normalizeMarkdownLink = (
  href: string | undefined,
  currentPath: string,
  noteIndex: Map<string, string>,
  allowInternalNoteLinks: boolean,
) => {
  if (!href || href.startsWith("#") || isExternalHref(href) || href.startsWith("/?file=")) {
    return href;
  }

  const hashIndex = href.indexOf("#");
  const target = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const hash = hashIndex >= 0 ? href.slice(hashIndex + 1) : "";

  if (!target.toLocaleLowerCase().endsWith(".md")) {
    return href;
  }

  if (!allowInternalNoteLinks) {
    return "#";
  }

  const resolvedPath = resolveNotePath(target, currentPath, noteIndex);
  return resolvedPath ? makeNoteHref(resolvedPath, hash) : href;
};

const normalizeMarkdownImage = (
  src: string | undefined,
  currentPath: string,
  assetHrefFactory: (path: string, currentPath: string) => string,
) => {
  if (
    !src ||
    src.startsWith("/api/notes/asset") ||
    src.startsWith("/api/share/asset") ||
    isExternalHref(src) ||
    src.startsWith("data:")
  ) {
    return src;
  }

  return assetHrefFactory(src, currentPath);
};

const getImageDownloadFilename = (src: string, fallback = "image.png") => {
  try {
    const url = new URL(src, window.location.origin);
    const sourcePath = url.searchParams.get("path") || url.pathname;
    const filename = sourcePath.split("/").pop();
    return filename ? decodeLoose(filename) : fallback;
  } catch {
    const filename = src.split("?")[0].split("/").pop();
    return filename ? decodeLoose(filename) : fallback;
  }
};

const LATEX_SYMBOLS: Record<string, string> = {
  rightarrow: "→", Rightarrow: "⇒", leftarrow: "←", Leftarrow: "⇐",
  leftrightarrow: "↔", Leftrightarrow: "⇔", uparrow: "↑", downarrow: "↓",
  to: "→", gets: "←", implies: "⟹", iff: "⟺",
  times: "×", div: "÷", pm: "±", cdot: "·", ldots: "…", cdots: "⋯",
  infty: "∞", partial: "∂", nabla: "∇", sqrt: "√",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε",
  theta: "θ", lambda: "λ", mu: "μ", pi: "π", sigma: "σ", tau: "τ",
  phi: "φ", omega: "ω", Delta: "Δ", Sigma: "Σ", Omega: "Ω",
  leq: "≤", geq: "≥", neq: "≠", approx: "≈", equiv: "≡",
  in: "∈", notin: "∉", subset: "⊂", cup: "∪", cap: "∩",
  forall: "∀", exists: "∃",
};

const substituteLatexMath = (text: string) =>
  text.replace(/\$([^$\n]+?)\$/g, (match, inner: string) => {
    const trimmed = inner.trim();
    const replaced = trimmed.replace(/\\([A-Za-z]+)/g, (_, cmd: string) => LATEX_SYMBOLS[cmd] ?? `\\${cmd}`);
    return replaced.includes("\\") ? match : replaced;
  });

const transformObsidianSyntax = (
  markdown: string,
  currentPath: string,
  noteIndex: Map<string, string>,
  assetHrefFactory: (path: string, currentPath: string) => string,
  allowInternalNoteLinks: boolean,
) => {
  const fencedBlockPattern = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
  return markdown
    .split(fencedBlockPattern)
    .map((part, index) => {
      if (index % 2 === 1) {
        return part;
      }

      return substituteLatexMath(part)
        .replace(/!\[\[([^\]]+)\]\]/g, (_match, rawTarget: string) => {
          const { target, alias } = splitObsidianTarget(rawTarget);
          const label = escapeMarkdownLabel(alias || target);
          return `![${label}](${assetHrefFactory(target, currentPath)})`;
        })
        .replace(/\[\[([^\]]+)\]\]/g, (_match, rawTarget: string) => {
          const { target, heading, alias } = splitObsidianTarget(rawTarget);
          const resolvedPath = resolveNotePath(target, currentPath, noteIndex);
          const label = escapeMarkdownLabel(alias || heading || target);
          const href = allowInternalNoteLinks && resolvedPath
            ? makeNoteHref(resolvedPath, heading)
            : allowInternalNoteLinks
              ? `inkfellow-create:${encodeURIComponent(target)}`
              : "#";
          return `[${label}](${href})`;
        });
    })
    .join("");
};

function CodeBlock({ className, children }: { className?: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const codeString = String(children).replace(/\n$/, "");
  const match = /language-(\w+)/.exec(className || "");
  const lang = match ? match[1] : "";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeString);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore copy failures */
    }
  };

  return (
    <div className={styles.codeBlockContainer}>
      {lang && <span className={styles.codeLanguage}>{lang.toLowerCase()}</span>}
      <button
        type="button"
        onClick={handleCopy}
        className={`${styles.codeCopyButton} ${copied ? styles.codeCopyButtonCopied : ""}`}
        aria-label="复制代码"
      >
        {copied ? (
          <span className={styles.copySuccess}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ width: "12px", height: "12px", marginRight: "3px" }}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
            已复制
          </span>
        ) : (
          <span className={styles.copyText}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: "12px", height: "12px", marginRight: "3px" }}>
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            复制
          </span>
        )}
      </button>
      <pre>
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

// Mermaid is loaded lazily from CDN rather than bundled: bundling it (d3 + a large tree)
// OOMs the webpack build on this low-memory host. Singleton promise + timeout + failure
// state keep weak-network/offline cases from hanging in the loading spinner forever.
type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, chart: string) => Promise<{ svg: string }>;
};

const MERMAID_CDN = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
const MERMAID_LOAD_TIMEOUT_MS = 12000;

let mermaidPromise: Promise<MermaidApi> | null = null;

function getMermaid(): Promise<MermaidApi> {
  if (mermaidPromise) return mermaidPromise;

  mermaidPromise = new Promise<MermaidApi>((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new Error("Mermaid unavailable during SSR"));
      return;
    }
    const w = window as unknown as { mermaid?: MermaidApi };
    if (w.mermaid) {
      resolve(w.mermaid);
      return;
    }

    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      mermaidPromise = null; // allow a later render to retry the load
      reject(new Error(message));
    };
    const succeed = () => {
      if (settled) return;
      if (!w.mermaid) {
        fail("Mermaid 加载失败");
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(w.mermaid);
    };
    const timer = setTimeout(() => fail("加载 Mermaid 超时，请检查网络后重试"), MERMAID_LOAD_TIMEOUT_MS);

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${MERMAID_CDN}"]`);
    if (existing) {
      existing.addEventListener("load", succeed);
      existing.addEventListener("error", () => fail("Mermaid 加载失败"));
      if (w.mermaid) succeed();
      return;
    }
    const script = document.createElement("script");
    script.src = MERMAID_CDN;
    script.async = true;
    script.addEventListener("load", succeed);
    script.addEventListener("error", () => fail("Mermaid 加载失败"));
    document.head.appendChild(script);
  }).then((mermaid) => {
    mermaid.initialize({ startOnLoad: false, theme: "default" });
    return mermaid;
  });

  return mermaidPromise;
}

function MermaidError({ chart, detail }: { chart: string; detail: string }) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  return (
    <div className={styles.mermaidError}>
      <pre className={styles.mermaidErrorCode}><code>{chart}</code></pre>
      <div className={styles.mermaidErrorBar}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
          <path d="M8 1L15 14H1L8 1z" /><line x1="8" y1="6" x2="8" y2="10" /><line x1="8" y1="12" x2="8" y2="13" />
        </svg>
        <span>Mermaid 语法错误</span>
        <button
          type="button"
          className={styles.mermaidErrorToggle}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={detailId}
        >
          {expanded ? "收起 ▴" : "查看详情 ▾"}
        </button>
      </div>
      {expanded && <div id={detailId} className={styles.mermaidErrorDetail}>{detail}</div>}
    </div>
  );
}

// Rendered with key={chart} by the parent, so each chart gets a fresh instance and
// the effect runs exactly once — no synchronous state reset needed.
function Mermaid({ chart }: { chart: string }) {
  const [state, setState] = useState<{ svg: string; error: string | null }>({ svg: "", error: null });

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid-${Math.random().toString(36).substring(2, 9)}`;
    getMermaid()
      .then((mermaid) => mermaid.render(id, chart))
      .then(({ svg }) => {
        if (!cancelled) setState({ svg, error: null });
      })
      .catch((e: unknown) => {
        // Remove the stray node mermaid injects into <body> on failure (the bottom toast)
        document.getElementById(`d${id}`)?.remove();
        if (!cancelled) setState({ svg: "", error: e instanceof Error ? e.message : String(e) });
      });
    return () => { cancelled = true; };
  }, [chart]);

  if (state.error !== null) {
    return <MermaidError chart={chart} detail={state.error} />;
  }

  if (!state.svg) {
    return <div className={styles.mermaidLoading}>渲染图表中…</div>;
  }

  return <div dangerouslySetInnerHTML={{ __html: state.svg }} style={{ display: "flex", justifyContent: "center", margin: "1rem 0" }} />;
}

type BacklinkEntry = {
  sourcePath: string;
  sourceName: string;
  context: string;
};

function BacklinksPanel({ currentPath, onNavigate }: { currentPath: string; onNavigate?: (path: string) => void }) {
  const [backlinks, setBacklinks] = useState<BacklinkEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Component is mounted fresh per-path via key={currentPath} in parent.
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ path: currentPath });
    fetch(`/api/notes/wiki/backlinks?${params.toString()}`, { signal: controller.signal, cache: "no-store" })
      .then((r) => r.json())
      .then((data: { backlinks?: BacklinkEntry[] }) => {
        setBacklinks(data.backlinks ?? []);
        setLoaded(true);
      })
      .catch(() => { /* silently ignore */ });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!loaded || backlinks.length === 0) return null;

  return (
    <div className={styles.backlinksPanel}>
      <div className={styles.backlinksPanelTitle}>{backlinks.length} 处引用</div>
      {backlinks.map((bl) => (
        <button
          key={bl.sourcePath}
          type="button"
          className={styles.backlinkItem}
          onClick={() => onNavigate?.(bl.sourcePath)}
        >
          <span className={styles.backlinkSource}>{bl.sourceName}</span>
          <span className={styles.backlinkContext}>{bl.context}</span>
        </button>
      ))}
    </div>
  );
}

export default function NotesMarkdown({
  markdown,
  currentPath,
  noteIndex,
  onNavigate,
  onCreateNote,
  assetHrefFactory = makeAssetHref,
  allowInternalNoteLinks = true,
}: NotesMarkdownProps) {
  const resolvedNoteIndex = useMemo(() => noteIndex ?? new Map<string, string>(), [noteIndex]);
  const { data: frontMatterData, body: markdownBody } = useMemo(
    () => parseFrontMatter(markdown),
    [markdown],
  );

  const renderedMarkdown = useMemo(
    () => transformObsidianSyntax(
      markdownBody,
      currentPath,
      resolvedNoteIndex,
      assetHrefFactory,
      allowInternalNoteLinks,
    ),
    [allowInternalNoteLinks, assetHrefFactory, currentPath, markdownBody, resolvedNoteIndex],
  );

  const components = useMemo<Components>(
    () => ({
      a({ href, children }) {
        const normalizedHref = normalizeMarkdownLink(
          href,
          currentPath,
          resolvedNoteIndex,
          allowInternalNoteLinks,
        );
        const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
          if (normalizedHref?.startsWith("inkfellow-create:")) {
            event.preventDefault();
            const noteName = decodeURIComponent(normalizedHref.slice("inkfellow-create:".length));
            onCreateNote?.(noteName);
            return;
          }

          if (!normalizedHref?.startsWith("/?file=")) {
            return;
          }

          const url = new URL(normalizedHref, window.location.origin);
          const file = url.searchParams.get("file");
          if (!file) {
            return;
          }

          event.preventDefault();
          onNavigate?.(file, url.hash || null);
        };

        const isMissingWikiLink = normalizedHref?.startsWith("inkfellow-create:");
        return (
          <a
            href={isMissingWikiLink ? "#" : normalizedHref}
            onClick={handleClick}
            className={isMissingWikiLink ? styles.wikiLinkMissing : undefined}
            target={!isMissingWikiLink && normalizedHref && isExternalHref(normalizedHref) ? "_blank" : undefined}
            rel={!isMissingWikiLink && normalizedHref && isExternalHref(normalizedHref) ? "noreferrer" : undefined}
          >
            {children}
          </a>
        );
      },
      img({ src, alt }) {
        const normalizedSrc = normalizeMarkdownImage(
          typeof src === "string" ? src : undefined,
          currentPath,
          assetHrefFactory,
        );
        if (!normalizedSrc) {
          return null;
        }
        function handleDownload(e: MouseEvent) {
          e.preventDefault();
          e.stopPropagation();
          if (!normalizedSrc) return;
          const filename = getImageDownloadFilename(normalizedSrc);
          fetch(normalizedSrc)
            .then((r) => r.blob())
            .then((blob) => {
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = filename;
              a.click();
              window.setTimeout(() => URL.revokeObjectURL(url), 0);
            })
            .catch(() => {
              const a = document.createElement("a");
              a.href = normalizedSrc;
              a.download = filename;
              a.click();
            });
        }
        return (
          <span className={styles.imageFrame}>
            <img src={normalizedSrc} alt={alt ?? ""} loading="lazy" />
            <button
              type="button"
              className={styles.imageDownloadBtn}
              onClick={handleDownload}
              aria-label="下载图片"
              title="下载图片"
            >
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 2.5v7M5.5 7 8 9.5 10.5 7" />
                <path d="M3 13h10" />
              </svg>
            </button>
          </span>
        );
      },
      pre({ children }) {
        return <>{children}</>;
      },
      table({ children }) {
        return (
          <div className={styles.tableWrap}>
            <table>{children}</table>
          </div>
        );
      },
      code({ node, className, children, inline, ...props }: MarkdownCodeProps) {
        void node;
        if (inline) {
          return (
            <code className={className} {...props}>
              {children}
            </code>
          );
        }
        
        const match = /language-(\w+)/.exec(className || "");
        const lang = match ? match[1] : "code";

        if (lang === "mermaid") {
          const chart = String(children).replace(/\n$/, "");
          return <Mermaid key={chart} chart={chart} />;
        }

        return (
          <CodeBlock className={className}>
            {children}
          </CodeBlock>
        );
      },
      h1({ children }) {
        return <h1 id={slugifyHeading(textFromChildren(children))}>{children}</h1>;
      },
      h2({ children }) {
        return <h2 id={slugifyHeading(textFromChildren(children))}>{children}</h2>;
      },
      h3({ children }) {
        return <h3 id={slugifyHeading(textFromChildren(children))}>{children}</h3>;
      },
      h4({ children }) {
        return <h4 id={slugifyHeading(textFromChildren(children))}>{children}</h4>;
      },
      h5({ children }) {
        return <h5 id={slugifyHeading(textFromChildren(children))}>{children}</h5>;
      },
      h6({ children }) {
        return <h6 id={slugifyHeading(textFromChildren(children))}>{children}</h6>;
      },
    }),
    [allowInternalNoteLinks, assetHrefFactory, currentPath, onCreateNote, onNavigate, resolvedNoteIndex],
  );

  return (
    <div className={styles.markdown}>
      <FrontMatterPanel data={frontMatterData} />
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {renderedMarkdown}
      </ReactMarkdown>
      {allowInternalNoteLinks && (
        <BacklinksPanel key={currentPath} currentPath={currentPath} onNavigate={onNavigate ? (p) => onNavigate(p) : undefined} />
      )}
    </div>
  );
}

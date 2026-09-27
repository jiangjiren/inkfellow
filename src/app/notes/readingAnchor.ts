/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Element, Root } from "hast";
import type { RootContent as MdastContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

/* ── Reading anchor：进出编辑时保持阅读位置（移植自 desktop-lite） ─────────
   预览和源码的排版高度对不上：标题字号、段距不同，一张图在预览里几百像素、在源码里只占一行，
   照搬像素 scrollTop 越往下偏得越多。这里改记「正在读的那个字在源码里的位置 + 它离视口顶多远」，
   切到另一种模式后把同一个字放回同一高度。
   锚点 { line, ch, offset }：ch 是数字时指向一个预览里看得见的字，offset 量它那一行的垂直中心；
   ch 为 null 时按行对齐（图片、分割线这类没有字的块），line 可带小数，offset 量行顶。
   { top: true } 表示停在文档最顶上。 */

export type ReadingAnchor =
  | { top: true }
  | { top?: false; line: number; ch: number | null; offset: number };

type LineAnchor = Exclude<ReadingAnchor, { top: true }>;
type BlockKind = "text" | "code" | "table" | "none";
type SourceColumn = { line: number; ch: number };
type TextChar = { node: Text; offset: number };
type PreviewBlock = { el: HTMLElement; start: number; end: number; kind: BlockKind };
type SourceBlock = { start: number; end: number; kind: BlockKind };
type Point = { clientX: number; clientY: number };

const MARKDOWN_ESCAPABLE_RE = /[!-/:-@[-`{-~]/;
const WIKI_IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const WIKI_ATTACHMENT_EXT_RE = /\.(mp4|webm|mov|m4v|mp3|wav|ogg|flac|pdf)$/i;
const BLOCK_ID_RE = /[ \t]+\^[A-Za-z0-9-]+[ \t]*$/;
const READING_PIN_MS = 3000;
const READING_PIN_RELEASE_EVENTS = ["wheel", "keydown", "pointerdown", "touchstart"];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const newlineCount = (text: string) => (text.match(/\n/g) || []).length;

export function splitSourceLines(content: string | null | undefined) {
  return String(content ?? "").split(/\r\n?|\n/);
}

/* ── 源码 → 渲染后看得见的字 ─────────────────────── */

/* 空白不算字（预览会折叠空白、软换行变成 <br>），代理对的后半截、块 ID 占位的零宽空格也不单独算 */
function isRenderedChar(text: string, i: number) {
  const code = text.charCodeAt(i);
  return !(code >= 0xdc00 && code <= 0xdfff) && code !== 0x200b && !/\s/.test(text[i]);
}

function pushRenderedRange(text: string, from: number, to: number, line: number, cols: SourceColumn[]) {
  for (let i = from; i < to; i++) if (isRenderedChar(text, i)) cols.push({ line, ch: i });
}

function closingBracketIndex(text: string, open: number, to: number) {
  let depth = 0;
  for (let i = open; i < to; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "[") depth++;
    else if (text[i] === "]" && --depth === 0) return i;
  }
  return -1;
}

/* 链接、图片的 [...] 后面紧跟的 (url "title") 或 [ref]，返回它结束后的位置 */
function linkTailEnd(text: string, i: number, to: number) {
  if (text[i] === "[") {
    const close = closingBracketIndex(text, i, to);
    return close === -1 ? -1 : close + 1;
  }
  if (text[i] !== "(") return -1;
  let depth = 0;
  for (let j = i; j < to; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === "(") depth++;
    else if (text[j] === ")" && --depth === 0) return j + 1;
  }
  return -1;
}

/* * _ ~ 两侧都是空白、下划线夹在单词中间时，不可能是定界符 */
function canDelimitEmphasis(text: string, i: number, run: number, from: number, to: number) {
  const before = i > from ? text[i - 1] : " ";
  const after = i + run < to ? text[i + run] : " ";
  if (/\s/.test(before) && /\s/.test(after)) return false;
  return !(text[i] === "_" && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after));
}

/* 做强调、删除线定界符时不出字；同一行里找不到能跟它配对的另一段，就按字面显示 */
function isEmphasisRun(text: string, i: number, run: number, from: number, to: number) {
  if (!canDelimitEmphasis(text, i, run, from, to)) return false;
  for (let j = from; j < to; j++) {
    if (text[j] !== text[i]) continue;
    let other = 1;
    while (j + other < to && text[j + other] === text[i]) other++;
    if (j !== i && canDelimitEmphasis(text, j, other, from, to)) return true;
    j += other - 1;
  }
  return false;
}

/* [[目标#标题|别名]]：和 transformObsidianSyntax 一致，显示 别名 || 标题 || 块 ID || 目标 */
function pushWikiColumns(text: string, from: number, to: number, line: number, cols: SourceColumn[]) {
  const pipe = text.indexOf("|", from);
  const hasPipe = pipe !== -1 && pipe < to;
  if (hasPipe && text.slice(pipe + 1, to).trim()) {
    pushRenderedRange(text, pipe + 1, to, line, cols);
    return;
  }
  const targetEnd = hasPipe ? pipe : to;
  const hash = text.indexOf("#", from);
  if (hash !== -1 && hash < targetEnd && text.slice(hash + 1, targetEnd).trim()) {
    pushRenderedRange(text, text[hash + 1] === "^" ? hash + 2 : hash + 1, targetEnd, line, cols);
    return;
  }
  pushRenderedRange(text, from, targetEnd, line, cols);
}

/* 一行行内 Markdown 渲染后，看得见的每个字对应的源码列 */
function pushInlineColumns(text: string, from: number, to: number, line: number, cols: SourceColumn[], table = false) {
  let i = from;
  while (i < to) {
    const c = text[i];
    if (c === "\\" && i + 1 < to && MARKDOWN_ESCAPABLE_RE.test(text[i + 1])) {
      pushRenderedRange(text, i + 1, i + 2, line, cols);
      i += 2;
      continue;
    }
    if (table && c === "|") {
      i++;
      continue;
    }
    if (c === "`") {
      let run = 1;
      while (text[i + run] === "`") run++;
      const close = text.indexOf("`".repeat(run), i + run);
      if (close !== -1 && close + run <= to) {
        pushRenderedRange(text, i + run, close, line, cols);
        i = close + run;
      } else {
        pushRenderedRange(text, i, i + run, line, cols);
        i += run;
      }
      continue;
    }
    const wikiOpen = (c === "!" && text[i + 1] === "[" && text[i + 2] === "[") || (c === "[" && text[i + 1] === "[");
    if (wikiOpen) {
      const inner = c === "!" ? i + 3 : i + 2;
      const close = text.indexOf("]]", inner);
      if (close !== -1 && close < to) {
        // ![[图片]] 渲染成图，![[笔记]] 嵌入成独立的一块，都不在这一行里出字；只有附件是一条链接
        const target = text.slice(inner, close).split(/[|#]/)[0].trim();
        const embedsWithoutText = c === "!" && (WIKI_IMAGE_EXT_RE.test(target) || !WIKI_ATTACHMENT_EXT_RE.test(target));
        if (!embedsWithoutText) pushWikiColumns(text, inner, close, line, cols);
        i = close + 2;
        continue;
      }
    } else if (c === "!" && text[i + 1] === "[") {
      const close = closingBracketIndex(text, i + 1, to);
      const end = close === -1 ? -1 : linkTailEnd(text, close + 1, to);
      if (end !== -1) {
        i = end; // 图片本身不出字
        continue;
      }
    } else if (c === "[") {
      const close = closingBracketIndex(text, i, to);
      const end = close === -1 ? -1 : linkTailEnd(text, close + 1, to);
      if (end !== -1) {
        pushInlineColumns(text, i + 1, close, line, cols, table);
        i = end;
        continue;
      }
    }
    if (c === "<") {
      const rest = text.slice(i, to);
      const autolink = /^<([a-z][a-z\d+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>]+)>/i.exec(rest);
      if (autolink) {
        pushRenderedRange(text, i + 1, i + 1 + autolink[1].length, line, cols);
        i += autolink[0].length;
        continue;
      }
      // 没接 rehype-raw，原始 HTML 标签不渲染
      const tag = /^(?:<\/?[a-z][a-z\d-]*(?:\s[^<>]*)?\/?>|<!--[\s\S]*?-->)/i.exec(rest);
      if (tag) {
        i += tag[0].length;
        continue;
      }
    }
    if (c === "&") {
      const entity = /^&(?:#\d{1,7}|#x[\da-f]{1,6}|[a-z][a-z\d]{1,31});/i.exec(text.slice(i, Math.min(to, i + 40)));
      if (entity) {
        if (!/^&(?:nbsp|#160|#xa0);$/i.test(entity[0])) cols.push({ line, ch: i });
        i += entity[0].length;
        continue;
      }
    }
    if (c === "*" || c === "_" || c === "~") {
      let run = 1;
      while (text[i + run] === c) run++;
      if (!isEmphasisRun(text, i, run, from, to)) pushRenderedRange(text, i, i + run, line, cols);
      i += run;
      continue;
    }
    if (isRenderedChar(text, i)) cols.push({ line, ch: i });
    i++;
  }
}

/* 行首的引用符、缩进、列表符号、任务框、标题井号（以及标题末尾的闭合井号）、行尾块 ID 都不出字 */
function blockTextRange(text: string, inFence: boolean): [number, number] {
  let i = 0;
  for (;;) {
    while (text[i] === " " || text[i] === "\t") i++;
    if (text[i] !== ">") break;
    i++;
  }
  if (inFence) return [i, text.length];
  if (/^\^[A-Za-z0-9-]+[ \t]*$/.test(text.slice(i))) return [i, i];
  const blockId = BLOCK_ID_RE.exec(text);
  let end = blockId && blockId.index > i ? blockId.index : text.length;
  const marker = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/.exec(text.slice(i));
  if (marker) {
    i += marker[0].length;
    const task = /^\[[ xX]\](?:[ \t]+|$)/.exec(text.slice(i));
    if (task) i += task[0].length;
  }
  const heading = /^#{1,6}(?:[ \t]+|$)/.exec(text.slice(i));
  if (!heading) return [i, end];
  const from = i + heading[0].length;
  const closing = /[ \t]+#+[ \t]*$/.exec(text.slice(0, end));
  if (closing && closing.index >= from) end = closing.index;
  return [from, end];
}

/* 一个块的源码里，渲染后看得见的字各在哪一列。预览和编辑器都靠它在「块内第几个字」和源码位置之间换算 */
function renderedSourceColumns(lines: string[], start: number, end: number, kind: BlockKind) {
  const cols: SourceColumn[] = [];
  if (kind === "none") return cols;
  let fence = "";
  for (let line = start; line <= end && line < lines.length; line++) {
    const text = lines[line];
    if (kind === "code") {
      if ((line === start || line === end) && /^ {0,3}(`{3,}|~{3,})/.test(text)) continue;
      pushRenderedRange(text, 0, text.length, line, cols);
      continue;
    }
    if (kind === "table") {
      if (line !== start + 1 || !/^[\s|:-]+$/.test(text)) pushInlineColumns(text, 0, text.length, line, cols, true);
      continue;
    }
    // 列表、引用里可能嵌着代码块：围栏行不出字，围栏里的内容原样显示
    const [from, to] = blockTextRange(text, Boolean(fence));
    const fenceMark = /^(`{3,}|~{3,})/.exec(text.slice(from))?.[1];
    if (fence) {
      if (fenceMark && fenceMark[0] === fence[0] && fenceMark.length >= fence.length) fence = "";
      else pushRenderedRange(text, from, to, line, cols);
      continue;
    }
    if (fenceMark) {
      fence = fenceMark;
      continue;
    }
    if (/^(?:\s*[-*_]){3,}\s*$|^=+\s*$/.test(text.slice(from, to))) continue; // 分割线、setext 标题下划线
    pushInlineColumns(text, from, to, line, cols);
  }
  return cols;
}

/* ── 预览里的块：NotesMarkdown 的 rehypeSourceLines 给顶层块标上的源码行区间 ── */

export const SOURCE_LINE_ATTRS = {
  line: "data-source-line",
  endLine: "data-source-end-line",
  kind: "data-source-kind",
} as const;

function hastBlockKind(el: Element): BlockKind {
  if (el.tagName === "pre") {
    const code = el.children.find((child): child is Element => child.type === "element" && child.tagName === "code");
    const className = code?.properties?.className;
    const classes = Array.isArray(className) ? className.map(String) : [String(className ?? "")];
    return classes.includes("language-mermaid") ? "none" : "code";
  }
  if (el.tagName === "table") return "table";
  if (el.tagName === "hr") return "none";
  return "text";
}

/**
 * rehype 插件：给顶层块标上源码行区间（首尾行都含，0 起算）。
 * lineOffset 是这一段 markdown 在原笔记里的起始行（属性区、嵌入笔记拆段都会让它往后挪）。
 * 代码块另把属性抄到 <code> 上，因为 pre 组件自己不出元素，由 CodeBlock / Mermaid 接住。
 */
export function rehypeSourceLines(options: { lineOffset?: number } = {}) {
  const lineOffset = options.lineOffset ?? 0;
  return (tree: Root) => {
    for (const child of tree.children) {
      if (child.type !== "element" || !child.position) continue;
      const attrs = {
        dataSourceLine: lineOffset + child.position.start.line - 1,
        dataSourceEndLine: lineOffset + child.position.end.line - 1,
        dataSourceKind: hastBlockKind(child),
      };
      child.properties = { ...child.properties, ...attrs };
      if (child.tagName === "pre") {
        for (const code of child.children) {
          if (code.type === "element" && code.tagName === "code") code.properties = { ...code.properties, ...attrs };
        }
      }
    }
  };
}

/** 从 hast 节点上取出源码行属性，给自定义组件原样挂回根元素 */
export function sourceLineProps(node: { properties?: Record<string, unknown> } | undefined) {
  const props = node?.properties;
  if (props?.dataSourceLine == null) return {};
  return {
    [SOURCE_LINE_ATTRS.line]: String(props.dataSourceLine),
    [SOURCE_LINE_ATTRS.endLine]: String(props.dataSourceEndLine),
    [SOURCE_LINE_ATTRS.kind]: String(props.dataSourceKind),
  };
}

/** 属性区（--- … ---）占掉的行数；和 NotesMarkdown 的 parseFrontMatter 判定一致 */
export function frontMatterBodyStartLine(content: string) {
  if (!content.startsWith("---")) return 0;
  const firstNewline = content.indexOf("\n");
  if (firstNewline === -1) return 0;
  const rest = content.slice(firstNewline + 1);
  const closingMatch = /^---[ \t]*\r?$/m.exec(rest);
  if (!closingMatch) return 0;
  return 1 + newlineCount(rest.slice(0, closingMatch.index)) + 1;
}

/* ── 预览：DOM 里的字 ────────────────────────────── */

function renderedTextChars(el: HTMLElement) {
  const chars: TextChar[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const text = node.data;
    for (let i = 0; i < text.length; i++) {
      if (isRenderedChar(text, i)) chars.push({ node, offset: i });
    }
  }
  return chars;
}

/* 代码块外壳里还有语言标签、复制按钮，只数 <pre> 里的字 */
function blockTextChars(block: PreviewBlock) {
  const scope = block.kind === "code" ? block.el.querySelector("pre") ?? block.el : block.el;
  return renderedTextChars(scope as HTMLElement);
}

function textCharRect({ node, offset }: TextChar) {
  const code = node.data.charCodeAt(offset);
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, Math.min(node.data.length, offset + (code >= 0xd800 && code <= 0xdbff ? 2 : 1)));
  return range.getBoundingClientRect();
}

function rowCenter(rect: { top: number; bottom: number }) {
  return (rect.top + rect.bottom) / 2;
}

/* 第一个所在行中线不高于 y 的字；都在 y 上面则返回 chars.length */
function firstCharBelow(chars: TextChar[], y: number) {
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rowCenter(textCharRect(chars[mid])) >= y) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function firstCharAtOrAfter(chars: TextChar[], node: Node, offset: number) {
  const range = document.createRange();
  range.setStart(node, offset);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (range.comparePoint(chars[mid].node, chars[mid].offset) >= 0) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function caretPointAt(x: number, y: number) {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (typeof doc.caretPositionFromPoint === "function") {
    const pos = doc.caretPositionFromPoint(x, y);
    return pos?.offsetNode ? { node: pos.offsetNode, offset: pos.offset } : null;
  }
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/* 预览里带源码行号的块，按文档顺序、行号单调递增；折叠起来没有布局的块不能当锚点 */
function previewSourceBlocks(root: HTMLElement) {
  const blocks: PreviewBlock[] = [];
  let lastEnd = -1;
  for (const el of root.querySelectorAll<HTMLElement>(`[${SOURCE_LINE_ATTRS.line}]`)) {
    const start = Number(el.dataset.sourceLine);
    const end = Math.max(start, Number(el.dataset.sourceEndLine ?? start));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start <= lastEnd || !el.getClientRects().length) continue;
    const kind = (["text", "code", "table", "none"] as const).find((k) => k === el.dataset.sourceKind) ?? "text";
    blocks.push({ el, start, end, kind });
    lastEnd = end;
  }
  return blocks;
}

function firstBlockBelow(blocks: PreviewBlock[], y: number) {
  let lo = 0;
  let hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].el.getBoundingClientRect().bottom > y) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/* 源码行（可带小数）→ 预览里的纵坐标：块内按比例，块与块之间的空行按间距比例 */
function previewLineY(blocks: PreviewBlock[], line: number) {
  let prev: PreviewBlock | null = null;
  for (const block of blocks) {
    if (line < block.start) {
      const top = block.el.getBoundingClientRect().top;
      if (!prev) return top;
      const prevBottom = prev.el.getBoundingClientRect().bottom;
      const t = (line - prev.end - 1) / (block.start - prev.end - 1);
      return prevBottom + clamp(t, 0, 1) * (top - prevBottom);
    }
    if (line < block.end + 1) {
      const rect = block.el.getBoundingClientRect();
      return rect.top + ((line - block.start) / (block.end + 1 - block.start)) * rect.height;
    }
    prev = block;
  }
  return prev ? prev.el.getBoundingClientRect().bottom : null;
}

function previewLineAtY(blocks: PreviewBlock[], y: number) {
  let prev: PreviewBlock | null = null;
  for (const block of blocks) {
    const rect = block.el.getBoundingClientRect();
    if (y < rect.top) {
      if (!prev) return block.start;
      const prevBottom = prev.el.getBoundingClientRect().bottom;
      const t = rect.top > prevBottom ? (y - prevBottom) / (rect.top - prevBottom) : 0;
      return prev.end + 1 + clamp(t, 0, 1) * (block.start - prev.end - 1);
    }
    if (y < rect.bottom) return block.start + ((y - rect.top) / rect.height) * (block.end + 1 - block.start);
    prev = block;
  }
  return prev ? prev.end + 1 : null;
}

/* 块内第 k 个看得见的字 → 源码位置。两边数出来的字数对不上时按比例折算，误差摊在整块里 */
function previewCharSource(lines: string[], block: PreviewBlock, chars: TextChar[], k: number) {
  const cols = renderedSourceColumns(lines, block.start, block.end, block.kind);
  if (!cols.length || !chars.length) return null;
  if (k >= chars.length) {
    const last = cols[cols.length - 1];
    return { line: last.line, ch: last.ch + 1 };
  }
  return cols[Math.min(cols.length - 1, Math.round((k * cols.length) / chars.length))];
}

/* ── 滚动视口：桌面端 reader 自己滚，移动端 reader 不滚、由 window 滚 ── */

type Viewport = { top: number; bottom: number; scrollTop: number; scrollBy: (delta: number) => void };

function readerViewport(reader: HTMLElement): Viewport {
  const scrollable = getComputedStyle(reader).overflowY !== "visible";
  let top = scrollable ? reader.getBoundingClientRect().top : 0;
  const bottom = scrollable ? top + reader.clientHeight : window.innerHeight;
  // 吸顶的标题栏盖住的那截看不见，从它下沿开始算「正在读的地方」
  const header = reader.querySelector<HTMLElement>("[data-notes-reader-header]");
  if (header && /sticky|fixed/.test(getComputedStyle(header).position)) {
    top = Math.max(top, Math.min(bottom, header.getBoundingClientRect().bottom));
  }
  return scrollable
    ? { top, bottom, scrollTop: reader.scrollTop, scrollBy: (d) => { reader.scrollTop += d; } }
    : { top, bottom, scrollTop: window.scrollY, scrollBy: (d) => window.scrollBy(0, d) };
}

export function readerScrollTop(reader: HTMLElement) {
  return readerViewport(reader).scrollTop;
}

/* 预览：从 y 往下找第一个能对齐的东西 —— 一行字，或顶边露在视口里的图片、分割线 */
function previewAnchorAt(root: HTMLElement, lines: string[], view: Viewport, y: number): LineAnchor | null {
  const blocks = previewSourceBlocks(root);
  for (let i = firstBlockBelow(blocks, y); i < blocks.length; i++) {
    const block = blocks[i];
    const rect = block.el.getBoundingClientRect();
    if (rect.top >= view.bottom) break;
    if (block.kind !== "none") {
      const chars = blockTextChars(block);
      const k = firstCharBelow(chars, y);
      const pos = k < chars.length ? previewCharSource(lines, block, chars, k) : null;
      if (pos) return { line: pos.line, ch: pos.ch, offset: rowCenter(textCharRect(chars[k])) - view.top };
    }
    // 被视口顶截掉一截的图片不拿来对齐：它在源码里只有一行，按它对齐会把下面正在读的字甩远
    if (rect.top >= y - 1) return { line: block.start, ch: null, offset: rect.top - view.top };
  }
  const line = previewLineAtY(blocks, y);
  return line == null ? null : { line, ch: null, offset: y - view.top };
}

/* 预览：鼠标点在哪个字上，锚点就是哪个字（双击进编辑用） */
function previewAnchorAtPoint(root: HTMLElement, lines: string[], view: Viewport, x: number, y: number): LineAnchor | null {
  const blocks = previewSourceBlocks(root);
  const caret = caretPointAt(x, y);
  const block = caret && blocks.find((b) => b.el.contains(caret.node));
  if (caret && block && block.kind !== "none") {
    const chars = blockTextChars(block);
    const k = firstCharAtOrAfter(chars, caret.node, caret.offset);
    const pos = previewCharSource(lines, block, chars, k);
    if (pos) {
      return { line: pos.line, ch: pos.ch, offset: rowCenter(textCharRect(chars[Math.min(k, chars.length - 1)])) - view.top };
    }
  }
  const line = previewLineAtY(blocks, y);
  return line == null ? null : { line, ch: null, offset: y - view.top };
}

function previewAnchorY(root: HTMLElement, lines: string[], anchor: LineAnchor) {
  const blocks = previewSourceBlocks(root);
  if (!blocks.length) return null;
  if (anchor.ch == null) return previewLineY(blocks, anchor.line);
  const block = blocks.find((b) => b.start <= anchor.line && anchor.line <= b.end);
  if (block && block.kind !== "none") {
    const cols = renderedSourceColumns(lines, block.start, block.end, block.kind);
    const chars = blockTextChars(block);
    if (cols.length && chars.length) {
      let j = cols.findIndex((c) => c.line > anchor.line || (c.line === anchor.line && c.ch >= (anchor.ch ?? 0)));
      if (j === -1) j = cols.length - 1;
      return rowCenter(textCharRect(chars[Math.min(chars.length - 1, Math.round((j * chars.length) / cols.length))]));
    }
  }
  return previewLineY(blocks, anchor.line + 0.5);
}

/* ── 编辑器（CodeMirror 5） ──────────────────────── */

const MDAST_BLOCK_KIND: Partial<Record<MdastContent["type"], BlockKind>> = {
  heading: "text", paragraph: "text", list: "text", blockquote: "text",
  code: "code", table: "table", thematicBreak: "none", html: "none",
};

const markdownParser = unified().use(remarkParse).use(remarkGfm);

/* 编辑器这边没有渲染好的块，按预览同样的解析把源码切块（属性区、代码块、表格……） */
function editorSourceBlocks(content: string) {
  const bodyStartLine = frontMatterBodyStartLine(content);
  const body = bodyStartLine > 0 ? splitSourceLines(content).slice(bodyStartLine).join("\n") : content;
  const blocks: SourceBlock[] = bodyStartLine > 0 ? [{ start: 0, end: bodyStartLine - 1, kind: "none" }] : [];
  for (const node of markdownParser.parse(body).children) {
    const kind = MDAST_BLOCK_KIND[node.type];
    if (!kind || !node.position) continue;
    let nodeKind = kind;
    if (node.type === "code" && node.lang === "mermaid") nodeKind = "none";
    blocks.push({
      start: bodyStartLine + node.position.start.line - 1,
      end: bodyStartLine + node.position.end.line - 1,
      kind: nodeKind,
    });
  }
  return blocks;
}

function editorLineColumns(lines: string[], blocks: SourceBlock[], line: number) {
  const block = blocks.find((b) => b.start <= line && line <= b.end);
  if (!block) return [];
  return renderedSourceColumns(lines, block.start, block.end, block.kind).filter((c) => c.line === line);
}

/* 编辑器：从 y 那一行往下找第一个在预览里看得见的字；整行都不出字（图片、围栏、分割线）就按行对齐 */
function editorAnchorAt(cm: any, view: Viewport, y: number): LineAnchor {
  const left = cm.charCoords({ line: cm.firstLine(), ch: 0 }, "window").left + 1;
  let pos = cm.coordsChar({ left, top: y }, "window");
  const row = cm.charCoords(pos, "window");
  if (rowCenter(row) < y) pos = cm.coordsChar({ left, top: row.bottom + 1 }, "window");
  const content: string = cm.getValue();
  const lines = splitSourceLines(content);
  const blocks = editorSourceBlocks(content);
  for (let line = pos.line, from = pos.ch; line <= cm.lastLine(); line++, from = 0) {
    const lineTop = cm.heightAtLine(line, "window");
    if (lineTop >= view.bottom) break;
    if (!lines[line]?.trim()) continue;
    const cols = editorLineColumns(lines, blocks, line);
    if (!cols.length) {
      if (from === 0) return { line, ch: null, offset: lineTop - view.top };
      continue;
    }
    const col = cols.find((c) => c.ch >= from);
    if (col) return { line, ch: col.ch, offset: rowCenter(cm.charCoords(col, "window")) - view.top };
  }
  const line = cm.lineAtHeight(y, "window");
  const lineTop = cm.heightAtLine(line, "window");
  const height = Math.max(1, cm.getLineHandle(line).height);
  return { line: line + clamp((y - lineTop) / height, 0, 1), ch: null, offset: y - view.top };
}

/* 编辑器：光标在视口里就以光标处的字为锚——刚打完字按 Esc，眼睛就停在那里 */
function editorAnchorAtCursor(cm: any, view: Viewport): LineAnchor | null {
  const head = cm.getCursor("head");
  const center = rowCenter(cm.charCoords(head, "window"));
  if (center < view.top || center > view.bottom) return null;
  const content: string = cm.getValue();
  const cols = editorLineColumns(splitSourceLines(content), editorSourceBlocks(content), head.line);
  const col = cols.find((c) => c.ch >= head.ch) || cols[cols.length - 1];
  if (!col) return { line: head.line, ch: null, offset: cm.heightAtLine(head.line, "window") - view.top };
  return { line: head.line, ch: col.ch, offset: rowCenter(cm.charCoords(col, "window")) - view.top };
}

function editorAnchorY(cm: any, anchor: LineAnchor) {
  const first = cm.firstLine();
  const last = cm.lastLine();
  if (anchor.ch != null) {
    return rowCenter(cm.charCoords({ line: clamp(anchor.line, first, last), ch: anchor.ch }, "window"));
  }
  const line = clamp(Math.floor(anchor.line), first, last);
  const lineTop = cm.heightAtLine(line, "window");
  return lineTop + clamp(anchor.line - line, 0, 1) * cm.getLineHandle(line).height;
}

/* ── 对外接口 ────────────────────────────────────── */

/** 阅读态传 preview（渲染好的 markdown 根节点 + 源码），编辑态传 cm */
export type ReadingSurface =
  | { mode: "preview"; root: HTMLElement; content: string }
  | { mode: "editor"; cm: any };

export function captureReadingAnchor(reader: HTMLElement, surface: ReadingSurface, point: Point | null = null): ReadingAnchor | null {
  try {
    const view = readerViewport(reader);
    if (surface.mode === "preview") {
      const lines = splitSourceLines(surface.content);
      if (point) return previewAnchorAtPoint(surface.root, lines, view, point.clientX, point.clientY);
      if (view.scrollTop < 1) return { top: true };
      return previewAnchorAt(surface.root, lines, view, view.top + 1);
    }
    const atCursor = editorAnchorAtCursor(surface.cm, view);
    if (atCursor) return atCursor;
    if (view.scrollTop < 1) return { top: true };
    return editorAnchorAt(surface.cm, view, view.top + 1);
  } catch (err) {
    console.warn("Failed to capture reading position", err);
    return null;
  }
}

export function applyReadingAnchor(reader: HTMLElement, surface: ReadingSurface, anchor: ReadingAnchor) {
  try {
    const view = readerViewport(reader);
    if (anchor.top) {
      view.scrollBy(-view.scrollTop);
      return true;
    }
    const y = surface.mode === "editor"
      ? editorAnchorY(surface.cm, anchor)
      : previewAnchorY(surface.root, splitSourceLines(surface.content), anchor);
    if (y == null || !Number.isFinite(y)) return false;
    view.scrollBy(y - (view.top + anchor.offset));
    return true;
  } catch (err) {
    console.warn("Failed to restore reading position", err);
    return false;
  }
}

/** 进编辑后把光标放在锚点那个字上（双击）或视口左上附近，不滚动 */
export function placeCaretAtAnchor(reader: HTMLElement, cm: any, anchor: ReadingAnchor | null, point: Point | null) {
  try {
    let pos: { line: number; ch: number };
    if (anchor && !anchor.top && point) {
      const line = clamp(Math.floor(anchor.line), cm.firstLine(), cm.lastLine());
      pos = anchor.ch != null
        ? { line, ch: clamp(anchor.ch, 0, (cm.getLine(line) || "").length) }
        : cm.coordsChar({ left: point.clientX, top: editorAnchorY(cm, anchor) + 1 }, "window");
    } else {
      const view = readerViewport(reader);
      const rect = cm.getWrapperElement().getBoundingClientRect();
      pos = cm.coordsChar({ left: rect.left + 1, top: Math.max(view.top, rect.top) + 1 }, "window");
    }
    cm.setCursor(pos, null, { scroll: false });
  } catch (err) {
    console.warn("Failed to place caret", err);
  }
}

/**
 * 切换后几秒内内容高度还会变（图片重新解码、字体晚到、编辑区占位撤掉），期间每变一次就把锚点重新摆回去；
 * 一旦用户自己滚动、按键或点击就放手。返回放手函数。
 */
export function pinReadingAnchor(content: HTMLElement, reapply: () => void) {
  if (typeof ResizeObserver === "undefined") return () => {};
  const observer = new ResizeObserver(() => {
    if (!content.isConnected) release();
    else reapply();
  });
  const timer = setTimeout(release, READING_PIN_MS);
  let released = false;
  function release() {
    if (released) return;
    released = true;
    observer.disconnect();
    clearTimeout(timer);
    for (const type of READING_PIN_RELEASE_EVENTS) window.removeEventListener(type, release, true);
  }
  for (const type of READING_PIN_RELEASE_EVENTS) {
    window.addEventListener(type, release, { capture: true, passive: true });
  }
  observer.observe(content);
  return release;
}

/** 嵌入笔记会把 markdown 拆成几段；算出每段第一行在原文里是第几行 */
export function partLineOffset(transformedBefore: string, embedsBefore: number) {
  // 每个嵌入 ![[笔记]] 在拆段时多插了前后各两个换行
  return newlineCount(transformedBefore) - 4 * embedsBefore;
}

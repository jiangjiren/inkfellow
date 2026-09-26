/* ── Constants ───────────────────────────────────── */
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 440;
const MIN_PANEL_WIDTH = 320;
function getMaxPanelWidth() {
  /* 只给拖拽条留 6px。原来留的是 60px，那点宽度什么都放不下，却又足够把笔记
     预览挤成一条断行的窄带——真正的沉浸是左边一点不剩。
     完全占满到一像素不留也不行：拖拽条会被挤出屏幕，就只能靠按钮退出了。 */
  return Math.max(MIN_PANEL_WIDTH, window.innerWidth - 6);
}
const SIDEBAR_WIDTH_KEY = "inkfellow-sidebar-width-v1";
const PANEL_WIDTH_KEY = "inkfellow-panel-width-v1";
const PANEL_MAXIMIZED_KEY = "inkfellow-panel-maximized-v1";
const SIDEBAR_VISIBLE_KEY = "inkfellow-sidebar-visible-v1";
const PANEL_VISIBLE_KEY = "inkfellow-panel-visible-v1";
const LAST_FILE_KEY = "inkfellow-last-file-v1";
const TABS_KEY = "inkfellow-tabs-v1";
const EXPANDED_KEY = "inkfellow-expanded-v1";
const EDIT_MODE_KEY = "inkfellow-edit-mode-v1";
const IMAGE_ZOOM_MIN = 0.2;
const IMAGE_ZOOM_MAX = 8;
const IMAGE_ZOOM_STEP = 1.12;
const MAX_PASTED_IMAGE_BYTES = 20 * 1024 * 1024;

/* ── State ───────────────────────────────────────── */
const state = {
  vaultPath: "",
  agentUrl: "",
  agentPort: null,
  tree: null,
  activePath: null,
  activeNote: null,
  tabs: [],
  tabScroll: new Map(),
  dirty: false,
  editMode: false,
  // 进出编辑时的阅读锚点：上次切换的记录（判断来回切换之间有没有动过）、图片加载期间的钉住、预览里已解码的图片
  readingAnchorMemo: null,
  readingAnchorPin: null,
  previewImages: null,
  // 新建后尚未命名的笔记：文件名跟随正文首行，用户手动改名或切走即退出
  autoTitlePath: null,
  navHistory: [],
  navIndex: -1,
  expanded: new Set([""]),
  outlineOpen: false,
  gitQuickOpen: false,
  gitWorkspaceOpen: false,
  searchTimer: null,
  searchRequestId: 0,
  savePromise: null,
  pendingImagePastes: new Set(),
  imageViewerLoading: false,
  contextTarget: null,
  gitStatus: null,
  gitPane: "main",
  gitFeedback: null,
  gitFeedbackError: false,
  // 最近一次同步动作的失败分类（network/auth/other），同步成功后清空；驱动状态点变红与提示文案
  gitLastErrorKind: null,
  gitMessage: "",
  gitEditingMessage: false,
  gitBusy: false,
  gitBusyLabel: "",
  gitSelectedFile: null,
  gitDiff: null,
  gitDiffLoading: false,
  gitDiffError: null,
  gitHistory: [],
  gitHistoryLoading: false,
  gitDiscardPath: null,
  gitDiscarding: false,
  docRenderGeneration: 0,
  treeRefreshTimer: null,
  vaultNotesSignature: null,
  agentReady: false,
  agentGenerating: false,
  agentGenerationKnown: false,
  agentToken: null,
  transientVault: false,
  desktopReady: false,
};

let markdownOpenQueue = Promise.resolve(false);

/* ── Tauri bridge ────────────────────────────────── */
function waitForTauri(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (window.__TAURI__?.core?.invoke) { resolve(); return; }
    const start = Date.now();
    const check = setInterval(() => {
      if (window.__TAURI__?.core?.invoke) { clearInterval(check); resolve(); return; }
      if (Date.now() - start > timeoutMs) {
        clearInterval(check);
        reject(new Error("Tauri API timeout: __TAURI__ not available after " + timeoutMs + "ms"));
      }
    }, 50);
  });
}

async function invoke(command, args = {}) {
  const api = window.__TAURI__?.core;
  if (!api?.invoke) throw new Error("Tauri API not available.");
  return api.invoke(command, args);
}

/* ── Utilities ───────────────────────────────────── */
function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }

function qs(id) { return document.getElementById(id); }

function escapeHtml(v) {
  return String(v)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stripExt(name) {
  return name.replace(/\.(md|html?|pdf|png|jpe?g|gif|webp|svg|avif)$/i, "");
}

/* 中文笔记标题长，每级缩进省下的都是标题宽度（VS Code 用 8px） */
const TREE_INDENT_PX = 10;

/* 树里的标题按中间截断显示：尾部这几个字固定不压缩，中段交给 ellipsis。
   按码点切，避免把 emoji 这类代理对切坏。 */
const TREE_LABEL_TAIL_CHARS = 4;
function fillTreeLabel(labelEl, text) {
  const chars = Array.from(text);
  const head = document.createElement("span");
  head.className = "treeLabelHead";
  if (chars.length <= TREE_LABEL_TAIL_CHARS * 2) {
    head.textContent = text;
    labelEl.replaceChildren(head);
    return;
  }
  head.textContent = chars.slice(0, -TREE_LABEL_TAIL_CHARS).join("");
  const tail = document.createElement("span");
  tail.className = "treeLabelTail";
  tail.textContent = chars.slice(-TREE_LABEL_TAIL_CHARS).join("");
  labelEl.replaceChildren(head, tail);
}

function parentFolder(path) {
  if (!path?.includes("/")) return "";
  return path.split("/").slice(0, -1).join("/");
}

function extOf(name) {
  const m = name.match(/\.([^.]+)$/);
  return m ? m[1].toLowerCase() : "";
}

function isImageExt(ext) {
  return /^(png|jpe?g|gif|webp|svg|avif)$/i.test(ext || "");
}

function pastedImageTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function suggestedPastedImageName(file) {
  const original = String(file?.name || "").trim();
  const stem = original.replace(/\.[^.]+$/, "");
  const generic = /^(?:image|screenshot|screen[-_ ]?shot|clipboard|pasted[-_ ]?image)(?:[-_ ]?\d+)?$/i;
  if (!stem || generic.test(stem)) return `image-${pastedImageTimestamp()}`;
  return original;
}

function pastedImageMime(file) {
  const declared = String(file?.type || "").toLowerCase();
  if (/^image\/(?:png|jpeg|gif|webp)$/.test(declared)) return declared;
  const extension = extOf(String(file?.name || ""));
  return {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  }[extension] || "";
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const separator = result.indexOf(",");
      if (separator === -1) reject(new Error("无法读取剪贴板图片。"));
      else resolve(result.slice(separator + 1));
    };
    reader.onerror = () => reject(reader.error || new Error("无法读取剪贴板图片。"));
    reader.readAsDataURL(file);
  });
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(seconds) {
  if (!seconds) return "";
  const d = new Date(seconds * 1000);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/* ── Toast ───────────────────────────────────────── */
let toastTimer;
function showToast(msg) {
  const el = qs("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3800);
}

/* ── Custom dialog (replaces prompt/confirm) ────── */
function showDialog(message, defaultValue = "") {
  return new Promise((resolve) => {
    const overlay = qs("dialog-overlay");
    const msgEl = qs("dialog-message");
    const inputEl = qs("dialog-input");
    const confirmBtn = qs("dialog-confirm");
    const cancelBtn = qs("dialog-cancel");

    msgEl.textContent = message;
    inputEl.value = defaultValue;
    overlay.hidden = false;
    setTimeout(() => { inputEl.focus(); inputEl.select(); }, 50);

    function finish(value) {
      overlay.hidden = true;
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("keydown", onKey);
      resolve(value);
    }

    function onConfirm() { finish(inputEl.value.trim() || null); }
    function onCancel() { finish(null); }
    function onKey(e) {
      if (e.key === "Enter") { e.preventDefault(); finish(inputEl.value.trim() || null); }
      if (e.key === "Escape") { e.preventDefault(); finish(null); }
    }

    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("keydown", onKey);
  });
}

function showConfirm(message) {
  return new Promise((resolve) => {
    const overlay = qs("dialog-overlay");
    const msgEl = qs("dialog-message");
    const inputEl = qs("dialog-input");
    const confirmBtn = qs("dialog-confirm");
    const cancelBtn = qs("dialog-cancel");

    msgEl.textContent = message;
    inputEl.hidden = true;
    confirmBtn.textContent = "删除";
    confirmBtn.style.background = "#cc2d24";
    overlay.hidden = false;
    confirmBtn.focus();

    function finish(value) {
      overlay.hidden = true;
      inputEl.hidden = false;
      confirmBtn.textContent = "确定";
      confirmBtn.style.background = "";
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("keydown", onKey);
      resolve(value);
    }

    function onConfirm() { finish(true); }
    function onCancel() { finish(false); }
    function onKey(e) {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
    }

    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("keydown", onKey);
  });
}

/* ── Dirty state & autosave ──────────────────────── */
const AUTOSAVE_DELAY = 800;

function setDirty(v) {
  state.dirty = v;
}

function scheduleAutosave() {
  clearTimeout(state.autosaveTimer);
  state.autosaveTimer = setTimeout(() => { void saveNote(); }, AUTOSAVE_DELAY);
}

function cancelAutosave() {
  clearTimeout(state.autosaveTimer);
}

/* 切换笔记/模式前把未保存内容落盘，避免丢失 */
async function flushPendingSave() {
  cancelAutosave();
  while (state.pendingImagePastes.size) {
    await Promise.allSettled([...state.pendingImagePastes]);
  }
  while (state.dirty) {
    if (!(await saveNote())) return false;
  }
  return true;
}

async function pasteEditorImage(cm, file, mimeType) {
  const notePath = state.activeNote?.path;
  if (!notePath || state.activeNote?.extension !== "md") return;

  const from = cm.getCursor("from");
  const to = cm.getCursor("to");
  const hasSelection = from.line !== to.line || from.ch !== to.ch;
  const spinner = document.createElement("span");
  spinner.className = "cmImagePastePending";
  spinner.setAttribute("aria-label", "正在保存图片");
  spinner.title = "正在保存图片";

  const selectionMarker = hasSelection
    ? cm.markText(from, to, {
        className: "cmImagePasteSelection",
        clearWhenEmpty: false,
        inclusiveLeft: false,
        inclusiveRight: false,
      })
    : null;
  const insertionMarker = cm.setBookmark(hasSelection ? to : from, {
    widget: spinner,
    insertLeft: false,
  });
  if (hasSelection) cm.setCursor(to);

  try {
    if (file.size > MAX_PASTED_IMAGE_BYTES) throw new Error("图片不能超过 20 MB。");
    const dataBase64 = await readFileAsBase64(file);
    const saved = await invoke("paste_image", {
      notePath,
      originalName: suggestedPastedImageName(file),
      mimeType,
      dataBase64,
    });
    const markedRange = selectionMarker?.find();
    const markedPosition = insertionMarker.find();
    selectionMarker?.clear();
    insertionMarker.clear();

    if (state.activeNote?.path !== notePath || state.editor !== cm) {
      showToast("图片已保存，但当前笔记已切换。");
      return;
    }
    if (!markedRange && !markedPosition) return;

    const insertFrom = markedRange?.from ?? markedPosition;
    const insertTo = markedRange?.to ?? markedPosition;
    const imagePath = `./${encodeWikiMediaTarget(saved.name)}`;
    cm.replaceRange(`![图片](${imagePath})`, insertFrom, insertTo, "paste");
    void loadTree(false).catch(() => {});
  } catch (err) {
    selectionMarker?.clear();
    insertionMarker.clear();
    showToast(String(err));
  }
}

function handleEditorPaste(cm, event) {
  if (state.activeNote?.extension !== "md") return;
  const file = Array.from(event.clipboardData?.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .find((candidate) => candidate && pastedImageMime(candidate));
  const mimeType = pastedImageMime(file);
  if (!file || !mimeType) return;

  event.preventDefault();
  const task = pasteEditorImage(cm, file, mimeType);
  state.pendingImagePastes.add(task);
  void task.finally(() => state.pendingImagePastes.delete(task));
}

/* 保存成功后短暂显示"已保存"（与 web 端一致） */
function flashSavedHint() {
  const el = qs("saved-hint");
  el.hidden = false;
  el.style.animation = "none";
  void el.offsetWidth;
  el.style.animation = "";
  clearTimeout(state.savedHintTimer);
  state.savedHintTimer = setTimeout(() => { el.hidden = true; }, 1700);
}

/* ── Edit / Preview mode ─────────────────────────── */
const EDIT_PENCIL_ICON = `<svg viewBox="0 0 1024 1024" aria-hidden="true" style="transform: scale(1.3)"><path fill="currentColor" d="M846 792H142c-4.4 0-8 3.6-8 8v40c0 4.4 3.6 8 8 8h704c4.4 0 8-3.6 8-8v-40c0-4.4-3.6-8-8-8zM194.7 726.4l157.4-41.5c4.1-1.1 7.8-3.2 10.8-6.2l357.5-357.5c9.4-9.4 9.4-24.6 0-33.9L614.3 181c-9.4-9.4-24.6-9.4-33.9 0L222.9 538.5c-3 3-5.2 6.7-6.2 10.8l-41.5 157.4c-3.2 12 7.6 22.8 19.5 19.7z m62.5-91.8l16.6-63.2c0.7-2.7 2.2-5.3 4.2-7.3l312.3-312.4c3.1-3.1 8.2-3.1 11.3 0l48.1 48.1c3.1 3.1 3.1 8.2 0 11.3L337.3 623.5c-2 2-4.5 3.4-7.2 4.2L267 644.4c-5.9 1.5-11.3-3.9-9.8-9.8z"/></svg>`;
const EXIT_EDIT_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`;

function updateEditButton() {
  const btn = qs("btn-toggle-mode");
  btn.innerHTML = state.editMode ? EXIT_EDIT_ICON : EDIT_PENCIL_ICON;
  btn.title = state.editMode ? "退出编辑模式" : "编辑笔记";
  btn.classList.toggle("editBtnActive", state.editMode);
}

function updateOutlineButton() {
  const btn = qs("btn-outline");
  const title = state.outlineOpen ? "关闭大纲" : "显示大纲";
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.setAttribute("aria-expanded", state.outlineOpen ? "true" : "false");
  btn.setAttribute("aria-pressed", state.outlineOpen ? "true" : "false");
  btn.classList.toggle("editBtnActive", state.outlineOpen);
}

function updateReaderDocumentActions() {
  const visible = Boolean(
    !state.gitWorkspaceOpen
    && state.activeNote
    && /^(md|html?)$/i.test(state.activeNote.extension || ""),
  );
  qs("btn-outline").hidden = !visible;
  qs("btn-toggle-mode").hidden = !visible;
  if (!visible && state.outlineOpen) closeOutline(false);
  else updateOutlineButton();
}

/* 把光标放到当前可视区域顶部附近，避免输入时视图跳走 */
/* 空文档给一行提示；未命名的新笔记顺带把「首行=标题」这条规则说出来 */
function syncEditorPlaceholder() {
  const container = qs("cm-container");
  const cm = state.editor;
  if (!container || !cm) return;
  container.dataset.placeholder = state.autoTitlePath && state.autoTitlePath === state.activeNote?.path
    ? "写下第一行，它会成为标题"
    : "开始写点什么…";
  container.classList.toggle("cmEmpty", cm.getValue() === "");
}

function placeCaretAtVisibleArea() {
  const cm = state.editor;
  if (!cm) return;
  const rect = qs("doc-area").getBoundingClientRect();
  const pos = cm.coordsChar({ left: rect.left + 80, top: rect.top + 60 }, "window");
  cm.setCursor(pos);
}

function normalizeEditTarget(target) {
  if (typeof target === "number") return Number.isFinite(target) ? { line: target } : null;
  if (!target || typeof target !== "object") return null;
  const line = Number(target.line);
  if (!Number.isFinite(line)) return null;
  const normalized = { line };
  const ch = target.ch == null ? NaN : Number(target.ch);
  if (Number.isFinite(ch)) normalized.ch = ch;
  const clientX = Number(target.clientX);
  if (Number.isFinite(clientX)) normalized.clientX = clientX;
  return normalized;
}

function placeCaretAtEditTarget(target, { scroll = true } = {}) {
  const cm = state.editor;
  const normalized = normalizeEditTarget(target);
  if (!cm || !normalized) return;

  const firstLine = typeof cm.firstLine === "function" ? cm.firstLine() : 0;
  const lastLine = typeof cm.lastLine === "function" ? cm.lastLine() : firstLine;
  const line = clamp(Math.round(normalized.line), firstLine, lastLine);
  let pos = { line, ch: 0 };

  if (Number.isFinite(normalized.ch)) {
    pos = { line, ch: clamp(Math.round(normalized.ch), 0, (cm.getLine(line) || "").length) };
  } else if (Number.isFinite(normalized.clientX) && typeof cm.charCoords === "function" && typeof cm.coordsChar === "function") {
    try {
      const lineStart = cm.charCoords({ line, ch: 0 }, "window");
      const lineHeight = Math.max(1, (lineStart.bottom ?? lineStart.top + 20) - lineStart.top);
      const nearClick = cm.coordsChar({ left: normalized.clientX, top: lineStart.top + lineHeight / 2 }, "window");
      const lineText = cm.getLine(line) || "";
      pos = { line, ch: clamp(nearClick.ch, 0, lineText.length) };
    } catch {
      pos = { line, ch: 0 };
    }
  }

  cm.setCursor(pos, null, { scroll });
  if (scroll) cm.scrollIntoView(pos, 80);
  cm.focus();
}

async function setEditMode(on, target = null) {
  if (!(await flushPendingSave())) return;
  const docArea = qs("doc-area");
  const scrollTop = currentReadingScrollTop();
  const markdown = state.activeNote?.extension === "md";
  const point = Number.isFinite(target?.clientX) && Number.isFinite(target?.clientY) ? target : null;
  const captured = markdown ? captureReadingAnchor(point) : null;
  // 来回切换之间没滚动、没改字，就回到上次离开时的锚点，反复切换不会一点点漂走
  const memo = state.readingAnchorMemo;
  const untouched = Boolean(
    !point && memo
    && memo.path === state.activePath
    && memo.editMode === state.editMode
    && memo.content === state.activeNote?.content
    && Math.abs(docArea.scrollTop - memo.scrollTop) < 2,
  );
  const anchor = untouched ? memo.anchor : captured;
  // 预览里解码好的图片留到退出编辑时原样放回，否则图片逐张重新加载，正文会被一截截往下推
  const imageNodes = !on && state.previewImages?.path === state.activePath ? state.previewImages.nodes : undefined;
  state.previewImages = on && markdown ? { path: state.activePath, nodes: captureMarkdownImages() } : null;
  state.editMode = on;
  updateEditButton();
  localStorage.setItem(EDIT_MODE_KEY, on ? "1" : "0");
  renderDocArea({ silent: !on, scrollTop, imageNodes });
  if (anchor && applyReadingAnchor(anchor)) pinReadingAnchor(anchor);
  else if (on || !isHtmlNote()) docArea.scrollTop = scrollTop;
  state.readingAnchorMemo = captured
    ? { path: state.activePath, editMode: on, content: state.activeNote.content, scrollTop: docArea.scrollTop, anchor: captured }
    : null;
  if (on) {
    requestAnimationFrame(() => {
      if (!state.editor) return;
      if (point && anchor) {
        // 双击的字已经被锚点放回鼠标底下，光标直接落在那里，不再滚动
        placeCaretAtEditTarget(anchor.ch != null
          ? { line: anchor.line, ch: anchor.ch }
          : { line: Math.floor(anchor.line), clientX: point.clientX }, { scroll: false });
      } else if (normalizeEditTarget(target)) {
        placeCaretAtEditTarget(target);
      } else {
        placeCaretAtVisibleArea();
      }
    });
  }
}

/* ── Reading anchor：进出编辑时保持阅读位置 ───────── */
/* 预览和源码的排版高度对不上：标题字号、段距不同，一张图在预览里几百像素、在源码里只占一行，
   照搬像素 scrollTop 越往下偏得越多。这里改记「正在读的那个字在源码里的位置 + 它离视口顶多远」，
   切到另一种模式后把同一个字放回同一高度。
   锚点 { line, ch, offset }：ch 是数字时指向一个预览里看得见的字，offset 量它那一行的垂直中心；
   ch 为 null 时按行对齐（图片、分割线这类没有字的块），line 可带小数，offset 量行顶。
   { top: true } 表示停在文档最顶上。 */
const PREVIEW_BLOCK_KIND = { PRE: "code", TABLE: "table", HR: "none", DETAILS: "none" };
const TOKEN_BLOCK_KIND = {
  heading: "text", paragraph: "text", text: "text", list: "text", blockquote: "text",
  code: "code", table: "table", hr: "none", html: "none",
};
const MARKDOWN_ESCAPABLE_RE = /[!-/:-@[-`{-~]/;
const READING_PIN_MS = 3000;
const READING_PIN_RELEASE_EVENTS = ["wheel", "keydown", "pointerdown", "touchstart"];

function splitSourceLines(content) {
  return String(content ?? "").split(/\r\n?|\n/);
}

/* 空白不算字（预览会折叠空白、软换行变成 <br>），代理对的后半截也不单独算 */
function isRenderedChar(text, i) {
  const code = text.charCodeAt(i);
  return !(code >= 0xdc00 && code <= 0xdfff) && !/\s/.test(text[i]);
}

function pushRenderedRange(text, from, to, line, cols) {
  for (let i = from; i < to; i++) if (isRenderedChar(text, i)) cols.push({ line, ch: i });
}

function closingBracketIndex(text, open, to) {
  let depth = 0;
  for (let i = open; i < to; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "[") depth++;
    else if (text[i] === "]" && --depth === 0) return i;
  }
  return -1;
}

/* 链接、图片的 [...] 后面紧跟的 (url "title") 或 [ref]，返回它结束后的位置 */
function linkTailEnd(text, i, to) {
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
function canDelimitEmphasis(text, i, run, from, to) {
  const before = i > from ? text[i - 1] : " ";
  const after = i + run < to ? text[i + run] : " ";
  if (/\s/.test(before) && /\s/.test(after)) return false;
  return !(text[i] === "_" && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after));
}

/* 做强调、删除线定界符时不出字；同一行里找不到能跟它配对的另一段，marked 就按字面显示 */
function isEmphasisRun(text, i, run, from, to) {
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

let wikiSyntaxRenderedCache = null;

/* [[...]] 在预览里渲染成链接还是原样显示，取决于 marked 扩展有没有生效；源码模型跟着实际渲染走 */
function wikiSyntaxRendered() {
  if (wikiSyntaxRenderedCache == null) {
    wikiSyntaxRenderedCache = typeof marked !== "undefined" && renderMarkdownContent("[[x]]").includes("inkwell-wiki:");
  }
  return wikiSyntaxRenderedCache;
}

/* [[目标#标题|别名]]：有别名只显示别名，否则显示「目标 › 标题」（# 和 › 恰好都占一个字） */
function pushWikiColumns(text, from, to, line, cols) {
  const pipe = text.indexOf("|", from);
  const hasPipe = pipe !== -1 && pipe < to;
  if (hasPipe && text.slice(pipe + 1, to).trim()) pushRenderedRange(text, pipe + 1, to, line, cols);
  else pushRenderedRange(text, from, hasPipe ? pipe : to, line, cols);
}

/* 一行行内 Markdown 渲染后，看得见的每个字对应的源码列 */
function pushInlineColumns(text, from, to, line, cols, table = false) {
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
    if (wikiOpen && wikiSyntaxRendered()) {
      const inner = c === "!" ? i + 3 : i + 2;
      const close = text.indexOf("]]", inner);
      if (close !== -1 && close < to) {
        const embedsMedia = c === "!" && isWikiMediaTarget(splitWikiTarget(text.slice(inner, close)).target);
        if (!embedsMedia) pushWikiColumns(text, inner, close, line, cols);
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

/* 行首的引用符、缩进、列表符号、任务框、标题井号（以及标题末尾的闭合井号）都不出字 */
function blockTextRange(text, inFence) {
  let i = 0;
  for (;;) {
    while (text[i] === " " || text[i] === "\t") i++;
    if (text[i] !== ">") break;
    i++;
  }
  if (inFence) return [i, text.length];
  const marker = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/.exec(text.slice(i));
  if (marker) {
    i += marker[0].length;
    const task = /^\[[ xX]\](?:[ \t]+|$)/.exec(text.slice(i));
    if (task) i += task[0].length;
  }
  const heading = /^#{1,6}(?:[ \t]+|$)/.exec(text.slice(i));
  if (!heading) return [i, text.length];
  const from = i + heading[0].length;
  const closing = /[ \t]+#+[ \t]*$/.exec(text);
  return [from, closing && closing.index >= from ? closing.index : text.length];
}

/* 一个块的源码里，渲染后看得见的字各在哪一列。预览和编辑器都靠它在「块内第几个字」和源码位置之间换算 */
function renderedSourceColumns(lines, start, end, kind) {
  const cols = [];
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

function renderedTextChars(el) {
  const chars = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.data;
    for (let i = 0; i < text.length; i++) {
      if (isRenderedChar(text, i)) chars.push({ node, offset: i });
    }
  }
  return chars;
}

function textCharRect({ node, offset }) {
  const code = node.data.charCodeAt(offset);
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, Math.min(node.data.length, offset + (code >= 0xd800 && code <= 0xdbff ? 2 : 1)));
  return range.getBoundingClientRect();
}

function rowCenter(rect) {
  return (rect.top + rect.bottom) / 2;
}

/* 第一个所在行中线不高于 y 的字；都在 y 上面则返回 chars.length */
function firstCharBelow(chars, y) {
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rowCenter(textCharRect(chars[mid])) >= y) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function firstCharAtOrAfter(chars, node, offset) {
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

function caretPointAt(x, y) {
  if (typeof document.caretPositionFromPoint === "function") {
    const pos = document.caretPositionFromPoint(x, y);
    return pos?.offsetNode ? { node: pos.offsetNode, offset: pos.offset } : null;
  }
  const range = document.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/* 预览里带源码行号的块，按文档顺序、行号单调递增；折叠起来没有布局的块不能当锚点 */
function previewSourceBlocks() {
  const root = qs("doc-area")?.querySelector(".document");
  if (!root) return [];
  const blocks = [];
  let lastEnd = -1;
  for (const el of root.querySelectorAll("[data-source-line]")) {
    const start = Number(el.dataset.sourceLine);
    const end = Math.max(start, Number(el.dataset.sourceEndLine ?? start));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start <= lastEnd || !el.getClientRects().length) continue;
    blocks.push({ el, start, end, kind: PREVIEW_BLOCK_KIND[el.tagName] || "text" });
    lastEnd = end;
  }
  return blocks;
}

function firstBlockBelow(blocks, y) {
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
function previewLineY(blocks, line) {
  let prev = null;
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

function previewLineAtY(blocks, y) {
  let prev = null;
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
function previewCharSource(block, chars, k) {
  const cols = renderedSourceColumns(splitSourceLines(state.activeNote?.content), block.start, block.end, block.kind);
  if (!cols.length || !chars.length) return null;
  if (k >= chars.length) {
    const last = cols[cols.length - 1];
    return { line: last.line, ch: last.ch + 1 };
  }
  return cols[Math.min(cols.length - 1, Math.round((k * cols.length) / chars.length))];
}

/* 预览：从 y 往下找第一个能对齐的东西 —— 一行字，或顶边露在视口里的图片、分割线 */
function previewAnchorAt(y) {
  const docArea = qs("doc-area");
  const top = docArea.getBoundingClientRect().top;
  const bottom = top + docArea.clientHeight;
  const blocks = previewSourceBlocks();
  for (let i = firstBlockBelow(blocks, y); i < blocks.length; i++) {
    const block = blocks[i];
    const rect = block.el.getBoundingClientRect();
    if (rect.top >= bottom) break;
    if (block.kind !== "none") {
      const chars = renderedTextChars(block.el);
      const k = firstCharBelow(chars, y);
      const pos = k < chars.length ? previewCharSource(block, chars, k) : null;
      if (pos) return { line: pos.line, ch: pos.ch, offset: rowCenter(textCharRect(chars[k])) - top };
    }
    // 被视口顶截掉一截的图片不拿来对齐：它在源码里只有一行，按它对齐会把下面正在读的字甩远
    if (rect.top >= y - 1) return { line: block.start, ch: null, offset: rect.top - top };
  }
  const line = previewLineAtY(blocks, y);
  return line == null ? null : { line, ch: null, offset: y - top };
}

/* 预览：鼠标点在哪个字上，锚点就是哪个字（双击进编辑用） */
function previewAnchorAtPoint(x, y) {
  const top = qs("doc-area").getBoundingClientRect().top;
  const blocks = previewSourceBlocks();
  const caret = caretPointAt(x, y);
  const block = caret && blocks.find((b) => b.el.contains(caret.node));
  if (block && block.kind !== "none") {
    const chars = renderedTextChars(block.el);
    const k = firstCharAtOrAfter(chars, caret.node, caret.offset);
    const pos = previewCharSource(block, chars, k);
    if (pos) {
      return { line: pos.line, ch: pos.ch, offset: rowCenter(textCharRect(chars[Math.min(k, chars.length - 1)])) - top };
    }
  }
  const line = previewLineAtY(blocks, y);
  return line == null ? null : { line, ch: null, offset: y - top };
}

function previewAnchorY(anchor) {
  const blocks = previewSourceBlocks();
  if (!blocks.length) return null;
  if (anchor.ch == null) return previewLineY(blocks, anchor.line);
  const block = blocks.find((b) => b.start <= anchor.line && anchor.line <= b.end);
  if (block && block.kind !== "none") {
    const cols = renderedSourceColumns(splitSourceLines(state.activeNote?.content), block.start, block.end, block.kind);
    const chars = renderedTextChars(block.el);
    if (cols.length && chars.length) {
      let j = cols.findIndex((c) => c.line > anchor.line || (c.line === anchor.line && c.ch >= anchor.ch));
      if (j === -1) j = cols.length - 1;
      return rowCenter(textCharRect(chars[Math.min(chars.length - 1, Math.round((j * chars.length) / cols.length))]));
    }
  }
  return previewLineY(blocks, anchor.line + 0.5);
}

/* 编辑器这边没有渲染好的块，按预览同样的规则把源码切块（属性区、代码块、表格……） */
function editorSourceBlocks(content) {
  if (typeof marked === "undefined") return [{ start: 0, end: Infinity, kind: "text" }];
  const { body, bodyStartLine } = parseFrontMatter(content);
  const tokens = annotateTokenLines(marked.lexer(body, { breaks: true, gfm: true }), body, bodyStartLine);
  const blocks = bodyStartLine > 0 ? [{ start: 0, end: bodyStartLine - 1, kind: "none" }] : [];
  for (const token of tokens) {
    const kind = TOKEN_BLOCK_KIND[token.type];
    if (kind) blocks.push({ start: token._sl, end: token._el, kind });
  }
  return blocks;
}

function editorLineColumns(lines, blocks, line) {
  const block = blocks.find((b) => b.start <= line && line <= b.end);
  if (!block) return [];
  return renderedSourceColumns(lines, block.start, block.end, block.kind).filter((c) => c.line === line);
}

/* 编辑器：从 y 那一行往下找第一个在预览里看得见的字；整行都不出字（图片、围栏、分割线）就按行对齐 */
function editorAnchorAt(y) {
  const cm = state.editor;
  const docArea = qs("doc-area");
  const top = docArea.getBoundingClientRect().top;
  const bottom = top + docArea.clientHeight;
  const left = cm.charCoords({ line: cm.firstLine(), ch: 0 }, "window").left + 1;
  let pos = cm.coordsChar({ left, top: y }, "window");
  const row = cm.charCoords(pos, "window");
  if (rowCenter(row) < y) pos = cm.coordsChar({ left, top: row.bottom + 1 }, "window");
  const content = cm.getValue();
  const lines = splitSourceLines(content);
  const blocks = editorSourceBlocks(content);
  for (let line = pos.line, from = pos.ch; line <= cm.lastLine(); line++, from = 0) {
    const lineTop = cm.heightAtLine(line, "window");
    if (lineTop >= bottom) break;
    if (!lines[line]?.trim()) continue;
    const cols = editorLineColumns(lines, blocks, line);
    if (!cols.length) {
      if (from === 0) return { line, ch: null, offset: lineTop - top };
      continue;
    }
    const col = cols.find((c) => c.ch >= from);
    if (col) return { line, ch: col.ch, offset: rowCenter(cm.charCoords(col, "window")) - top };
  }
  const line = cm.lineAtHeight(y, "window");
  const lineTop = cm.heightAtLine(line, "window");
  const height = Math.max(1, cm.getLineHandle(line).height);
  return { line: line + clamp((y - lineTop) / height, 0, 1), ch: null, offset: y - top };
}

/* 编辑器：光标在视口里就以光标处的字为锚——刚打完字按 Esc，眼睛就停在那里 */
function editorAnchorAtCursor() {
  const cm = state.editor;
  const docArea = qs("doc-area");
  const top = docArea.getBoundingClientRect().top;
  const head = cm.getCursor("head");
  const center = rowCenter(cm.charCoords(head, "window"));
  if (center < top || center > top + docArea.clientHeight) return null;
  const content = cm.getValue();
  const cols = editorLineColumns(splitSourceLines(content), editorSourceBlocks(content), head.line);
  const col = cols.find((c) => c.ch >= head.ch) || cols[cols.length - 1];
  if (!col) return { line: head.line, ch: null, offset: cm.heightAtLine(head.line, "window") - top };
  return { line: head.line, ch: col.ch, offset: rowCenter(cm.charCoords(col, "window")) - top };
}

function editorAnchorY(anchor) {
  const cm = state.editor;
  const first = cm.firstLine();
  const last = cm.lastLine();
  if (anchor.ch != null) {
    return rowCenter(cm.charCoords({ line: clamp(anchor.line, first, last), ch: anchor.ch }, "window"));
  }
  const line = clamp(Math.floor(anchor.line), first, last);
  const lineTop = cm.heightAtLine(line, "window");
  return lineTop + clamp(anchor.line - line, 0, 1) * cm.getLineHandle(line).height;
}

function captureReadingAnchor(point = null) {
  const docArea = qs("doc-area");
  if (!docArea) return null;
  try {
    if (point && !state.editMode) return previewAnchorAtPoint(point.clientX, point.clientY);
    if (state.editMode) {
      if (!state.editor) return null;
      const atCursor = editorAnchorAtCursor();
      if (atCursor) return atCursor;
    }
    if (docArea.scrollTop < 1) return { top: true };
    const y = docArea.getBoundingClientRect().top + 1;
    return state.editMode ? editorAnchorAt(y) : previewAnchorAt(y);
  } catch (err) {
    console.warn("Failed to capture reading position", err);
    return null;
  }
}

function applyReadingAnchor(anchor) {
  const docArea = qs("doc-area");
  if (!docArea) return false;
  if (anchor.top) {
    docArea.scrollTop = 0;
    return true;
  }
  try {
    const y = state.editMode ? (state.editor ? editorAnchorY(anchor) : null) : previewAnchorY(anchor);
    if (!Number.isFinite(y)) return false;
    docArea.scrollTop += y - (docArea.getBoundingClientRect().top + anchor.offset);
    return true;
  } catch (err) {
    console.warn("Failed to restore reading position", err);
    return false;
  }
}

/* 切换后几秒内内容高度还会变（新插入的图片解码、字体晚到），期间每变一次就把锚点重新摆回去；
   一旦用户自己滚动、按键或点击就放手。 */
function pinReadingAnchor(anchor) {
  releaseReadingAnchorPin();
  const docArea = qs("doc-area");
  const content = docArea?.firstElementChild;
  if (!content || typeof ResizeObserver === "undefined") return;
  const observer = new ResizeObserver(() => {
    if (!content.isConnected) {
      release();
      return;
    }
    applyReadingAnchor(anchor);
    if (state.readingAnchorMemo) state.readingAnchorMemo.scrollTop = docArea.scrollTop;
  });
  const timer = setTimeout(() => release(), READING_PIN_MS);
  function release() {
    observer.disconnect();
    clearTimeout(timer);
    for (const type of READING_PIN_RELEASE_EVENTS) window.removeEventListener(type, release, true);
    if (state.readingAnchorPin === release) state.readingAnchorPin = null;
  }
  for (const type of READING_PIN_RELEASE_EVENTS) {
    window.addEventListener(type, release, { capture: true, passive: true });
  }
  observer.observe(content);
  state.readingAnchorPin = release;
}

function releaseReadingAnchorPin() {
  state.readingAnchorPin?.();
}

/* ── Wiki Links ──────────────────────────────────── */
const WIKI_MEDIA_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|mp4|webm|mov|m4v|mp3|wav|ogg|flac|pdf)$/i;

function isWikiMediaTarget(t) {
  return WIKI_MEDIA_EXT_RE.test(t.trim());
}

function splitWikiTarget(inner) {
  const pipIdx = inner.indexOf("|");
  const core = pipIdx !== -1 ? inner.slice(0, pipIdx) : inner;
  const alias = pipIdx !== -1 ? inner.slice(pipIdx + 1).trim() : "";
  const hashIdx = core.indexOf("#");
  return {
    target: (hashIdx !== -1 ? core.slice(0, hashIdx) : core).trim(),
    heading: hashIdx !== -1 ? core.slice(hashIdx + 1).trim() : "",
    alias,
  };
}

function encodeWikiMediaTarget(value) {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    try { return new URL(value).href; } catch { return value; }
  }

  return value.split("/").map((segment) => {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch {}
    return encodeURIComponent(decoded).replace(/[!'()*]/g, (char) =>
      `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  }).join("/");
}

/** Parse [[...]] as an inline extension so fenced and inline code remain literal. */
const wikiSyntaxExtension = {
  name: "wikiSyntax",
  level: "inline",
  start(src) {
    return src.search(/!?\[\[/);
  },
  tokenizer(src) {
    const match = /^(!?)\[\[([^\]\n]+)\]\]/.exec(src);
    if (!match) return undefined;
    return { type: "wikiSyntax", raw: match[0], embed: match[1] === "!", inner: match[2] };
  },
  renderer(token) {
    const { target, heading, alias } = splitWikiTarget(token.inner);
    if (!target) return escapeHtml(token.raw);

    if (token.embed && isWikiMediaTarget(target)) {
      const src = encodeWikiMediaTarget(target);
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alias || target)}">`;
    }

    const display = alias || (heading ? `${target} › ${heading}` : target);
    let href = "inkwell-wiki:" + encodeURIComponent(target);
    if (heading) href += encodeURIComponent("#" + heading);
    return `<a href="${href}">${escapeHtml(display || token.raw)}</a>`;
  },
};

if (typeof marked !== "undefined" && typeof marked.use === "function") {
  marked.use({ extensions: [wikiSyntaxExtension] });
}

/** Build a lowercase name/path → vault-relative path index from the current tree. */
function buildNoteIndex() {
  const index = new Map();
  for (const file of flattenFiles(state.tree)) {
    if (!file.name.endsWith(".md")) continue;
    const nameKey = stripExt(file.name).toLowerCase();
    if (!index.has(nameKey)) index.set(nameKey, file.path);
    const pathKey = stripExt(file.path).toLowerCase().replace(/\\/g, "/");
    if (!index.has(pathKey)) index.set(pathKey, file.path);
  }
  return index;
}

/** Wire click handlers on all inkwell-wiki: anchors after rendering. */
function wireWikiLinks(noteIndex) {
  const container = qs("prose-content");
  if (!container) return;

  container.querySelectorAll('a[href^="inkwell-wiki:"]').forEach((a) => {
    const raw = a.getAttribute("href").slice("inkwell-wiki:".length);
    const pctHash = raw.indexOf("%23");
    const targetEnc = pctHash !== -1 ? raw.slice(0, pctHash) : raw;
    const headingEnc = pctHash !== -1 ? raw.slice(pctHash + 3) : "";
    let target = targetEnc;
    let heading = headingEnc;
    try { target = decodeURIComponent(targetEnc); } catch {}
    try { heading = headingEnc ? decodeURIComponent(headingEnc) : ""; } catch {}
    const key = target.toLowerCase().replace(/\.md$/i, "");
    const resolvedPath = noteIndex.get(key);

    a.href = "#";
    if (resolvedPath) {
      a.classList.add("wikiLink");
      a.addEventListener("click", (e) => {
        e.preventDefault();
        loadNote(resolvedPath).then(() => {
          if (!heading) return;
          requestAnimationFrame(() => {
            const slug = heading.toLowerCase().trim()
              .replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]/gu, "") || "heading";
            const el = document.getElementById(`h-${slug}`);
            if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
          });
        });
      });
    } else {
      a.classList.add("wikiLink", "wikiLinkMissing");
      a.addEventListener("click", (e) => {
        e.preventDefault();
        createWikiNote(target);
      });
    }
  });
}

/** Create a new note for a missing wiki link target and navigate to it. */
async function createWikiNote(target) {
  const folder = state.activePath ? parentFolder(state.activePath) : "";
  // If target contains a slash, split into folder + filename
  const slashIdx = target.lastIndexOf("/");
  const noteName = slashIdx !== -1 ? target.slice(slashIdx + 1) : target;
  const noteFolder = slashIdx !== -1
    ? (folder ? `${folder}/${target.slice(0, slashIdx)}` : target.slice(0, slashIdx))
    : folder;
  try {
    const note = await invoke("create_note", { folder: noteFolder, title: noteName });
    if (noteFolder) state.expanded.add(noteFolder);
    await loadTree(false);
    await loadNote(note.path);
    await setEditMode(true);
  } catch (err) {
    if (String(err).includes("already exists")) {
      const safeName = noteName.replace(/\.md$/i, "");
      const path = noteFolder ? `${noteFolder}/${safeName}.md` : `${safeName}.md`;
      await loadNote(path);
    } else {
      showToast("创建笔记失败：" + err);
    }
  }
}

/** Append backlinks panel below the article (async). */
async function renderBacklinksPanel(notePath, renderGeneration) {
  try {
    const backlinks = await invoke("wiki_backlinks", { path: notePath });
    // Guard: note may have changed while waiting
    if (state.activeNote?.path !== notePath || state.docRenderGeneration !== renderGeneration) return;
    const container = qs("prose-content");
    if (!container) return;

    const existing = document.getElementById("backlinks-panel");
    if (existing) existing.remove();
    if (!backlinks || backlinks.length === 0) return;

    const panel = document.createElement("div");
    panel.id = "backlinks-panel";
    panel.className = "backlinksPanel";

    const header = document.createElement("div");
    header.className = "backlinksPanelTitle";
    header.textContent = `${backlinks.length} 处引用`;
    panel.appendChild(header);

    for (const link of backlinks) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "backlinkItem";
      item.innerHTML = `<span class="backlinkSource">${escapeHtml(link.sourceName)}</span><span class="backlinkContext">${escapeHtml(link.context)}</span>`;
      item.addEventListener("click", () => loadNote(link.sourcePath));
      panel.appendChild(item);
    }

    container.closest(".document")?.appendChild(panel);
  } catch {
    // Silently ignore; backlinks are non-critical
  }
}

/** [[ autocomplete hint function for CodeMirror (desktop). */
function desktopWikiHint(cm) {
  const cursor = cm.getCursor();
  const line = cm.getLine(cursor.line);
  const before = line.slice(0, cursor.ch);

  const bracketStart = before.lastIndexOf("[[");
  if (bracketStart === -1) return { list: [], from: cursor, to: cursor };

  const afterBrackets = before.slice(bracketStart + 2);
  if (afterBrackets.includes("]]")) return { list: [], from: cursor, to: cursor };

  const files = flattenFiles(state.tree).filter((f) => f.name.endsWith(".md"));
  const names = files.map((f) => stripExt(f.name));
  const query = afterBrackets.toLowerCase();

  const matches = names
    .filter((name) => !query || name.toLowerCase().includes(query))
    .sort((a, b) => {
      if (a.toLowerCase() === query) return -1;
      if (b.toLowerCase() === query) return 1;
      const aS = a.toLowerCase().startsWith(query);
      const bS = b.toLowerCase().startsWith(query);
      if (aS && !bS) return -1;
      if (!aS && bS) return 1;
      return a.localeCompare(b);
    })
    .slice(0, 20)
    .map((name) => ({ text: name + "]]", displayText: name }));

  if (matches.length === 0) return { list: [], from: cursor, to: cursor };

  return { list: matches, from: { line: cursor.line, ch: bracketStart + 2 }, to: cursor };
}

/* ── Markdown rendering ──────────────────────────── */
// Inject data-source-line on top-level block elements so double-click and mode switches can map back to editor lines.
function sourceTokenSelector(token) {
  if (token.type === "heading") return `h${token.depth}`;
  if (token.type === "paragraph" || token.type === "text") return "p";
  if (token.type === "list") return token.ordered ? "ol" : "ul";
  if (token.type === "blockquote") return "blockquote";
  if (token.type === "code") return "pre";
  if (token.type === "table") return "table";
  if (token.type === "hr") return "hr";
  return "";
}

/* 给顶层 token 标上源码行区间（首尾行都含）。marked 会把链接定义（[id]: url）整行吞掉、
   不产出 token，只按 raw 累加行数会从那里开始整体错位，所以每个 token 都回源码里对一下位置。 */
function annotateTokenLines(tokens, source, lineOffset = 0) {
  const src = source
    .replace(/\r\n|\r/g, "\n")
    .replace(/^( *)(\t+)/gm, (_, leading, tabs) => leading + "    ".repeat(tabs.length));
  const newlines = (text) => (text.match(/\n/g) || []).length;
  let offset = 0;
  let line = lineOffset;
  for (const tok of tokens) {
    const raw = tok.raw || "";
    const at = !raw || src.startsWith(raw, offset) ? offset : src.indexOf(raw, offset);
    if (at > offset) {
      line += newlines(src.slice(offset, at));
      offset = at;
    }
    tok._sl = line;
    tok._el = line + newlines(raw.replace(/\n+$/, ""));
    line += newlines(raw);
    offset += raw.length;
  }
  return tokens;
}

/* HTML 块自己产出的元素要跳过，否则会被下一个段落 token 认领，之后的行号全部错一位。
   只开不合的标签（<div> 自成一块、中间夹着 Markdown）会把后面的内容包进去，
   这种只跳过外层，让里面的块照常认领。 */
function skipHtmlTokenElements(token, elements, index) {
  const probe = document.createElement("template");
  probe.innerHTML = sanitizeMarkdownHtml(token.raw || "");
  for (const expected of probe.content.children) {
    const el = elements[index];
    if (!el || el.tagName !== expected.tagName) break;
    const wrapsFollowingBlocks = el.getElementsByTagName("*").length > expected.getElementsByTagName("*").length;
    index++;
    if (!wrapsFollowingBlocks) while (index < elements.length && el.contains(elements[index])) index++;
  }
  return index;
}

function injectSourceLineAttrs(html, tokens) {
  if (typeof document === "undefined") return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  const elements = Array.from(template.content.querySelectorAll("*"));
  let elementIndex = 0;

  for (const token of tokens) {
    if (token.type === "html") {
      elementIndex = skipHtmlTokenElements(token, elements, elementIndex);
      continue;
    }
    const selector = sourceTokenSelector(token);
    if (!selector || !Number.isFinite(token._sl)) continue;
    for (; elementIndex < elements.length; elementIndex++) {
      const el = elements[elementIndex];
      if (!el.matches(selector)) continue;
      el.dataset.sourceLine = String(token._sl);
      el.dataset.sourceEndLine = String(Number.isFinite(token._el) ? token._el : token._sl);
      elementIndex++;
      while (elementIndex < elements.length && el.contains(elements[elementIndex])) elementIndex++;
      break;
    }
  }

  return template.innerHTML;
}

const MARKDOWN_URI_ALLOWLIST = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|inkwell-wiki):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

function sanitizeMarkdownHtml(html) {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "base", "meta", "link"],
    FORBID_ATTR: ["style"],
    ALLOWED_URI_REGEXP: MARKDOWN_URI_ALLOWLIST,
    ALLOW_DATA_ATTR: false,
    SANITIZE_NAMED_PROPS: true,
  });
}

function renderMarkdownContent(md, options = {}) {
  if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
    return `<pre>${escapeHtml(md)}</pre>`;
  }
  const lineOffset = Number.isFinite(options.lineOffset) ? options.lineOffset : 0;
  // Notes are authored line-by-line in the editor, so preserve single newlines in
  // the preview instead of collapsing GFM soft breaks into spaces.
  const tokens = annotateTokenLines(marked.lexer(md, { breaks: true, gfm: true }), md, lineOffset);
  const html = marked.parser(tokens, { breaks: true, gfm: true });
  return injectSourceLineAttrs(sanitizeMarkdownHtml(html), tokens);
}

function previewClickEditTarget(event, block) {
  const startLine = parseInt(block.dataset.sourceLine, 10);
  if (!Number.isFinite(startLine)) return null;

  const endLine = parseInt(block.dataset.sourceEndLine, 10);
  let line = startLine;
  if (Number.isFinite(endLine) && endLine > startLine) {
    const rect = block.getBoundingClientRect();
    const ratio = rect.height > 0 ? clamp((event.clientY - rect.top) / rect.height, 0, 0.999) : 0;
    line = Math.round(startLine + ratio * (endLine - startLine));
  }

  return { line, clientX: event.clientX };
}

const DIFF_FLASH_BLOCK_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,th";
const DIFF_LCS_CELL_LIMIT = 250000;

function normalizeDiffText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function collectDiffBlocks(root = qs("doc-area")) {
  if (!root) return [];
  const candidates = [...root.querySelectorAll(DIFF_FLASH_BLOCK_SELECTOR)];
  return candidates
    .filter((el) => !candidates.some((other) => other !== el && el.contains(other)))
    .map((el) => ({ el, text: normalizeDiffText(el.textContent) }))
    .filter((block) => block.text.length > 0);
}

function changedNewBlockIndexes(oldValues, newValues) {
  const changed = new Set();
  if (newValues.length === 0) return changed;
  if (oldValues.length === 0) {
    newValues.forEach((_, i) => changed.add(i));
    return changed;
  }

  let start = 0;
  while (
    start < oldValues.length &&
    start < newValues.length &&
    oldValues[start] === newValues[start]
  ) {
    start++;
  }

  let oldEnd = oldValues.length - 1;
  let newEnd = newValues.length - 1;
  while (
    oldEnd >= start &&
    newEnd >= start &&
    oldValues[oldEnd] === newValues[newEnd]
  ) {
    oldEnd--;
    newEnd--;
  }

  if (newEnd < start) return changed;

  const oldLen = oldEnd - start + 1;
  const newLen = newEnd - start + 1;
  if (oldLen <= 0) {
    for (let i = start; i <= newEnd; i++) changed.add(i);
    return changed;
  }

  const cells = (oldLen + 1) * (newLen + 1);
  if (cells > DIFF_LCS_CELL_LIMIT) {
    for (let i = start; i <= newEnd; i++) changed.add(i);
    return changed;
  }

  const cols = newLen + 1;
  const Table = Math.min(oldLen, newLen) > 65535 ? Uint32Array : Uint16Array;
  const dp = new Table((oldLen + 1) * cols);

  for (let i = 1; i <= oldLen; i++) {
    const oldText = oldValues[start + i - 1];
    for (let j = 1; j <= newLen; j++) {
      const idx = i * cols + j;
      if (oldText === newValues[start + j - 1]) {
        dp[idx] = dp[(i - 1) * cols + j - 1] + 1;
      } else {
        dp[idx] = Math.max(dp[(i - 1) * cols + j], dp[i * cols + j - 1]);
      }
    }
  }

  const matchedNew = new Set();
  let i = oldLen;
  let j = newLen;
  while (i > 0 && j > 0) {
    if (oldValues[start + i - 1] === newValues[start + j - 1]) {
      matchedNew.add(start + j - 1);
      i--;
      j--;
    } else if (dp[(i - 1) * cols + j] >= dp[i * cols + j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  for (let index = start; index <= newEnd; index++) {
    if (!matchedNew.has(index)) changed.add(index);
  }
  return changed;
}

function flashElement(el) {
  if (!el) return;
  el.classList.remove("diff-flash");
  void el.offsetWidth;
  el.classList.add("diff-flash");
  el.addEventListener("animationend", () => el.classList.remove("diff-flash"), { once: true });
}

function flashChangedPreviewBlocks(oldBlockTexts) {
  requestAnimationFrame(() => {
    const blocks = collectDiffBlocks();
    const changedIndexes = changedNewBlockIndexes(oldBlockTexts, blocks.map((block) => block.text));
    changedIndexes.forEach((index) => flashElement(blocks[index]?.el));
  });
}

const TAG_KEYS = new Set(["tags", "tag", "aliases", "alias"]);

function parseFrontMatter(content) {
  const empty = { data: {}, body: content, bodyStartLine: 0 };
  if (!content.startsWith("---")) return empty;
  const firstNewline = content.indexOf("\n");
  if (firstNewline === -1) return empty;

  const rest = content.slice(firstNewline + 1);
  const closingMatch = /^---[ \t]*$/m.exec(rest);
  if (!closingMatch || closingMatch.index === undefined) return empty;

  const yamlContent = rest.slice(0, closingMatch.index);
  const afterClose = rest.slice(closingMatch.index + closingMatch[0].length);
  const body = afterClose.startsWith("\n") ? afterClose.slice(1) : afterClose;
  const frontMatterText = content.slice(0, firstNewline + 1 + closingMatch.index + closingMatch[0].length);
  const bodyStartLine =
    (frontMatterText.match(/\n/g) || []).length + (afterClose.startsWith("\n") ? 1 : 0);

  const data = {};
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
      const items = [];
      i++;
      while (i < lines.length && /^\s+-/.test(lines[i])) {
        const item = lines[i].replace(/^\s+-\s*/, "").trim();
        if (item) items.push(item);
        i++;
      }
      data[key] = items;
      continue;
    }

    if (!valueStr) { data[key] = null; i++; continue; }

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

  return { data, body, bodyStartLine };
}

function renderFrontMatterPanel(data, bodyStartLine = 0) {
  const entries = Object.entries(data);
  if (entries.length === 0) return "";

  const rows = entries.map(([key, value]) => {
    const isTagField = TAG_KEYS.has(key.toLowerCase());
    const items = Array.isArray(value) ? value : null;

    let valueHtml;
    if (value === null || value === "") {
      valueHtml = `<span class="frontMatterEmpty">—</span>`;
    } else if (items !== null) {
      if (items.length === 0) {
        valueHtml = `<span class="frontMatterEmpty">—</span>`;
      } else if (isTagField) {
        const tags = items
          .map((item) => `<span class="frontMatterTag">${escapeHtml(item)}</span>`)
          .join("");
        valueHtml = `<span class="frontMatterTags">${tags}</span>`;
      } else {
        const listItems = items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
        valueHtml = `<ul class="frontMatterList">${listItems}</ul>`;
      }
    } else if (typeof value === "boolean") {
      valueHtml = `<span class="frontMatterBool">${value ? "true" : "false"}</span>`;
    } else {
      valueHtml = escapeHtml(String(value));
    }

    return `
      <div class="frontMatterRow">
        <dt class="frontMatterKey">${escapeHtml(key)}</dt>
        <dd class="frontMatterValue">${valueHtml}</dd>
      </div>
    `;
  }).join("");

  const sourceAttrs = bodyStartLine > 0
    ? ` data-source-line="0" data-source-end-line="${bodyStartLine - 1}"`
    : "";
  return `
    <details class="frontMatter"${sourceAttrs}>
      <summary class="frontMatterLabel">笔记属性</summary>
      <dl class="frontMatterGrid">${rows}</dl>
    </details>
  `;
}

/* ── TOC extraction ──────────────────────────────── */
/* slug 保留中文等 Unicode 字符；重复标题追加序号保证唯一 */
function slugifyHeading(text, seen) {
  const base = text.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]/gu, "") || "heading";
  const count = seen.get(base) || 0;
  seen.set(base, count + 1);
  return count > 0 ? `${base}-${count}` : base;
}

function extractToc(markdown) {
  const lines = markdown.split("\n");
  const entries = [];
  const seen = new Map();
  let inCode = false;
  for (const line of lines) {
    if (line.trim().startsWith("```")) { inCode = !inCode; continue; }
    if (inCode) continue;
    const m = line.match(/^(#{1,6})\s+(.+)$/);
    if (m) {
      const level = m[1].length;
      const text = m[2].replace(/[*_`~\[\]]/g, "").trim();
      entries.push({ level, text, slug: slugifyHeading(text, seen) });
    }
  }
  return entries;
}

function isHtmlNote(note = state.activeNote) {
  return /^html?$/i.test(note?.extension || "");
}

function htmlFrame() {
  return qs("html-frame");
}

function extractHtmlToc(frame = htmlFrame()) {
  const doc = frame?.contentDocument;
  if (!doc) return [];
  const seen = new Map();
  const entries = [];
  doc.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((heading, index) => {
    const text = heading.textContent?.trim();
    if (!text) return;
    let fragment = heading.id;
    if (!fragment) {
      const base = slugifyHeading(text, seen);
      fragment = base;
      let suffix = 1;
      while (doc.getElementById(fragment)) {
        fragment = `${base}-${suffix++}`;
      }
      heading.id = fragment;
    }
    const key = `html-heading-${index}`;
    heading.dataset.inkfellowHeadingKey = key;
    entries.push({
      level: Number(heading.tagName.slice(1)),
      text,
      slug: key,
      fragment,
      heading,
      html: true,
    });
  });
  return entries;
}

function renderToc() {
  const list = qs("toc-list");
  const empty = qs("toc-empty");
  const count = qs("toc-count");
  if (!list || !empty || !count) return;
  list.replaceChildren();

  if (!state.activeNote || !/^(md|html?)$/i.test(state.activeNote.extension)) {
    empty.hidden = false;
    count.textContent = "";
    return;
  }

  const htmlPreview = isHtmlNote() && !state.editMode;
  const entries = htmlPreview
    ? extractHtmlToc()
    : extractToc(state.editMode && state.editor
      ? state.editor.getValue()
      : state.activeNote.content);

  empty.hidden = entries.length > 0;
  count.textContent = entries.length > 0 ? entries.length : "";

  for (const entry of entries) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = entry.text;
    btn.dataset.slug = entry.slug;
    btn.className = "articleTocLink" + (entry.level > 2 ? " articleTocLinkSub" : "");
    btn.addEventListener("click", () => {
      if (entry.html) {
        scrollHtmlFrameToFragment(htmlFrame(), entry.fragment, {
          behavior: "smooth",
          pushHistory: true,
        });
        return;
      }
      const docArea = qs("doc-area");
      const heading = docArea.querySelector(`[data-heading-slug="${entry.slug}"]`);
      if (heading) heading.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    li.appendChild(btn);
    list.appendChild(li);
  }

  updateActiveTocLink();
}

/* 滚动跟随：高亮阅读位置所在的标题（与 web 端大纲行为一致） */
function updateActiveTocLink() {
  const list = qs("toc-list");
  if (!list.childElementCount) return;
  if (isHtmlNote() && !state.editMode) {
    const frame = htmlFrame();
    const doc = frame?.contentDocument;
    const view = frame?.contentWindow;
    const headings = doc?.querySelectorAll("[data-inkfellow-heading-key]");
    if (!headings?.length) return;
    let active = headings[0].dataset.inkfellowHeadingKey;
    const atBottom = view
      && view.scrollY + view.innerHeight >= doc.documentElement.scrollHeight - 2;
    if (atBottom) {
      active = headings[headings.length - 1].dataset.inkfellowHeadingKey;
    } else {
      for (const heading of headings) {
        if (heading.getBoundingClientRect().top <= 90) {
          active = heading.dataset.inkfellowHeadingKey;
        } else {
          break;
        }
      }
    }
    list.querySelectorAll(".articleTocLink").forEach((btn) => {
      btn.classList.toggle("articleTocLinkActive", btn.dataset.slug === active);
    });
    return;
  }
  const docArea = qs("doc-area");
  const headings = docArea.querySelectorAll("[data-heading-slug]");
  if (!headings.length) return;

  const threshold = docArea.getBoundingClientRect().top + 90;
  let active = headings[0].getAttribute("data-heading-slug");
  for (const h of headings) {
    if (h.getBoundingClientRect().top <= threshold) {
      active = h.getAttribute("data-heading-slug");
    } else {
      break;
    }
  }

  list.querySelectorAll(".articleTocLink").forEach((btn) => {
    btn.classList.toggle("articleTocLinkActive", btn.dataset.slug === active);
  });
}

function decodeHtmlFragment(value) {
  let fragment = String(value || "").replace(/^#/, "");
  try { fragment = decodeURIComponent(fragment); } catch {}
  return fragment;
}

function htmlFragmentTarget(doc, fragment) {
  fragment = decodeHtmlFragment(fragment);
  if (!fragment) return doc.documentElement;
  return doc.getElementById(fragment) || doc.getElementsByName(fragment)[0] || null;
}

function scrollHtmlFrameToFragment(frame, fragment, options = {}) {
  const doc = frame?.contentDocument;
  const view = frame?.contentWindow;
  if (!doc || !view) return false;
  const decoded = decodeHtmlFragment(fragment);
  const target = htmlFragmentTarget(doc, decoded);
  if (!target) return false;
  if (!decoded) view.scrollTo({ top: 0, behavior: options.behavior || "auto" });
  else target.scrollIntoView({ behavior: options.behavior || "auto", block: "start" });
  if (options.pushHistory && state.activePath) navPush(state.activePath, decoded);
  if (state.outlineOpen) requestAnimationFrame(updateActiveTocLink);
  updateNavButtons();
  return true;
}

function currentReadingScrollTop() {
  const frame = isHtmlNote() && !state.editMode ? htmlFrame() : null;
  if (frame?.contentWindow) {
    return frame.contentWindow.scrollY
      || frame.contentDocument?.documentElement?.scrollTop
      || frame.contentDocument?.body?.scrollTop
      || 0;
  }
  return qs("doc-area")?.scrollTop || 0;
}

function htmlPreviewBaseHref(notePath = state.activePath) {
  const convertFileSrc = window.__TAURI__?.core?.convertFileSrc;
  if (!convertFileSrc || !state.vaultPath) return "";
  const separator = state.vaultPath.includes("\\") ? "\\" : "/";
  const root = state.vaultPath.replace(/[\\/]+$/, "");
  const folder = parentFolder(notePath || "").replaceAll("/", separator);
  const absoluteFolder = folder ? `${root}${separator}${folder}` : root;
  const url = convertFileSrc(absoluteFolder, "asset");
  return url.endsWith("/") ? url : `${url}/`;
}

function htmlPreviewContent(content, notePath = state.activePath) {
  const baseHref = htmlPreviewBaseHref(notePath);
  if (!baseHref) return content;
  const existingBase = /(<base\b[^>]*\bhref\s*=\s*)(["'])([^"']*)\2/i;
  const match = content.match(existingBase);
  if (match) {
    try {
      const resolved = new URL(match[3], baseHref).href;
      return content.replace(existingBase, () => `${match[1]}${match[2]}${resolved}${match[2]}`);
    } catch {
      return content;
    }
  }
  const baseTag = `<base href="${escapeHtml(baseHref)}">`;
  const head = content.match(/<head\b[^>]*>/i);
  if (head?.index != null) {
    const insertion = head.index + head[0].length;
    return `${content.slice(0, insertion)}${baseTag}${content.slice(insertion)}`;
  }
  const html = content.match(/<html\b[^>]*>/i);
  if (html?.index != null) {
    const insertion = html.index + html[0].length;
    return `${content.slice(0, insertion)}<head>${baseTag}</head>${content.slice(insertion)}`;
  }
  return `<head>${baseTag}</head>${content}`;
}

function findLinkedNote(rawPath) {
  let decoded = rawPath;
  try { decoded = decodeURIComponent(rawPath); } catch {}
  decoded = decoded.replaceAll("\\", "/");
  const noteDir = parentFolder(state.activePath || "");
  const resolved = decoded.startsWith("/")
    ? resolveRelativePath("", decoded.replace(/^\/+/, ""))
    : resolveRelativePath(noteDir, decoded);
  const candidates = [resolved];
  if (!extOf(resolved)) candidates.push(`${resolved}.md`, `${resolved}.html`, `${resolved}.htm`);
  const files = flattenFiles(state.tree);
  return files.find((file) => candidates.includes(file.path))
    || files.find((file) => candidates.some((path) => file.path.toLowerCase() === path.toLowerCase()))
    || null;
}

function scrollActiveDocumentToFragment(fragment, options = {}) {
  if (isHtmlNote() && !state.editMode) {
    return scrollHtmlFrameToFragment(htmlFrame(), fragment, options);
  }
  const decoded = decodeHtmlFragment(fragment);
  if (!decoded) {
    qs("doc-area").scrollTo({ top: 0, behavior: options.behavior || "auto" });
    return true;
  }
  const slug = decoded.toLowerCase().trim()
    .replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]/gu, "") || decoded;
  const target = document.getElementById(`h-${slug}`) || document.getElementById(decoded);
  if (!target) return false;
  target.scrollIntoView({ behavior: options.behavior || "auto", block: "start" });
  return true;
}

async function openLinkedNote(path, fragment = null) {
  if (path === state.activePath) {
    if (fragment != null && scrollActiveDocumentToFragment(fragment, { behavior: "smooth" })) {
      navPush(path, decodeHtmlFragment(fragment));
      updateNavButtons();
    }
    return;
  }
  const opts = fragment == null ? {} : { fragment: decodeHtmlFragment(fragment) };
  await loadNote(path, opts);
}

function routeDocumentLink(event, rawHref, frame = null) {
  const href = String(rawHref || "").trim();
  if (!href || href.startsWith("inkwell-wiki:")) return false;

  if (href.startsWith("#")) {
    if (!frame) return false;
    event.preventDefault();
    scrollHtmlFrameToFragment(frame, href, { behavior: "smooth", pushHistory: true });
    return true;
  }

  if (/^https?:\/\//i.test(href) || href.startsWith("//")) {
    event.preventDefault();
    const externalUrl = href.startsWith("//") ? `https:${href}` : href;
    invoke("open_external_url", { url: externalUrl }).catch(() => {});
    return true;
  }

  if (href.startsWith("obsidian://")) {
    event.preventDefault();
    try {
      const url = new URL(href);
      const filePath = decodeURIComponent(url.searchParams.get("file") || "");
      if (filePath) void openLinkedNote(filePath);
    } catch {}
    return true;
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
  const hashIndex = href.indexOf("#");
  const pathAndQuery = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const queryIndex = pathAndQuery.indexOf("?");
  const rawPath = queryIndex === -1 ? pathAndQuery : pathAndQuery.slice(0, queryIndex);
  const fragment = hashIndex === -1 ? null : href.slice(hashIndex + 1);
  if (!rawPath) return false;
  const match = findLinkedNote(rawPath);
  if (!match) return false;
  event.preventDefault();
  void openLinkedNote(match.path, fragment);
  return true;
}

function wireHtmlFrameLinks(frame, notePath) {
  const doc = frame.contentDocument;
  const view = frame.contentWindow;
  if (!doc || !view) return;

  view.addEventListener("scroll", () => {
    if (state.activePath === notePath) state.tabScroll.set(notePath, currentReadingScrollTop());
    if (state.outlineOpen) updateActiveTocLink();
  }, { passive: true });

  doc.addEventListener("click", (event) => {
    const target = event.target?.closest ? event.target : event.target?.parentElement;
    const link = target?.closest?.("a");
    if (!link) return;
    routeDocumentLink(event, link.getAttribute("href") || "", frame);
  });
}

/* ── Document area render ────────────────────────── */
function renderDocArea(options = {}) {
  releaseReadingAnchorPin();
  // 换了笔记，上一篇留下的图片缓存和切换记录就没用了，别一直占着内存
  if (state.previewImages && state.previewImages.path !== state.activeNote?.path) state.previewImages = null;
  if (state.readingAnchorMemo && state.readingAnchorMemo.path !== state.activeNote?.path) state.readingAnchorMemo = null;
  const docArea = qs("doc-area");
  const silent = options.silent === true;
  const renderGeneration = ++state.docRenderGeneration;
  const docAreaClass = (...classes) => ["docArea", ...classes, silent ? "docAreaSilentRefresh" : ""]
    .filter(Boolean)
    .join(" ");

  if (!state.activeNote) {
    docArea.className = docAreaClass();
    docArea.innerHTML = renderDashboard();
    wireDashboard();
    updateReaderDocumentActions();
    return;
  }

  const ext = state.activeNote.extension;
  const isText = /^(md|html?)$/.test(ext);
  const isImage = isImageExt(ext);
  updateReaderDocumentActions();

  state.editor = null;

  if (state.editMode && isText) {
    docArea.className = docAreaClass("docAreaEdit");
    docArea.innerHTML = `<div class="document"><div id="cm-container" class="cmContainer"></div></div>`;
    const cm = CodeMirror(qs("cm-container"), {
      value: state.activeNote.content,
      mode: "markdown",
      lineWrapping: true,
      autofocus: false,
      indentUnit: 2,
      tabSize: 2,
      extraKeys: {
        "Enter": "newlineAndIndentContinueMarkdownList",
        "Ctrl-Space": (instance) => instance.showHint({ completeSingle: false }),
      },
      hintOptions: { completeSingle: false, hint: desktopWikiHint },
      // 编辑器自身不滚动（外层 docArea 统一滚动），需全量渲染行
      viewportMargin: Infinity,
    });
    state.editor = cm;
    // [[ autocomplete trigger: check cursor context, not change.text content
    let _wikiHintTimer = null;
    cm.on("change", (_inst, change) => {
      if (change.origin === "+input" || change.origin === "+delete") {
        const cur = cm.getCursor();
        const before = cm.getLine(cur.line).slice(0, cur.ch);
        const open = before.lastIndexOf("[[");
        const inWikiCtx = open !== -1 && !before.slice(open + 2).includes("]]");
        if (inWikiCtx) {
          clearTimeout(_wikiHintTimer);
          _wikiHintTimer = setTimeout(() => {
            if (!cm.state.completionActive) cm.showHint({ completeSingle: false });
          }, 80);
        }
      }
    });
    cm.on("change", () => {
      setDirty(true);
      scheduleAutosave();
      if (state.outlineOpen) renderToc();
    });
    cm.on("paste", (_inst, event) => handleEditorPaste(cm, event));
    cm.on("blur", () => { void flushPendingSave(); });
    cm.on("cursorActivity", sendSelectionContext);
    cm.on("change", syncEditorPlaceholder);
    syncEditorPlaceholder();
    cm.getInputField().focus({ preventScroll: true });
  } else {
    docArea.className = docAreaClass();
    if (ext === "md") {
      const { data: frontMatterData, body: markdownBody, bodyStartLine } = parseFrontMatter(state.activeNote.content);
      const frontMatterHtml = renderFrontMatterPanel(frontMatterData, bodyStartLine);
      const html = renderMarkdownContent(markdownBody, { lineOffset: bodyStartLine });
      docArea.innerHTML = `<div class="document">${frontMatterHtml}<article class="prose" id="prose-content">${html}</article></div>`;
      addHeadingSlugs();
      wrapMarkdownTables();
      reuseMarkdownImages(qs("prose-content"), options.imageNodes);
      resolveMarkdownImages(state.activeNote.path, renderGeneration);
      wireWikiLinks(buildNoteIndex());
      renderBacklinksPanel(state.activeNote.path, renderGeneration);
    } else if (/^html?$/.test(ext)) {
      docArea.className = docAreaClass("docAreaHtml");
      docArea.innerHTML = `<iframe id="html-frame" class="htmlFrame"></iframe>`;
      const frame = document.getElementById("html-frame");
      const notePath = state.activeNote.path;
      const restoreFragment = Object.prototype.hasOwnProperty.call(options, "fragment");
      const restoreScrollTop = Number.isFinite(options.scrollTop)
        ? options.scrollTop
        : state.tabScroll.get(notePath) ?? 0;
      frame.addEventListener("load", () => {
        try {
          wireHtmlFrameLinks(frame, notePath);
          if (restoreFragment) {
            scrollHtmlFrameToFragment(frame, options.fragment, { behavior: "auto" });
          } else {
            frame.contentWindow.scrollTo(0, restoreScrollTop);
          }
          if (state.outlineOpen) renderToc();
        } catch {}
      });
      frame.srcdoc = htmlPreviewContent(state.activeNote.content, notePath);
    } else if (isImage) {
      const navigation = imageViewerNavigation(state.activeNote.path);
      docArea.innerHTML = `
        <div class="imageViewer">
          <figure class="imageViewerFrame">
            ${renderImageViewerNavButton("previous", navigation.previous)}
            <img class="imageViewerImage" src="${state.activeNote.dataUrl}" alt="${escapeHtml(state.activeNote.name)}" />
            ${renderImageViewerNavButton("next", navigation.next)}
          </figure>
          <div class="imageViewerMeta">
            <strong>${escapeHtml(state.activeNote.name)}</strong>
            <span>${escapeHtml((state.activeNote.mime || ext).toUpperCase())}</span>
            <span>${escapeHtml(formatSize(state.activeNote.size || 0))}</span>
            ${navigation.items.length > 1 && navigation.index >= 0
              ? `<span class="imageViewerPosition" aria-label="当前为第 ${navigation.index + 1} 张，共 ${navigation.items.length} 张">${navigation.index + 1} / ${navigation.items.length}</span>`
              : ""}
          </div>
        </div>`;
      wireImageZoom();
    } else {
      docArea.innerHTML = `<div class="document"><p class="prose">无法预览此类型文件（${ext}）。</p></div>`;
    }
    docArea.addEventListener("mouseup", sendSelectionContext, { once: false });
  }
}

function imageViewerNavigation(path = state.activePath) {
  const folder = parentFolder(path || "").toLowerCase();
  const items = flattenFiles(state.tree).filter((file) => {
    const extension = file.extension || extOf(file.path);
    return isImageExt(extension) && parentFolder(file.path).toLowerCase() === folder;
  });
  const normalizedPath = String(path || "").toLowerCase();
  const index = items.findIndex((file) => file.path.toLowerCase() === normalizedPath);
  return {
    items,
    index,
    previous: index > 0 ? items[index - 1] : null,
    next: index >= 0 && index < items.length - 1 ? items[index + 1] : null,
  };
}

function renderImageViewerNavButton(direction, target) {
  if (!target) return "";
  const isPrevious = direction === "previous";
  const label = isPrevious ? "上一张图片" : "下一张图片";
  const shortcut = isPrevious ? "←" : "→";
  const path = isPrevious ? "M15 18l-6-6 6-6" : "M9 18l6-6-6-6";
  return `
    <button
      type="button"
      class="imageViewerNav imageViewerNav${isPrevious ? "Previous" : "Next"}"
      data-image-viewer-direction="${direction}"
      aria-label="${label}：${escapeHtml(target.name)}"
      title="${label}（${shortcut}）"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="${path}" />
      </svg>
    </button>`;
}

async function navigateImageViewer(direction, options = {}) {
  if (state.imageViewerLoading || !isImageExt(state.activeNote?.extension)) return;
  const navigation = imageViewerNavigation(state.activePath);
  const target = direction === "previous" ? navigation.previous : navigation.next;
  if (!target) return;

  state.imageViewerLoading = true;
  try {
    await loadNote(target.path, { replaceCurrentTab: true });
    if (options.restoreFocus) {
      requestAnimationFrame(() => {
        document.querySelector(`[data-image-viewer-direction="${direction}"]`)
          ?.focus({ preventScroll: true });
      });
    }
  } finally {
    state.imageViewerLoading = false;
  }
}

function wireImageZoom() {
  const frame = document.querySelector(".imageViewerFrame");
  const image = document.querySelector(".imageViewerImage");
  if (!frame || !image) return;

  frame.querySelectorAll("[data-image-viewer-direction]").forEach((button) => {
    button.addEventListener("pointerdown", (e) => e.stopPropagation());
    button.addEventListener("dblclick", (e) => e.stopPropagation());
    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const restoreFocus = button.matches(":focus-visible");
      void navigateImageViewer(button.dataset.imageViewerDirection, { restoreFocus });
    });
  });

  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let dragTimer = null;
  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartPanX = 0;
  let dragStartPanY = 0;
  const applyZoom = () => {
    if (zoom <= 1.01) {
      panX = 0;
      panY = 0;
    }
    image.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    frame.classList.toggle("imageViewerFrameZoomed", zoom > 1.01);
    frame.classList.toggle("imageViewerFramePannable", zoom > 1.01);
  };
  const endDrag = () => {
    clearTimeout(dragTimer);
    dragTimer = null;
    dragging = false;
    frame.classList.remove("imageViewerFrameDragging");
  };

  frame.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? IMAGE_ZOOM_STEP : 1 / IMAGE_ZOOM_STEP;
    zoom = clamp(zoom * factor, IMAGE_ZOOM_MIN, IMAGE_ZOOM_MAX);
    applyZoom();
  }, { passive: false });

  frame.addEventListener("dblclick", () => {
    zoom = 1;
    panX = 0;
    panY = 0;
    image.style.transform = "";
    frame.classList.remove("imageViewerFrameZoomed", "imageViewerFramePannable");
  });

  frame.addEventListener("pointerdown", (e) => {
    if (zoom <= 1.01 || (e.pointerType === "mouse" && e.button !== 0)) return;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartPanX = panX;
    dragStartPanY = panY;
    clearTimeout(dragTimer);
    dragTimer = setTimeout(() => {
      dragging = true;
      frame.classList.add("imageViewerFrameDragging");
      try { frame.setPointerCapture(e.pointerId); } catch {}
    }, 180);
  });

  frame.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    e.preventDefault();
    panX = dragStartPanX + (e.clientX - dragStartX);
    panY = dragStartPanY + (e.clientY - dragStartY);
    applyZoom();
  });

  frame.addEventListener("pointerup", endDrag);
  frame.addEventListener("pointercancel", endDrag);
  frame.addEventListener("pointerleave", () => {
    if (!dragging) clearTimeout(dragTimer);
  });
}

function recentDashboardFiles() {
  return flattenFiles(state.tree)
    .filter((file) => !/^(png|jpe?g|gif|webp|svg|avif|pdf)$/i.test(file.extension || ""))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 6);
}

function renderDashboard() {
  const files = recentDashboardFiles();
  const cards = files.map((file) => `
    <button type="button" class="dashboardRecentCard" data-path="${escapeHtml(file.path)}">
      <span class="dashboardRecentCardIcon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      </span>
      <span class="dashboardRecentCardContent">
        <span class="dashboardRecentCardTitle">${escapeHtml(stripExt(file.name))}</span>
        <span class="dashboardRecentCardPath">${escapeHtml(file.path)}</span>
        <span class="dashboardRecentCardDate">${escapeHtml(formatDate(file.updatedAt))}</span>
      </span>
    </button>
  `).join("");

  return `
    <section class="dashboardContainer">
      <div class="dashboardHero">
        <p class="dashboardSubtitle">你的个人知识库，已就绪。</p>
        <form class="dashboardComposer" id="dashboard-ask-form" aria-label="问 Fellow">
          <span class="dashboardComposerMark" aria-hidden="true">✦</span>
          <input id="dashboard-ask-input" class="dashboardComposerInput" type="text" placeholder="问 Fellow…" autocomplete="off" spellcheck="false" />
          <button type="submit" class="dashboardComposerSend" title="问 Fellow" aria-label="问 Fellow">
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M8 12V4" />
              <path d="M4.5 7.5 8 4l3.5 3.5" />
            </svg>
          </button>
        </form>
      </div>
      <div class="dashboardSection">
        <div class="dashboardSectionHeader">
          <h2 class="dashboardSectionTitle">${files.length ? "继续你的工作" : "开始记录"}</h2>
          <button type="button" id="dashboard-capture" class="dashboardCaptureChip">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
            <span>记录灵感</span>
          </button>
        </div>
        ${files.length ? `<div class="dashboardRecentGrid">${cards}</div>` : `
          <div class="dashboardEmptyPanel">
            <p>还没有笔记。点击下方按钮，或左上角「+」开始记录。</p>
            <button type="button" id="dashboard-empty-create" class="emptyStateCta">新建笔记</button>
          </div>
        `}
      </div>
    </section>`;
}

function wireDashboard() {
  qs("dashboard-capture")?.addEventListener("click", createNote);
  qs("dashboard-empty-create")?.addEventListener("click", createNote);
  const askInput = qs("dashboard-ask-input");
  const askSend = qs("dashboard-ask-form")?.querySelector(".dashboardComposerSend");
  const syncAskReady = () => {
    if (!askSend || !askInput) return;
    askSend.classList.toggle("isReady", askInput.value.trim().length > 0);
  };
  askInput?.addEventListener("input", syncAskReady);
  syncAskReady();

  qs("dashboard-ask-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = qs("dashboard-ask-input");
    const text = input?.value.trim();
    openFellowPanel();
    setTimeout(() => {
      const accepted = postAgentMessage(text
        ? { type: "note-ask", text, filePath: state.activePath ?? null }
        : { type: "note-ask", filePath: state.activePath ?? null });
      if (accepted && input) {
        input.value = "";
        syncAskReady();
      }
    }, 120);
  });

  document.querySelectorAll(".dashboardRecentCard").forEach((card) => {
    card.addEventListener("click", () => {
      const path = card.getAttribute("data-path");
      if (path) loadNote(path);
    });
  });
}

function addHeadingSlugs() {
  const container = qs("prose-content");
  if (!container) return;
  const seen = new Map();
  container.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h) => {
    const slug = slugifyHeading(h.textContent, seen);
    h.setAttribute("data-heading-slug", slug);
    h.id = `h-${slug}`;
  });
}

function wrapMarkdownTables() {
  const container = qs("prose-content");
  if (!container) return;
  container.querySelectorAll("table").forEach((table) => {
    if (table.parentElement?.classList.contains("tableWrap")) return;
    const wrapper = document.createElement("div");
    wrapper.className = "tableWrap";
    table.before(wrapper);
    wrapper.appendChild(table);
  });
}

/* 将 md 里引用的本地图片 src 转成 data URL */
function resolveRelativePath(base, rel) {
  const baseParts = base ? base.split("/") : [];
  const segs = rel.replace(/^\.\//, "").split("/");
  const out = [...baseParts];
  for (const s of segs) {
    if (s === "..") out.pop();
    else if (s !== "." && s !== "") out.push(s);
  }
  return out.join("/");
}

function nextMarkdownImageKey(src, occurrences) {
  const occurrence = occurrences.get(src) ?? 0;
  occurrences.set(src, occurrence + 1);
  return `${src}\u0000${occurrence}`;
}

function captureMarkdownImages(container = qs("prose-content")) {
  const images = new Map();
  const occurrences = new Map();
  container?.querySelectorAll("img").forEach((img) => {
    const src = img.dataset.markdownSource || (img.getAttribute("src") || "").trim();
    images.set(nextMarkdownImageKey(src, occurrences), img);
  });
  return images;
}

function reuseMarkdownImages(container, preservedImages = new Map()) {
  if (!container || preservedImages.size === 0) return;
  const occurrences = new Map();
  container.querySelectorAll("img").forEach((img) => {
    const src = (img.getAttribute("src") || "").trim();
    const preserved = preservedImages.get(nextMarkdownImageKey(src, occurrences));
    if (!preserved) return;
    for (const attr of ["alt", "title"]) {
      if (img.hasAttribute(attr)) preserved.setAttribute(attr, img.getAttribute(attr));
      else preserved.removeAttribute(attr);
    }
    img.replaceWith(preserved);
  });
}

async function resolveMarkdownImages(notePath, renderGeneration) {
  const container = qs("prose-content");
  if (!container) return;
  const imgs = container.querySelectorAll("img");
  if (!imgs.length) return;

  const noteDir = notePath.includes("/") ? notePath.split("/").slice(0, -1).join("/") : "";
  const occurrences = new Map();

  for (const img of imgs) {
    // marked.js 会对路径做 URL 编码（中文、空格等），需先解码再传给 Rust
    const encodedSrc = img.dataset.markdownSource || (img.getAttribute("src") || "").trim();
    img.dataset.markdownSource = encodedSrc;
    nextMarkdownImageKey(encodedSrc, occurrences);
    if (img.dataset.markdownResolved === encodedSrc && img.complete && img.naturalWidth > 0) continue;
    let raw = encodedSrc;
    try { raw = decodeURIComponent(encodedSrc); } catch {}
    // 跳过外部协议、data/blob URL、协议相对 URL和锚点
    if (!raw || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(raw)) continue;

    const assetPath = raw.startsWith("/")
      ? raw.replace(/^\/+/, "")
      : resolveRelativePath(noteDir, raw);

    // 加载中占位
    img.style.opacity = "0.3";
    try {
      const asset = await invoke("read_asset", { path: assetPath });
      if (state.docRenderGeneration !== renderGeneration || !img.isConnected) return;
      img.src = asset.dataUrl;
      img.dataset.markdownResolved = encodedSrc;
    } catch {
      if (state.docRenderGeneration !== renderGeneration || !img.isConnected) return;
      img.classList.add("imgBroken");
    } finally {
      img.style.opacity = "";
    }
  }
}

/* ── Header meta ─────────────────────────────────── */
function renderNoteMeta() {
  const titleEl = qs("note-title");
  const metaEl = qs("note-meta");
  updateReaderDocumentActions();

  if (state.gitWorkspaceOpen) {
    titleEl.textContent = "同步";
    metaEl.querySelectorAll(".noteBreadcrumb,.noteBreadcrumbSep").forEach((el) => el.remove());
    qs("btn-more-menu").disabled = true;
    toggleMoreMenu(false);
    return;
  }

  if (!state.activeNote) {
    titleEl.textContent = "inkfellow Desktop";
    metaEl.querySelectorAll(".noteBreadcrumb,.noteBreadcrumbSep").forEach((el) => el.remove());
    qs("btn-more-menu").disabled = true;
    toggleMoreMenu(false);
    return;
  }

  // 笔记态不再显示标题/路径：文档身份由标签承载（悬停标签可见完整路径）
  titleEl.textContent = "";
  metaEl.querySelectorAll(".noteBreadcrumb,.noteBreadcrumbSep").forEach((el) => el.remove());

  qs("btn-more-menu").disabled = false;
}

/* ── ⋯ 更多菜单 ──────────────────────────────────── */
function toggleMoreMenu(force) {
  const menu = qs("more-menu");
  const btn = qs("btn-more-menu");
  const open = force !== undefined ? force : menu.hidden;
  menu.hidden = !open;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
}

/* ── Tree rendering ──────────────────────────────── */
const FOLDER_ICON = `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 3.5h4l1.5 1.5H13v7H1V3.5z"/></svg>`;
const FILE_ICON = `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 1h6l3 3v9H3V1z"/><path d="M9 1v3h3"/></svg>`;
const CHEVRON_ICON = `<svg viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,1 6,4 2,7"/></svg>`;

/* 文件树按类型区分图标：形状先辨认，低饱和色相做二次提示 */
const SVG_OPEN = `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">`;
const FILE_KIND_ICONS = {
  doc: FILE_ICON,
  note: `${SVG_OPEN}<path d="M3 1h6l3 3v9H3V1z"/><path d="M9 1v3h3"/><path d="M5 8h4M5 10.5h2.5"/></svg>`,
  image: `${SVG_OPEN}<rect x="1.5" y="2.5" width="11" height="9" rx="1.5"/><circle cx="5" cy="5.75" r="0.9"/><path d="M2.2 10.2l2.8-2.8 2.4 2.4 1.8-1.8 2.6 2.6"/></svg>`,
  code: `${SVG_OPEN}<polyline points="4.5,3.8 1.6,7 4.5,10.2"/><polyline points="9.5,3.8 12.4,7 9.5,10.2"/></svg>`,
  pdf: `${SVG_OPEN}<path d="M2 2.5h4a1.8 1.8 0 0 1 1.8 1.8v7.2a1.4 1.4 0 0 0-1.4-1.4H2V2.5z"/><path d="M12 2.5H8a1.8 1.8 0 0 0-1.8 1.8v7.2a1.4 1.4 0 0 1 1.4-1.4H12V2.5z"/></svg>`,
  sheet: `${SVG_OPEN}<rect x="1.5" y="2.5" width="11" height="9" rx="1.5"/><path d="M1.5 5.6h11M5.4 5.6v5.9"/></svg>`,
  audio: `${SVG_OPEN}<path d="M5.6 9.4V3.3l6-1.1v6"/><circle cx="4.1" cy="9.9" r="1.6"/><circle cx="10.1" cy="8.8" r="1.6"/></svg>`,
  video: `${SVG_OPEN}<rect x="1.5" y="3" width="11" height="8" rx="1.5"/><path d="M6 5.7l3.1 1.9L6 9.5V5.7z"/></svg>`,
  archive: `${SVG_OPEN}<path d="M1.5 5h11v6.5a0.8 0.8 0 0 1-0.8 0.8H2.3a0.8 0.8 0 0 1-0.8-0.8V5z"/><path d="M2.6 2.2h8.8L12.5 5h-11L2.6 2.2z"/><path d="M6 7.6h2"/></svg>`,
};

const FILE_KIND_BY_EXT = {
  md: "note", markdown: "note", txt: "note", rtf: "note", doc: "doc", docx: "doc",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image",
  bmp: "image", avif: "image", ico: "image", heic: "image",
  html: "code", htm: "code", js: "code", mjs: "code", cjs: "code", ts: "code", tsx: "code",
  jsx: "code", css: "code", scss: "code", json: "code", yaml: "code", yml: "code",
  toml: "code", xml: "code", py: "code", rs: "code", go: "code", java: "code", c: "code",
  h: "code", cpp: "code", sh: "code", rb: "code", php: "code", sql: "code", vue: "code", svelte: "code",
  pdf: "pdf",
  csv: "sheet", xls: "sheet", xlsx: "sheet",
  mp3: "audio", wav: "audio", m4a: "audio", flac: "audio", ogg: "audio", aac: "audio",
  mp4: "video", mov: "video", mkv: "video", avi: "video", webm: "video",
  zip: "archive", rar: "archive", "7z": "archive", gz: "archive", tar: "archive", bz2: "archive",
};

function fileKindOf(ext) {
  return FILE_KIND_BY_EXT[ext] || "doc";
}

function flattenFiles(node, result = []) {
  if (!node) return result;
  if (node.type === "file") { result.push(node); return result; }
  for (const child of node.children || []) flattenFiles(child, result);
  return result;
}

function expandAncestors(path) {
  state.expanded.add("");
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    state.expanded.add(parts.slice(0, i).join("/"));
  }
}

function renderTree() {
  const container = qs("tree");
  container.replaceChildren();
  if (!state.tree) return;
  buildTreeNodes(state.tree, container, 0, true);
  saveExpandedState();
}

function buildTreeNodes(node, container, level, isRoot) {
  if (node.type === "directory") {
    const isExpanded = state.expanded.has(node.path);
    const wrap = document.createElement("div");
    wrap.className = "treeNodeWrap";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "treeFolder";
    btn.style.paddingLeft = `${4 + level * TREE_INDENT_PX}px`;

    const chevron = document.createElement("span");
    chevron.className = "chevron" + (isExpanded ? " chevronOpen" : "");
    chevron.innerHTML = CHEVRON_ICON;

    const icon = document.createElement("span");
    icon.className = "treeNodeIcon";
    icon.innerHTML = FOLDER_ICON;

    const label = document.createElement("span");
    label.className = "treeLabel";
    fillTreeLabel(label, isRoot ? (node.name || "Vault") : node.name);
    label.title = node.path || state.vaultPath;
    if (!isRoot) label.dataset.path = node.path;

    btn.append(chevron, icon, label);
    btn.addEventListener("click", () => {
      if (state.expanded.has(node.path)) state.expanded.delete(node.path);
      else state.expanded.add(node.path);
      renderTree();
    });

    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "treeNodeMore";
    moreBtn.textContent = "⋯";
    moreBtn.title = "More actions";
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showContextMenu(e, { kind: "folder", name: node.name, path: node.path });
    });

    wrap.append(btn, moreBtn);
    container.appendChild(wrap);

    if (isExpanded && node.children?.length) {
      const childGroup = document.createElement("div");
      childGroup.className = "treeChildren";
      for (const child of node.children) {
        buildTreeNodes(child, childGroup, level + 1, false);
      }
      container.appendChild(childGroup);
    }
  } else {
    const ext = extOf(node.name);
    const wrap = document.createElement("div");
    wrap.className = "treeNodeWrap";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "treeFile" + (node.path === state.activePath ? " treeFileActive" : "");
    btn.style.paddingLeft = `${4 + level * TREE_INDENT_PX}px`;
    btn.title = `${node.path}\n${formatDate(node.updatedAt)}`;

    // 文件没有展开箭头，补一个等宽空位，否则同级的文件会比文件夹左移一截
    const spacer = document.createElement("span");
    spacer.className = "chevronSpacer";

    const kind = fileKindOf(ext);
    const icon = document.createElement("span");
    icon.className = `treeNodeIcon treeNodeIcon-${kind}`;
    icon.innerHTML = FILE_KIND_ICONS[kind] || FILE_ICON;

    const label = document.createElement("span");
    label.className = "treeLabel";
    fillTreeLabel(label, stripExt(node.name));
    label.dataset.path = node.path;

    btn.append(spacer, icon, label);

    if (ext && ext !== "md") {
      const badge = document.createElement("span");
      badge.className = `fileTypeBadge fileTypeBadge-${kind}`;
      badge.textContent = ext.toUpperCase();
      btn.appendChild(badge);
    }

    btn.addEventListener("click", () => loadNote(node.path));

    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "treeNodeMore";
    moreBtn.textContent = "⋯";
    moreBtn.title = "More actions";
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showContextMenu(e, { kind: "file", name: node.name, path: node.path });
    });

    wrap.append(btn, moreBtn);
    container.appendChild(wrap);
  }
}

function saveExpandedState() {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...state.expanded]));
  } catch {}
}

function loadExpandedState() {
  try {
    const saved = localStorage.getItem(EXPANDED_KEY);
    if (saved) state.expanded = new Set(JSON.parse(saved));
  } catch {}
  state.expanded.add("");
}

/* ── Context menu ────────────────────────────────── */
const MENU_ICONS = {
  note:   `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2 1.5h6L10.5 4V11.5H2V1.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M8 1.5V4h2.5" stroke="currentColor" stroke-width="1.2"/><path d="M4 6.5h5M4 8.5h3" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>`,
  folder: `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M1 3.5h4l1 1.5h6v6H1V3.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>`,
  rename: `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M8.5 2L11 4.5 4.5 11H2V8.5L8.5 2Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>`,
  delete: `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2 3.5h9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M4.5 3.5V2h4v1.5" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M3 3.5l.6 7.5h5.8L10 3.5" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5 6v3.5M8 6v3.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>`,
};

function showContextMenu(e, target) {
  const menu = qs("context-menu");
  menu.replaceChildren();
  state.contextTarget = target;

  const items = [];

  if (target.kind === "file") {
    items.push({ label: "重命名", icon: MENU_ICONS.rename, action: renameEntry });
    items.push({ separator: true });
    items.push({ label: "删除", icon: MENU_ICONS.delete, action: deleteEntry, danger: true });
  } else {
    items.push({ label: "新建笔记", icon: MENU_ICONS.note, action: newNoteInFolder });
    items.push({ label: "新建文件夹", icon: MENU_ICONS.folder, action: newFolderInFolder });
    if (target.path) {
      items.push({ separator: true });
      items.push({ label: "重命名", icon: MENU_ICONS.rename, action: renameEntry });
      items.push({ label: "删除", icon: MENU_ICONS.delete, action: deleteEntry, danger: true });
    }
  }

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "treeActionSep";
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "treeActionItem" + (item.danger ? " danger" : "");
    btn.innerHTML = `<span class="treeActionIcon">${item.icon}</span><span>${item.label}</span>`;
    btn.addEventListener("click", () => {
      hideContextMenu();
      item.action(target);
    });
    menu.appendChild(btn);
  }

  // 先取消 hidden 才能量到真实尺寸；同一同步块内完成定位，绘制前不会闪烁
  menu.hidden = false;
  const rect = e.currentTarget.getBoundingClientRect();
  let top = rect.bottom + 4;
  let left = rect.left;
  if (left + menu.offsetWidth > window.innerWidth - 8) left = window.innerWidth - menu.offsetWidth - 8;
  if (top + menu.offsetHeight > window.innerHeight - 8) top = rect.top - 4 - menu.offsetHeight;
  if (top < 8) top = 8;

  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}

function hideContextMenu() {
  qs("context-menu").hidden = true;
  state.contextTarget = null;
}

/* 属性选择器对含反斜杠的 Windows 路径转义不可靠，改用精确比较查找 */
function findTreeLabel(path) {
  for (const el of document.querySelectorAll(".treeLabel[data-path]")) {
    if (el.dataset.path === path) return el;
  }
  return null;
}

function renameEntry(target) {
  const labelEl = findTreeLabel(target.path);
  if (!labelEl) return;

  const ext = target.kind === "file" ? extOf(target.name) : "";
  const originalDisplay = labelEl.textContent;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "treeRenameInput";
  input.value = originalDisplay;
  labelEl.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;

  async function commit() {
    if (settled) return;
    settled = true;
    input.removeEventListener("blur", commit);

    const raw = input.value.trim();
    const newName = raw ? (ext ? raw + "." + ext : raw) : target.name;

    input.replaceWith(labelEl);

    if (!raw || newName === target.name) return;
    try {
      const newPath = await invoke("rename_entry", { path: target.path, name: newName });
      // 用户亲自命名后，不再让首行接管文件名
      if (state.autoTitlePath === target.path) state.autoTitlePath = null;
      if (target.path === state.activePath) {
        state.activePath = newPath;
        if (state.activeNote) state.activeNote = { ...state.activeNote, path: newPath, name: newName };
        renderNoteMeta();
      }
      // 标签跟随改名（文件夹改名时映射所有子路径）；先映射再刷新树，避免失效清理误删旧路径标签
      mapTabPaths((p) => p === target.path
        ? newPath
        : target.kind === "folder" && p.startsWith(target.path + "/")
          ? newPath + p.slice(target.path.length)
          : p);
      await loadTree(false);
      showToast("已重命名");
    } catch (err) {
      showToast(String(err));
    }
  }

  function cancel() {
    if (settled) return;
    settled = true;
    input.removeEventListener("blur", commit);
    input.replaceWith(labelEl);
  }

  input.addEventListener("mousedown", (e) => e.stopPropagation());
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter")  { e.preventDefault(); commit(); }
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
}

async function deleteEntry(target) {
  const confirmed = await showConfirm(`确认删除 "${target.name}"？此操作不可撤销。`);
  if (!confirmed) return;
  const affectsActive =
    (target.kind === "file" && target.path === state.activePath) ||
    (target.kind === "folder" && state.activePath?.startsWith(target.path + "/"));
  // 删除当前打开的笔记前取消自动保存，避免删除后被写回
  if (affectsActive) {
    cancelAutosave();
    setDirty(false);
  }
  try {
    await invoke("delete_entry", { path: target.path });
    pruneTabs((p) => target.kind === "file"
      ? p !== target.path
      : p !== target.path && !p.startsWith(target.path + "/"));
    if (affectsActive) {
      clearActiveNote();
    }
    await loadTree(false);
    showToast("已删除");
  } catch (err) {
    showToast(String(err));
  }
}

async function newNoteInFolder(target) {
  await createBlankNote(target.path);
}

async function newFolderInFolder(target) {
  const name = await showDialog("新建文件夹", "新文件夹");
  if (!name) return;
  try {
    await invoke("create_folder", { parent: target.path, name });
    state.expanded.add(target.path);
    await loadTree(false);
    showToast("文件夹已创建");
  } catch (err) {
    showToast(String(err));
  }
}

/* ── Navigation history ──────────────────────────── */
function navEntry(path, fragment = null) {
  return {
    path,
    fragment: fragment == null ? null : decodeHtmlFragment(fragment),
  };
}

function navPush(path, fragment = null) {
  const next = navEntry(path, fragment);
  const current = state.navHistory[state.navIndex];
  // Same path: don't duplicate
  if (current?.path === next.path && current?.fragment === next.fragment) return;
  // Truncate forward history
  state.navHistory = state.navHistory.slice(0, state.navIndex + 1);
  state.navHistory.push(next);
  state.navIndex = state.navHistory.length - 1;
  // Cap at 200 entries
  if (state.navHistory.length > 200) {
    state.navHistory.shift();
    state.navIndex--;
  }
}

function updateNavButtons() {
  const back = qs("btn-nav-back");
  const fwd  = qs("btn-nav-forward");
  if (back) back.disabled = state.navIndex <= 0;
  if (fwd)  fwd.disabled  = state.navIndex >= state.navHistory.length - 1;
}

async function navigateToHistoryEntry(entry) {
  if (!entry?.path) return;
  if (entry.path === state.activePath && entry.fragment != null) {
    scrollActiveDocumentToFragment(entry.fragment, { behavior: "auto" });
    return;
  }
  const options = { skipHistory: true };
  if (entry.fragment != null) options.fragment = entry.fragment;
  await loadNote(entry.path, options);
}

async function navBack() {
  if (state.navIndex <= 0) return;
  state.navIndex--;
  updateNavButtons();
  await navigateToHistoryEntry(state.navHistory[state.navIndex]);
}

async function navForward() {
  if (state.navIndex >= state.navHistory.length - 1) return;
  state.navIndex++;
  updateNavButtons();
  await navigateToHistoryEntry(state.navHistory[state.navIndex]);
}

/* ── 多标签 ──────────────────────────────────────── */
/* 标签只是「已打开路径」的书签列表，文档加载/保存仍由 loadNote 单例逻辑持有 */

function loadTabsFromStorage() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TABS_KEY) || "[]");
    if (Array.isArray(parsed)) {
      state.tabs = parsed.filter((p) => typeof p === "string" && p);
    }
  } catch {}
}

function persistTabs() {
  try { localStorage.setItem(TABS_KEY, JSON.stringify(state.tabs)); } catch {}
}

function ensureTab(path) {
  if (!state.tabs.includes(path)) {
    state.tabs.push(path);
    persistTabs();
  }
  renderTabs();
}

/* 重命名/移动后批量映射路径，映射后去重 */
function replaceTabPath(previousPath, nextPath) {
  if (!previousPath || !state.tabs.includes(previousPath)) {
    ensureTab(nextPath);
    return;
  }
  state.tabs = [...new Set(state.tabs.map((path) => path === previousPath ? nextPath : path))];
  state.tabScroll.delete(previousPath);
  persistTabs();
  renderTabs();
}

function mapTabPaths(mapper) {
  const next = [];
  for (const p of state.tabs) {
    const mapped = mapper(p);
    if (!next.includes(mapped)) next.push(mapped);
  }
  const changed = next.length !== state.tabs.length || next.some((p, i) => p !== state.tabs[i]);
  if (changed) {
    state.tabs = next;
    persistTabs();
    renderTabs();
  }
}

/* 按谓词保留标签（删除文件/文件夹、文件树刷新后清理失效标签） */
function pruneTabs(keep) {
  const next = state.tabs.filter(keep);
  if (next.length !== state.tabs.length) {
    state.tabs = next;
    persistTabs();
    renderTabs();
  }
}

const TAB_CLOSE_ICON = `<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
const TAB_ADD_ICON = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

function renderTabs() {
  const strip = qs("tab-strip");
  if (!strip) return;
  strip.hidden = state.tabs.length === 0;
  strip.innerHTML = "";
  for (const path of state.tabs) {
    const name = stripExt(path.split("/").pop() || path);
    const active = path === state.activePath;

    const tab = document.createElement("div");
    tab.className = "tabItem" + (active ? " tabItemActive" : "");
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.dataset.path = path;
    tab.title = path;
    tab.tabIndex = 0;

    const label = document.createElement("span");
    label.className = "tabLabel";
    label.textContent = name;

    const close = document.createElement("button");
    close.type = "button";
    close.className = "tabClose";
    close.setAttribute("aria-label", `关闭 ${name}`);
    close.title = "关闭";
    close.tabIndex = -1;
    close.innerHTML = TAB_CLOSE_ICON;
    close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(path); });

    tab.addEventListener("click", () => selectTab(path));
    tab.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); closeTab(path); } });
    tab.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
    tab.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectTab(path); }
    });

    tab.append(label, close);
    strip.append(tab);
  }

  // 浏览器式「+」：快速打开器（搜索已有笔记 / 新建）
  const add = document.createElement("button");
  add.type = "button";
  add.className = "tabAdd";
  add.title = "打开或新建笔记";
  add.setAttribute("aria-label", "打开或新建笔记");
  add.setAttribute("aria-haspopup", "dialog");
  add.innerHTML = TAB_ADD_ICON;
  add.addEventListener("click", () => openQuickOpen(add));
  strip.append(add);

  // 激活标签滚入可视区（标签多到横向溢出时）
  const activeEl = strip.querySelector(".tabItemActive");
  if (activeEl && strip.scrollWidth > strip.clientWidth) {
    activeEl.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

async function selectTab(path) {
  if (path === state.activePath) return;
  await loadNote(path);
}

/* ── 快速打开器（标签栏「+」）─────────────────────── */
/* 一个输入框同时覆盖「打开已有」与「新建」：空查询列最近笔记，
   输入即按文件名过滤，无匹配时首项变为「新建『query』」 */
let quickOpenEl = null;

function closeQuickOpen() {
  if (!quickOpenEl) return;
  quickOpenEl.remove();
  quickOpenEl = null;
  document.removeEventListener("mousedown", onQuickOpenOutside, true);
}

function onQuickOpenOutside(e) {
  if (quickOpenEl && !quickOpenEl.contains(e.target)) closeQuickOpen();
}

function quickOpenMatches(query) {
  const files = flattenFiles(state.tree);
  if (!query) return recentDashboardFiles();
  const q = query.toLowerCase();
  const starts = [];
  const nameHits = [];
  const pathHits = [];
  for (const f of files) {
    const base = stripExt(f.name).toLowerCase();
    if (base.startsWith(q)) starts.push(f);
    else if (base.includes(q)) nameHits.push(f);
    else if (f.path.toLowerCase().includes(q)) pathHits.push(f);
  }
  return [...starts, ...nameHits, ...pathHits].slice(0, 8);
}

function openQuickOpen(anchor) {
  closeQuickOpen();
  const rect = anchor.getBoundingClientRect();

  const pop = document.createElement("div");
  pop.className = "quickOpen";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "打开或新建笔记");
  pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 316))}px`;
  pop.style.top = `${rect.bottom + 6}px`;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "quickOpenInput";
  input.placeholder = "输入以打开或新建笔记…";
  input.autocomplete = "off";
  input.spellcheck = false;

  const list = document.createElement("div");
  list.className = "quickOpenList";

  pop.append(input, list);
  document.body.append(pop);
  quickOpenEl = pop;
  document.addEventListener("mousedown", onQuickOpenOutside, true);

  // 新建目标：当前笔记所在文件夹；无打开笔记时落根目录。在「新建」行上明示。
  const targetFolder = state.activePath ? parentFolder(state.activePath) : "";

  let items = [];
  let selected = 0;

  function applySelection() {
    list.querySelectorAll(".quickOpenItem").forEach((el, i) => {
      el.classList.toggle("quickOpenItemSelected", i === selected);
    });
  }

  async function activate(item) {
    closeQuickOpen();
    if (item.kind === "file") {
      await loadNote(item.path);
    } else {
      await createNoteWithTitle(item.title, targetFolder);
    }
  }

  function rebuild() {
    const query = input.value.trim();
    const matches = quickOpenMatches(query);
    items = matches.map((f) => ({ kind: "file", path: f.path, name: f.name }));

    // 无同名笔记时提供「新建」项：有匹配放末尾（优先打开已有），零匹配放首位
    const exact = query && matches.some((f) => stripExt(f.name).toLowerCase() === query.toLowerCase());
    if (query && !exact) {
      const createItem = { kind: "create", title: query };
      if (items.length === 0) items.unshift(createItem);
      else items.push(createItem);
    }

    selected = 0;
    list.innerHTML = "";

    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "quickOpenEmpty";
      empty.textContent = "输入以搜索或新建笔记";
      list.append(empty);
      return;
    }

    items.forEach((item, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "quickOpenItem" + (i === selected ? " quickOpenItemSelected" : "");

      const name = document.createElement("span");
      name.className = "quickOpenName";
      if (item.kind === "file") {
        name.textContent = stripExt(item.name);
        const folder = parentFolder(item.path);
        if (folder) {
          const sub = document.createElement("span");
          sub.className = "quickOpenPath";
          sub.textContent = folder;
          row.append(name, sub);
        } else {
          row.append(name);
        }
      } else {
        name.innerHTML = `${TAB_ADD_ICON} 新建「${escapeHtml(item.title)}」`;
        const dest = document.createElement("span");
        dest.className = "quickOpenPath";
        dest.textContent = `存到：${targetFolder || "根目录"}`;
        row.append(name, dest);
      }

      row.addEventListener("mouseenter", () => { selected = i; applySelection(); });
      row.addEventListener("click", () => activate(item));
      list.append(row);
    });
  }

  input.addEventListener("input", rebuild);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selected = Math.min(selected + 1, items.length - 1);
      applySelection();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selected = Math.max(selected - 1, 0);
      applySelection();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (items[selected]) activate(items[selected]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeQuickOpen();
    }
  });

  rebuild();
  input.focus();
}

async function closeTab(path) {
  const isActive = path === state.activePath;
  const idx = state.tabs.indexOf(path);
  const neighbor = isActive ? state.tabs[idx + 1] ?? state.tabs[idx - 1] ?? null : null;
  pruneTabs((p) => p !== path);
  if (!isActive) return;
  if (neighbor) {
    await loadNote(neighbor);
  } else {
    if (!(await flushPendingSave())) return;
    clearActiveNote();
    // 本次会话不再自动恢复被关掉的文件
    try { localStorage.removeItem(LAST_FILE_KEY); } catch {}
  }
}

/* ── Note operations ─────────────────────────────── */
async function loadNote(path, opts = {}) {
  const previousActivePath = state.activePath;
  // 切到别的笔记就不再自动命名，避免旧笔记在后台被改名
  if (state.autoTitlePath && state.autoTitlePath !== path) state.autoTitlePath = null;
  // 自动保存模式：切换前把未保存内容落盘
  if (!(await flushPendingSave())) return;
  closeGitWorkspace(false);

  // 记住当前笔记的阅读位置（loading 替换内容前采集，切标签回来时恢复）
  if (state.activePath && state.activePath !== path) {
    state.tabScroll.set(state.activePath, currentReadingScrollTop());
  }

  // Push to navigation history (skip when going back/forward)
  if (!opts.skipHistory) {
    navPush(path, Object.prototype.hasOwnProperty.call(opts, "fragment") ? opts.fragment : null);
  }
  updateNavButtons();

  const docArea = qs("doc-area");
  docArea.className = "docArea";
  docArea.innerHTML = `<div class="loadingDoc"><div class="loadingSpinner"></div><span>加载中…</span></div>`;

  try {
    const command = isImageExt(extOf(path)) ? "read_asset" : "read_note";
    const note = opts.note ?? await invoke(command, { path });
    state.activePath = note.path;
    state.activeNote = note;
    if (opts.replaceCurrentTab) replaceTabPath(previousActivePath, note.path);
    else ensureTab(note.path);
    expandAncestors(note.path);
    renderTree();
    renderNoteMeta();
    setDirty(false);
    const renderOptions = { scrollTop: state.tabScroll.get(note.path) ?? 0 };
    if (Object.prototype.hasOwnProperty.call(opts, "fragment")) {
      renderOptions.fragment = opts.fragment;
    }
    renderDocArea(renderOptions);
    if (!isHtmlNote()) docArea.scrollTop = renderOptions.scrollTop;
    if (state.outlineOpen) renderToc();
    sendNoteContext();
    try { localStorage.setItem(LAST_FILE_KEY, path); } catch {}
  } catch (err) {
    showToast(String(err));
    docArea.className = "docArea";
    docArea.innerHTML = `<div class="emptyState"><p class="emptyStateTitle" style="color:#cc2d24">${escapeHtml(String(err))}</p></div>`;
  }
}

function clearActiveNote() {
  cancelAutosave();
  state.autoTitlePath = null;
  state.activePath = null;
  state.activeNote = null;
  setDirty(false);
  renderNoteMeta();
  renderDocArea();
  renderTree();
  renderTabs();
  sendNoteContext();
}

async function saveNote() {
  if (!state.activeNote || !state.dirty) return true;
  if (state.savePromise) return await state.savePromise;

  const savePromise = (async () => {
    cancelAutosave();
    const savedPath = state.activeNote.path;
    const content = state.editor ? state.editor.getValue() : state.activeNote.content;
    state.saving = true;
    try {
      const note = await invoke("write_note", { path: savedPath, content });
      // 保存期间笔记可能已被切换，仅在仍是当前笔记时更新状态
      if (state.activeNote?.path === savedPath) {
        state.activeNote = note;
        if (state.editor && state.editor.getValue() !== content) {
          // 保存期间又有新输入，保持 dirty 并等待下一轮自动保存
          setDirty(true);
          scheduleAutosave();
        } else {
          setDirty(false);
          flashSavedHint();
        }
      }
      await maybeAutoTitle(savedPath);
      await loadTree(false);
      if (state.outlineOpen) renderToc();
      return true;
    } catch (err) {
      showToast(String(err));
      if (state.activeNote?.path === savedPath && state.dirty) scheduleAutosave();
      return false;
    } finally {
      state.saving = false;
    }
  })();

  state.savePromise = savePromise;
  try {
    return await savePromise;
  } finally {
    if (state.savePromise === savePromise) state.savePromise = null;
  }
}

async function createNoteWithTitle(title, folder) {
  try {
    const note = await invoke("create_note", { folder, title });
    if (folder) state.expanded.add(folder);
    await loadTree(false);
    await loadNote(note.path);
  } catch (err) {
    showToast(String(err));
  }
}

const UNTITLED_NAME = "无标题";

/* 新建不问名字：先给一个不冲突的占位名，写完首行再自动落定 */
function uniqueUntitledName(folder) {
  const taken = new Set(
    flattenFiles(state.tree)
      .filter((file) => parentFolder(file.path) === folder)
      .map((file) => stripExt(file.name).toLowerCase())
  );
  if (!taken.has(UNTITLED_NAME.toLowerCase())) return UNTITLED_NAME;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${UNTITLED_NAME} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${UNTITLED_NAME} ${Date.now()}`;
}

/* 正文首个非空行 → 文件名（跳过 front matter，去掉 markdown 记号与文件系统非法字符） */
function titleFromContent(content) {
  const { body } = parseFrontMatter(String(content || ""));
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && l !== "---");
  if (!line) return "";
  return line
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[-*+>]\s*/, "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

async function createBlankNote(folder = "") {
  try {
    const note = await invoke("create_note", { folder, title: uniqueUntitledName(folder) });
    if (folder) state.expanded.add(folder);
    await loadTree(false);
    await loadNote(note.path);
    if (state.activePath !== note.path) return;
    state.autoTitlePath = note.path;
    await openBlankEditor();
  } catch (err) {
    showToast(String(err));
  }
}

/* 新笔记直接落在空白页第一行：不留占位标题，也不用先想名字 */
async function openBlankEditor() {
  if (!state.editMode) await setEditMode(true, { line: 0 });
  const cm = state.editor;
  if (!cm) return;
  if (cm.getValue() !== "") cm.setValue("");
  cm.setCursor({ line: 0, ch: 0 });
  cm.focus();
  syncEditorPlaceholder();
}

async function createNote() {
  const folder = state.activePath ? parentFolder(state.activePath) : "";
  await createBlankNote(folder);
}

/* 自动保存后把占位名换成首行标题；重名等冲突静默跳过，下次输入再试 */
async function maybeAutoTitle(savedPath) {
  if (!state.autoTitlePath || state.autoTitlePath !== savedPath) return;
  if (state.activeNote?.path !== savedPath) return;
  const ext = extOf(state.activeNote.name);
  const title = titleFromContent(state.editor ? state.editor.getValue() : state.activeNote.content);
  if (!title || title === UNTITLED_NAME) return;
  const newName = ext ? `${title}.${ext}` : title;
  if (newName === state.activeNote.name) return;
  try {
    const newPath = await invoke("rename_entry", { path: savedPath, name: newName });
    state.activePath = newPath;
    state.activeNote = { ...state.activeNote, path: newPath, name: newName };
    state.autoTitlePath = newPath;
    mapTabPaths((p) => (p === savedPath ? newPath : p));
    const scroll = state.tabScroll.get(savedPath);
    if (scroll != null) {
      state.tabScroll.delete(savedPath);
      state.tabScroll.set(newPath, scroll);
    }
    renderNoteMeta();
    try { localStorage.setItem(LAST_FILE_KEY, newPath); } catch {}
  } catch {
    /* 同名文件已存在等情况：保留占位名 */
  }
}

async function deleteActiveNote() {
  if (!state.activeNote) return;
  if (!(await flushPendingSave())) return;
  const ok = await showConfirm(`确定删除「${state.activeNote.name}」吗？此操作无法撤销。`);
  if (!ok) return;
  // 取消待执行的自动保存，避免删除后又把文件写回来
  cancelAutosave();
  setDirty(false);
  try {
    const deletedPath = state.activeNote.path;
    await invoke("delete_entry", { path: deletedPath });
    pruneTabs((p) => p !== deletedPath);
    clearActiveNote();
    await loadTree(false);
    showToast("已删除");
  } catch (err) {
    showToast(String(err));
  }
}

/* ── Vault switcher ──────────────────────────────── */
const RECENT_VAULTS_KEY = "recent_vaults";

function vaultDisplayName(path) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function vaultDisplayPath(path) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 3 ? `…${parts.slice(-3).join("/")}` : path;
}

function getRecentVaults() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_VAULTS_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function rememberVault(path) {
  if (!path) return;
  const list = [path, ...getRecentVaults().filter((p) => p !== path)].slice(0, 5);
  try {
    localStorage.setItem(RECENT_VAULTS_KEY, JSON.stringify(list));
  } catch {}
}

function removeRecentVault(path) {
  try {
    const list = getRecentVaults().filter((p) => p !== path);
    localStorage.setItem(RECENT_VAULTS_KEY, JSON.stringify(list));
    renderVaultMenu();
  } catch {}
}

function toggleVaultMenu(force) {
  const menu = qs("vault-menu");
  const btn = qs("btn-vault-switcher");
  const open = force !== undefined ? force : menu.hidden;
  menu.hidden = !open;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) renderVaultMenu();
}

function renderVaultMenu() {
  const menu = qs("vault-menu");
  const current = state.vaultPath;
  const recents = getRecentVaults().filter((p) => p !== current);

  menu.innerHTML = `
    <div class="vaultDropdownSectionTitle">${state.transientVault ? "临时打开目录" : "当前笔记本"}</div>
    <div class="activeVaultCard">
      <div class="activeVaultIcon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M6 6h10"/><path d="M6 10h10"/></svg>
      </div>
      <div class="activeVaultInfo">
        <p class="activeVaultName">${escapeHtml(vaultDisplayName(current))}</p>
        <p class="activeVaultPath" title="${escapeHtml(current)}">${escapeHtml(vaultDisplayPath(current))}</p>
      </div>
    </div>
    ${recents.length ? `
      <div class="vaultDropdownDivider"></div>
      <div class="vaultDropdownSectionTitle">最近使用</div>
      <div class="recentVaultsList">
        ${recents.map((path) => `
          <div class="vaultDropdownItemWrap" role="none">
            <button type="button" class="vaultDropdownItem" role="menuitem" data-vault-path="${escapeHtml(path)}">
              <svg class="dropdownItemIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/></svg>
              <span class="recentVaultInfo">
                <span class="recentVaultNameText">${escapeHtml(vaultDisplayName(path))}</span>
                <span class="recentVaultPathText">${escapeHtml(vaultDisplayPath(path))}</span>
              </span>
            </button>
            <button type="button" class="vaultRemoveBtn" role="menuitem" data-remove-vault="${escapeHtml(path)}" title="从最近列表移除" aria-label="从最近列表移除 ${escapeHtml(vaultDisplayName(path))}">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>`).join("")}
      </div>` : ""}
    <div class="vaultDropdownDivider"></div>
    <button type="button" id="btn-choose-vault" class="vaultDropdownItemAction" role="menuitem">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <span>选择其他笔记本文件夹…</span>
    </button>`;

  menu.querySelectorAll("[data-vault-path]").forEach((el) => {
    el.addEventListener("click", () => switchToVault(el.getAttribute("data-vault-path")));
  });
  menu.querySelectorAll("[data-remove-vault]").forEach((el) => {
    el.addEventListener("click", (e) => { e.stopPropagation(); removeRecentVault(el.getAttribute("data-remove-vault")); });
  });
  qs("btn-choose-vault").addEventListener("click", chooseVault);
}

async function applyVaultChange(desktop) {
  applyDesktopState(desktop);
  clearActiveNote();
  await loadTree(true);
  waitForAgent();
  refreshGitStatus();
}

async function switchToVault(path) {
  toggleVaultMenu(false);
  if (!path || path === state.vaultPath) return;
  if (!(await flushPendingSave())) return;
  try {
    const desktop = await invoke("set_vault_path", { path });
    await applyVaultChange(desktop);
  } catch (err) {
    showToast(String(err));
  }
}

async function chooseVault() {
  toggleVaultMenu(false);
  if (!(await flushPendingSave())) return;
  try {
    const desktop = await invoke("select_and_set_vault");
    await applyVaultChange(desktop);
  } catch (err) {
    if (!String(err).includes("cancelled")) showToast(String(err));
  }
}

async function openMarkdownFromShell(absolutePath) {
  if (!absolutePath) return false;
  if (!(await flushPendingSave())) return false;

  try {
    const result = await invoke("open_markdown_file", { path: absolutePath });
    const rootChanged = result.rootChanged === true;
    applyDesktopState(result.desktop);
    if (rootChanged) {
      state.tree = null;
      state.tabs = [];
      persistTabs();
      renderTabs();
    }
    clearActiveNote();
    state.navHistory = [];
    state.navIndex = -1;
    state.tabScroll.clear();
    updateNavButtons();
    await loadNote(result.path, { note: result.note });
    showToast(`已打开 ${result.path.split("/").pop()}`);
    requestAnimationFrame(() => {
      // 只有 agent iframe 从没起过（比如双击 .md 冷启动整个 app）才需要 waitForAgent
      // 去设 frame.src。它已经连上时再调，会把 iframe 整个重新加载一遍，正在跑的
      // 对话直接被清空——单实例复用时（app 已经开着，双击/外部程序打开 .md 走
      // file association 转发到这个已有窗口）就是这么把 AI 面板炸空的。
      if (!state.agentReady) void waitForAgent();
      const backgroundTasks = [refreshGitStatus()];
      if (rootChanged) backgroundTasks.push(loadTree(false));
      void Promise.allSettled(backgroundTasks).then((outcomes) => {
        for (const outcome of outcomes) {
          if (outcome.status === "rejected") {
            console.warn("[inkfellow] Markdown background initialization failed:", outcome.reason);
          }
        }
      });
    });
    return true;
  } catch (err) {
    showToast(`无法打开 Markdown: ${String(err)}`);
    return false;
  }
}

async function drainPendingMarkdownFiles() {
  const paths = await invoke("take_pending_markdown_files");
  let opened = false;
  for (const path of paths) {
    opened = (await openMarkdownFromShell(path)) || opened;
  }
  return opened;
}

function queuePendingMarkdownOpen() {
  const next = markdownOpenQueue
    .catch(() => false)
    .then(() => drainPendingMarkdownFiles())
    .catch((err) => {
      showToast(`无法读取待打开文件: ${String(err)}`);
      return false;
    });
  markdownOpenQueue = next;
  return next;
}

/* ── Search ──────────────────────────────────────── */
function clearSearch() {
  const input = qs("search-input");
  const box = qs("search-results");
  const sidebar = qs("sidebar");
  clearTimeout(state.searchTimer);
  state.searchTimer = null;
  state.searchRequestId++;
  input.value = "";
  qs("btn-search-clear").hidden = true;
  box.hidden = true;
  box.replaceChildren();
  sidebar.classList.remove("searchActive");
}

async function runSearch(query, requestId) {
  const box = qs("search-results");
  const sidebar = qs("sidebar");
  if (requestId !== state.searchRequestId) return;
  if (query.trim().length < 2) {
    box.hidden = true;
    box.replaceChildren();
    sidebar.classList.remove("searchActive");
    return;
  }
  sidebar.classList.add("searchActive");
  try {
    const hits = await invoke("search_notes", { query });
    if (requestId !== state.searchRequestId) return;
    box.replaceChildren();
    if (hits.length === 0) {
      const empty = document.createElement("p");
      empty.className = "searchEmpty";
      empty.textContent = "没有找到相关笔记";
      box.appendChild(empty);
      box.hidden = false;
      return;
    }
    for (const hit of hits) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "searchHit";
      const title = document.createElement("span");
      title.className = "searchHitTitle";
      title.textContent = stripExt(hit.name);
      const snippet = document.createElement("span");
      snippet.className = "searchHitSnippet";
      snippet.textContent = hit.snippet || hit.path;
      btn.append(title, snippet);
      btn.addEventListener("click", () => {
        loadNote(hit.path);
        clearSearch();
      });
      box.appendChild(btn);
    }
    box.hidden = false;
  } catch (err) {
    if (requestId !== state.searchRequestId) return;
    box.hidden = true;
    box.replaceChildren();
    sidebar.classList.remove("searchActive");
    showToast(String(err));
  }
}

/* ── Agent ───────────────────────────────────────── */
function agentOrigin() {
  try {
    return new URL(state.agentUrl).origin;
  } catch {
    return null;
  }
}

const pendingAgentMessages = [];

function setAgentLoading(visible, detail = "") {
  const loading = qs("agent-loading");
  if (!loading) return;
  if (detail) qs("agent-loading-detail").textContent = detail;
  loading.hidden = !visible;
}

function postAgentMessage(message) {
  const frame = qs("agent-frame");
  const targetOrigin = agentOrigin();
  // iframe 未就绪时其 origin 仍是宿主窗口，精确 targetOrigin 会被浏览器拒绝并刷红
  // console；此时入队（设上限防堆积），待 iframe 内部 WebSocket 就绪后统一补发。
  if (!state.agentReady || !frame.contentWindow || !targetOrigin) {
    if (pendingAgentMessages.length >= 100) return false;
    pendingAgentMessages.push(message);
    return true;
  }
  try {
    // 附带由 Rust 与 sidecar 共享的会话 token，供 iframe 校验真实桌面宿主。
    frame.contentWindow.postMessage({ ...message, __token: state.agentToken }, targetOrigin);
    return true;
  } catch {
    if (pendingAgentMessages.length >= 100) return false;
    pendingAgentMessages.push(message);
    return true;
  }
}

function flushAgentMessages({ includeAgentRequests = true } = {}) {
  if (!state.agentReady) return;
  const queued = pendingAgentMessages.splice(0);
  for (const message of queued) {
    if (!includeAgentRequests && message?.type === "note-ask") {
      pendingAgentMessages.push(message);
      continue;
    }
    postAgentMessage(message);
  }
}

function sendNoteContext() {
  postAgentMessage({ type: "note-context", filePath: state.activePath ?? null });
}

function sendVaultNotes(force = false) {
  if (!state.tree) return;
  const notes = flattenFiles(state.tree)
    .filter((file) => /^(md|html?)$/i.test(file.extension || extOf(file.name)))
    .map((file) => ({
      path: file.path,
      title: stripExt(file.name),
    }));
  const signature = JSON.stringify([state.vaultPath, notes]);
  if (!force && signature === state.vaultNotesSignature) return;
  if (postAgentMessage({ type: "vault-notes", notes })) {
    state.vaultNotesSignature = signature;
  }
}

function sendSelectionContext() {
  let text = "";
  if (state.editor && state.editor.hasFocus()) {
    text = state.editor.getSelection().trim();
  } else {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) text = sel.toString().trim();
  }
  postAgentMessage(text
    ? { type: "note-selection", text }
    : { type: "note-selection-clear" });
}

async function waitForAgent() {
  setAgentLoading(true, "正在启动本地 AI 服务...");
  for (let i = 0; i < 120; i++) {
    try {
      const ready = await invoke("agent_status");
      if (ready) {
        const url = new URL("/", state.agentUrl);
        url.searchParams.set("desktop", "1");
        url.searchParams.set("wsPort", String(state.agentPort));
        url.searchParams.set("parentOrigin", window.location.origin);
        if (!state.agentToken) throw new Error("Missing desktop agent token.");
        url.searchParams.set("token", state.agentToken);
        const frame = qs("agent-frame");
        state.agentReady = false;
        setAgentLoading(true, "正在打开 Fellow...");
        frame.src = url.toString();
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, i < 60 ? 100 : 350));
  }
  setAgentLoading(true, "Fellow 启动超时，请重启应用或查看日志。");
}

/* ── Git ─────────────────────────────────────────── */
function gitStateLabel(value, kind) {
  if (kind === "folder" && value === "added") return "新文件夹";
  return {
    modified: "已修改",
    added: "新笔记",
    deleted: "已删除",
    renamed: "重命名",
    // 正常情况下冲突已经在同步时自动合并掉了，这里只是极端情况下的兜底提示
    conflict: "冲突，点击「立即同步」自动合并",
  }[value] || "已修改";
}

function gitStateDotClass(value) {
  return {
    modified: "gitStateDotModified",
    added: "gitStateDotAdded",
    deleted: "gitStateDotDeleted",
    renamed: "gitStateDotModified",
    conflict: "gitStateDotConflict",
  }[value] || "gitStateDotModified";
}

function gitParentPath(path) {
  return path.includes("/") ? path.split("/").slice(0, -1).join(" / ") : "";
}

function formatLastSync(iso) {
  if (!iso) return "";
  const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH} 小时前`;
  return new Date(iso).toLocaleDateString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function renderGitStatusUI() {
  const dot = qs("sidebar-git-dot");
  const label = qs("sidebar-git-label");
  const st = state.gitStatus;
  if (!st) return;

  if (state.transientVault) {
    dot.className = "sidebarGitDot";
    label.textContent = "临时文件不参与同步";
    renderGitPanel();
    return;
  }

  if (!st.initialized) {
    dot.className = "sidebarGitDot";
    label.textContent = "尚未初始化同步";
    renderGitPanel();
    return;
  }

  const files = st.files || [];
  const synced = files.length === 0 && st.ahead === 0 && st.behind === 0;
  const errorHint = state.gitLastErrorKind && gitErrorHint(state.gitLastErrorKind);
  dot.className = "sidebarGitDot" + (errorHint ? " sidebarGitDotError" : synced ? " sidebarGitDotSynced" : "");
  if (errorHint) {
    label.textContent = errorHint;
  } else if (synced) {
    label.textContent = "已同步到云端";
  } else if (files.length === 0 && st.behind > 0) {
    label.textContent = `云端有 ${st.behind} 个新版本`;
  } else if (files.length > 0) {
    label.textContent = `${files.length} 篇待同步`;
  } else {
    label.textContent = `${st.ahead} 篇待同步`;
  }
  renderGitPanel();
}

async function refreshGitStatus() {
  try {
    state.gitStatus = await invoke("git_status");
    renderGitStatusUI();
  } catch (err) {
    qs("sidebar-git-label").textContent = "同步状态异常";
    state.gitFeedback = String(err);
    state.gitFeedbackError = true;
    renderGitPanel();
  }
}

const _pendingChangedPaths = new Set();
let _treeRefreshRunning = false;

function scheduleTreeRefresh(changedPaths = []) {
  for (const p of changedPaths) _pendingChangedPaths.add(p);
  clearTimeout(state.treeRefreshTimer);
  state.treeRefreshTimer = setTimeout(() => {
    state.treeRefreshTimer = null;
    void flushTreeRefresh();
  }, 300);
}

async function flushTreeRefresh() {
  if (_treeRefreshRunning || _pendingChangedPaths.size === 0) return;
  _treeRefreshRunning = true;
  const accumulated = [..._pendingChangedPaths];
  _pendingChangedPaths.clear();

  try {
    const activePath = state.activePath;
    await loadTree(false);
    const activePathLower = activePath?.toLowerCase();
    if (!activePathLower || state.activePath?.toLowerCase() !== activePathLower) return;

    // 精准判断：检查防抖期间所有变化路径，Windows 大小写不敏感
    const activeChanged = accumulated.length === 0 || accumulated.some((p) => {
      const changed = p.toLowerCase();
      return changed === activePathLower || activePathLower.startsWith(changed + "/");
    });
    if (!activeChanged || (state.editMode && state.dirty)) return;

    const stillExists = flattenFiles(state.tree)
      .some((file) => file.path.toLowerCase() === activePathLower);
    if (!stillExists) {
      clearActiveNote();
      showToast("当前文件已被外部删除");
      return;
    }

    const isImage = isImageExt(extOf(activePath));
    const command = isImage ? "read_asset" : "read_note";
    const note = await invoke(command, { path: activePath });
    if (state.activePath?.toLowerCase() !== activePathLower) return;

    const changed = isImage
      ? note.updatedAt !== state.activeNote?.updatedAt ||
        note.size !== state.activeNote?.size ||
        note.dataUrl !== state.activeNote?.dataUrl
      : note.content !== state.activeNote?.content;
    if (!changed) return;

    const docArea = qs("doc-area");
    const scrollTop = currentReadingScrollTop();
    const oldBlockTexts = collectDiffBlocks().map((block) => block.text);
    const imageNodes = captureMarkdownImages();
    state.activeNote = note;
    renderDocArea({ silent: true, imageNodes, scrollTop });
    if (!isHtmlNote()) docArea.scrollTop = scrollTop;
    if (state.outlineOpen) renderToc();
    flashChangedPreviewBlocks(oldBlockTexts);
  } catch (err) {
    console.warn("Failed to refresh file tree after vault change", err);
  } finally {
    _treeRefreshRunning = false;
    if (_pendingChangedPaths.size > 0 && state.treeRefreshTimer == null) {
      scheduleTreeRefresh();
    }
  }
}

function requestAutoPull() {
  if (state.transientVault) return;
  if (state.gitStatus && !state.gitStatus.initialized) return;
  // 正在编辑时不拉取，保护沉浸状态
  if (state.editMode && state.dirty) return;
  invoke("sync_request_pull", { force: false }).catch(() => {});
}

async function initSyncEvents() {
  const listen = window.__TAURI__?.event?.listen;
  if (!listen) return;

  await listen("vault-tree-changed", ({ payload }) => {
    scheduleTreeRefresh(payload?.changedPaths ?? []);
  });

  await listen("open-markdown-files-pending", () => {
    if (state.desktopReady) void queuePendingMarkdownOpen();
  });

  await listen("sync-state", async ({ payload }) => {
    const dot = qs("sidebar-git-dot");

    if (payload.phase === "pulling" || payload.phase === "syncing") {
      dot.classList.add("sidebarGitDotPulsing");
      if (payload.phase === "syncing") {
        state.gitBusy = true;
        renderGitPanel();
      }
      return;
    }

    // idle：一次同步动作结束
    dot.classList.remove("sidebarGitDotPulsing");
    state.gitBusy = false;

    // 先落地这次的错误分类，renderGitStatusUI 才能同步显示红点
    const previousErrorKind = state.gitLastErrorKind;
    state.gitLastErrorKind = payload.error ? (payload.errorKind || "other") : null;

    if (payload.status) {
      state.gitStatus = payload.status;
      renderGitStatusUI();
    } else if (payload.error) {
      renderGitStatusUI();
    }

    if (payload.kind === "commitPush") {
      if (payload.error) {
        showGitFeedback(gitErrorFriendlyMessage(state.gitLastErrorKind, payload.error), true);
      } else {
        state.gitMessage = "";
        state.gitEditingMessage = false;
        showGitFeedback(payload.feedback || "已同步。");
      }
    }
    // 自动 pull 失败大多保持静默（网络抖动会自动退避重试）；圆点变红已经在
    // renderGitStatusUI 中体现。但鉴权失败不会靠重试自愈，这里边缘触发提示一次。
    if (
      payload.kind === "pull" &&
      payload.error &&
      state.gitLastErrorKind === "auth" &&
      previousErrorKind !== "auth"
    ) {
      showToast("云端鉴权失败，需要重新登录这台设备的 Git");
    }

    if (payload.pulledChanges) {
      showToast("已获取云端更新");
      await loadTree(false);
      if (state.gitPane === "history") await openGitHistory();
    }
  });
}

function gitErrorFriendlyMessage(kind, raw) {
  switch (kind) {
    case "network":
      return "网络不稳定，同步失败了，请检查网络后重试。";
    case "auth":
      return "云端仓库鉴权失败，请检查这台设备的 Git 登录状态。";
    default:
      return raw || "同步失败，请重试。";
  }
}

function gitErrorHint(kind) {
  switch (kind) {
    case "network":
      return "网络不稳定，稍后会自动重试";
    case "auth":
      return "云端鉴权失败，需要重新登录";
    case "other":
      return "同步遇到问题，可点击重试";
    default:
      return null;
  }
}

function showGitFeedback(msg, isError = false) {
  state.gitFeedback = msg;
  state.gitFeedbackError = isError;
  renderGitPanel();
  setTimeout(() => {
    if (state.gitFeedback === msg) {
      state.gitFeedback = null;
      renderGitPanel();
    }
  }, 6000);
}

async function gitCommitPush() {
  const message = state.gitMessage.trim();
  state.gitBusy = true;
  // 进行中的说明放进按钮里：不占一条绿色「成功」横幅，也不把按钮往下挤
  state.gitBusyLabel = message ? "正在同步到云端…" : "正在同步并生成 AI 摘要…";
  state.gitFeedback = null;
  renderGitPanel();
  try {
    // 只入队，执行结果由 sync-state 事件回推
    await invoke("sync_commit_and_push", { message });
  } catch (err) {
    state.gitBusy = false;
    showGitFeedback(String(err), true);
    renderGitPanel();
  }
}

async function gitInit() {
  state.gitBusy = true;
  renderGitPanel();
  try {
    const result = await invoke("git_init");
    showGitFeedback(result.stdout || "已初始化。");
    await refreshGitStatus();
  } catch (err) {
    showGitFeedback(String(err), true);
  } finally {
    state.gitBusy = false;
    renderGitPanel();
  }
}

const GIT_ICON_BACK = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>`;
const GIT_ICON_REFRESH = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>`;
const GIT_ICON_UNDO = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>`;
const GIT_ICON_FILE = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>`;

/* 返回放在内容列左上角、带文字，三个页面同一个样式：眼睛在内容上，返回就该在手边 */
function renderGitBackLink(action, label, id = "") {
  return `
    <nav class="gitPaneNav">
      <button ${id ? `id="${id}" ` : ""}class="gitBackLink" type="button" data-action="${action}" title="${label}（Esc）">
        ${GIT_ICON_BACK}<span>${label}</span><kbd>Esc</kbd>
      </button>
    </nav>`;
}

/* 「还原」在不同状态下其实是不同的事，按钮上直接说清楚 */
function discardActionLabel(fileState, kind) {
  if (kind === "folder" || fileState === "added") return "删除";
  if (fileState === "deleted") return "恢复";
  if (fileState === "modified") return "放弃修改";
  return "还原";
}

function renderGitPanel() {
  renderGitQuickPopover();
  const panel = qs("git-panel");
  if (!panel || !state.gitWorkspaceOpen) return;
  if (state.transientVault) {
    panel.innerHTML = `
      <div id="git-app" class="gitPanel">
        <div class="gitEmptyState">
          <div class="gitEmptyTitle">这是临时打开的 Markdown 文件</div>
          <div class="gitEmptyDesc">临时目录不会自动初始化或同步。需要同步时，请先把目录选择为正式笔记本。</div>
        </div>
      </div>`;
    return;
  }

  const st = state.gitStatus;
  const files = st?.files || [];
  const initialized = st ? st.initialized !== false : null;
  const synced = initialized === true && files.length === 0 && st.ahead === 0 && st.behind === 0;
  const focusKey = gitPanelFocusKey(panel);

  panel.innerHTML = `
    <div id="git-app" class="gitPanel">
      <div class="gitStack ${state.gitPane !== "main" ? "gitStackShowingDetail" : ""}">
        <section class="gitStackPane" aria-hidden="${state.gitPane !== "main" ? "true" : "false"}" ${state.gitPane !== "main" ? "inert" : ""}>${renderGitMainPane(st, files, initialized, synced)}</section>
        <section class="gitStackPane gitDetailPane" aria-hidden="${state.gitPane === "main" ? "true" : "false"}" ${state.gitPane === "main" ? "inert" : ""}>
          ${state.gitPane === "diff" ? renderGitDiffPane() : ""}
          ${state.gitPane === "history" ? renderGitHistoryPane() : ""}
        </section>
      </div>
    </div>`;
  wireGitPanel();
  restoreGitPanelFocus(panel, focusKey);
}

/* 面板每次整块重绘，焦点会掉回 body：记下焦点在哪个按钮上，重绘后放回去；
   那个按钮没了（比如确认框收起）就落到当前页的返回键上，键盘和 Esc 都接得上 */
function gitPanelFocusKey(panel) {
  const el = document.activeElement;
  if (!el || el === document.body || !panel.contains(el)) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;
  const action = el.getAttribute("data-action");
  if (!action) return "";
  const path = el.getAttribute("data-path");
  return `[data-action="${action}"]${path != null ? `[data-path="${CSS.escape(path)}"]` : ""}`;
}

function restoreGitPanelFocus(panel, key) {
  if (key == null) return;
  const visiblePane = panel.querySelector(".gitStackPane:not([inert])");
  const target = (key && visiblePane?.querySelector(key)) || visiblePane?.querySelector(".gitBackLink");
  target?.focus({ preventScroll: true });
}

function renderGitQuickPopover() {
  const content = qs("git-quick-content");
  if (!content || !state.gitQuickOpen) return;
  if (state.transientVault) {
    content.innerHTML = `
      <div class="gitQuickStatus">
        <span class="gitQuickStatusDot"></span>
        <div class="gitQuickStatusText">
          <strong>临时文件不参与同步</strong>
          <span>需要同步时，请先把目录选择为正式笔记本。</span>
        </div>
      </div>`;
    requestAnimationFrame(positionGitQuickPopover);
    return;
  }

  const st = state.gitStatus;
  const files = st?.files || [];
  const initialized = st ? st.initialized !== false : null;
  const synced = initialized === true && files.length === 0 && st.ahead === 0 && st.behind === 0;
  const errorHint = initialized === true && state.gitLastErrorKind && gitErrorHint(state.gitLastErrorKind);
  const statusLabel = !st
    ? "正在检查..."
    : !initialized
      ? "尚未初始化同步"
      : errorHint
        ? errorHint
        : synced
          ? "已同步到云端"
          : files.length
            ? `${files.length} 篇待同步`
            : st.behind > 0
              ? `云端有 ${st.behind} 个新版本`
              : `${st.ahead || 0} 篇待同步`;
  const detailLabel = st?.lastSync
    ? `上次同步 ${formatLastSync(st.lastSync)}`
    : st?.branch || "";
  const previewFiles = files.slice(0, 3);

  content.innerHTML = `
    <div class="gitQuickStatus">
      <span class="gitQuickStatusDot ${errorHint ? "gitQuickStatusDotError" : synced ? "gitQuickStatusDotSynced" : ""} ${state.gitBusy ? "gitQuickStatusDotBusy" : ""}"></span>
      <div class="gitQuickStatusText">
        <strong>${escapeHtml(statusLabel)}</strong>
        ${detailLabel ? `<span>${escapeHtml(detailLabel)}</span>` : ""}
      </div>
      <button id="btn-git-quick-refresh" class="gitQuickIconButton" type="button" title="重新检查" aria-label="重新检查" ${state.gitBusy ? "disabled" : ""}>${GIT_ICON_REFRESH}</button>
    </div>
    ${previewFiles.length ? `
      <div class="gitQuickChanges">
        <div class="gitQuickSectionLabel">最近更改</div>
        <ul>
          ${previewFiles.map((file) => `
            <li>
              <button type="button" ${file.kind === "folder" ? "disabled" : `data-quick-diff="${escapeHtml(file.path)}"`}>
                <span class="gitStateDot ${gitStateDotClass(file.state)}"></span>
                <span class="gitQuickFileText">
                  <strong>${escapeHtml(stripExt(file.name))}</strong>
                  <span>${escapeHtml(gitStateLabel(file.state, file.kind))}</span>
                </span>
              </button>
            </li>`).join("")}
        </ul>
        ${files.length > previewFiles.length ? `<div class="gitQuickMoreCount">另有 ${files.length - previewFiles.length} 项更改</div>` : ""}
      </div>` : ""}
    ${state.gitFeedback ? `<div class="gitQuickFeedback ${state.gitFeedbackError ? "gitQuickFeedbackError" : ""}">${escapeHtml(state.gitFeedback)}</div>` : ""}
    <div class="gitQuickActions">
      ${initialized === null ? `
        <button class="gitQuickPrimary" type="button" disabled>正在检查...</button>` : initialized ? `
        <button id="btn-git-quick-sync" class="gitQuickPrimary ${state.gitBusy ? "gitQuickPrimaryBusy" : ""}" type="button" ${state.gitBusy || synced ? "disabled" : ""}>
          ${state.gitBusy ? `<span class="gitSpinner"></span>同步中…` : synced ? "已是最新版本" : "立即同步"}
        </button>` : `
        <button id="btn-git-quick-init" class="gitQuickPrimary" type="button" ${state.gitBusy ? "disabled" : ""}>初始化同步</button>`}
      <button id="btn-git-quick-details" class="gitQuickDetails" type="button">${files.length ? "查看全部更改" : "查看同步详情"}</button>
    </div>`;

  qs("btn-git-quick-refresh")?.addEventListener("click", () => void refreshGitStatus());
  qs("btn-git-quick-sync")?.addEventListener("click", () => void gitCommitPush());
  qs("btn-git-quick-init")?.addEventListener("click", () => void gitInit());
  qs("btn-git-quick-details")?.addEventListener("click", () => void openGitWorkspace());
  content.querySelectorAll("[data-quick-diff]").forEach((button) => {
    button.addEventListener("click", async () => {
      const path = button.getAttribute("data-quick-diff");
      if (await openGitWorkspace()) await openGitDiff(path);
    });
  });
  requestAnimationFrame(positionGitQuickPopover);
}

function renderGitMainPane(st, files, initialized, synced) {
  const statusLabel = !st
    ? "正在检查云端..."
    : !initialized
      ? "尚未初始化云端同步"
      : synced
        ? "已是最新版本"
        : files.length
          ? `${files.length} 篇笔记待同步`
          : st.behind > 0
            ? `云端有 ${st.behind} 个新版本`
            : `${st.ahead} 个版本待推送到云端`;
  // 分支、云端状态、上次同步合成一行副标题，底部只留操作
  const errorHint = initialized && state.gitLastErrorKind && gitErrorHint(state.gitLastErrorKind);
  const subParts = [];
  if (errorHint) subParts.push(errorHint);
  if (st?.behind > 0 && files.length) subParts.push("云端有新更新");
  if (st?.branch) subParts.push(st.branch);
  if (st?.lastSync) subParts.push(`上次同步 ${formatLastSync(st.lastSync)}`);

  return `
    ${renderGitBackLink("close", "返回笔记", "btn-close-git-workspace")}
    <div class="gitStatusBar">
      <div class="gitStatusLeft">
        <span class="gitStatusDot ${errorHint ? "gitStatusDotError" : synced ? "gitStatusDotSynced" : ""} ${state.gitBusy ? "gitStatusDotPulsing" : ""}"></span>
        <div class="gitStatusText">
          <div class="gitStatusLabel">${escapeHtml(statusLabel)}</div>
          <div class="gitStatusSubLabel">${escapeHtml(subParts.join(" · "))}</div>
        </div>
      </div>
      <div class="gitHeaderActions">
        ${initialized ? `<button id="btn-git-history-new" class="gitHistoryBtn" type="button">版本记录</button>` : ""}
        <button id="btn-git-refresh-new" class="gitRefresh" type="button" title="重新检查" aria-label="重新检查" ${state.gitBusy ? "disabled" : ""}>${GIT_ICON_REFRESH}</button>
      </div>
    </div>
    <div class="gitFileListContainer">${renderGitFileList(st, files, initialized, synced)}</div>
    ${state.gitFeedback ? `<div class="gitFeedback ${state.gitFeedbackError ? "gitFeedbackError" : ""}" role="status">${escapeHtml(state.gitFeedback)}</div>` : ""}
    <div class="gitBottomBar">
      ${initialized && files.length ? renderGitMessageBar() : ""}
      <div class="gitActions">
        ${initialized === null ? `<button class="gitButton gitButtonPrimary gitButtonFull gitButtonDisabled" type="button" disabled>正在检查...</button>` : initialized ? `
          <button id="btn-git-sync-new" class="gitButton gitButtonPrimary gitButtonFull ${synced && !state.gitBusy ? "gitButtonDisabled" : ""} ${state.gitBusy ? "gitButtonBusy" : ""}" type="button" ${state.gitBusy || synced ? "disabled" : ""}>
            ${state.gitBusy ? `<span class="gitSpinner"></span><span>${escapeHtml(state.gitBusyLabel || "正在同步…")}</span>` : synced ? "<span>已同步到最新</span>" : "<span>立即同步到云端</span>"}
          </button>
        ` : `<button id="btn-git-init-new" class="gitButton gitButtonPrimary gitButtonFull" type="button" ${state.gitBusy ? "disabled" : ""}>初始化同步仓库</button>`}
      </div>
    </div>`;
}

function renderGitFileList(st, files, initialized, synced) {
  if (!st) return `<div class="gitEmptyState"><div class="gitEmptyTitle">正在检查...</div></div>`;
  if (!initialized) return `<div class="gitEmptyState"><div class="gitEmptyTitle">还没有同步仓库</div><div class="gitEmptyDesc">初始化后即可把笔记同步到云端。</div></div>`;
  if (synced) return `<div class="gitEmptyState"><div class="gitEmptyTitle">一片纯净</div><div class="gitEmptyDesc">所有想法已同步到云端。</div></div>`;
  if (!files.length && st.behind > 0) return `<div class="gitEmptyState"><div class="gitEmptyTitle">云端有新内容</div><div class="gitEmptyDesc">本地没有待上传的改动，同步一下就能把云端的更新拉到这台设备。</div></div>`;
  if (!files.length) return `<div class="gitEmptyState"><div class="gitEmptyTitle">还有版本没推上云端</div><div class="gitEmptyDesc">改动已经存成版本，同步一下就会推送到云端。</div></div>`;
  return `<div class="gitFileList"><ul>${files.map((file) => renderGitFileItem(file)).join("")}</ul></div>`;
}

function renderGitFileItem(file) {
  const parent = gitParentPath(file.path);
  const confirming = state.gitDiscardPath === file.path;
  return `
    <li class="gitFileItem ${confirming ? "gitFileItemConfirming" : ""}" data-path="${escapeHtml(file.path)}">
      <div class="gitFileRowContent">
        <span class="gitStateDot ${gitStateDotClass(file.state)}" title="${escapeHtml(gitStateLabel(file.state, file.kind))}"></span>
        <div class="gitFileInfo">
          <button class="gitFileNameBtn" type="button" data-action="diff" data-path="${escapeHtml(file.path)}" ${file.kind === "folder" ? "disabled" : ""}>${escapeHtml(stripExt(file.name))}</button>
          ${file.kind === "folder" || parent ? `
          <span class="gitFileSubLine">
            ${file.kind === "folder" ? `<span class="gitFileKindTag">文件夹</span>` : ""}
            ${parent ? `<span class="gitFilePath">${escapeHtml(parent)}</span>` : ""}
          </span>` : ""}
        </div>
        <span class="gitFileState">${escapeHtml(gitStateLabel(file.state, file.kind))}</span>
        <div class="gitHoverActions">
          ${file.state !== "deleted" && file.kind !== "folder" ? `<button class="gitCircleBtn" type="button" data-action="open" data-path="${escapeHtml(file.path)}" title="打开笔记" aria-label="打开笔记">${GIT_ICON_FILE}</button>` : ""}
          <button class="gitCircleBtn gitCircleBtnDanger" type="button" data-action="confirm-discard" data-path="${escapeHtml(file.path)}" title="${discardActionLabel(file.state, file.kind)}这项更改" aria-label="${discardActionLabel(file.state, file.kind)}这项更改">${GIT_ICON_UNDO}</button>
        </div>
      </div>
      ${confirming ? `
        <div class="gitPopover">
          <div class="gitPopoverHeader">警告</div>
          <div class="gitPopoverText">${escapeHtml(discardWarning(file.state, file.kind))}</div>
          <div class="gitPopoverBtns">
            <button class="gitPopoverCancel" type="button" data-action="cancel-discard">取消</button>
            <button class="gitPopoverConfirm" type="button" data-action="discard" data-path="${escapeHtml(file.path)}" ${state.gitDiscarding ? "disabled" : ""}>${state.gitDiscarding ? "处理中..." : `确定${discardActionLabel(file.state, file.kind)}`}</button>
          </div>
        </div>` : ""}
    </li>`;
}

function renderGitMessageBar() {
  if (state.gitEditingMessage) {
    return `
      <div class="gitMessageBar">
        <div class="gitMessageEdit">
          <input id="git-message-input-new" class="gitNoteInput" type="text" placeholder="这次写了什么？" value="${escapeHtml(state.gitMessage)}" maxlength="80" />
          <button id="btn-git-message-done" class="gitMsgDoneBtn" type="button">确定</button>
        </div>
      </div>`;
  }
  return `
    <div class="gitMessageBar">
      <div class="gitMessageDisplay">
        <span class="gitMessageLabel">${state.gitMessage ? `自定义日志：${escapeHtml(state.gitMessage)}` : "同步日志：AI 自动总结，失败时使用普通说明"}</span>
        <button id="btn-git-message-edit" class="gitMsgEditBtn" type="button">修改</button>
      </div>
    </div>`;
}

function renderGitDiffPane() {
  const file = state.gitSelectedFile;
  if (!file) return "";
  const parent = gitParentPath(file.path);
  const confirming = state.gitDiscardPath === file.path;
  return `
    ${renderGitBackLink("back", "返回同步")}
    <header class="gitDiffHeader">
      <div class="gitDiffHeaderText">
        <strong>${escapeHtml(stripExt(file.name))}</strong>
        ${parent ? `<span>${escapeHtml(parent)}</span>` : ""}
      </div>
    </header>
    <div class="gitDiffSummary">
      <span class="gitDiffStateTitle">${escapeHtml(gitStateLabel(file.state))}</span>
      ${state.gitDiff ? `<span class="gitDiffStats"><span class="gitDiffAdd">+${state.gitDiff.addCount || 0} 行</span><span class="gitDiffRemove">-${state.gitDiff.removeCount || 0} 行</span></span>` : ""}
    </div>
    <div class="gitDiffContent">${renderGitDiffContent()}</div>
    <footer class="gitDiffFooter">
      ${confirming ? `
        <div class="gitDiffDiscardConfirmCard">
          <span class="gitDiffDiscardConfirmText">${escapeHtml(discardWarning(file.state, file.kind))}</span>
          <div class="gitDiscardBtns">
            <button class="gitDiscardCancel" type="button" data-action="cancel-discard" ${state.gitDiscarding ? "disabled" : ""}>取消</button>
            <button class="gitDiscardOk" type="button" data-action="discard" data-path="${escapeHtml(file.path)}" ${state.gitDiscarding ? "disabled" : ""}>${state.gitDiscarding ? "…" : `确定${discardActionLabel(file.state, file.kind)}`}</button>
          </div>
        </div>
      ` : `
        <div class="gitDiffNormalFooter">
          ${file.state !== "deleted" ? `<button class="gitDiffFooterBtn" type="button" data-action="open" data-path="${escapeHtml(file.path)}">打开此笔记</button>` : ""}
          <button class="gitDiffFooterBtn gitDiffFooterDanger" type="button" data-action="confirm-discard" data-path="${escapeHtml(file.path)}">${discardActionLabel(file.state, file.kind)}</button>
        </div>
      `}
    </footer>`;
}

function renderGitDiffContent() {
  if (state.gitDiffLoading) return `<div class="gitDiffState">正在对比差异...</div>`;
  if (state.gitDiffError) return `<div class="gitDiffState gitDiffStateError">${escapeHtml(state.gitDiffError)}</div>`;
  const diff = state.gitDiff;
  if (!diff) return "";
  if (diff.binary) return `<div class="gitDiffState">二进制文件不支持文本差异预览。</div>`;
  if (!diff.lines?.length) return `<div class="gitDiffState">没有文本内容变动。</div>`;
  return `<div class="gitDiffLines">${diff.lines.map((line) => {
    const cls = line.type === "add" ? "gitDiffLineAdd" : line.type === "remove" ? "gitDiffLineRemove" : line.type === "hunk" ? "gitDiffLineHunk" : "";
    if (line.type === "hunk") return `<div class="gitDiffLine ${cls}"><span class="gitDiffHunkLabel">${escapeHtml(line.content)}</span></div>`;
    const marker = line.type === "add" ? "+" : line.type === "remove" ? "-" : "";
    return `<div class="gitDiffLine ${cls}"><span class="gitDiffMarker">${marker}</span><span class="gitDiffText">${escapeHtml(line.content || " ")}</span></div>`;
  }).join("")}</div>`;
}

function renderGitHistoryPane() {
  return `
    ${renderGitBackLink("back", "返回同步")}
    <header class="gitDiffHeader">
      <div class="gitDiffHeaderText"><strong>版本记录</strong><span>云端与本地的提交历史</span></div>
    </header>
    <div class="gitDiffContent gitHistoryContent">
      ${state.gitHistoryLoading ? `<div class="gitDiffState">正在载入版本历史...</div>` : state.gitHistory.length ? `
        <div class="gitTimelineWrapper">
          ${state.gitHistory.map((item, index) => `
            <div class="gitTimelineItem">
              <div class="gitTimelineNodeWrap">
                <div class="gitTimelineNode"></div>
                ${index < state.gitHistory.length - 1 ? `<div class="gitTimelineLine"></div>` : ""}
              </div>
              <div class="gitTimelineCard">
                <div class="gitTimelineCardHeader"><span class="gitCommitHash">${escapeHtml(item.hash)}</span><span class="gitCommitDate">${escapeHtml(item.date)}</span></div>
                <div class="gitCommitMsg" title="${escapeHtml(item.message)}">${escapeHtml(item.message)}</div>
                <div class="gitCommitAuthor">by ${escapeHtml(item.author)}</div>
              </div>
            </div>`).join("")}
        </div>` : `<div class="gitDiffState">暂无版本同步记录。</div>`}
    </div>`;
}

function wireGitPanel() {
  qs("btn-git-refresh-new")?.addEventListener("click", async () => {
    await refreshGitStatus();
    if (state.gitPane === "history") await openGitHistory();
  });
  qs("btn-git-sync-new")?.addEventListener("click", gitCommitPush);
  qs("btn-git-init-new")?.addEventListener("click", gitInit);
  qs("btn-git-history-new")?.addEventListener("click", openGitHistory);
  qs("btn-git-message-edit")?.addEventListener("click", () => {
    state.gitEditingMessage = true;
    renderGitPanel();
    setTimeout(() => qs("git-message-input-new")?.focus(), 0);
  });
  qs("btn-git-message-done")?.addEventListener("click", () => {
    state.gitMessage = qs("git-message-input-new")?.value.trim() || "";
    state.gitEditingMessage = false;
    renderGitPanel();
  });
  qs("git-message-input-new")?.addEventListener("input", (event) => {
    state.gitMessage = event.target.value;
  });
  qs("git-message-input-new")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    qs("btn-git-message-done")?.click();
  });
  document.querySelectorAll("#git-panel [data-action]").forEach((el) => {
    el.addEventListener("click", () => handleGitAction(el));
  });
  // 整行都能点进差异，不用瞄准文件名
  document.querySelectorAll("#git-panel .gitFileRowContent").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      const nameBtn = row.querySelector("[data-action=diff]");
      if (nameBtn && !nameBtn.disabled) openGitDiff(nameBtn.getAttribute("data-path"));
    });
  });
}

/* Esc 一层层往回退：先收起确认和编辑，再从详情回到列表，最后才离开同步页 */
function stepBackInGitWorkspace() {
  if (state.gitDiscardPath && !state.gitDiscarding) {
    state.gitDiscardPath = null;
    renderGitPanel();
  } else if (state.gitEditingMessage) {
    state.gitEditingMessage = false;
    renderGitPanel();
  } else if (state.gitPane !== "main") {
    backToGitMain();
  } else {
    closeGitWorkspace();
  }
}

function backToGitMain() {
  state.gitPane = "main";
  state.gitSelectedFile = null;
  state.gitDiff = null;
  state.gitDiffError = null;
  state.gitDiscardPath = null;
  renderGitPanel();
  requestAnimationFrame(() => qs("btn-close-git-workspace")?.focus({ preventScroll: true }));
}

function handleGitAction(el) {
  const action = el.getAttribute("data-action");
  const path = el.getAttribute("data-path");
  if (action === "close") {
    closeGitWorkspace();
  } else if (action === "back") {
    backToGitMain();
  } else if (action === "diff" && path) {
    openGitDiff(path);
  } else if (action === "open" && path) {
    loadNote(path);
  } else if (action === "confirm-discard" && path) {
    state.gitDiscardPath = path;
    renderGitPanel();
  } else if (action === "cancel-discard") {
    state.gitDiscardPath = null;
    renderGitPanel();
  } else if (action === "discard" && path) {
    gitDiscard(path);
  }
}

function focusGitDetailBack() {
  requestAnimationFrame(() => document.querySelector("#git-panel .gitDetailPane .gitBackLink")?.focus({ preventScroll: true }));
}

async function openGitDiff(path) {
  const file = (state.gitStatus?.files || []).find((item) => item.path === path);
  if (!file) return;
  state.gitSelectedFile = file;
  state.gitPane = "diff";
  state.gitDiff = null;
  state.gitDiffError = null;
  state.gitDiffLoading = true;
  renderGitPanel();
  focusGitDetailBack();
  try {
    state.gitDiff = await invoke("git_diff", { path });
  } catch (err) {
    state.gitDiffError = String(err);
  } finally {
    state.gitDiffLoading = false;
    renderGitPanel();
  }
}

async function openGitHistory() {
  const entering = state.gitPane !== "history";
  state.gitPane = "history";
  state.gitHistoryLoading = true;
  renderGitPanel();
  if (entering) focusGitDetailBack();
  try {
    state.gitHistory = await invoke("git_history");
  } catch (err) {
    showGitFeedback(String(err), true);
    state.gitHistory = [];
  } finally {
    state.gitHistoryLoading = false;
    renderGitPanel();
  }
}

async function gitDiscard(path) {
  state.gitDiscarding = true;
  renderGitPanel();
  // 还原的是当前打开的笔记时，丢弃编辑器内容，避免自动保存把旧内容写回
  const isActive = path === state.activePath || state.activePath?.startsWith(path + "/");
  if (isActive) {
    cancelAutosave();
    setDirty(false);
  }
  try {
    await invoke("git_discard", { path });
    showGitFeedback("已还原。");
    state.gitDiscardPath = null;
    state.gitPane = "main";
    state.gitSelectedFile = null;
    state.gitDiff = null;
    await Promise.all([refreshGitStatus(), loadTree(false)]);
    if (isActive) {
      // 重新加载还原后的内容；文件被删（还原"新笔记"）则回到首页
      const stillExists = flattenFiles(state.tree).some((f) => f.path === state.activePath);
      if (stillExists) await loadNote(state.activePath, { skipHistory: true });
      else clearActiveNote();
    }
  } catch (err) {
    showGitFeedback(String(err), true);
  } finally {
    state.gitDiscarding = false;
    renderGitPanel();
  }
}

function discardWarning(fileState, kind) {
  if (kind === "folder") return "确定删除这个新建文件夹吗？删除后不可撤销。";
  return {
    modified: "确定放弃修改并还原吗？本地改动将无法找回。",
    added: "确定删除这篇本地新笔记吗？删除后不可撤销。",
    deleted: "确定恢复这篇已删除的笔记吗？",
    renamed: "确定还原重命名吗？",
  }[fileState] || "确定还原这个文件吗？";
}

/* ── Fellow panel ────────────────────────────────── */
/* 面板开关按钮不随面板搬家（位置稳定 > 邻近），用按下态与提示语表达状态 */
function syncPanelToggleUI(open) {
  const btn = qs("btn-toggle-panel");
  btn.classList.toggle("fellowPillActive", open);
  btn.title = open ? "收起 Fellow (Ctrl+L)" : "Fellow (Ctrl+L)";
  btn.setAttribute("aria-pressed", open ? "true" : "false");
  btn.setAttribute("aria-expanded", open ? "true" : "false");
}

function openFellowPanel() {
  closeOutline(false);
  closeGitQuickPopover(false);
  const shell = qs("shell");
  if (shell.classList.contains("shellPanelHidden")) {
    shell.classList.remove("shellPanelHidden");
    syncPanelToggleUI(true);
    localStorage.setItem(PANEL_VISIBLE_KEY, "1");
  }
  postAgentMessage({ type: "focus-input" });
}

function toggleSidebar() {
  const shell = qs("shell");
  shell.classList.remove("shellSidebarPeek");
  const isHidden = shell.classList.toggle("shellSidebarHidden");
  if (isHidden) closeGitQuickPopover(false);
  localStorage.setItem(SIDEBAR_VISIBLE_KEY, isHidden ? "0" : "1");
}

function togglePanel() {
  const shell = qs("shell");
  const isHidden = shell.classList.toggle("shellPanelHidden");
  syncPanelToggleUI(!isHidden);
  localStorage.setItem(PANEL_VISIBLE_KEY, isHidden ? "0" : "1");
  if (!isHidden) {
    closeOutline(false);
    closeGitQuickPopover(false);
  }
}

/* ── Outline popover ─────────────────────────────── */
function openOutline() {
  closeGitQuickPopover(false);
  toggleMoreMenu(false);
  state.outlineOpen = true;
  const pop = qs("outline-popover");
  if (pop) pop.hidden = false;
  updateOutlineButton();
  renderToc();
  requestAnimationFrame(() => {
    if (state.outlineOpen) qs("btn-close-outline")?.focus();
  });
}

function closeOutline(restoreFocus = true) {
  if (!state.outlineOpen) return;
  state.outlineOpen = false;
  const pop = qs("outline-popover");
  if (pop) pop.hidden = true;
  updateOutlineButton();
  if (restoreFocus) {
    requestAnimationFrame(() => qs("btn-outline")?.focus());
  }
}

function toggleOutline() {
  if (state.outlineOpen) closeOutline();
  else openOutline();
}

/* ── Quick sync popover + center workspace ───────── */
function positionGitQuickPopover() {
  if (!state.gitQuickOpen) return;
  const popover = qs("git-quick-popover");
  const trigger = qs("btn-git-footer");
  if (!popover || !trigger) return;

  const triggerRect = trigger.getBoundingClientRect();
  const margin = 10;
  const width = Math.min(360, window.innerWidth - margin * 2);
  popover.style.width = `${width}px`;
  popover.style.maxHeight = `${Math.max(180, window.innerHeight - margin * 2)}px`;
  const left = clamp(triggerRect.left + 8, margin, window.innerWidth - width - margin);
  const maxTop = Math.max(margin, window.innerHeight - popover.offsetHeight - margin);
  const top = clamp(triggerRect.top - popover.offsetHeight - 8, margin, maxTop);
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function openGitQuickPopover() {
  closeOutline(false);
  state.gitQuickOpen = true;
  const popover = qs("git-quick-popover");
  const trigger = qs("btn-git-footer");
  if (popover) popover.hidden = false;
  trigger?.setAttribute("aria-expanded", "true");
  renderGitPanel();
  void refreshGitStatus();
  requestAnimationFrame(() => {
    if (state.gitQuickOpen) qs("btn-close-git-quick")?.focus();
  });
}

function closeGitQuickPopover(restoreFocus = true) {
  if (!state.gitQuickOpen) return;
  state.gitQuickOpen = false;
  const popover = qs("git-quick-popover");
  const trigger = qs("btn-git-footer");
  if (popover) popover.hidden = true;
  trigger?.setAttribute("aria-expanded", "false");
  if (restoreFocus) {
    requestAnimationFrame(() => trigger?.focus());
  }
}

async function openGitWorkspace() {
  if (state.gitWorkspaceOpen) {
    closeGitQuickPopover(false);
    qs("btn-close-git-workspace")?.focus();
    return true;
  }
  if (!(await flushPendingSave())) return false;

  closeGitQuickPopover(false);
  closeOutline(false);
  state.gitWorkspaceOpen = true;
  state.gitPane = "main";
  qs("doc-area").hidden = true;
  qs("git-workspace").hidden = false;
  qs("reader").classList.add("readerSyncWorkspaceOpen");
  renderNoteMeta();
  renderGitPanel();
  void refreshGitStatus();
  requestAnimationFrame(() => qs("btn-close-git-workspace")?.focus());
  return true;
}

function closeGitWorkspace(restoreFocus = true) {
  if (!state.gitWorkspaceOpen) return;
  state.gitWorkspaceOpen = false;
  state.gitPane = "main";
  state.gitSelectedFile = null;
  state.gitDiff = null;
  state.gitDiffError = null;
  state.gitDiscardPath = null;
  qs("git-workspace").hidden = true;
  qs("doc-area").hidden = false;
  qs("reader").classList.remove("readerSyncWorkspaceOpen");
  renderNoteMeta();
  updateEditButton();
  if (restoreFocus) {
    requestAnimationFrame(() => {
      const trigger = qs("btn-git-footer");
      if (trigger?.getClientRects().length) trigger.focus();
      else qs("btn-toggle-sidebar")?.focus();
    });
  }
}

/* ── Panel resize ────────────────────────────────── */
function initSidebarResize() {
  const resizer = qs("sidebar-resizer");
  const shell = qs("shell");

  resizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    shell.classList.add("shellResizing");
    const startX = e.clientX;
    const startW = parseInt(getComputedStyle(shell).getPropertyValue("--sidebar-width"), 10) || 280;

    function onMove(ev) {
      const w = clamp(startW + ev.clientX - startX, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
      shell.style.setProperty("--sidebar-width", `${w}px`);
    }

    function onUp() {
      shell.classList.remove("shellResizing");
      resizer.releasePointerCapture(e.pointerId);
      const w = parseInt(shell.style.getPropertyValue("--sidebar-width"), 10);
      if (w) localStorage.setItem(SIDEBAR_WIDTH_KEY, w);
      resizer.removeEventListener("pointermove", onMove);
      resizer.removeEventListener("pointerup", onUp);
    }

    resizer.addEventListener("pointermove", onMove);
    resizer.addEventListener("pointerup", onUp);
  });

  resizer.addEventListener("dblclick", toggleSidebar);
}

/* ── Sidebar hover peek（侧栏隐藏时，鼠标靠左边缘浮出） ── */
function initSidebarPeek() {
  const shell = qs("shell");
  const sidebar = qs("sidebar");

  const zone = document.createElement("div");
  zone.className = "sidebarPeekZone";
  shell.appendChild(zone);

  let hideTimer = null;
  let closeAnimTimer = null;

  function openPeek() {
    if (!shell.classList.contains("shellSidebarHidden")) return;
    clearTimeout(hideTimer);
    clearTimeout(closeAnimTimer);
    shell.classList.remove("shellSidebarPeekClosing");
    shell.classList.add("shellSidebarPeek");
  }

  function closePeek() {
    if (!shell.classList.contains("shellSidebarPeek")) return;
    // 先以悬浮态滑出屏幕（不回流），动画结束后再无过渡地归位，
    // 避免侧栏带着 width 过渡回到文档流时挤动中间区域
    shell.classList.add("shellSidebarPeekClosing");
    closeAnimTimer = setTimeout(() => {
      sidebar.style.transition = "none";
      shell.classList.remove("shellSidebarPeek", "shellSidebarPeekClosing");
      requestAnimationFrame(() => { sidebar.style.transition = ""; });
    }, 360); // 与 --notes-transition-spring 时长一致
  }

  function scheduleClose() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(closePeek, 260);
  }

  zone.addEventListener("mouseenter", openPeek);
  zone.addEventListener("mouseleave", scheduleClose);
  sidebar.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  sidebar.addEventListener("mouseleave", scheduleClose);
}

let savedFellowWidthBeforeMaximize = null;

/* 全宽宽度不能就那么存下来：它是按当时的窗口宽度算出来的，换个屏幕就对不上；更要命
   的是读回来时光有个宽度，没人知道该不该同时把左边收起来——那就成了面板全宽、笔记树
   却还占着位，两边都是 flex:0 0 auto 不会收缩，加起来超出屏幕，面板右边一截被裁掉。
   所以宽度这一格存的始终是「退出全宽后该回到多宽」，全宽与否单独记一个标志。 */
function persistPanelLayout(maximized, restoreWidth) {
  try {
    localStorage.setItem(PANEL_MAXIMIZED_KEY, maximized ? "1" : "0");
    if (restoreWidth) localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(restoreWidth)));
  } catch {}
}

function toggleFellowMaximize(forceState = null) {
  const shell = qs("shell");
  /* 面板收着的时候按这个键，人要的是「打开并铺满」，不会是「打开然后退出全宽」
     ——哪怕它收起前正好停在全宽上。 */
  const wasHidden = shell.classList.contains("shellPanelHidden");
  if (wasHidden) openFellowPanel();
  const currentW = parseInt(shell.style.getPropertyValue("--assistant-panel-width") || getComputedStyle(shell).getPropertyValue("--assistant-panel-width"), 10) || 400;
  const maxW = getMaxPanelWidth();
  const isCurrentlyMaximized = shell.classList.contains("shellPanelMaximized") || currentW >= maxW - 40;
  const shouldMaximize = forceState !== null ? forceState : (wasHidden || !isCurrentlyMaximized);

  if (shouldMaximize) {
    // 本来就在全宽上，当下这个宽度就是全宽，拿它当「退出后回到哪」等于把记录抹了
    if (!isCurrentlyMaximized) savedFellowWidthBeforeMaximize = currentW;
    shell.style.setProperty("--assistant-panel-width", `${maxW}px`);
    shell.classList.add("shellPanelMaximized");
    persistPanelLayout(true, savedFellowWidthBeforeMaximize);
    postAgentMessage({ type: "agent-maximize-state", isMaximized: true });
  } else {
    const restoreW = savedFellowWidthBeforeMaximize || 460;
    shell.style.setProperty("--assistant-panel-width", `${restoreW}px`);
    shell.classList.remove("shellPanelMaximized");
    persistPanelLayout(false, restoreW);
    postAgentMessage({ type: "agent-maximize-state", isMaximized: false });
  }
}

function initPanelResize() {
  const resizer = qs("panel-resizer");
  const shell = qs("shell");

  resizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    shell.classList.add("shellResizing");
    const startX = e.clientX;
    const startW = parseInt(getComputedStyle(shell).getPropertyValue("--assistant-panel-width"), 10) || 400;

    let lastMaximized = shell.classList.contains("shellPanelMaximized");

    function onMove(ev) {
      const maxW = getMaxPanelWidth();
      const w = clamp(startW - (ev.clientX - startX), MIN_PANEL_WIDTH, maxW);
      const maximized = w >= maxW - 30;
      /* 一旦进入沉浸区就吸附到底。左边的笔记树和预览这一刻已经收起来了，面板要是
         还停在「拖到哪算哪」的宽度上，右边就空出一条背景色，看着像没对齐。 */
      shell.style.setProperty("--assistant-panel-width", `${maximized ? maxW : w}px`);
      shell.classList.toggle("shellPanelMaximized", maximized);
      // 状态没变就别发——鼠标每动一下都 postMessage，一秒能有几十条
      if (maximized !== lastMaximized) {
        lastMaximized = maximized;
        // 记住是从多宽拖进来的，不然按钮/快捷键退出全宽时只能回落到默认那个 460
        if (maximized) savedFellowWidthBeforeMaximize = startW >= maxW - 40 ? 460 : startW;
        postAgentMessage({ type: "agent-maximize-state", isMaximized: maximized });
      }
    }

    function onUp() {
      shell.classList.remove("shellResizing");
      resizer.releasePointerCapture(e.pointerId);
      const maximized = shell.classList.contains("shellPanelMaximized");
      const w = parseInt(shell.style.getPropertyValue("--assistant-panel-width"), 10);
      // 全宽时存的不是当下这个宽度，是退出全宽后该回到哪——见 persistPanelLayout
      persistPanelLayout(maximized, maximized ? savedFellowWidthBeforeMaximize : w);
      resizer.removeEventListener("pointermove", onMove);
      resizer.removeEventListener("pointerup", onUp);
    }

    resizer.addEventListener("pointermove", onMove);
    resizer.addEventListener("pointerup", onUp);
  });

  resizer.addEventListener("dblclick", () => {
    if (shell.classList.contains("shellPanelHidden")) openFellowPanel();
    else toggleFellowMaximize();
  });

  /* 全宽是按当时的窗口宽度算出来的一个固定像素值。窗口一放大，右边就空出一条；
     缩小则被裁掉。跟着窗口重算。 */
  window.addEventListener("resize", () => {
    if (!shell.classList.contains("shellPanelMaximized")) return;
    shell.style.setProperty("--assistant-panel-width", `${getMaxPanelWidth()}px`);
  });
}

/* ── Restore panel widths from localStorage ──────── */
function restoreLayout() {
  const shell = qs("shell");

  const sw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  if (sw) shell.style.setProperty("--sidebar-width", `${sw}px`);

  const pw = localStorage.getItem(PANEL_WIDTH_KEY);
  if (pw) shell.style.setProperty("--assistant-panel-width", `${pw}px`);

  /* 上次退出时停在全宽：宽度按这次的窗口重算，并且必须连 shellPanelMaximized 一起
     恢复——只设宽度的话左边还占着位，右边一截会被裁掉（见 persistPanelLayout）。 */
  if (localStorage.getItem(PANEL_MAXIMIZED_KEY) === "1") {
    savedFellowWidthBeforeMaximize = parseInt(pw, 10) || 460;
    shell.style.setProperty("--assistant-panel-width", `${getMaxPanelWidth()}px`);
    shell.classList.add("shellPanelMaximized");
  }

  const sv = localStorage.getItem(SIDEBAR_VISIBLE_KEY);
  if (sv === "0") shell.classList.add("shellSidebarHidden");

  // Default closed (two-column). Bump key meaning: only explicit "1" restores open.
  // Clear legacy "open by default" feel by treating missing/"0" as closed.
  const pv = localStorage.getItem(PANEL_VISIBLE_KEY);
  if (pv === "1") {
    shell.classList.remove("shellPanelHidden");
    syncPanelToggleUI(true);
  } else {
    shell.classList.add("shellPanelHidden");
    qs("btn-toggle-panel").classList.remove("fellowPillActive");
    if (pv !== "0") {
      try { localStorage.setItem(PANEL_VISIBLE_KEY, "0"); } catch {}
    }
  }

  const em = localStorage.getItem(EDIT_MODE_KEY);
  state.editMode = em === "1";
  updateEditButton();
}

/* ── Desktop state ───────────────────────────────── */
function applyDesktopState(desktop) {
  const transientVault = desktop.transientVault === true;
  if (state.vaultPath !== desktop.vaultPath || state.transientVault !== transientVault) {
    state.vaultNotesSignature = null;
    pendingAgentMessages.length = 0;
    state.agentReady = false;
    state.agentGenerating = false;
    state.agentGenerationKnown = false;
  }
  state.vaultPath = desktop.vaultPath;
  state.transientVault = transientVault;
  state.agentUrl = desktop.agentUrl;
  state.agentPort = desktop.agentPort;
  state.agentToken = desktop.agentToken;
  qs("vault-label").textContent = transientVault
    ? `临时 · ${vaultDisplayName(desktop.vaultPath)}`
    : vaultDisplayName(desktop.vaultPath);
  qs("btn-vault-switcher").title = transientVault
    ? `临时打开目录（${desktop.vaultPath}）`
    : `切换笔记本（当前: ${desktop.vaultPath}）`;
  if (!transientVault) rememberVault(desktop.vaultPath);
}

async function loadTree(selectFirst = false) {
  const response = await invoke("list_notes_tree");
  state.tree = response.root;
  // 清理指向已不存在文件的标签（保留 activePath：新建文件可能先于树刷新出现）
  const existingPaths = new Set(flattenFiles(state.tree).map((f) => f.path));
  pruneTabs((p) => existingPaths.has(p) || p === state.activePath);
  renderTree();
  sendVaultNotes();
  if (!state.activeNote) renderDocArea();

  if (selectFirst && !state.activePath) {
    const lastPath = localStorage.getItem(LAST_FILE_KEY);
    const files = flattenFiles(state.tree);
    const target = lastPath && files.find((f) => f.path === lastPath)
      ? lastPath
      : files.find((f) => /^(md|html?)$/i.test(f.extension))?.path;
    if (target) await loadNote(target);
  }
}

/* ── Keyboard shortcuts ──────────────────────────── */
function initKeyboard() {
  document.addEventListener("keydown", (e) => {
    const isMac = navigator.platform.includes("Mac");
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const activeElement = document.activeElement;
    const isTyping = activeElement?.matches?.("input, textarea, select, [contenteditable='true']");

    if (
      !mod &&
      !e.altKey &&
      !e.shiftKey &&
      !isTyping &&
      (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
      isImageExt(state.activeNote?.extension) &&
      qs("dialog-overlay").hidden &&
      !state.gitQuickOpen &&
      !state.outlineOpen &&
      !state.gitWorkspaceOpen &&
      !quickOpenEl
    ) {
      const direction = e.key === "ArrowLeft" ? "previous" : "next";
      const navigation = imageViewerNavigation(state.activePath);
      const target = direction === "previous" ? navigation.previous : navigation.next;
      if (target) {
        e.preventDefault();
        void navigateImageViewer(direction);
        return;
      }
    }

    if (mod && e.key === "s") {
      e.preventDefault();
      saveNote();
    }

    if (mod && e.key === "f") {
      e.preventDefault();
      const input = qs("search-input");
      input.focus();
      input.select();
    }

    if (mod && e.key === "b") {
      e.preventDefault();
      toggleSidebar();
    }

    if (mod && e.key === "n") {
      e.preventDefault();
      void createNote();
    }

    if (mod && e.shiftKey && (e.key === "l" || e.key === "L" || e.key === "f" || e.key === "F")) {
      e.preventDefault();
      toggleFellowMaximize();
      return;
    }

    if (mod && e.key === "l") {
      e.preventDefault();
      if (qs("shell").classList.contains("shellPanelHidden")) openFellowPanel();
      else togglePanel();
    }

    if (e.key === "Escape") {
      hideContextMenu();
      toggleVaultMenu(false);
      toggleMoreMenu(false);
      if (!qs("dialog-overlay").hidden) {
        qs("dialog-cancel").click();
        return;
      }
      if (state.gitQuickOpen) {
        e.preventDefault();
        closeGitQuickPopover();
        return;
      }
      if (state.outlineOpen) {
        e.preventDefault();
        closeOutline();
        return;
      }
      if (state.gitWorkspaceOpen) {
        e.preventDefault();
        stepBackInGitWorkspace();
        return;
      }
      if (state.editMode) {
        void setEditMode(false);
      }
      const input = qs("search-input");
      if (document.activeElement === input || !qs("search-results").hidden) {
        clearSearch();
        input.blur();
      }
    }
  });
}

/* ── Wire events ─────────────────────────────────── */
function wireEvents() {
  qs("btn-vault-switcher").addEventListener("click", () => toggleVaultMenu());
  qs("btn-new-note").addEventListener("click", () => { void createNote(); });
  qs("empty-create-note")?.addEventListener("click", () => { void createNote(); });
  qs("btn-toggle-sidebar").addEventListener("click", toggleSidebar);
  if (navigator.platform.includes("Mac")) {
    qs("btn-toggle-sidebar").title = "切换侧栏 (⌘B)";
    qs("btn-new-note").title = "新建笔记 (⌘N)";
    qs("btn-toggle-panel").title = "Fellow (⌘L)";
  }
  qs("btn-nav-back").addEventListener("click", navBack);
  qs("btn-nav-forward").addEventListener("click", navForward);
  qs("btn-toggle-panel").addEventListener("click", () => {
    if (qs("shell").classList.contains("shellPanelHidden")) openFellowPanel();
    else togglePanel();
  });
  qs("btn-toggle-mode").addEventListener("click", () => void setEditMode(!state.editMode));
  qs("btn-outline").addEventListener("click", toggleOutline);

  qs("doc-area").addEventListener("dblclick", (e) => {
    if (state.editMode) return;
    const ext = state.activeNote?.extension;
    if (!ext || !/^md$/.test(ext)) return;
    if (e.target.closest("a")) return;
    const block = e.target.closest("[data-source-line]");
    const fallback = block ? previewClickEditTarget(e, block) : null;
    void setEditMode(true, { ...fallback, clientX: e.clientX, clientY: e.clientY });
  });

  qs("btn-more-menu").addEventListener("click", () => {
    if (qs("more-menu").hidden) closeOutline(false);
    toggleMoreMenu();
  });
  qs("menu-delete").addEventListener("click", () => {
    toggleMoreMenu(false);
    deleteActiveNote();
  });
  qs("btn-close-outline")?.addEventListener("click", () => closeOutline());

  qs("btn-git-footer").addEventListener("click", () => {
    if (state.gitQuickOpen) closeGitQuickPopover();
    else openGitQuickPopover();
  });
  qs("btn-close-git-quick")?.addEventListener("click", () => closeGitQuickPopover());
  window.addEventListener("resize", positionGitQuickPopover);

  window.addEventListener("message", (event) => {
    const frame = qs("agent-frame");
    if (event.source !== frame.contentWindow || event.origin !== agentOrigin()) return;
    if (!state.agentToken || event.data?.__token !== state.agentToken) return;
    if (event.data?.type === "ai-generating-state") {
      state.agentGenerating = event.data.isGenerating === true;
      state.agentGenerationKnown = true;
      if (state.agentReady && !state.agentGenerating) flushAgentMessages();
      return;
    }
    if (event.data?.type === "agent-not-ready") {
      state.agentReady = false;
      state.agentGenerationKnown = false;
      setAgentLoading(true, "Fellow 连接已断开，正在重连...");
      return;
    }
    if (event.data?.type === "agent-collapse-panel") {
      if (!qs("shell").classList.contains("shellPanelHidden")) togglePanel();
      return;
    }
    if (event.data?.type === "agent-toggle-maximize") {
      toggleFellowMaximize();
      return;
    }
    if (event.data?.type !== "agent-ready") return;
    state.agentReady = true;
    setAgentLoading(false);
    flushAgentMessages({
      includeAgentRequests: state.agentGenerationKnown && !state.agentGenerating,
    });
    sendNoteContext();
    sendVaultNotes(true);
    postAgentMessage({
      type: "agent-maximize-state",
      isMaximized: qs("shell").classList.contains("shellPanelMaximized"),
    });
  });

  qs("search-input").addEventListener("input", (e) => {
    clearTimeout(state.searchTimer);
    const q = e.target.value;
    const requestId = ++state.searchRequestId;
    qs("btn-search-clear").hidden = q.length === 0;
    if (q.trim().length < 2) {
      void runSearch(q, requestId);
      return;
    }
    state.searchTimer = setTimeout(() => {
      state.searchTimer = null;
      void runSearch(q, requestId);
    }, 220);
  });

  qs("btn-search-clear").addEventListener("click", () => {
    clearSearch();
    qs("search-input").focus();
  });

  qs("search-input").addEventListener("blur", () => {
    setTimeout(() => {
      const box = qs("search-results");
      const search = qs("search-input").closest(".search");
      if (!box.matches(":focus-within") && !search.matches(":focus-within")) {
        if (qs("search-input").value === "") clearSearch();
      }
    }, 150);
  });

  document.addEventListener("click", (e) => {
    if (!qs("context-menu").hidden && !qs("context-menu").contains(e.target)) {
      hideContextMenu();
    }
    const vaultMenu = qs("vault-menu");
    if (!vaultMenu.hidden && !vaultMenu.contains(e.target) && !qs("btn-vault-switcher").contains(e.target)) {
      toggleVaultMenu(false);
    }
    const moreMenu = qs("more-menu");
    if (!moreMenu.hidden && !moreMenu.contains(e.target) && !qs("btn-more-menu").contains(e.target)) {
      toggleMoreMenu(false);
    }
    const outline = qs("outline-popover");
    if (
      state.outlineOpen &&
      outline &&
      !outline.contains(e.target) &&
      !qs("btn-outline")?.contains(e.target)
    ) {
      closeOutline(false);
    }
    const gitQuick = qs("git-quick-popover");
    if (
      state.gitQuickOpen &&
      gitQuick &&
      !gitQuick.contains(e.target) &&
      !qs("btn-git-footer")?.contains(e.target)
    ) {
      closeGitQuickPopover(false);
    }
  });

  qs("doc-area").addEventListener("scroll", () => {
    if (state.outlineOpen) updateActiveTocLink();
  }, { passive: true });

  // 链接拦截：外部 http(s) → 系统浏览器；相对 .md → 应用内导航
  qs("doc-area").addEventListener("click", (e) => {
    const link = e.target.closest("a");
    if (!link) return;
    routeDocumentLink(e, link.getAttribute("href") || "");
  });

  // 鼠标侧键后退/前进（XButton1/2，与浏览器、资源管理器一致）
  window.addEventListener("mouseup", (e) => {
    if (e.button === 3) { e.preventDefault(); void navBack(); }
    if (e.button === 4) { e.preventDefault(); void navForward(); }
  });
  // 阻止 webview 自身的历史导航，避免侧键把页面导走
  window.addEventListener("auxclick", (e) => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  });

  // 后退/前进键盘快捷键（Alt+← / Alt+→，与 Windows/Obsidian 一致）
  document.addEventListener("keydown", (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      if (e.key === "ArrowLeft")  { e.preventDefault(); void navBack(); }
      if (e.key === "ArrowRight") { e.preventDefault(); void navForward(); }
    }
  });

  // 窗口隐藏/关闭前尽量把未保存内容落盘
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushPendingSave();
  });
}

/* 窗口成为焦点时检查云端更新；节流与退避由 Rust 侧同步引擎负责 */
function initAutoSync() {
  let pollId;

  const onFocus = () => {
    requestAutoPull();
  };

  const startPoll = () => {
    if (pollId) clearInterval(pollId);
    pollId = setInterval(requestAutoPull, 60_000);
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      requestAutoPull();
      startPoll();
    } else {
      if (pollId) clearInterval(pollId);
      pollId = null;
    }
  });
  window.addEventListener("focus", onFocus);
  startPoll();
}

/* ── Boot ────────────────────────────────────────── */
async function boot() {
  try {
    qs("dialog-overlay").hidden = true;
    loadExpandedState();
    loadTabsFromStorage();
    renderTabs();
    restoreLayout();
    wireEvents();
    initSidebarResize();
    initSidebarPeek();
    initPanelResize();
    initKeyboard();
  } catch (initErr) {
    qs("vault-label").textContent = "初始化失败";
    showToast("初始化失败: " + String(initErr));
    return;
  }

  try {
    await waitForTauri(6000);
    await initSyncEvents();
    const desktop = await invoke("get_desktop_state");
    applyDesktopState(desktop);
    state.desktopReady = true;
    const openedPendingMarkdown = await queuePendingMarkdownOpen();
    if (!openedPendingMarkdown) {
      await Promise.all([loadTree(false), waitForAgent(), refreshGitStatus()]);
    }
    requestAutoPull();
    initAutoSync();
  } catch (err) {
    qs("vault-label").textContent = "启动失败";
    showToast("启动失败: " + String(err));
  }
}

window.addEventListener("DOMContentLoaded", boot);

/* ── Constants ───────────────────────────────────── */
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 440;
const MIN_PANEL_WIDTH = 320;
const MAX_PANEL_WIDTH = 900;
const SIDEBAR_WIDTH_KEY = "inkfellow-sidebar-width-v1";
const PANEL_WIDTH_KEY = "inkfellow-panel-width-v1";
const SIDEBAR_VISIBLE_KEY = "inkfellow-sidebar-visible-v1";
const PANEL_VISIBLE_KEY = "inkfellow-panel-visible-v1";
const LAST_FILE_KEY = "inkfellow-last-file-v1";
const EXPANDED_KEY = "inkfellow-expanded-v1";
const PANEL_TAB_KEY = "inkfellow-panel-tab-v1";
const EDIT_MODE_KEY = "inkfellow-edit-mode-v1";

/* ── State ───────────────────────────────────────── */
const state = {
  vaultPath: "",
  agentUrl: "",
  agentPort: null,
  tree: null,
  activePath: null,
  activeNote: null,
  dirty: false,
  editMode: false,
  expanded: new Set([""]),
  activeTab: "agent",
  searchTimer: null,
  contextTarget: null,
  gitStatus: null,
  gitPane: "main",
  gitFeedback: null,
  gitFeedbackError: false,
  gitMessage: "",
  gitEditingMessage: false,
  gitBusy: false,
  gitSelectedFile: null,
  gitDiff: null,
  gitDiffLoading: false,
  gitDiffError: null,
  gitHistory: [],
  gitHistoryLoading: false,
  gitDiscardPath: null,
  gitDiscarding: false,
};

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
    confirmBtn.textContent = "Delete";
    confirmBtn.style.background = "#cc2d24";
    overlay.hidden = false;
    confirmBtn.focus();

    function finish(value) {
      overlay.hidden = true;
      inputEl.hidden = false;
      confirmBtn.textContent = "OK";
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
  if (state.dirty) await saveNote();
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

/* 编辑/预览共用 doc-area 作为滚动容器，切换时按比例保持阅读位置 */
function getDocScrollRatio() {
  const el = qs("doc-area");
  const max = el.scrollHeight - el.clientHeight;
  return max > 0 ? el.scrollTop / max : 0;
}

function applyDocScrollRatio(ratio) {
  const el = qs("doc-area");
  const max = el.scrollHeight - el.clientHeight;
  el.scrollTop = ratio * max;
}

/* 把光标放到当前可视区域顶部附近，避免输入时视图跳走 */
function placeCaretAtVisibleArea() {
  const cm = state.editor;
  if (!cm) return;
  const rect = qs("doc-area").getBoundingClientRect();
  const pos = cm.coordsChar({ left: rect.left + 80, top: rect.top + 60 }, "window");
  cm.setCursor(pos);
}

async function setEditMode(on) {
  const ratio = getDocScrollRatio();
  await flushPendingSave();
  state.editMode = on;
  updateEditButton();
  localStorage.setItem(EDIT_MODE_KEY, on ? "1" : "0");
  renderDocArea();
  applyDocScrollRatio(ratio);
  // CodeMirror 初次渲染后高度才稳定，下一帧再校准一次
  requestAnimationFrame(() => {
    applyDocScrollRatio(ratio);
    placeCaretAtVisibleArea();
  });
}

/* ── Markdown rendering ──────────────────────────── */
function renderMarkdownContent(md) {
  if (typeof marked === "undefined") return `<pre>${escapeHtml(md)}</pre>`;
  return marked.parse(md, { breaks: false, gfm: true });
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

function renderToc() {
  const list = qs("toc-list");
  const empty = qs("toc-empty");
  const count = qs("toc-count");
  list.replaceChildren();

  if (!state.activeNote || !/^(md|html?)$/i.test(state.activeNote.extension)) {
    empty.hidden = false;
    count.textContent = "";
    return;
  }

  const content = state.editMode && state.editor
    ? state.editor.getValue()
    : state.activeNote.content;
  const entries = extractToc(content);

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

/* ── Document area render ────────────────────────── */
function renderDocArea() {
  const docArea = qs("doc-area");

  if (!state.activeNote) {
    docArea.className = "docArea";
    docArea.innerHTML = renderDashboard();
    wireDashboard();
    qs("btn-toggle-mode").hidden = true;
    return;
  }

  const ext = state.activeNote.extension;
  const isText = /^(md|html?)$/.test(ext);
  const isImage = isImageExt(ext);
  qs("btn-toggle-mode").hidden = !isText;

  state.editor = null;

  if (state.editMode && isText) {
    docArea.className = "docArea docAreaEdit";
    docArea.innerHTML = `<div class="document"><div id="cm-container" class="cmContainer"></div></div>`;
    const cm = CodeMirror(qs("cm-container"), {
      value: state.activeNote.content,
      mode: "markdown",
      lineWrapping: true,
      autofocus: false,
      indentUnit: 2,
      tabSize: 2,
      extraKeys: { Enter: "newlineAndIndentContinueMarkdownList" },
      // 编辑器自身不滚动（外层 docArea 统一滚动），需全量渲染行
      viewportMargin: Infinity,
    });
    state.editor = cm;
    cm.on("change", () => {
      setDirty(true);
      scheduleAutosave();
      if (state.activeTab === "toc") renderToc();
    });
    cm.on("blur", () => { void flushPendingSave(); });
    cm.on("cursorActivity", sendSelectionContext);
    cm.getInputField().focus({ preventScroll: true });
  } else {
    docArea.className = "docArea";
    if (ext === "md") {
      const html = renderMarkdownContent(state.activeNote.content);
      docArea.innerHTML = `<div class="document"><article class="prose" id="prose-content">${html}</article></div>`;
      addHeadingSlugs();
      resolveMarkdownImages(state.activeNote.path);
    } else if (/^html?$/.test(ext)) {
      docArea.innerHTML = `<div class="document"><article class="prose" id="prose-content">${state.activeNote.content}</article></div>`;
    } else if (isImage) {
      docArea.innerHTML = `
        <div class="imageViewer">
          <figure class="imageViewerFrame">
            <img class="imageViewerImage" src="${state.activeNote.dataUrl}" alt="${escapeHtml(state.activeNote.name)}" />
          </figure>
          <div class="imageViewerMeta">
            <strong>${escapeHtml(state.activeNote.name)}</strong>
            <span>${escapeHtml((state.activeNote.mime || ext).toUpperCase())}</span>
            <span>${escapeHtml(formatSize(state.activeNote.size || 0))}</span>
          </div>
        </div>`;
    } else {
      docArea.innerHTML = `<div class="document"><p class="prose">无法预览此类型文件（${ext}）。</p></div>`;
    }
    docArea.addEventListener("mouseup", sendSelectionContext, { once: false });
  }
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
        <form class="dashboardSearchBox" id="dashboard-search-form">
          <svg class="dashboardSearchIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input id="dashboard-search-input" class="dashboardSearchInput" placeholder="有什么想写或想聊的..." autocomplete="off" spellcheck="false" />
          <button type="submit" class="dashboardSearchShortcut" title="Ask Fellow">Fellow</button>
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
            <p>左侧选择文件夹，或点击“记录灵感”创建第一篇笔记。</p>
          </div>
        `}
      </div>
    </section>`;
}

function wireDashboard() {
  qs("dashboard-capture")?.addEventListener("click", createNote);
  qs("dashboard-search-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = qs("dashboard-search-input");
    const text = input?.value.trim();
    if (qs("shell").classList.contains("shellPanelHidden")) togglePanel();
    switchTab("agent");
    setTimeout(() => {
      const frame = qs("agent-frame");
      try {
        frame.contentWindow?.postMessage(
          text ? { type: "note-ask", text } : { type: "note-ask" },
          "*",
        );
      } catch {}
      if (input) input.value = "";
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

async function resolveMarkdownImages(notePath) {
  const container = qs("prose-content");
  if (!container) return;
  const imgs = container.querySelectorAll("img");
  if (!imgs.length) return;

  const noteDir = notePath.includes("/") ? notePath.split("/").slice(0, -1).join("/") : "";

  for (const img of imgs) {
    const raw = (img.getAttribute("src") || "").trim();
    // 跳过外链、data URL、锚点
    if (!raw || /^(https?:|data:|#)/i.test(raw)) continue;

    const assetPath = raw.startsWith("/")
      ? raw.replace(/^\/+/, "")
      : resolveRelativePath(noteDir, raw);

    // 加载中占位
    img.style.opacity = "0.3";
    try {
      const asset = await invoke("read_asset", { path: assetPath });
      img.src = asset.dataUrl;
    } catch {
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

  if (!state.activeNote) {
    titleEl.textContent = "inkfellow Desktop";
    metaEl.querySelectorAll(".noteBreadcrumb,.noteBreadcrumbSep").forEach((el) => el.remove());
    qs("btn-more-menu").disabled = true;
    toggleMoreMenu(false);
    return;
  }

  const parts = state.activePath.split("/");
  titleEl.textContent = stripExt(parts[parts.length - 1]);

  metaEl.querySelectorAll(".noteBreadcrumb,.noteBreadcrumbSep").forEach((el) => el.remove());
  if (parts.length > 1) {
    const sep = document.createElement("span");
    sep.className = "noteBreadcrumbSep";
    sep.textContent = "/";
    const crumb = document.createElement("span");
    crumb.className = "noteBreadcrumb";
    crumb.textContent = parts.slice(0, -1).join("/");
    metaEl.insertBefore(crumb, titleEl);
    metaEl.insertBefore(sep, titleEl);
  }

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
    btn.style.paddingLeft = `${4 + level * 14}px`;

    const chevron = document.createElement("span");
    chevron.className = "chevron" + (isExpanded ? " chevronOpen" : "");
    chevron.innerHTML = CHEVRON_ICON;

    const icon = document.createElement("span");
    icon.className = "treeNodeIcon";
    icon.innerHTML = FOLDER_ICON;

    const label = document.createElement("span");
    label.className = "treeLabel";
    label.textContent = isRoot ? (node.name || "Vault") : node.name;
    label.title = node.path || state.vaultPath;

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
    btn.style.paddingLeft = `${4 + level * 14}px`;
    btn.title = `${node.path}\n${formatDate(node.updatedAt)}`;

    const icon = document.createElement("span");
    icon.className = "treeNodeIcon";
    icon.innerHTML = FILE_ICON;

    const label = document.createElement("span");
    label.className = "treeLabel";
    label.textContent = stripExt(node.name);

    btn.append(icon, label);

    if (ext && ext !== "md") {
      const badge = document.createElement("span");
      badge.className = "fileTypeBadge";
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
function showContextMenu(e, target) {
  const menu = qs("context-menu");
  menu.replaceChildren();
  state.contextTarget = target;

  const items = [];

  if (target.kind === "file") {
    items.push({ label: "Rename…", action: renameEntry });
    items.push({ label: "Delete…", action: deleteEntry, danger: true });
  } else {
    items.push({ label: "New note here…", action: newNoteInFolder });
    items.push({ label: "New folder here…", action: newFolderInFolder });
    if (target.path) {
      items.push({ label: "Rename…", action: renameEntry });
      items.push({ label: "Delete…", action: deleteEntry, danger: true });
    }
  }

  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "treeActionItem" + (item.danger ? " danger" : "");
    btn.textContent = item.label;
    btn.addEventListener("click", () => {
      hideContextMenu();
      item.action(target);
    });
    menu.appendChild(btn);
  }

  const rect = e.currentTarget.getBoundingClientRect();
  let top = rect.bottom + 4;
  let left = rect.left;
  const menuWidth = 160;
  if (left + menuWidth > window.innerWidth - 8) left = window.innerWidth - menuWidth - 8;
  if (top + 200 > window.innerHeight) top = rect.top - 4 - Math.min(items.length * 36, 160);

  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
  menu.hidden = false;
}

function hideContextMenu() {
  qs("context-menu").hidden = true;
  state.contextTarget = null;
}

async function renameEntry(target) {
  const newName = await showDialog(`Rename "${target.name}"`, target.name);
  if (!newName || newName === target.name) return;
  try {
    const newPath = await invoke("rename_entry", { path: target.path, name: newName });
    if (target.path === state.activePath) {
      state.activePath = newPath;
      if (state.activeNote) state.activeNote = { ...state.activeNote, path: newPath, name: newName };
      renderNoteMeta();
    }
    await loadTree(false);
    showToast("Renamed.");
  } catch (err) {
    showToast(String(err));
  }
}

async function deleteEntry(target) {
  const confirmed = await showConfirm(`Delete "${target.name}"? This cannot be undone.`);
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
    if (affectsActive) {
      clearActiveNote();
    }
    await loadTree(false);
    showToast("Deleted.");
  } catch (err) {
    showToast(String(err));
  }
}

async function newNoteInFolder(target) {
  const title = await showDialog("New note title", "Untitled");
  if (!title) return;
  try {
    const note = await invoke("create_note", { folder: target.path, title });
    state.expanded.add(target.path);
    await loadTree(false);
    await loadNote(note.path);
  } catch (err) {
    showToast(String(err));
  }
}

async function newFolderInFolder(target) {
  const name = await showDialog("New folder name", "New folder");
  if (!name) return;
  try {
    await invoke("create_folder", { parent: target.path, name });
    state.expanded.add(target.path);
    await loadTree(false);
    showToast("Folder created.");
  } catch (err) {
    showToast(String(err));
  }
}

/* ── Note operations ─────────────────────────────── */
async function loadNote(path) {
  // 自动保存模式：切换前把未保存内容落盘
  await flushPendingSave();

  const docArea = qs("doc-area");
  docArea.className = "docArea";
  docArea.innerHTML = `<div class="loadingDoc"><div class="loadingSpinner"></div><span>Loading…</span></div>`;

  try {
    const command = isImageExt(extOf(path)) ? "read_asset" : "read_note";
    const note = await invoke(command, { path });
    state.activePath = note.path;
    state.activeNote = note;
    expandAncestors(note.path);
    renderTree();
    renderNoteMeta();
    setDirty(false);
    renderDocArea();
    if (state.activeTab === "toc") renderToc();
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
  state.activePath = null;
  state.activeNote = null;
  setDirty(false);
  renderNoteMeta();
  renderDocArea();
  renderTree();
}

async function saveNote() {
  if (!state.activeNote || !state.dirty || state.saving) return;
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
    await loadTree(false);
    if (state.activeTab === "toc") renderToc();
  } catch (err) {
    showToast(String(err));
    scheduleAutosave();
  } finally {
    state.saving = false;
  }
}

async function createNote() {
  const folder = state.activePath ? parentFolder(state.activePath) : "";
  const title = await showDialog("New note title", "Untitled");
  if (!title) return;
  try {
    const note = await invoke("create_note", { folder, title });
    if (folder) state.expanded.add(folder);
    await loadTree(false);
    await loadNote(note.path);
  } catch (err) {
    showToast(String(err));
  }
}

async function deleteActiveNote() {
  if (!state.activeNote) return;
  const ok = await showConfirm(`确定删除「${state.activeNote.name}」吗？此操作无法撤销。`);
  if (!ok) return;
  // 取消待执行的自动保存，避免删除后又把文件写回来
  cancelAutosave();
  setDirty(false);
  try {
    await invoke("delete_entry", { path: state.activeNote.path });
    clearActiveNote();
    await loadTree(false);
    showToast("Deleted.");
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
    <div class="vaultDropdownSectionTitle">当前笔记本</div>
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
          <button type="button" class="vaultDropdownItem" role="menuitem" data-vault-path="${escapeHtml(path)}">
            <svg class="dropdownItemIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/></svg>
            <span class="recentVaultInfo">
              <span class="recentVaultNameText">${escapeHtml(vaultDisplayName(path))}</span>
              <span class="recentVaultPathText">${escapeHtml(vaultDisplayPath(path))}</span>
            </span>
          </button>`).join("")}
      </div>` : ""}
    <div class="vaultDropdownDivider"></div>
    <button type="button" id="btn-choose-vault" class="vaultDropdownItemAction" role="menuitem">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <span>选择其他笔记本文件夹…</span>
    </button>`;

  menu.querySelectorAll("[data-vault-path]").forEach((el) => {
    el.addEventListener("click", () => switchToVault(el.getAttribute("data-vault-path")));
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
  try {
    const desktop = await invoke("set_vault_path", { path });
    await applyVaultChange(desktop);
  } catch (err) {
    showToast(String(err));
  }
}

async function chooseVault() {
  toggleVaultMenu(false);
  try {
    const desktop = await invoke("select_and_set_vault");
    await applyVaultChange(desktop);
  } catch (err) {
    if (!String(err).includes("cancelled")) showToast(String(err));
  }
}

/* ── Search ──────────────────────────────────────── */
async function runSearch(query) {
  const box = qs("search-results");
  if (query.trim().length < 2) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  try {
    const hits = await invoke("search_notes", { query });
    box.replaceChildren();
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
        qs("search-input").value = "";
        box.hidden = true;
        box.replaceChildren();
      });
      box.appendChild(btn);
    }
    box.hidden = hits.length === 0;
  } catch (err) {
    showToast(String(err));
  }
}

/* ── Agent ───────────────────────────────────────── */
function sendNoteContext() {
  const frame = qs("agent-frame");
  if (!frame.contentWindow || !state.activePath) return;
  try {
    frame.contentWindow.postMessage({ type: "note-context", filePath: state.activePath }, "*");
  } catch {}
}

function sendSelectionContext() {
  const frame = qs("agent-frame");
  if (!frame.contentWindow) return;
  let text = "";
  if (state.editor && state.editor.hasFocus()) {
    text = state.editor.getSelection().trim();
  } else {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) text = sel.toString().trim();
  }
  try {
    if (text) {
      frame.contentWindow.postMessage({ type: "note-selection", text }, "*");
    } else {
      frame.contentWindow.postMessage({ type: "note-selection-clear" }, "*");
    }
  } catch {}
}

async function waitForAgent() {
  for (let i = 0; i < 120; i++) {
    try {
      const ready = await invoke("agent_status");
      if (ready) {
        // Extra 800ms: TCP port open doesn't mean HTTP server is ready
        await new Promise((r) => setTimeout(r, 800));
        const url = `${state.agentUrl}/?desktop=1&wsPort=${state.agentPort}`;
        const frame = qs("agent-frame");
        frame.src = url;
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 350));
  }
}

/* ── Git ─────────────────────────────────────────── */
function gitStateLabel(value) {
  return {
    modified: "已修改",
    added: "新笔记",
    deleted: "已删除",
    renamed: "重命名",
  }[value] || "已修改";
}

function gitStateDotClass(value) {
  return {
    modified: "gitStateDotModified",
    added: "gitStateDotAdded",
    deleted: "gitStateDotDeleted",
    renamed: "gitStateDotModified",
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

async function refreshGitStatus() {
  const dot = qs("sidebar-git-dot");
  const label = qs("sidebar-git-label");
  try {
    const st = await invoke("git_status");
    state.gitStatus = st;

    if (!st.initialized) {
      dot.className = "sidebarGitDot";
      label.textContent = "尚未初始化同步";
      renderGitPanel();
      return;
    }

    const files = st.files || [];
    const synced = files.length === 0 && st.ahead === 0 && st.behind === 0;
    dot.className = "sidebarGitDot" + (synced ? " sidebarGitDotSynced" : "");
    if (synced) {
      label.textContent = "已同步到云端";
    } else if (files.length === 0 && st.behind > 0) {
      label.textContent = `远端有 ${st.behind} 个新版本`;
    } else if (files.length > 0) {
      label.textContent = `${files.length} 篇待同步`;
    } else {
      label.textContent = `${st.ahead} 篇待同步`;
    }
    renderGitPanel();
  } catch (err) {
    label.textContent = "同步状态异常";
    state.gitFeedback = String(err);
    state.gitFeedbackError = true;
    renderGitPanel();
  }
}

/* ── 自动拉取云端更新 ──────────────────────────── */
async function autoPull() {
  if (state.pulling) return;
  
  if (state.gitStatus && !state.gitStatus.initialized) return;

  // 正在编辑时不拉取，保护沉浸状态
  if (state.editMode && state.dirty) return;

  state.pulling = true;
  const dot = qs("sidebar-git-dot");
  dot.classList.add("sidebarGitDotPulsing");

  try {
    const out = await invoke("git_pull");
    if (!out.success) {
      await refreshGitStatus();
      return;
    }
    const updated = out.stdout && !/already up to date/i.test(out.stdout);
    if (updated) {
      showToast("已获取云端更新");
      await loadTree(false);
      if (state.gitPane === "history") await openGitHistory();
    }
    await refreshGitStatus();
  } catch {
    // 网络失败：静默，圆点由 refreshGitStatus 更新为黄色
    await refreshGitStatus();
  } finally {
    state.pulling = false;
    dot.classList.remove("sidebarGitDotPulsing");
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
  const message = state.gitMessage.trim() || "Update notes";
  state.gitBusy = true;
  renderGitPanel();
  try {
    showGitFeedback("Checking cloud updates...");
    const pull = await invoke("git_pull");
    if (!pull.success) throw new Error(pull.stderr || pull.stdout || "Pull failed.");

    showGitFeedback("Syncing notes to cloud...");
    const results = await invoke("git_commit_and_push", { message });
    const failed = results.find((r) => !r.success);
    if (failed) throw new Error(failed.stderr || failed.stdout || "Sync failed.");
    const out = results.map((r) => [r.stdout, r.stderr].filter(Boolean).join("\n")).join("\n").trim();
    state.gitMessage = "";
    state.gitEditingMessage = false;
    showGitFeedback(out || "Synced.");
    await refreshGitStatus();
    if (state.gitPane === "history") await openGitHistory();
  } catch (err) {
    showGitFeedback(String(err), true);
  } finally {
    state.gitBusy = false;
    renderGitPanel();
  }
}

async function gitInit() {
  state.gitBusy = true;
  renderGitPanel();
  try {
    const result = await invoke("git_init");
    showGitFeedback(result.stdout || "Initialized.");
    await refreshGitStatus();
  } catch (err) {
    showGitFeedback(String(err), true);
  } finally {
    state.gitBusy = false;
    renderGitPanel();
  }
}

function renderGitPanel() {
  const panel = qs("git-panel");
  if (!panel || state.activeTab !== "git") return;

  const st = state.gitStatus;
  const files = st?.files || [];
  const initialized = st?.initialized !== false;
  const synced = initialized && st && files.length === 0 && st.ahead === 0 && st.behind === 0;

  panel.innerHTML = `
    <div id="git-app" class="gitPanel">
      <div class="gitStack ${state.gitPane !== "main" ? "gitStackShowingDetail" : ""}">
        <section class="gitStackPane">${renderGitMainPane(st, files, initialized, synced)}</section>
        <section class="gitStackPane gitDetailPane" aria-hidden="${state.gitPane === "main" ? "true" : "false"}">
          ${state.gitPane === "diff" ? renderGitDiffPane() : ""}
          ${state.gitPane === "history" ? renderGitHistoryPane() : ""}
        </section>
      </div>
    </div>`;
  wireGitPanel();
}

function renderGitMainPane(st, files, initialized, synced) {
  const statusLabel = !st
    ? "正在检查云端..."
    : !initialized
      ? "尚未初始化云端同步"
      : synced
        ? "已是最新版本"
        : `${files.length} 篇笔记待同步`;

  return `
    <div class="gitStatusBar">
      <div class="gitStatusLeft">
        <span class="gitStatusDot ${synced ? "gitStatusDotSynced" : ""} ${state.gitBusy ? "gitStatusDotPulsing" : ""}"></span>
        <div class="gitStatusText">
          <div class="gitStatusLabel">${escapeHtml(statusLabel)}</div>
          <div class="gitStatusSubLabel">${st?.behind > 0 ? "云端有新更新" : st?.branch ? escapeHtml(st.branch) : ""}</div>
        </div>
      </div>
      <button id="btn-git-refresh-new" class="gitRefresh" type="button" title="重新检查" ${state.gitBusy ? "disabled" : ""}>↻</button>
    </div>
    <div class="gitFileListContainer">${renderGitFileList(st, files, initialized, synced)}</div>
    ${state.gitFeedback ? `<div class="gitFeedback ${state.gitFeedbackError ? "gitFeedbackError" : ""}">${escapeHtml(state.gitFeedback)}</div>` : ""}
    <div class="gitBottomBar">
      ${initialized && files.length ? renderGitMessageBar() : ""}
      <div class="gitActions">
        ${initialized ? `
          <button id="btn-git-sync-new" class="gitButton gitButtonPrimary gitButtonFull ${synced ? "gitButtonDisabled" : ""}" type="button" ${state.gitBusy || synced ? "disabled" : ""}>
            ${state.gitBusy ? `<span class="gitSpinner"></span><span>智能同步中...</span>` : synced ? "<span>已同步到最新</span>" : "<span>立即同步到云端</span>"}
          </button>
          <div class="gitSecondaryRow">
            <button id="btn-git-history-new" class="gitHistoryBtn" type="button">版本记录</button>
            ${st?.lastSync ? `<span class="gitStatusTime">上次同步：${escapeHtml(formatLastSync(st.lastSync))}</span>` : ""}
          </div>
        ` : `<button id="btn-git-init-new" class="gitButton gitButtonPrimary gitButtonFull" type="button" ${state.gitBusy ? "disabled" : ""}>初始化同步仓库</button>`}
      </div>
    </div>`;
}

function renderGitFileList(st, files, initialized, synced) {
  if (!st) return `<div class="gitEmptyState"><div class="gitEmptyTitle">正在检查...</div></div>`;
  if (!initialized) return `<div class="gitEmptyState"><div class="gitEmptyTitle">还没有同步仓库</div><div class="gitEmptyDesc">初始化后即可把笔记同步到云端。</div></div>`;
  if (synced) return `<div class="gitEmptyState"><div class="gitEmptyTitle">一片纯净</div><div class="gitEmptyDesc">所有想法已同步到云端。</div></div>`;
  return `<div class="gitFileList"><ul>${files.map((file) => renderGitFileItem(file)).join("")}</ul></div>`;
}

function renderGitFileItem(file) {
  const parent = gitParentPath(file.path);
  const confirming = state.gitDiscardPath === file.path;
  return `
    <li class="gitFileItem ${confirming ? "gitFileItemConfirming" : ""}" data-path="${escapeHtml(file.path)}">
      <div class="gitFileRowContent">
        <span class="gitStateDot ${gitStateDotClass(file.state)}" title="${escapeHtml(gitStateLabel(file.state))}"></span>
        <div class="gitFileInfo">
          <button class="gitFileNameBtn" type="button" data-action="diff" data-path="${escapeHtml(file.path)}" ${file.kind === "folder" ? "disabled" : ""}>${escapeHtml(stripExt(file.name))}</button>
          ${parent ? `<span class="gitFilePath">${escapeHtml(parent)}</span>` : ""}
        </div>
        <div class="gitHoverActions">
          ${file.state !== "deleted" && file.kind !== "folder" ? `<button class="gitCircleBtn" type="button" data-action="open" data-path="${escapeHtml(file.path)}" title="打开文件"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg></button>` : ""}
          <button class="gitCircleBtn gitCircleBtnDanger" type="button" data-action="confirm-discard" data-path="${escapeHtml(file.path)}" title="还原">↩</button>
        </div>
      </div>
      ${confirming ? `
        <div class="gitPopover">
          <div class="gitPopoverHeader">警告</div>
          <div class="gitPopoverText">${escapeHtml(discardWarning(file.state, file.kind))}</div>
          <div class="gitPopoverBtns">
            <button class="gitPopoverCancel" type="button" data-action="cancel-discard">取消</button>
            <button class="gitPopoverConfirm" type="button" data-action="discard" data-path="${escapeHtml(file.path)}" ${state.gitDiscarding ? "disabled" : ""}>${state.gitDiscarding ? "处理中..." : "确定还原"}</button>
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
        <span class="gitMessageLabel">${state.gitMessage ? `自定义日志：${escapeHtml(state.gitMessage)}` : "同步日志：由 AI 提取自动总结"}</span>
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
    <header class="gitDiffHeader">
      <button class="gitDiffBack" type="button" data-action="back">←</button>
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
            <button class="gitDiscardOk" type="button" data-action="discard" data-path="${escapeHtml(file.path)}" ${state.gitDiscarding ? "disabled" : ""}>${state.gitDiscarding ? "…" : "确定还原"}</button>
          </div>
        </div>
      ` : `
        <div class="gitDiffNormalFooter">
          ${file.state !== "deleted" ? `<button class="gitDiffFooterBtn" type="button" data-action="open" data-path="${escapeHtml(file.path)}">打开此笔记</button>` : ""}
          <button class="gitDiffFooterBtn gitDiffFooterDanger" type="button" data-action="confirm-discard" data-path="${escapeHtml(file.path)}">还原此文件</button>
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
    <header class="gitDiffHeader">
      <button class="gitDiffBack" type="button" data-action="back">←</button>
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
  document.querySelectorAll("#git-panel [data-action]").forEach((el) => {
    el.addEventListener("click", () => handleGitAction(el));
  });
}

function handleGitAction(el) {
  const action = el.getAttribute("data-action");
  const path = el.getAttribute("data-path");
  if (action === "back") {
    state.gitPane = "main";
    state.gitSelectedFile = null;
    state.gitDiff = null;
    state.gitDiffError = null;
    state.gitDiscardPath = null;
    renderGitPanel();
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

async function openGitDiff(path) {
  const file = (state.gitStatus?.files || []).find((item) => item.path === path);
  if (!file) return;
  state.gitSelectedFile = file;
  state.gitPane = "diff";
  state.gitDiff = null;
  state.gitDiffError = null;
  state.gitDiffLoading = true;
  renderGitPanel();
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
  state.gitPane = "history";
  state.gitHistoryLoading = true;
  renderGitPanel();
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
      if (stillExists) await loadNote(state.activePath);
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

function switchTab(tab) {
  state.activeTab = tab;
  localStorage.setItem(PANEL_TAB_KEY, tab);

  document.querySelectorAll(".assistantPanelTab").forEach((btn) => {
    btn.classList.toggle("assistantPanelTabActive", btn.dataset.tab === tab);
  });

  const frame = qs("agent-frame");
  const toc = qs("toc-panel");
  const git = qs("git-panel");

  frame.classList.toggle("assistantPanelFrameHidden", tab !== "agent");
  toc.hidden = tab !== "toc";
  git.hidden = tab !== "git";
  git.style.display = tab === "git" ? "flex" : "";
  git.style.flexDirection = tab === "git" ? "column" : "";

  if (tab === "toc") renderToc();
  if (tab === "git") {
    renderGitPanel();
    refreshGitStatus();
  }
}

/* ── Sidebar + Panel visibility toggle ──────────── */
function toggleSidebar() {
  const shell = qs("shell");
  const isHidden = shell.classList.toggle("shellSidebarHidden");
  localStorage.setItem(SIDEBAR_VISIBLE_KEY, isHidden ? "0" : "1");
}

function togglePanel() {
  const shell = qs("shell");
  const isHidden = shell.classList.toggle("shellPanelHidden");
  const btn = qs("btn-toggle-panel");
  btn.classList.toggle("fellowPillActive", !isHidden);
  localStorage.setItem(PANEL_VISIBLE_KEY, isHidden ? "0" : "1");
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
}

function initPanelResize() {
  const resizer = qs("panel-resizer");
  const shell = qs("shell");

  resizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    shell.classList.add("shellResizing");
    const startX = e.clientX;
    const startW = parseInt(getComputedStyle(shell).getPropertyValue("--assistant-panel-width"), 10) || 480;

    function onMove(ev) {
      const w = clamp(startW - (ev.clientX - startX), MIN_PANEL_WIDTH, MAX_PANEL_WIDTH);
      shell.style.setProperty("--assistant-panel-width", `${w}px`);
    }

    function onUp() {
      shell.classList.remove("shellResizing");
      resizer.releasePointerCapture(e.pointerId);
      const w = parseInt(shell.style.getPropertyValue("--assistant-panel-width"), 10);
      if (w) localStorage.setItem(PANEL_WIDTH_KEY, w);
      resizer.removeEventListener("pointermove", onMove);
      resizer.removeEventListener("pointerup", onUp);
    }

    resizer.addEventListener("pointermove", onMove);
    resizer.addEventListener("pointerup", onUp);
  });
}

/* ── Restore panel widths from localStorage ──────── */
function restoreLayout() {
  const shell = qs("shell");

  const sw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  if (sw) shell.style.setProperty("--sidebar-width", `${sw}px`);

  const pw = localStorage.getItem(PANEL_WIDTH_KEY);
  if (pw) shell.style.setProperty("--assistant-panel-width", `${pw}px`);

  const sv = localStorage.getItem(SIDEBAR_VISIBLE_KEY);
  if (sv === "0") shell.classList.add("shellSidebarHidden");

  const pv = localStorage.getItem(PANEL_VISIBLE_KEY);
  if (pv === "0") {
    shell.classList.add("shellPanelHidden");
    qs("btn-toggle-panel").classList.remove("fellowPillActive");
  } else {
    qs("btn-toggle-panel").classList.add("fellowPillActive");
  }

  const tab = localStorage.getItem(PANEL_TAB_KEY) || "agent";
  switchTab(tab);

  const em = localStorage.getItem(EDIT_MODE_KEY);
  state.editMode = em === "1";
  updateEditButton();
}

/* ── Desktop state ───────────────────────────────── */
function applyDesktopState(desktop) {
  state.vaultPath = desktop.vaultPath;
  state.agentUrl = desktop.agentUrl;
  state.agentPort = desktop.agentPort;
  qs("vault-label").textContent = vaultDisplayName(desktop.vaultPath);
  qs("btn-vault-switcher").title = `当前笔记本路径: ${desktop.vaultPath}`;
  rememberVault(desktop.vaultPath);
}

async function loadTree(selectFirst = false) {
  const response = await invoke("list_notes_tree");
  state.tree = response.root;
  renderTree();
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

    if (mod && e.key === "s") {
      e.preventDefault();
      saveNote();
    }

    if (e.key === "Escape") {
      hideContextMenu();
      toggleVaultMenu(false);
      toggleMoreMenu(false);
      if (!qs("dialog-overlay").hidden) {
        qs("dialog-cancel").click();
      }
    }
  });
}

/* ── Wire events ─────────────────────────────────── */
function wireEvents() {
  qs("btn-vault-switcher").addEventListener("click", () => toggleVaultMenu());
  qs("btn-toggle-sidebar").addEventListener("click", toggleSidebar);
  qs("btn-toggle-panel").addEventListener("click", togglePanel);
  qs("btn-close-panel").addEventListener("click", togglePanel);
  qs("btn-toggle-mode").addEventListener("click", () => void setEditMode(!state.editMode));

  qs("btn-more-menu").addEventListener("click", () => toggleMoreMenu());
  qs("menu-outline").addEventListener("click", () => {
    toggleMoreMenu(false);
    if (qs("shell").classList.contains("shellPanelHidden")) togglePanel();
    switchTab("toc");
  });
  qs("menu-delete").addEventListener("click", () => {
    toggleMoreMenu(false);
    deleteActiveNote();
  });

  qs("btn-git-footer").addEventListener("click", () => {
    if (qs("shell").classList.contains("shellPanelHidden")) togglePanel();
    switchTab("git");
  });

  document.querySelectorAll(".assistantPanelTab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  qs("agent-frame").addEventListener("load", sendNoteContext);

  qs("search-input").addEventListener("input", (e) => {
    clearTimeout(state.searchTimer);
    const q = e.target.value;
    state.searchTimer = setTimeout(() => runSearch(q), 220);
  });

  qs("search-input").addEventListener("blur", () => {
    setTimeout(() => {
      const box = qs("search-results");
      if (!box.matches(":focus-within")) {
        box.hidden = true;
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
  });

  qs("doc-area").addEventListener("scroll", () => {
    if (state.activeTab === "toc") updateActiveTocLink();
  }, { passive: true });

  // 窗口隐藏/关闭前尽量把未保存内容落盘
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushPendingSave();
  });
}

/* 窗口成为焦点时检查云端更新 */
function initAutoSync() {
  let pollId;

  const onFocus = () => {
    void autoPull();
  };

  const startPoll = () => {
    if (pollId) clearInterval(pollId);
    pollId = setInterval(() => { void autoPull(); }, 60_000);
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void autoPull();
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
    restoreLayout();
    wireEvents();
    initSidebarResize();
    initPanelResize();
    initKeyboard();
  } catch (initErr) {
    qs("vault-label").textContent = "Init error: " + String(initErr);
    return;
  }

  try {
    await waitForTauri(6000);
    const desktop = await invoke("get_desktop_state");
    applyDesktopState(desktop);
    await Promise.all([loadTree(false), waitForAgent(), refreshGitStatus()]);
    void autoPull();
    initAutoSync();
  } catch (err) {
    qs("vault-label").textContent = "Error: " + String(err);
    showToast("启动失败: " + String(err));
  }
}

window.addEventListener("DOMContentLoaded", boot);

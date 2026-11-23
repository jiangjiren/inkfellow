/* 视频工作台界面。视频是主角，点到哪改到哪，只有一个主按钮。
   工程文件只读，人工改动只写 edits.json。接口约定见 _design/video-workbench-contract.md */
(function (root) {
  const Model = root.InkfellowVideoModel;
  const EXTENSION = "videoproject";
  const TAB_FILE = "edl.json";
  const REFRESH_THROTTLE_MS = 1200;
  const STATUS_DEBOUNCE_MS = 400;
  const SCROLL_FOLLOW_PAUSE_MS = 3000;
  const PREVIEW_DRIFT_SEC = 0.25;
  const SEEK_STALL_MS = 600;
  const RESUME_PREFIX = "vw-resume:";
  const UNDO_SHOW_MS = 6000;

  const svg = (body) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICONS = {
    play: `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.5 2.8v10.4a.6.6 0 0 0 .92.5l8.1-5.2a.6.6 0 0 0 0-1l-8.1-5.2a.6.6 0 0 0-.92.5z"/></svg>`,
    pause: `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3.5" y="2.5" width="3.2" height="11" rx="0.8"/><rect x="9.3" y="2.5" width="3.2" height="11" rx="0.8"/></svg>`,
    prev: svg('<path d="M4 3.5v9"/><path d="M12 3.8L6.5 8l5.5 4.2V3.8z" fill="currentColor" stroke="none"/>'),
    next: svg('<path d="M12 3.5v9"/><path d="M4 3.8L9.5 8 4 12.2V3.8z" fill="currentColor" stroke="none"/>'),
    sound: svg('<path d="M3 6v4h2.5L9 13V3L5.5 6H3z"/><path d="M11.5 5.8a3 3 0 0 1 0 4.4"/>'),
    mute: svg('<path d="M3 6v4h2.5L9 13V3L5.5 6H3z"/><path d="M11.5 6.2l3 3.6M14.5 6.2l-3 3.6"/>'),
    fullscreen: svg('<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>'),
    video: svg('<rect x="2" y="3.5" width="12" height="9" rx="1.6"/><path d="M6.8 6.2l3.2 1.8-3.2 1.8V6.2z"/>'),
    photo: svg('<rect x="2" y="3" width="12" height="10" rx="1.6"/><circle cx="5.7" cy="6.5" r="1"/><path d="M2.6 11.6l3.2-3.2 2.6 2.6 2-2 3 3"/>'),
    scene: svg('<path d="M8 2.2l1.7 3.7 4 .5-3 2.7.9 4L8 11.1l-3.6 2 .9-4-3-2.7 4-.5z"/>'),
    warn: svg('<path d="M8 2.2l6.3 11.3H1.7z"/><path d="M8 6.4v3.2M8 11.6v.1"/>'),
    back: svg('<path d="M12.5 8H3.5M7.5 4L3.5 8l4 4"/>'),
    edit: svg('<path d="M11.2 2.8l2 2-7.5 7.5-2.7.7.7-2.7 7.5-7.5z"/>'),
    trash: svg('<path d="M3 4.5h10M6 4.5V3h4v1.5M5 4.5l.6 8.5h4.8l.6-8.5"/>'),
    undo: svg('<path d="M4.5 6.5H10a3 3 0 1 1 0 6H7.5"/><path d="M6.5 4L4 6.5 6.5 9"/>'),
    redo: svg('<path d="M11.5 6.5H6a3 3 0 1 0 0 6h2.5"/><path d="M9.5 4L12 6.5 9.5 9"/>'),
    help: svg('<circle cx="8" cy="8" r="6"/><path d="M6.3 6.3a1.8 1.8 0 0 1 3.4.7c0 1.2-1.7 1.4-1.7 2.4"/><circle cx="8" cy="11.6" r="0.4" fill="currentColor"/>'),
    search: svg('<circle cx="7.2" cy="7.2" r="4.5"/><path d="M10.7 10.7L13.5 13.5"/>'),
    close: svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
    swap: svg('<path d="M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13"/>'),
    sparkles: `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5l1.4 3.9 3.9 1.4-3.9 1.4L8 12.1 6.6 8.2 2.7 6.8l3.9-1.4L8 1.5zm4.3 8.4l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z"/></svg>`,
    bolt: `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.2 1.8L3.4 9h4.1l-.7 5.2L12.6 7H8.5l.7-5.2z"/></svg>`,
    check: svg('<path d="M3.5 8.5l3 3 6-6.5"/>'),
    doc: svg('<path d="M4.5 2.5h5l3 3v8h-8v-11z"/><path d="M9.5 2.5v3h3"/>'),
    card: svg('<rect x="2" y="3.5" width="12" height="9" rx="1.8"/><path d="M5 7h6M5 9.5h3.5"/>'),
    playSmall: `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5 3.6v8.8a.5.5 0 0 0 .77.42l6.8-4.4a.5.5 0 0 0 0-.84l-6.8-4.4A.5.5 0 0 0 5 3.6z"/></svg>`,
  };

  let deps = null;
  let view = null;
  let eventsBound = false;
  const projectIndex = new Map();
  /* 很多工程的文件夹就叫「视频」，光看文件夹名分不清是哪条片，优先用方案里写的片名 */
  const projectTitles = new Map();
  /* 帧条和素材缩略图按路径缓存，关掉面板再打开不用重新等 */
  const stripCache = new Map();
  const sourceThumbs = new Map();

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));

  /* ── 路径 ───────────────────────────────────────── */
  function isProjectTab(path) {
    return typeof path === "string" && (path === TAB_FILE || path.endsWith(`/${TAB_FILE}`));
  }

  function projectOfTab(path) {
    return path === TAB_FILE ? "" : path.slice(0, -(TAB_FILE.length + 1));
  }

  function tabForProject(projectPath) {
    return projectPath ? `${projectPath}/${TAB_FILE}` : TAB_FILE;
  }

  function isProject(folderPath) {
    return projectIndex.has(folderPath);
  }

  function listProjects() {
    return [...projectIndex.values()];
  }

  function tabLabel(path) {
    const project = projectOfTab(path);
    const title = projectTitles.get(project) || projectIndex.get(project)?.title;
    if (title) return title;
    const parts = project.split("/");
    const folder = parts[parts.length - 1] || "视频工程";
    return folder === "视频" && parts.length > 1 ? `${parts[parts.length - 2]} · 视频` : folder;
  }

  function makeNote(path) {
    return { path, name: tabLabel(path), extension: EXTENSION, content: "", size: 0, updatedAt: 0 };
  }

  function assetUrl(abs, mtime) {
    if (!abs) return "";
    const url = deps.convertFileSrc ? deps.convertFileSrc(abs) : abs;
    return mtime ? `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(mtime)}` : url;
  }

  async function loadProjects() {
    if (!deps) return;
    try {
      const { projects } = await deps.invoke("video_list_projects");
      projectIndex.clear();
      for (const project of projects || []) projectIndex.set(project.path, project);
      deps.onProjectsChanged?.();
    } catch (err) {
      console.warn("video_list_projects failed", err);
    }
  }

  /* ── 生命周期 ───────────────────────────────────── */
  function init(options) {
    deps = options;
    // 页面被重新加载时也留住现场；sessionStorage 跟着这次运行走，重启应用就从头开始
    root.addEventListener?.("pagehide", () => { if (view) saveResume(view); });
    void loadProjects();
    bindGlobalEvents();
  }

  async function bindGlobalEvents() {
    if (eventsBound || !deps.listen) return;
    eventsBound = true;
    await deps.listen("video-job", ({ payload }) => handleJobEvent(payload));
    await deps.listen("video-project-changed", ({ payload }) => handleProjectChanged(payload));
  }

  function handleProjectChanged(payload) {
    if (payload?.kinds?.includes("edl") || payload?.kinds?.includes("out")) void loadProjects();
    if (!view || payload?.project !== view.projectPath) return;
    if (payload?.kinds?.includes("docs")) view.publishLoadedFor = null;
    if (view.refreshTimer) {
      view.refreshQueued = true;
      return;
    }
    void refresh();
    view.refreshTimer = setTimeout(() => {
      if (!view) return;
      view.refreshTimer = null;
      if (view.refreshQueued) {
        view.refreshQueued = false;
        handleProjectChanged({ project: view.projectPath, kinds: [] });
      }
    }, REFRESH_THROTTLE_MS);
  }

  function mount(container, tabPath) {
    const projectPath = projectOfTab(tabPath);
    if (view && view.projectPath === projectPath && view.el.isConnected) return;
    leave();
    container.innerHTML = shellHtml();
    view = {
      el: container.querySelector(".vw"),
      tabPath,
      projectPath,
      data: null,
      doc: Model.normalizeDoc(null),
      history: { past: [], future: [] },
      rows: [],
      liveRows: [],
      hook: null,
      plan: null,
      planSource: "none",
      versionName: null,
      cleanMedia: null,
      cleanRequest: null,
      cleanError: false,
      cleanUnavailable: false,
      musicAudio: null,
      voiceRequest: null,
      usingCleanVideo: false,
      compareOriginal: false,
      followLatest: true,
      pendingLatest: null,
      tab: "script",
      thumbs: new Map(),
      thumbsRequested: new Map(),
      editing: null,
      editingCard: null,
      playingSample: null,
      stopAt: null,
      skim: null,
      dragging: false,
      pendingSeek: null,
      sampleBusy: new Set(),
      sampleRequests: new Map(),
      renderBusy: false,
      renderQa: false,
      renderJobId: null,
      renderError: null,
      picker: null,
      sourceItems: null,
      sourceLoading: false,
      pendingSend: false,
      env: null,
      durationMismatch: false,
      panelDirty: false,
      lastUserScroll: 0,
      activeBeat: null,
      activeShotKey: null,
      playbackRate: 1,
      scriptQuery: "",
      onlyModified: false,
      shortcutsOpen: false,
      rafId: 0,
      refreshTimer: null,
      refreshQueued: false,
      refreshSequence: 0,
      appliedRefresh: 0,
      statusTimer: null,
      publishHtml: null,
      publishLoadedFor: null,
      overlayBroken: new Set(),
      observers: [],
      onDocKey: null,
    };
    wireView();
    void firstLoad();
  }

  function leave() {
    if (!view) return;
    const current = view;
    saveResume(current);
    stopMusicPreview();
    void current.musicAudio?.context.close().catch(() => {});
    cancelSourceRequest(current.picker);
    view = null;
    cancelAnimationFrame(current.rafId);
    clearTimeout(current.refreshTimer);
    clearTimeout(current.statusTimer);
    clearTimeout(current.undoTimer);
    document.removeEventListener("keydown", current.onDocKey);
    for (const observer of current.observers) observer.disconnect();
    for (const video of current.el.querySelectorAll("video, audio")) {
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {}
    }
  }

  /* 离开再回来：接着刚才的地方看 */
  function saveResume(current) {
    if (!current.data) return; // 还没加载完就离开，别盖掉上次的现场
    const video = current.el.querySelector(".vwVideo");
    const body = current.el.querySelector(".vwPanelBody");
    try {
      sessionStorage.setItem(RESUME_PREFIX + current.projectPath, JSON.stringify({
        version: current.versionName,
        followLatest: current.followLatest,
        time: current.playingSample ? current.playingSample.start : (video?.currentTime || 0),
        tab: current.tab,
        playbackRate: current.playbackRate || 1,
        scrollTop: current.picker ? 0 : (body?.scrollTop || 0),
        picker: current.picker ? { beat: current.picker.beat, shotIdx: current.picker.shotIdx } : null,
      }));
    } catch {}
  }

  function readResume(projectPath) {
    try {
      return JSON.parse(sessionStorage.getItem(RESUME_PREFIX + projectPath));
    } catch {
      return null;
    }
  }

  function applyResume(saved) {
    const resume = Model.resolveResume(saved, view.versionName);
    if (!resume) return;
    // 上次看的旧版已经不在了，回到跟随最新版
    if (view.versionName !== saved.version) view.followLatest = true;
    if (saved && Model.PLAYBACK_RATES.includes(Number(saved.playbackRate))) {
      view.playbackRate = Number(saved.playbackRate);
      applyPlaybackRate();
    }
    if (resume.tab !== view.tab) {
      view.tab = resume.tab;
      renderTabs();
      renderPanel(true);
    }
    if (resume.picker) void openPicker(resume.picker.beat, resume.picker.shotIdx);
    if (resume.time) seek(resume.time);
    if (resume.scrollTop) {
      view.el.querySelector(".vwPanelBody").scrollTop = resume.scrollTop;
      view.lastUserScroll = Date.now();
    }
  }

  async function firstLoad() {
    const current = view;
    const saved = readResume(current.projectPath);
    if (saved?.followLatest === false && typeof saved.version === "string") {
      view.versionName = saved.version;
      view.followLatest = false;
    }
    try {
      const env = await deps.invoke("video_env").catch((err) => ({ ok: false, message: String(err) }));
      if (view !== current) return;
      view.env = env;
      await refresh();
      if (view === current && view.data) applyResume(saved);
    } catch (err) {
      if (view === current) renderFatal(err);
    }
  }

  async function refresh() {
    const current = view;
    if (!current) return;
    const sequence = ++current.refreshSequence;
    const startingDoc = current.doc;
    try {
      const data = await deps.invoke("video_read_project", { path: current.projectPath });
      if (view !== current || sequence < current.appliedRefresh) return;
      current.appliedRefresh = sequence;
      await applyData(data, startingDoc);
    } catch (err) {
      if (view !== current) return;
      if (!view.data) renderFatal(err);
      else console.warn("video_read_project failed", err);
    }
  }

  async function applyData(data, startingDoc) {
    const current = view;
    const previousMedia = versionMediaKey(currentVersion());
    const previousLatest = view.data?.latest ?? null;
    view.data = data;
    const title = data.edl?.project;
    if (title && projectTitles.get(view.projectPath) !== title) {
      projectTitles.set(view.projectPath, title);
      deps.onProjectsChanged?.();
    }
    const readDoc = Model.normalizeDoc(data.edits);
    if (view.doc === startingDoc || readDoc.revision >= view.doc.revision) view.doc = readDoc;
    if (data.running) view.renderError = null;

    const stillExists = data.versions.some((item) => item.name === view.versionName);
    let target = view.versionName;
    if (!stillExists) target = data.latest;
    else if (view.followLatest && data.latest !== view.versionName) {
      const video = videoEl();
      if (video && !video.paused && previousLatest) view.pendingLatest = data.latest;
      else target = data.latest;
    }
    if (data.latest === target) view.pendingLatest = null;
    const switched = target !== view.versionName;
    if (switched) {
      view.versionName = target;
      if (previousLatest && target === data.latest) deps.showToast(`新版本已生成：${versionLabel(target)}`);
    }
    const mediaChanged = previousMedia !== versionMediaKey(currentVersion());
    if (mediaChanged) resetPreviewMedia();

    await loadPlanFor(target);
    if (view !== current || view.data !== data || view.versionName !== target) return;
    rebuildRows();
    if (mediaChanged || !videoEl()?.getAttribute("src")) loadCurrentVersion();
    else syncVideoSource();
    renderAll();
    ensureShotThumbs();
    ensureCleanPreview();
    if (data.latest) void pruneOldSentNotes();
  }

  async function loadPlanFor(versionName) {
    const data = view.data;
    if (!versionName || versionName === data.latest) {
      view.plan = data.plan;
      view.planSource = data.planSource;
      return;
    }
    const current = view;
    try {
      const res = await deps.invoke("video_read_plan", { path: view.projectPath, version: versionName });
      if (view !== current || view.data !== data || view.versionName !== versionName) return;
      view.plan = res.plan;
      view.planSource = res.planSource;
    } catch {
      if (view !== current || view.data !== data || view.versionName !== versionName) return;
      view.plan = null;
      view.planSource = "latest";
    }
  }

  function rebuildRows() {
    const reverted = Model.revertedEdits({ plan: view.plan, edl: view.data.edl, doc: view.doc });
    view.reverted = reverted;
    view.rows = Model.buildRows({ edl: view.data.edl, plan: view.plan, edits: view.doc, reverted });
    view.hook = Model.buildHook({ edl: view.data.edl, plan: view.plan, edits: view.doc });
    const conflicts = conflictIds();
    if (conflicts.size) {
      const accepted = { ...view.doc, edits: view.doc.edits.filter((edit) => !conflicts.has(edit.id)) };
      view.liveRows = Model.buildRows({ edl: view.data.edl, plan: view.plan, edits: accepted, reverted });
      view.liveHook = Model.buildHook({ edl: view.data.edl, plan: view.plan, edits: accepted });
    } else {
      view.liveRows = view.rows;
      view.liveHook = view.hook;
    }
    ensureSourceIndex(reverted);
  }

  /* 撤掉已出片的改动后，最新成片和下次生成的结果对不上，也算待生成 */
  function revertedPending() {
    if (!view.data) return [];
    return Model.revertedEdits({ plan: view.data.plan, edl: view.data.edl, doc: view.doc });
  }

  function pendingTotal() {
    return pendingEdits().length + revertedPending().length;
  }

  /* 镜头原素材的绝对路径（盖预览、换镜头面板标原镜头用） */
  function originalOf(shot) {
    return Model.resolveOriginalShot(shot, { items: view.sourceItems, projectDir: view.data?.abs || "" });
  }

  /* edl 里用编号引用素材时，没有素材清单就找不到原镜头文件，盖不了预览：需要时读一次清单 */
  function ensureSourceIndex(reverted) {
    if (view.sourceItems || view.sourceLoading) return;
    const needs = reverted.some((edit) => edit.op === "replace_shot" && typeof edit.base?.src === "string"
      && !/[\\/]/.test(edit.base.src));
    if (!needs) return;
    const current = view;
    current.sourceLoading = true;
    deps.invoke("video_list_sources", { path: current.projectPath }).then((res) => {
      if (view !== current) return;
      const items = new Map();
      for (const asset of res.assets || []) items.set(asset.path, asset);
      current.sourceItems = items;
    }).catch(() => {
      if (view === current) current.sourceItems = new Map();
    }).finally(() => { current.sourceLoading = false; });
  }

  function currentVersion() {
    return view.data?.versions.find((item) => item.name === view.versionName) || null;
  }

  function versionMediaKey(version) {
    return version ? JSON.stringify([version.name, version.mediaRevision ?? version.mtime, version.size]) : "";
  }

  function versionLabel(name) {
    const match = /_v(\d+)\.[^.]+$/.exec(name || "");
    if (match) return `v${match[1]}`;
    if (/_preview\.[^.]+$/.test(name || "")) return "预览版";
    return Model.baseName(name) || "未出片";
  }

  function videoEl() {
    return view?.el.querySelector(".vwVideo");
  }

  function canvasOf() {
    const canvas = view?.data?.edl?.canvas || "9:16";
    const [w, h] = String(canvas).split(":").map(Number);
    return w && h ? { w, h } : { w: 9, h: 16 };
  }

  /* ── 骨架 ───────────────────────────────────────── */
  function shellHtml() {
    return `
      <div class="vw" tabindex="-1" data-playing="false">
        <header class="vwHead"></header>
        <div class="vwStatus" hidden></div>
        <div class="vwBody">
          <section class="vwStage" aria-label="播放器">
            <div class="vwPlayerBox">
              <div class="vwFrame">
                <video class="vwVideo" preload="metadata" playsinline></video>
                <video class="vwPreviewVideo" preload="auto" muted playsinline hidden></video>
                <img class="vwPreviewImage" alt="" hidden />
                <div class="vwLiveLayer" hidden></div>
                <div class="vwPreviewCaption" hidden></div>
                <span class="vwPreviewTag" hidden>预览新镜头</span>
                <button type="button" class="vwLiveToggle" data-action="toggle-compare" hidden></button>
                <span class="vwSampleFrameBadge" hidden></span>
                <div class="vwHotspots" hidden></div>
                <button type="button" class="vwBigPlay" data-action="toggle-play" aria-label="播放" tabindex="-1">${ICONS.play}</button>
                <div class="vwPlayerEmpty" hidden></div>
              </div>
            </div>
            <div class="vwControls">
              <div class="vwControlGroup">
                <button type="button" class="vwIconBtn" data-action="step-beat" data-delta="-1" aria-label="上一句" title="上一句 (←)">${ICONS.prev}</button>
                <button type="button" class="vwIconBtn vwPlayBtn" data-action="toggle-play" aria-label="播放" title="播放 / 暂停 (空格)">${ICONS.play}</button>
                <button type="button" class="vwIconBtn" data-action="step-beat" data-delta="1" aria-label="下一句" title="下一句 (→)">${ICONS.next}</button>
              </div>
              <span class="vwClock">00:00 / 00:00</span>
              <span class="vwSampleTag" hidden></span>
              <span class="vwControlsSpacer"></span>
              <div class="vwControlGroup">
                <button type="button" class="vwRateBtn" data-action="cycle-rate" aria-label="播放倍速" title="切换审片倍速 (1x / 1.25x / 1.5x / 2x)">1x</button>
                <button type="button" class="vwIconBtn vwMuteBtn" data-action="toggle-mute" aria-label="静音" title="静音 / 取消静音">${ICONS.sound}</button>
                <button type="button" class="vwIconBtn" data-action="fullscreen" aria-label="全屏" title="全屏预览">${ICONS.fullscreen}</button>
              </div>
            </div>
            <div class="vwVoiceSample" hidden>
              <strong>新配音试听</strong>
              <audio controls preload="metadata"></audio>
              <button type="button" class="vwLink" data-action="close-voice">关闭</button>
              <output></output>
            </div>
          </section>
          <section class="vwPanel" aria-label="脚本与修改">
            <div class="vwTabs" role="tablist"></div>
            <div class="vwPanelBody" tabindex="-1"></div>
            <div class="vwUndo" role="status" hidden><span class="vwUndoText"></span><button type="button" class="vwUndoBtn" data-action="undo-last">撤销</button></div>
          </section>
        </div>
        <div class="vwStrip" aria-label="时间轴"></div>
      </div>`;
  }

  function renderFatal(err) {
    const box = view?.el;
    if (!box) return;
    box.innerHTML = `
      <div class="vwFatal">
        <p class="vwFatalTitle">打不开这个视频</p>
        <p class="vwFatalBody">${esc(String(err))}</p>
      </div>`;
  }

  function renderAll() {
    if (!view?.data) return;
    const { w, h } = canvasOf();
    view.el.dataset.orient = w >= h ? "landscape" : "portrait";
    fitFrame();
    renderHead();
    renderStatus();
    renderTabs();
    renderPanel();
    syncPicker();
    renderStrip();
    updatePlayback();
  }

  /* 画面按比例撑满可用空间，预览层才能和视频严丝合缝 */
  function fitFrame() {
    const box = view?.el.querySelector(".vwPlayerBox");
    const frame = view?.el.querySelector(".vwFrame");
    if (!box || !frame) return;
    const { w, h } = canvasOf();
    const width = Math.min(box.clientWidth, box.clientHeight * (w / h));
    frame.style.width = `${Math.floor(width)}px`;
    frame.style.height = `${Math.floor(width * (h / w))}px`;
  }

  /* ── 顶栏 ───────────────────────────────────────── */
  function conflictIds() {
    const status = view.data?.editsStatus;
    const list = status && status.revision === view.doc.revision ? status.conflicts : [];
    return new Set(Array.isArray(list) ? list.map((item) => item.id) : []);
  }

  function pendingEdits() {
    const conflicts = conflictIds();
    return view.doc.edits.filter((edit) => !Model.isEditInFinal(view.data, edit) && !conflicts.has(edit.id));
  }

  /* 改动已经在屏幕上这个版本里了吗：决定要不要盖预览、怎么描述 */
  function isEditRendered(edit) {
    return Model.isEditInPlan(view.plan, edit);
  }

  function unsentNotes() {
    return view.doc.notes.filter((note) => !note.sentAt);
  }

  function isRendering() {
    return Boolean(view.renderBusy || (view.data?.running && view.data.running.cmd === "render"));
  }

  function aiIsHandlingNotes() {
    return deps.isAgentGenerating?.() === true && view.doc.notes.some((note) => note.sentAt);
  }

  function shortcutsPopoverHtml() {
    return `
      <div class="vwShortcutPopover" role="dialog" aria-label="快捷键速查" ${view.shortcutsOpen ? "" : "hidden"}>
        <div class="vwShortcutTitle">审片快捷键</div>
        <dl class="vwShortcutList">
          <div><dt><kbd>Space</kbd></dt><dd>播放 / 暂停</dd></div>
          <div><dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>上一句 / 下一句</dd></div>
          <div><dt><kbd>Shift</kbd>+<kbd>←</kbd>/<kbd>→</kbd></dt><dd>快退 / 快进 1 秒</dd></div>
          <div><dt><kbd>,</kbd> <kbd>.</kbd></dt><dd>逐帧后退 / 前进</dd></div>
          <div><dt><kbd>Ctrl</kbd>+<kbd>Z</kbd></dt><dd>撤销（<kbd>Shift</kbd> 重做）</dd></div>
          <div><dt><kbd>Esc</kbd></dt><dd>关闭换镜头 / 取消编辑</dd></div>
        </dl>
        <p class="vwShortcutTip">暂停时可直接点画面改字幕、提字卡意见或换镜头；双击脚本句子也能直接改字。</p>
      </div>`;
  }

  function setShortcutsOpen(open) {
    view.shortcutsOpen = open;
    const button = view.el.querySelector('[data-action="toggle-shortcuts"]');
    button.classList.toggle("vwIconBtnActive", open);
    button.setAttribute("aria-expanded", String(open));
    view.el.querySelector(".vwShortcutPopover").hidden = !open;
  }

  function renderHead() {
    const data = view.data;
    const plan = view.plan;
    const title = data.edl?.project || data.name;
    const versions = data.versions.filter((item) => item.kind !== "other" || item.name === view.versionName);
    const options = versions.map((item) => {
      const label = item.name === data.latest ? `${versionLabel(item.name)}（最新）` : versionLabel(item.name);
      return `<option value="${esc(item.name)}" ${item.name === view.versionName ? "selected" : ""}>${esc(label)}</option>`;
    }).join("");
    const edits = pendingTotal();
    const notes = unsentNotes().length;
    const meta = Model.applyButtonMeta({ editCount: edits, noteCount: notes });
    const blocked = meta.route === "render" && !view.env?.ok;
    let button = "";
    if (view.pendingSend) {
      button = `<button type="button" class="vwBtn" data-action="apply">等 AI 忙完再发（点击取消）</button>`;
    } else if (aiIsHandlingNotes() && notes === 0) {
      // AI 处理期间又写了新意见时，按钮要还能点（会排到这轮之后），不能把新意见卡住
      button = `<button type="button" class="vwBtn" disabled>AI 正在处理…</button>`;
    } else if (meta.total > 0) {
      const btnIcon = meta.route === "ai" ? ICONS.sparkles : ICONS.bolt;
      button = `<button type="button" class="vwBtn vwBtnPrimary ${meta.route === "ai" ? "vwBtnAi" : ""}" data-action="apply" ${isRendering() || blocked ? "disabled" : ""}
        title="${esc(blocked ? (view.env?.message || "找不到剪辑引擎") : meta.hint)}"><span class="vwBtnIcon">${btnIcon}</span><span>${esc(meta.label)}</span></button>`;
    }
    const lastUndo = view.history.past[view.history.past.length - 1];
    const lastRedo = view.history.future[view.history.future.length - 1];
    const hasHistory = Boolean(lastUndo || lastRedo);
    const metaParts = [
      plan?.duration ? Model.humanDuration(plan.duration) : "",
      view.rows.length ? `${view.rows.length} 句` : "",
    ].filter(Boolean);
    view.el.querySelector(".vwHead").innerHTML = `
      <div class="vwHeadMain">
        <h2 class="vwTitle" title="${esc(data.path)}">${esc(title)}</h2>
        ${versions.length > 1
          ? `<select class="vwVersion" data-change="version" aria-label="选择版本" title="切换历史版本">${options}</select>`
          : (versions.length === 1 ? `<span class="vwVersionBadge">${esc(versionLabel(versions[0].name))}</span>` : "")}
        ${metaParts.length ? `<span class="vwMeta">${esc(metaParts.join(" · "))}</span>` : ""}
      </div>
      <div class="vwHeadActions">
        ${hasHistory ? `
          <div class="vwHistoryBtns" role="group" aria-label="撤销与重做">
            <button type="button" class="vwIconBtn" data-action="undo-history" ${lastUndo ? "" : "disabled"}
              aria-label="撤销" title="${esc(lastUndo ? `撤销：${lastUndo.label} (Ctrl+Z)` : "没有可撤销的操作")}">${ICONS.undo}</button>
            <button type="button" class="vwIconBtn" data-action="redo-history" ${lastRedo ? "" : "disabled"}
              aria-label="重做" title="${esc(lastRedo ? `重做：${lastRedo.label} (Ctrl+Shift+Z)` : "没有可重做的操作")}">${ICONS.redo}</button>
          </div>` : ""}
        <div class="vwShortcutWrap">
          <button type="button" class="vwIconBtn ${view.shortcutsOpen ? "vwIconBtnActive" : ""}" data-action="toggle-shortcuts"
            aria-label="审片快捷键" aria-expanded="${view.shortcutsOpen}" title="审片快捷键与技巧">${ICONS.help}</button>
          ${shortcutsPopoverHtml()}
        </div>
        ${button}
      </div>`;
  }

  /* ── 状态行：只说最要紧的一件事，没事就不占地方 ──── */
  function renderStatus() {
    const data = view.data;
    const box = view.el.querySelector(".vwStatus");
    const steps = Model.deriveSteps({
      facts: data.facts,
      journal: data.journal,
      running: data.running,
      versions: data.versions,
      covers: data.covers,
    });
    const failure = view.renderError || (!data.running ? Model.lastCommandFailure(data.journal) : null);
    const stopped = !failure && (data.journal || []).length > 0
      ? Model.stoppedStep({
        steps,
        running: data.running,
        agentGenerating: deps.isAgentGenerating?.() === true,
        journal: data.journal,
        nowSeconds: Date.now() / 1000,
      })
      : null;
    const status = Model.pickStatus({
      running: data.running,
      renderBusy: view.renderBusy,
      renderQa: view.renderQa,
      canCancel: Boolean(view.renderJobId),
      failure,
      conflictCount: conflictIds().size,
      stopped,
      pendingLatestLabel: view.pendingLatest ? versionLabel(view.pendingLatest) : null,
      envProblem: view.env && !view.env.ok ? (view.env.message || "找不到剪辑引擎") : null,
    });
    const stepper = Model.visibleSteps(steps);
    if (!status && stepper.length === 0) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.hidden = false;
    const action = status?.action
      ? `<button type="button" class="vwLink" data-action="${esc(status.action)}" ${status.actionTab ? `data-tab="${esc(status.actionTab)}"` : ""} ${status.step ? `data-step="${esc(status.step)}"` : ""}>${esc(status.actionLabel)}</button>`
      : "";
    box.innerHTML = `
      ${stepper.length ? `<ol class="vwStepList" aria-label="制作进度">${stepper.map((step) => `
        <li class="vwStep vwStep-${step.state}" ${step.state === "active" ? 'aria-current="step"' : ""}><span class="vwStepDot" aria-hidden="true"></span>${esc(step.label)}</li>`).join("")}</ol>` : ""}
      ${status ? `<p class="vwStatusLine vwStatus-${esc(status.kind)}" role="${status.kind === "error" ? "alert" : "status"}"><span>${esc(status.text)}</span>${action}</p>` : ""}
      ${status?.progress != null ? `<div class="vwProgress" role="progressbar" aria-valuenow="${Math.round(status.progress * 100)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${(status.progress * 100).toFixed(1)}%"></span></div>` : ""}`;
  }

  /* ── 标签 ───────────────────────────────────────── */
  function renderTabs() {
    const box = view.el.querySelector(".vwTabs");
    if (view.picker) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const conflicts = conflictIds().size;
    const count = pendingTotal() + unsentNotes().length + conflicts;
    const tabs = [["script", "脚本", 0, false], ["changes", "待处理", count, conflicts > 0], ["publish", "发布", 0, false]];
    box.innerHTML = tabs.map(([key, label, n, alert]) => `
      <button type="button" role="tab" class="vwTab ${view.tab === key ? "vwTabActive" : ""}" aria-selected="${view.tab === key}"
        data-action="tab" data-tab="${key}">${esc(label)}${n ? `<span class="vwTabCount ${alert ? "vwTabCountAlert" : ""}">${n}</span>` : ""}</button>`).join("");
  }

  /* ── 面板 ───────────────────────────────────────── */
  function renderPanel(force = false) {
    if (view.picker) return;
    const body = view.el.querySelector(".vwPanelBody");
    // 正在输入时后台刷新不能冲掉草稿
    const typing = body.contains(document.activeElement) && document.activeElement.matches("input, textarea, select");
    if (!force && (view.editing || view.editingCard || typing)) {
      view.panelDirty = true;
      return;
    }
    view.panelDirty = false;
    const top = body.scrollTop;
    view.rerendering = true;
    if (view.tab === "script") body.innerHTML = scriptHtml();
    else if (view.tab === "changes") body.innerHTML = changesHtml();
    else {
      body.innerHTML = publishHtml();
      void loadPublishDoc();
    }
    view.rerendering = false;
    body.scrollTop = top;
    if (view.tab === "script") markActiveRow(view.activeBeat, true);
    focusEditor();
    if (document.activeElement === document.body) view.el.focus({ preventScroll: true });
  }

  function focusEditor() {
    const field = view.el.querySelector(".vwSayEditor");
    if (field && document.activeElement !== field) {
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
      autoGrow(field);
    }
  }

  function autoGrow(field) {
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight + 2}px`;
  }

  function thumbFor(shot) {
    const replaced = shot.replace?.value?.src;
    if (replaced && sourceThumbs.has(replaced)) return sourceThumbs.get(replaced);
    if (shot.planIndex < 0) return null;
    return view.thumbs.get(`${versionMediaKey(currentVersion())}#${shot.planIndex}`) || null;
  }

  function shotKindIcon(kind) {
    if (kind === "scene") return ICONS.scene;
    if (kind === "photo") return ICONS.photo;
    return ICONS.video;
  }

  function shotThumbHtml(shot) {
    const thumb = thumbFor(shot);
    return thumb
      ? `<img src="${esc(assetUrl(thumb))}" alt="" loading="lazy" data-plan-shot="${shot.planIndex}" />`
      : `<span class="vwShotPlaceholder" data-plan-shot="${shot.planIndex}">${shotKindIcon(shot.kind)}</span>`;
  }

  function scriptProgressText() {
    const total = view.rows.length;
    if (!total) return "";
    const active = view.rows.find((item) => item.id === view.activeBeat);
    return active ? `第 ${active.index + 1} / ${total} 句` : `共 ${total} 句`;
  }

  function updateScriptProgress() {
    const el = view?.el.querySelector(".vwScriptProgress");
    if (el) el.textContent = scriptProgressText();
  }

  function scriptRowsHtml() {
    const filtered = Model.filterRows(view.rows, { query: view.scriptQuery, onlyModified: view.onlyModified });
    if (filtered.length === 0) {
      return `<div class="vwEmptyLarge">
        <p>没有找到符合条件的句子。</p>
        <button type="button" class="vwBtn vwBtnSmall" data-action="clear-script-filter">清除筛选</button>
      </div>`;
    }
    return filtered.map(rowHtml).join("");
  }

  function cardEditorHtml(ec) {
    const posVal = typeof ec.draftPos === "number" ? "custom" : (ec.draftPos || "upper");
    const posOptions = Model.TEXT_POS_OPTIONS.map(([val, label]) =>
      `<option value="${esc(val)}" ${posVal === val ? "selected" : ""}>${esc(label)}</option>`
    ).join("");
    const customOption = typeof ec.draftPos === "number"
      ? `<option value="custom" selected>自定义 (${Math.round(ec.draftPos * 100)}%)</option>`
      : "";
    const showBadge = !ec.isHook && (ec.draftBadge || ec.style === "chapter");
    const showSub = ec.isHook || ec.draftSub || ec.style === "chapter" || ec.style === "title";
    return `
      <div class="vwCardEditor" data-card-editor>
        <div class="vwCardEditorHead">
          <strong>${ec.isHook ? "编辑开头钩子大字" : "编辑画面字卡"}</strong>
          <span class="vwCardEditorHint">修改后左侧画面实时预览</span>
        </div>
        <div class="vwCardEditorFields">
          <label class="vwCardField">
            <span>${ec.isHook ? "主标题" : "字卡文字"}</span>
            <input type="text" class="vwInput" data-card-field="text" value="${esc(ec.draftText)}" placeholder="输入画面显示的文字" />
          </label>
          ${showSub ? `
          <label class="vwCardField">
            <span>副标题（可选）</span>
            <input type="text" class="vwInput" data-card-field="sub" value="${esc(ec.draftSub || "")}" placeholder="留空不显示" />
          </label>` : ""}
          ${showBadge ? `
          <label class="vwCardField">
            <span>角标（可选）</span>
            <input type="text" class="vwInput" data-card-field="badge" value="${esc(ec.draftBadge || "")}" placeholder="如：白天玩法" />
          </label>` : ""}
          <label class="vwCardField vwCardFieldPos">
            <span>位置</span>
            <select class="vwInput vwPosSelect" data-card-field="pos">${customOption}${posOptions}</select>
          </label>
        </div>
        <div class="vwCardEditorFoot">
          <div class="vwCardEditorLeft">
            <button type="button" class="vwBarBtn vwBarBtnDanger" data-action="delete-editing-card">${ICONS.trash}<span>${ec.isHook ? "删除钩子" : "删除字卡"}</span></button>
            ${ec.editId ? `<button type="button" class="vwLink" data-action="undo-edit" data-id="${esc(ec.editId)}">恢复原样</button>` : ""}
            ${!ec.isHook ? `<button type="button" class="vwLink" data-action="ask-card-ai">让 AI 调样式</button>` : ""}
          </div>
          <div class="vwCardEditorRight">
            <button type="button" class="vwBtn vwBtnSmall" data-action="cancel-card-edit">取消</button>
            <button type="button" class="vwBtn vwBtnSmall vwBtnPrimary" data-action="save-card-edit">保存</button>
          </div>
        </div>
      </div>`;
  }

  function hookCardHtml() {
    const hook = view.hook;
    if (!hook || !hook.exists) return "";
    const editingHook = view.editingCard?.isHook ? view.editingCard : null;
    if (editingHook) {
      return `<div class="vwHookCard vwHookCardEditing">${cardEditorHtml(editingHook)}</div>`;
    }
    if (hook.deleted && hook.edit) {
      return `
        <div class="vwHookCard vwHookCardDeleted">
          <span class="vwHookBadge">开头钩子</span>
          <span class="vwHookText vwHookTextDel">${esc(hook.originalText)}</span>
          <button type="button" class="vwLink" data-action="undo-edit" data-id="${esc(hook.edit.id)}">恢复钩子</button>
        </div>`;
    }
    return `
      <div class="vwHookCard ${hook.edit ? "vwHookCardChanged" : ""}" data-action="edit-hook" title="点击直接修改开头钩子大字（实时预览）">
        <span class="vwHookBadge">开头钩子</span>
        <div class="vwHookContent">
          <span class="vwHookText">${esc(hook.text)}</span>
          ${hook.sub ? `<span class="vwHookSub">${esc(hook.sub)}</span>` : ""}
        </div>
        <button type="button" class="vwSayEditBtn vwHookEditBtn" data-action="edit-hook">${ICONS.edit}<span>改钩子</span></button>
      </div>`;
  }

  function scriptHtml() {
    if (view.rows.length === 0) return `<p class="vwEmptyLarge">这条视频还没有内容。</p>`;
    const modifiedCount = view.rows.filter(Model.rowHasChanges).length;
    const showFilterBtn = modifiedCount > 0 || view.onlyModified;
    return `
      <div class="vwScriptWrap">
        <div class="vwScriptTools">
          <div class="vwSearchBox">
            <span class="vwSearchIcon">${ICONS.search}</span>
            <input type="text" class="vwSearchInput" data-input="script-query" value="${esc(view.scriptQuery)}"
              placeholder="搜索脚本、字卡或意见…" aria-label="搜索脚本" />
            <button type="button" class="vwSearchClear" data-action="clear-script-query" aria-label="清空搜索" ${view.scriptQuery ? "" : "hidden"}>${ICONS.close}</button>
          </div>
          ${showFilterBtn ? `
            <button type="button" class="vwFilterPill ${view.onlyModified ? "vwFilterPillOn" : ""}" data-action="toggle-only-modified" aria-pressed="${view.onlyModified}">
              仅看改动${modifiedCount ? ` (${modifiedCount})` : ""}
            </button>` : ""}
          <span class="vwScriptProgress">${esc(scriptProgressText())}</span>
        </div>
        ${!view.scriptQuery && !view.onlyModified ? hookCardHtml() : ""}
        <div class="vwScript">${scriptRowsHtml()}</div>
      </div>`;
  }

  function rowHtml(row) {
    const editing = view.editing?.beat === row.id ? view.editing : null;
    const sampleBusy = view.sampleBusy.has(row.id);
    const deleteEdit = view.doc.edits.find((edit) => edit.op === "delete_beat" && edit.beat === row.id);
    const hasUnsentNote = row.notes.some((n) => !n.sentAt) || row.shots.some((s) => s.notes.some((n) => !n.sentAt));
    const hasShotEdit = row.shots.some((s) => Boolean(s.replace || s.revert));
    const hasCardEdit = (row.cards || []).some((c) => Boolean(c.setText || c.deleteText));
    const classes = ["vwRow"];
    if (row.deleted) classes.push("vwRowDeleted");
    if (row.id === view.activeBeat) classes.push("vwRowActive");
    if (row.setSay || row.setTts || hasShotEdit || hasCardEdit) classes.push("vwRowChanged");
    if (hasUnsentNote) classes.push("vwRowHasNote");
    const missing = view.data.missingSources || [];

    // 删掉的句子只留文字和「恢复」：成片里已经没有它的画面，换镜头也没有意义
    const shots = row.deleted ? "" : row.shots.map((shot) => {
      const duration = Model.shotDuration(shot);
      const lost = Model.isMissingSource(shot.path, missing) && !shot.replace;
      const isCurrent = view.activeShotKey === `${row.id}#${shot.idx}`;
      return `<button type="button" class="vwShot ${shot.replace ? "vwShotChanged" : ""} ${lost ? "vwShotLost" : ""} ${isCurrent ? "vwShotCurrent" : ""}"
          data-action="open-picker" data-beat="${esc(row.id)}" data-shot="${shot.idx}" data-shot-key="${esc(`${row.id}#${shot.idx}`)}"
          aria-label="换这个镜头：${esc(shot.name)}" title="${esc(lost ? `素材读不到：${shot.path}` : `${shot.name} · 点击换镜头`)}">
          ${shotThumbHtml(shot)}
          ${shot.replace ? '<span class="vwShotTag">已换</span>' : (shot.kind === "scene" ? '<span class="vwShotTag vwShotTagScene">动画</span>' : "")}
          ${duration !== null ? `<span class="vwShotDur">${duration.toFixed(1)}s</span>` : ""}
          ${lost ? `<span class="vwShotBadge">${ICONS.warn}</span>` : ""}
          <span class="vwShotHover" aria-hidden="true">${ICONS.swap}<span>换镜头</span></span>
        </button>`;
    }).join("");

    const say = editing
      ? sayEditorHtml(row, editing)
      : `<div class="vwSayHead">
          <p class="vwSay" data-action="row-text" data-beat="${esc(row.id)}" title="${row.deleted ? "" : "点击选中，再点或双击直接改字"}">${esc(row.say) || '<span class="vwMuted">（这一段没有口播）</span>'}</p>
          ${row.deleted ? "" : `<button type="button" class="vwSayEditBtn" data-action="edit-beat" data-beat="${esc(row.id)}" title="修改这句口播和字幕" aria-label="改字">${ICONS.edit}<span>改字</span></button>`}
        </div>`;

    const notes = [
      ...row.notes.map((note) => noteHtml(note, "")),
      ...row.shots.flatMap((shot) => shot.notes.map((note) => noteHtml(note, `第 ${shot.idx + 1} 个镜头`))),
    ].join("");

    const editingRowCard = view.editingCard && !view.editingCard.isHook && view.editingCard.beat === row.id ? view.editingCard : null;
    const cards = Array.isArray(row.cards) ? row.cards : [];
    const textsHtml = cards.length && !row.deleted
      ? `<div class="vwTexts" aria-label="画面字卡">${cards.map((card) => {
          if (card.deleted && card.deleteText) {
            return `<span class="vwTextTag vwTextTagDeleted">
              <span class="vwTextTagIcon">${ICONS.card}</span>
              <span class="vwTextTagDelText">${esc(card.originalText)}</span>
              <button type="button" class="vwLink" data-action="undo-edit" data-id="${esc(card.deleteText.id)}">恢复</button>
            </span>`;
          }
          const isEditingThis = editingRowCard && editingRowCard.idx === card.idx;
          return `<button type="button" class="vwTextTag ${card.setText ? "vwTextTagEdited" : ""} ${isEditingThis ? "vwTextTagActive" : ""}"
            data-action="edit-text-card" data-beat="${esc(row.id)}" data-idx="${card.idx}"
            title="点击直接修改或删除这张字卡（实时预览）">
            <span class="vwTextTagIcon">${ICONS.card}</span>
            <span class="vwTextTagLabel">${card.setText ? "字卡·已改" : "字卡"}</span>
            <span>${esc(card.text)}</span>
          </button>`;
        }).join("")}</div>${editingRowCard ? cardEditorHtml(editingRowCard) : ""}`
      : "";

    const voiceEdit = view.doc.edits.find((edit) => edit.op === "set_voice");
    const voicePending = Boolean(voiceEdit && !isEditRendered(voiceEdit));
    const showSample = sampleBusy || Model.rowNeedsSample(row, { isRendered: isEditRendered, voicePending });
    const voiceCfg = view.data.edl?.voice;
    const hasVoiceChange = voicePending || [row.setSay, row.setTts].some((edit) => edit && !isEditRendered(edit));
    const canSampleVoice = voiceCfg && voiceCfg.enabled !== false && voiceCfg.provider !== "files" && hasVoiceChange && row.say;
    const loadingVoice = view.voiceRequest?.beat === row.id;

    const noteComposeHtml = `
            <div class="vwNoteCompose">
              <input type="text" class="vwNoteInput" data-note-beat="${esc(row.id)}" placeholder="写下这句的修改意见，回车或点「添加修改」" aria-label="写下这句的修改意见" />
              <button type="button" class="vwNoteSend" data-action="submit-note" disabled>添加修改</button>
            </div>`;
    const deleteBtnHtml = `<button type="button" class="vwBarBtn vwBarBtnDanger" data-action="delete-beat" data-beat="${esc(row.id)}">${ICONS.trash}<span>删除这句</span></button>`;

    const rowPanelHtml = row.deleted ? "" : (showSample ? `
          <div class="vwRowPanel">
            <div class="vwRowQuickOps">
              <button type="button" class="vwBarBtn vwBarBtnAccent" data-action="sample" data-beat="${esc(row.id)}" ${sampleBusy || !view.env?.ok ? "disabled" : ""}
                title="只渲染这一句的新配音与画面，几秒验效果，不用等全片生成">${ICONS.playSmall}<span>${sampleBusy ? "生成试看中…" : "试看改后效果"}</span></button>
              ${canSampleVoice ? `<button type="button" class="vwBarBtn" data-action="voice-sample" data-beat="${esc(row.id)}" ${view.voiceRequest || !view.env?.ok ? "disabled" : ""}>${loadingVoice ? "生成配音中…" : "试听新配音"}</button>` : ""}
              <span class="vwControlsSpacer"></span>
              ${deleteBtnHtml}
            </div>
            ${noteComposeHtml}
          </div>` : `
          <div class="vwRowPanel">
            <div class="vwRowCompactBar">
              ${noteComposeHtml}
              ${deleteBtnHtml}
            </div>
          </div>`);

    return `
      <article class="${classes.join(" ")}" data-beat="${esc(row.id)}" data-action="row-select">
        <div class="vwRowGutter">
          <span class="vwRowNum">#${String(row.index + 1).padStart(2, "0")}</span>
          <span class="vwRowTime">${esc(row.start === null ? "" : Model.fmtTime(row.start))}</span>
        </div>
        <div class="vwRowBody">
          ${say}
          ${row.setSay && !editing ? `<p class="vwWas"><span>原文：${esc(row.originalSay)}</span><button type="button" class="vwLink" data-action="undo-edit" data-id="${esc(row.setSay.id)}">恢复原文</button></p>` : ""}
          ${row.deleted && deleteEdit ? `<p class="vwWas"><span>${isEditRendered(deleteEdit) ? "这句已经删掉了" : "这句会被删掉"}</span><button type="button" class="vwLink" data-action="undo-edit" data-id="${esc(deleteEdit.id)}">恢复这句</button></p>` : ""}
          ${row.deleted ? "" : `<div class="vwShots">${shots}</div>`}
          ${textsHtml}
          ${notes ? `<div class="vwNotesList">${notes}</div>` : ""}
          ${rowPanelHtml}
        </div>
      </article>`;
  }

  function editorCharHint(draft, original) {
    const len = String(draft || "").trim().length;
    const origLen = String(original || "").trim().length;
    const diff = len - origLen;
    if (!origLen || Math.abs(diff) < 5) return `${len} 字`;
    return `${len} 字（比原句${diff > 0 ? `多 ${diff}` : `少 ${-diff}`} 字）`;
  }

  function sayEditorHtml(row, editing) {
    const draft = editing.draft ?? row.say;
    return `
      <div class="vwEditor" data-editor-box>
        <textarea class="vwSayEditor" rows="2" aria-label="口播文字" data-editor="say" data-original-say="${esc(row.originalSay)}">${esc(draft)}</textarea>
        ${editing.showTts
          ? `<label class="vwTtsField">配音读作（字幕不变）<input type="text" class="vwInput" data-editor="tts" value="${esc(editing.ttsDraft ?? row.sayTts)}" placeholder="把难读的词换成同音字" /></label>`
          : ""}
        <div class="vwEditorFoot">
          <div class="vwEditorFootLeft">
            ${editing.showTts ? "" : `<button type="button" class="vwLink" data-action="show-tts">有字读错了？</button>`}
            <span class="vwEditorCount">${esc(editorCharHint(draft, row.originalSay))}</span>
          </div>
          <div class="vwEditorFootRight">
            <button type="button" class="vwBtn vwBtnSmall" data-action="cancel-edit">取消</button>
            <button type="button" class="vwBtn vwBtnSmall vwBtnPrimary" data-action="commit-edit">保存</button>
          </div>
        </div>
      </div>`;
  }

  function noteHtml(note, prefix) {
    return `<div class="vwNote ${note.sentAt ? "vwNoteSent" : ""}">
      <span class="vwNoteTag">${ICONS.sparkles}<span>${note.sentAt ? "已发给 AI" : "待发给 AI"}</span></span>
      <span class="vwNoteBody">${prefix ? `<strong>${esc(prefix)}：</strong>` : ""}${esc(note.text)}</span>
      ${note.sentAt ? "" : `<button type="button" class="vwNoteRemove" data-action="remove-note" data-id="${esc(note.id)}" aria-label="删除这条意见" title="删除">${ICONS.close}</button>`}
    </div>`;
  }

  /* ── 待处理 ─────────────────────────────────────── */
  function describeCurrent(current) {
    if (typeof current.say === "string") return current.say;
    if (typeof current.say_tts === "string") return `读作 ${current.say_tts}`;
    if (typeof current.text === "string") return `字卡「${current.text}」`;
    if (current.scene) return `动画 ${current.scene}`;
    if (current.src) return `${Model.baseName(current.src)}${typeof current.in === "number" ? `（${current.in} 秒起）` : ""}`;
    if (current.speed !== undefined) return `语速 ${current.speed} 倍`;
    if (current.rate !== undefined) return `语速 ${current.rate}`;
    if (current.gain_db !== undefined) return `配乐 ${current.gain_db} dB`;
    return "";
  }

  function changesHtml() {
    const status = view.data.editsStatus;
    const edits = view.doc.edits;
    const conflicts = conflictIds();
    const conflicted = edits.filter((edit) => conflicts.has(edit.id));
    const pending = pendingEdits();
    const reverts = revertedPending();
    const rendered = edits.filter((edit) => Model.isEditInFinal(view.data, edit) && !conflicts.has(edit.id));
    const notes = unsentNotes();
    const sent = view.doc.notes.filter((note) => note.sentAt);

    const editRow = (edit) => {
      const info = Model.statusOfEdit(edit.id, status);
      const conflict = info.state === "conflict";
      const current = conflict ? status?.conflicts?.find((item) => item.id === edit.id)?.current : null;
      const aiVersion = current ? describeCurrent(current) : "";
      return `
        <li class="vwChange ${conflict ? "vwChangeConflict" : ""}">
          <div class="vwChangeText" ${edit.beat ? `data-action="jump-row" data-beat="${esc(edit.beat)}"` : ""}>
            <span>${esc(Model.describeEdit(edit, view.rows))}</span>
            ${conflict ? `<small>${esc(info.message)}</small>` : ""}
            ${aiVersion ? `<small class="vwChangeCurrent">AI 现在的版本：${esc(aiVersion)}</small>` : ""}
          </div>
          <div class="vwChangeActions">
            ${current ? `<button type="button" class="vwBtn vwBtnSmall" data-action="keep-mine" data-id="${esc(edit.id)}">用我的</button>` : ""}
            <button type="button" class="vwBtn vwBtnSmall" data-action="undo-edit" data-id="${esc(edit.id)}">${conflict ? "用 AI 的" : "撤销"}</button>
          </div>
        </li>`;
    };

    const revertRow = (edit) => `
        <li class="vwChange">
          <div class="vwChangeText" ${edit.beat ? `data-action="jump-row" data-beat="${esc(edit.beat)}"` : ""}>
            <span>${esc(Model.describeRevert(edit, view.rows))}</span>
          </div>
          <div class="vwChangeActions">
            <button type="button" class="vwBtn vwBtnSmall" data-action="unrevert" data-id="${esc(edit.id)}">撤销</button>
          </div>
        </li>`;

    const noteRow = (note) => {
      const row = view.rows.find((item) => item.id === note.beat);
      const where = !row
        ? "全片"
        : (Number.isInteger(note.shot) ? `第 ${row.index + 1} 句第 ${note.shot + 1} 个镜头` : `第 ${row.index + 1} 句`);
      return `
        <li class="vwChange">
          <div class="vwChangeText" ${row ? `data-action="jump-row" data-beat="${esc(row.id)}"` : ""}><span>${esc(note.text)}</span><small>${esc(where)}</small></div>
          <div class="vwChangeActions"><button type="button" class="vwBtn vwBtnSmall" data-action="remove-note" data-id="${esc(note.id)}">删除</button></div>
        </li>`;
    };

    const voice = view.data.edl?.voice;
    const canSetSpeed = voice && typeof voice === "object" && voice.provider === "minimax";
    const voiceEdit = edits.find((edit) => edit.op === "set_voice");
    const currentSpeed = voiceEdit?.value?.speed ?? voice?.speed ?? 1;
    const directCount = pending.length + reverts.length;
    const nothing = conflicted.length + notes.length + directCount === 0;

    let bannerHtml = "";
    if (conflicted.length > 0) {
      bannerHtml = `<div class="vwChangesBanner vwChangesBannerWarn">有 <strong>${conflicted.length}</strong> 处改动和 AI 的修改冲突，请先在下方选择保留哪个版本。</div>`;
    } else if (notes.length > 0) {
      bannerHtml = `<div class="vwChangesBanner vwChangesBannerAi">${ICONS.sparkles}<span>共 <strong>${notes.length}</strong> 条 AI 意见${directCount ? `（及 ${directCount} 处直接改动）` : ""}，点右上角「发给 AI 处理」将一并交给 AI。</span></div>`;
    } else if (directCount > 0) {
      bannerHtml = `<div class="vwChangesBanner">${ICONS.bolt}<span>共 <strong>${directCount}</strong> 处直接改动，点右上角「生成新版本」将直接本地渲染，不花 AI 额度。</span></div>`;
    }

    return `
      <div class="vwChanges">
        ${bannerHtml}
        ${conflicted.length ? `
          <section class="vwChangeGroup">
            <h3><span class="vwGroupDot vwGroupDotDanger"></span>需要你决定 <span class="vwGroupCount">${conflicted.length}</span></h3>
            <ul class="vwChangeList">${conflicted.map(editRow).join("")}</ul>
          </section>` : ""}
        ${notes.length ? `
          <section class="vwChangeGroup">
            <h3><span class="vwGroupDot vwGroupDotAi"></span>告诉 AI 的 <span class="vwGroupCount">${notes.length}</span></h3>
            <ul class="vwChangeList">${notes.map(noteRow).join("")}</ul>
          </section>` : ""}
        ${directCount ? `
          <section class="vwChangeGroup">
            <h3><span class="vwGroupDot vwGroupDotEdit"></span>你改的 <span class="vwGroupCount">${directCount}</span></h3>
            <ul class="vwChangeList">${pending.map(editRow).join("")}${reverts.map(revertRow).join("")}</ul>
          </section>` : ""}
        ${nothing ? `<div class="vwEmptyLarge"><p>还没有待处理的修改</p><small>在脚本里点「改字」或双击文字即可改口播，点镜头缩略图就能换画面。</small></div>` : ""}
        <section class="vwChangeGroup vwGlobalNoteCard">
          <h3>对整条视频提意见</h3>
          <div class="vwNoteCompose">
            <input type="text" class="vwNoteInput vwNoteGlobal" data-note-beat="" placeholder="对整条视频有修改想法？回车或点「添加修改」" aria-label="写下对整条视频的修改想法" />
            <button type="button" class="vwNoteSend" data-action="submit-note" disabled>添加修改</button>
          </div>
        </section>
        ${canSetSpeed ? `
          <details class="vwChangeGroup">
            <summary>配音语速（当前 ${Number(currentSpeed).toFixed(2)} 倍）</summary>
            <p class="vwHint">改语速会重配所有句子，MiniMax 按字数计费。</p>
            <div class="vwSpeed">
              <button type="button" class="vwBtn vwBtnSmall" data-action="speed" data-delta="-0.05">慢一点</button>
              <span class="vwSpeedValue">${Number(currentSpeed).toFixed(2)} 倍</span>
              <button type="button" class="vwBtn vwBtnSmall" data-action="speed" data-delta="0.05">快一点</button>
            </div>
          </details>` : ""}
        ${(() => {
          const music = view.data.edl?.music;
          const hasMusic = Boolean((view.plan?.music || music) && music !== "none");
          if (!hasMusic) return "";
          const baseGain = typeof music === "object" && typeof music.gain_db === "number" ? music.gain_db : 0;
          const musicEdit = edits.find((edit) => edit.op === "set_music");
          const curGain = musicEdit?.value?.gain_db ?? baseGain;
          const gainText = `${curGain > 0 ? `+${curGain}` : curGain} dB`;
          return `
          <details class="vwChangeGroup">
            <summary>配乐音量（当前 ${esc(gainText)}）</summary>
            <p class="vwHint">${view.cleanMedia?.music ? "播放即可试听。成片生成时统一混音。" : "此版本没有可独立试听的配乐轨，音量将在新版本生效。"}</p>
            <div class="vwSpeed">
              <button type="button" class="vwBtn vwBtnSmall" data-action="music-gain" data-delta="-2">小声点 (-2)</button>
              <span class="vwSpeedValue">${esc(gainText)}</span>
              <button type="button" class="vwBtn vwBtnSmall" data-action="music-gain" data-delta="2">大声点 (+2)</button>
              ${musicEdit ? `<button type="button" class="vwLink" data-action="undo-edit" data-id="${esc(musicEdit.id)}">还原</button>` : ""}
            </div>
          </details>`;
        })()}
        ${rendered.length ? `
          <details class="vwChangeGroup">
            <summary>已生效（${rendered.length}）</summary>
            <ul class="vwChangeList">${rendered.map(editRow).join("")}</ul>
          </details>` : ""}
        ${sent.length ? `
          <details class="vwChangeGroup">
            <summary>已告诉 AI（${sent.length}）</summary>
            <ul class="vwChangeList">${sent.map((note) => `<li class="vwChange"><div class="vwChangeText"><span>${esc(note.text)}</span></div></li>`).join("")}</ul>
          </details>` : ""}
      </div>`;
  }

  /* ── 发布 ───────────────────────────────────────── */
  function publishHtml() {
    const data = view.data;
    const covers = data.covers || [];
    const coverGrid = covers.length
      ? `<div class="vwCovers">${covers.map((cover) => `
          <button type="button" class="vwCover" data-action="open-cover" data-name="${esc(cover.name)}" title="点击查看封面：${esc(cover.name)}">
            <span class="vwCoverImg"><img src="${esc(assetUrl(cover.abs, cover.mtime))}" alt="${esc(cover.name)}" loading="lazy" /></span>
            <span class="vwCoverName">${esc(cover.name)}</span>
          </button>`).join("")}</div>`
      : `<div class="vwPublishEmpty"><span>还没有生成封面</span><button type="button" class="vwBtn vwBtnSmall" data-action="ask" data-text="帮这条视频做一张封面">${ICONS.sparkles}<span>让 AI 做封面</span></button></div>`;
    const docs = [
      data.files?.publish ? ["编辑文案", data.files.publish] : null,
      data.files?.script ? ["口播稿", data.files.script] : null,
      data.files?.notes ? ["制作说明", data.files.notes] : null,
    ].filter(Boolean);
    return `
      <div class="vwPublish">
        <section><h3>封面</h3>${coverGrid}</section>
        <section>
          ${data.files?.publish
            ? `<div class="vwPublishDoc">${view.publishHtml ?? '<p class="vwMuted">加载中…</p>'}</div>`
            : `<h3>标题和描述</h3><div class="vwPublishEmpty"><span>还没有发布文案</span><button type="button" class="vwBtn vwBtnSmall" data-action="ask" data-text="帮这条视频写发布文案，包括抖音、视频号、小红书的标题和描述">${ICONS.sparkles}<span>让 AI 写文案</span></button></div>`}
        </section>
        ${docs.length ? `<section class="vwDocLinks">${docs.map(([label, path]) => `
          <button type="button" class="vwDocChip" data-action="open-doc" data-path="${esc(path)}">${ICONS.doc}<span>${esc(label)}</span></button>`).join("")}</section>` : ""}
      </div>`;
  }

  async function loadPublishDoc() {
    const file = view?.data?.files?.publish;
    if (!file) return;
    if (view.publishLoadedFor === file && view.publishHtml) return;
    const current = view;
    try {
      const note = await deps.invoke("read_note", { path: file });
      if (view !== current) return;
      const parsed = root.marked ? root.marked.parse(note.content || "") : esc(note.content || "");
      const safe = root.DOMPurify ? root.DOMPurify.sanitize(parsed) : parsed;
      view.publishHtml = decoratePublish(safe);
      view.publishLoadedFor = file;
      const box = view.el.querySelector(".vwPublishDoc");
      if (box) box.innerHTML = view.publishHtml;
    } catch (err) {
      console.warn("read publish doc failed", err);
    }
  }

  /* 文案按平台分块，每个标题和正文都能一键复制：发布时要做的就是这件事 */
  function decoratePublish(html) {
    const holder = document.createElement("div");
    holder.innerHTML = html;
    const sections = [];
    let current = null;
    for (const node of [...holder.childNodes]) {
      if (node.nodeType === 1 && /^H[12]$/.test(node.tagName)) {
        if (node.tagName === "H1") continue;
        current = document.createElement("section");
        current.className = "vwPlatform";
        const head = document.createElement("div");
        head.className = "vwPlatformHead";
        head.append(node);
        const copyAll = document.createElement("button");
        copyAll.type = "button";
        copyAll.className = "vwCopyAll";
        copyAll.dataset.action = "copy-platform";
        copyAll.textContent = "复制整块";
        head.append(copyAll);
        current.append(head);
        sections.push(current);
        continue;
      }
      if (node.nodeType === 1 && node.tagName === "HR") continue;
      if (current) current.append(node);
    }
    if (sections.length === 0) return `<div class="vwPlatform">${html}</div>`;
    const copyButton = () => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "vwCopy";
      button.dataset.action = "copy-text";
      button.textContent = "复制";
      return button;
    };
    for (const section of sections) {
      for (const item of section.querySelectorAll("li, pre")) {
        item.classList.add("vwCopyable");
        item.append(copyButton());
      }
    }
    return sections.map((section) => section.outerHTML).join("");
  }

  async function writeClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    }
  }

  /* ── 胶片条：它同时就是进度条，鼠标滑过画面跟着走 ── */
  function renderStrip() {
    const box = view.el.querySelector(".vwStrip");
    const plan = view.plan;
    if (!plan?.duration || !plan.shots?.length) {
      box.innerHTML = "";
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const fps = plan.fps || 30;
    const pct = (seconds) => `${((seconds / plan.duration) * 100).toFixed(3)}%`;
    const missing = view.data.missingSources || [];
    const replacedIndex = new Set();
    for (const row of view.rows) {
      for (const shot of row.shots) {
        if (shot.planIndex >= 0 && ((shot.replace && !isEditRendered(shot.replace)) || (shot.revert && !shot.replace))) {
          replacedIndex.add(shot.planIndex);
        }
      }
    }
    const tiles = plan.shots.map((shot, index) => {
      const start = shot.start / fps;
      const length = shot.frames / fps;
      const thumb = view.thumbs.get(`${versionMediaKey(currentVersion())}#${index}`);
      return `<span class="vwStripShot vwStripShot-${esc(shot.kind)} ${replacedIndex.has(index) ? "vwStripChanged" : ""} ${Model.isMissingSource(shot.path, missing) ? "vwStripLost" : ""}"
        style="left:${pct(start)};width:${pct(length)}" data-strip-shot="${index}">${thumb ? `<img src="${esc(assetUrl(thumb))}" alt="" loading="lazy" />` : ""}</span>`;
    }).join("");
    const deleted = view.rows.filter((row) => row.deleted && row.start !== null)
      .map((row) => `<span class="vwStripDeleted" style="left:${pct(row.start)};width:${pct(row.end - row.start)}"></span>`).join("");
    // 句子比镜头大一级：句间留更宽的缝，选中的句子框出来，和右边脚本对得上
    const beats = view.rows.filter((row) => row.start !== null && row.end !== null)
      .map((row, index) => {
        const noted = row.notes.some((n) => !n.sentAt) || row.shots.some((s) => s.notes.some((n) => !n.sentAt));
        return `<span class="vwStripBeat ${index === 0 ? "vwStripBeatFirst" : ""} ${row.id === view.activeBeat ? "vwStripBeatActive" : ""} ${noted ? "vwStripBeatNoted" : ""}"
          data-strip-beat="${esc(row.id)}" style="left:${pct(row.start)};width:${pct(row.end - row.start)}"></span>`;
      }).join("");
    box.innerHTML = `
      <div class="vwStripWrap">
        <div class="vwStripTrack" role="slider" tabindex="0" aria-label="播放位置" aria-valuemin="0" aria-valuemax="${Math.round(plan.duration)}" aria-valuenow="0">
          ${tiles}${deleted}${beats}
          <span class="vwSkimLine" hidden></span>
        </div>
        <span class="vwPlayhead"><span class="vwPlayheadCap"></span></span>
        <span class="vwSkimTime" hidden></span>
      </div>`;
    updatePlayhead();
  }

  function updatePlayhead() {
    const video = videoEl();
    const head = view?.el.querySelector(".vwPlayhead");
    const duration = view?.plan?.duration;
    if (!video || !head || !duration || view.playingSample) return;
    const time = view.skim?.restore ?? video.currentTime ?? 0;
    head.style.left = `${Math.min(100, (time / duration) * 100).toFixed(3)}%`;
  }

  function stripTime(event, track) {
    const rect = track.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    return { fraction, time: fraction * (view.plan?.duration || 0) };
  }

  function wireStrip(box) {
    box.addEventListener("pointermove", (event) => {
      const track = event.target.closest?.(".vwStripTrack");
      if (!track || !view?.plan) return;
      const wrap = track.closest(".vwStripWrap") || box;
      const { fraction, time } = stripTime(event, track);
      const line = track.querySelector(".vwSkimLine");
      const label = wrap.querySelector(".vwSkimTime");
      line.hidden = false;
      label.hidden = false;
      line.style.left = `${fraction * 100}%`;
      const row = Model.rowAtTime(view.rows, time);
      const baseLabel = Model.stripLabel(view.rows, time, 18);
      label.textContent = row ? `#${String(row.index + 1).padStart(2, "0")} · ${baseLabel}` : baseLabel;
      // 提示浮在胶片条上方，按像素夹在宽度内，不半截跑出去
      const trackWidth = track.clientWidth;
      const half = label.offsetWidth / 2 + 4;
      label.style.left = `${Math.min(trackWidth - half, Math.max(half, fraction * trackWidth))}px`;
      const video = videoEl();
      if (view.dragging) {
        seekQuick(time);
      } else if (video.paused && !view.playingSample) {
        // 暂停时鼠标滑过就能看画面，移开回到原来的位置
        if (!view.skim) view.skim = { restore: video.currentTime };
        seekQuick(time);
      }
    });
    box.addEventListener("pointerleave", () => {
      const track = box.querySelector(".vwStripTrack");
      const wrap = box.querySelector(".vwStripWrap");
      if (track) track.querySelector(".vwSkimLine").hidden = true;
      if (wrap) wrap.querySelector(".vwSkimTime").hidden = true;
      if (view?.skim && !view.dragging) {
        const restore = view.skim.restore;
        view.skim = null;
        seekQuick(restore);
      }
    });
    box.addEventListener("pointerdown", (event) => {
      const track = event.target.closest?.(".vwStripTrack");
      if (!track || !view?.plan) return;
      if (view.playingSample) loadCurrentVersion();
      view.skim = null;
      view.dragging = true;
      view.stopAt = null;
      track.setPointerCapture?.(event.pointerId);
      seekQuick(stripTime(event, track).time);
    });
    const endDrag = () => { if (view) view.dragging = false; };
    box.addEventListener("pointerup", endDrag);
    box.addEventListener("pointercancel", endDrag);
  }

  /* 上一次跳转还没完成时只记下最后的目标，否则鼠标一动就排起长队。
     但不能无限等：跳转万一迟迟不结束，后面的滑动就全失效了，等太久就直接再跳一次 */
  function seekQuick(time) {
    const video = videoEl();
    if (!video || video.readyState < 1) return;
    if (video.seeking && Date.now() - (view.lastSeekAt || 0) < SEEK_STALL_MS) {
      view.pendingSeek = time;
      return;
    }
    view.lastSeekAt = Date.now();
    video.currentTime = Math.max(0, time);
    updatePlayback();
  }

  /* ── 播放器 ─────────────────────────────────────── */
  function applyPlaybackRate() {
    if (!view) return;
    const rate = Number(view.playbackRate) || 1;
    const video = videoEl();
    if (video) video.playbackRate = rate;
    const previewVideo = view.el.querySelector(".vwPreviewVideo");
    if (previewVideo) previewVideo.playbackRate = rate;
    const btn = view.el.querySelector(".vwRateBtn");
    if (btn) {
      btn.textContent = Model.formatPlaybackRate(rate);
      btn.classList.toggle("vwRateBtnActive", rate !== 1);
    }
  }

  function stepBeat(delta) {
    const timed = view.rows.filter((row) => row.start !== null);
    if (timed.length === 0) return;
    const now = videoEl()?.currentTime || 0;
    const currentIndex = timed.findIndex((row) => now >= row.start - 0.001 && now < row.end);
    const next = timed[Math.min(timed.length - 1, Math.max(0, (currentIndex < 0 ? 0 : currentIndex) + delta))];
    if (!next) return;
    seek(next.start);
    markActiveRow(next.id, true);
    const rowEl = view.el.querySelector(`.vwRow[data-beat="${CSS.escape(next.id)}"]`);
    if (rowEl) scrollRowIntoView(rowEl, "smooth");
  }

  function wantCleanMode() {
    if (!view || view.playingSample || view.compareOriginal) return false;
    return hasLiveVisualChanges();
  }

  function hasLiveVisualChanges() {
    return Boolean(view.editingCard || view.editing)
      || view.reverted?.some((edit) => ["set_text", "delete_text", "set_hook", "set_say"].includes(edit.op))
      || Model.hasPendingLiveVisualEdits({ rows: view.liveRows, hook: view.liveHook, isPending: (edit) => !isEditRendered(edit) });
  }

  let jobRequestSequence = 0;

  function resetPreviewMedia() {
    stopMusicPreview();
    const audio = view.musicAudio;
    if (audio) {
      audio.buffers = null;
      audio.loadingFor = null;
      audio.failed = false;
    }
    closeVoiceSample();
    view.cleanMedia = null;
    view.cleanRequest = null;
    view.cleanError = false;
    view.cleanUnavailable = false;
    view.compareOriginal = false;
    view.usingCleanVideo = false;
  }

  function ensureCleanPreview() {
    const current = view;
    const version = current && currentVersion();
    if (!version?.hasCleanBase || current.cleanMedia || current.cleanRequest || current.cleanError || current.cleanUnavailable || !current.env?.ok) return;
    const token = String(++jobRequestSequence);
    const request = { token, key: versionMediaKey(version) };
    current.cleanRequest = request;
    deps.invoke("video_start_job", {
      path: current.projectPath,
      kind: "clean_preview",
      args: { video: version.name, requestId: token },
    }).catch(() => {
      if (view === current && current.cleanRequest === request) finishCleanRequest(null);
    });
  }

  function finishCleanRequest(event) {
    view.cleanRequest = null;
    view.cleanMedia = event?.cleanVideo ? event : null;
    view.cleanUnavailable = ["no_matching_base", "version_missing"].includes(event?.reason);
    view.cleanError = !view.cleanMedia && !view.cleanUnavailable;
    syncVideoSource();
    updatePlayback();
    if (view.tab === "changes") renderPanel();
  }

  function pendingMusicGain() {
    const conflicts = conflictIds();
    const edit = view.doc.edits.find((item) => item.op === "set_music" && !conflicts.has(item.id));
    if (edit && !isEditRendered(edit) && Number.isFinite(edit.value?.gain_db)) return edit.value.gain_db;
    if (view.reverted?.some((item) => item.op === "set_music")) return Number(view.data.edl?.music?.gain_db ?? 0);
    return null;
  }

  function unlockMusicPreview() {
    if (!view.musicAudio && typeof AudioContext === "function") {
      const context = new AudioContext();
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.ratio.value = 12;
      limiter.connect(context.destination);
      view.musicAudio = { context, limiter };
    }
    void view.musicAudio?.context.resume().catch(() => {});
  }

  function stopMusicPreview() {
    const audio = view?.musicAudio;
    if (!audio?.playing) return;
    for (const source of audio.playing.sources) {
      source.stop();
      source.disconnect();
    }
    audio.playing.gain.disconnect();
    audio.playing.video.volume = audio.playing.volume;
    audio.playing = null;
  }

  function syncMusicPreview(video) {
    const current = view;
    const media = current.cleanMedia;
    const audio = current.musicAudio;
    const requestedGain = pendingMusicGain();
    if (!audio || !media?.music || !media.dialogue || requestedGain === null || current.compareOriginal || current.playingSample) {
      stopMusicPreview();
      return;
    }
    if (!audio.buffers && audio.loadingFor !== media && !audio.failed) {
      audio.loadingFor = media;
      Promise.all([media.dialogue, media.music].map(async (path) => {
        const response = await fetch(assetUrl(path));
        if (!response.ok) throw new Error(String(response.status));
        return audio.context.decodeAudioData(await response.arrayBuffer());
      })).then((buffers) => {
        if (view !== current || current.cleanMedia !== media) return;
        audio.buffers = buffers;
        audio.loadingFor = null;
        updatePlayback();
      }).catch(() => {
        if (view !== current || current.cleanMedia !== media) return;
        audio.loadingFor = null;
        audio.failed = true;
        updatePlayback();
      });
    }
    if (!audio.buffers || audio.context.state !== "running" || video.paused || video.ended || video.seeking || video.muted || video.readyState < 2) {
      stopMusicPreview();
      return;
    }
    const time = video.currentTime;
    const rate = video.playbackRate;
    const now = audio.context.currentTime;
    const gainValue = 10 ** ((requestedGain - Number(media.gainDb || 0)) / 20);
    const active = audio.playing;
    if (active && active.rate === rate && Math.abs(time - (active.offset + (now - active.start) * rate)) < 0.15) {
      active.gain.gain.setTargetAtTime(gainValue, now, 0.035);
      return;
    }
    stopMusicPreview();
    const gain = audio.context.createGain();
    gain.gain.value = gainValue;
    gain.connect(audio.limiter);
    const sources = audio.buffers.map((buffer, index) => {
      const source = audio.context.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = rate;
      source.connect(index === 1 ? gain : audio.limiter);
      source.start(now, Math.min(buffer.duration, time));
      return source;
    });
    audio.playing = { sources, gain, video, volume: video.volume, rate, offset: time, start: now };
    video.volume = 0;
  }

  function closeVoiceSample() {
    view.voiceRequest = null;
    const panel = view.el.querySelector(".vwVoiceSample");
    const player = panel.querySelector("audio");
    player.pause();
    if (player.hasAttribute("src")) {
      player.removeAttribute("src");
      player.load();
    }
    player.ontimeupdate = null;
    panel.hidden = true;
  }

  function showVoiceSample(sample) {
    const panel = view.el.querySelector(".vwVoiceSample");
    const audio = panel.querySelector("audio");
    const caption = panel.querySelector("output");
    videoEl()?.pause();
    caption.textContent = sample.say;
    audio.ontimeupdate = () => {
      caption.textContent = Model.cueAt(sample.cues, audio.currentTime) || sample.say;
    };
    audio.src = assetUrl(sample.voiceSample);
    panel.hidden = false;
    void audio.play().catch(() => {});
  }

  /* 有无字底片且有未渲染的文字/字卡/钩子改动时，无缝切到无字底片 + 实时叠层，保持播放时刻与状态 */
  function syncVideoSource() {
    const video = videoEl();
    const version = currentVersion();
    if (!video || !version || view.playingSample) return;
    const shouldUseClean = Boolean(view.cleanMedia && wantCleanMode());
    const src = shouldUseClean ? assetUrl(view.cleanMedia.cleanVideo) : assetUrl(version.abs, version.mediaRevision ?? version.mtime);
    if (video.getAttribute("src") === src) return;
    const wasPlaying = !video.paused && !video.ended;
    const time = video.currentTime || 0;
    const current = view;
    const source = Symbol();
    current.videoSource = source;
    view.usingCleanVideo = shouldUseClean;
    video.src = src;
    video.hidden = false;
    view.el.querySelector(".vwPlayerEmpty").hidden = true;
    applyPlaybackRate();
    const restore = () => {
      if (view !== current || current.videoSource !== source || view.playingSample) return;
      if (time > 0) video.currentTime = Math.min(time, Number.isFinite(video.duration) ? video.duration : time);
      if (wasPlaying) video.play().catch(() => {});
      updatePlayback();
    };
    if (video.readyState >= 1) restore();
    else video.addEventListener("loadedmetadata", restore, { once: true });
  }

  function loadCurrentVersion(keepTime = false) {
    const video = videoEl();
    const empty = view.el.querySelector(".vwPlayerEmpty");
    const version = currentVersion();
    view.videoSource = null;
    view.playingSample = null;
    renderSampleTag();
    view.durationMismatch = false;
    if (!version) {
      view.usingCleanVideo = false;
      video.hidden = true;
      video.removeAttribute("src");
      empty.hidden = false;
      empty.textContent = "还没有成片。AI 做好后这里会自动显示。";
      return;
    }
    video.hidden = false;
    empty.hidden = true;
    const time = keepTime ? video.currentTime : 0;
    const shouldUseClean = Boolean(view.cleanMedia && wantCleanMode());
    view.usingCleanVideo = shouldUseClean;
    video.src = shouldUseClean ? assetUrl(view.cleanMedia.cleanVideo) : assetUrl(version.abs, version.mediaRevision ?? version.mtime);
    applyPlaybackRate();
    if (time) video.currentTime = time;
  }

  function renderSampleTag() {
    // 试看小样的画面和成片时间对不上，画面上的可点区域要收起来
    syncHotspots(videoEl()?.currentTime || 0);
    const tag = view.el.querySelector(".vwSampleTag");
    const frameBadge = view.el.querySelector(".vwSampleFrameBadge");
    if (!tag) return;
    if (!view.playingSample) {
      tag.hidden = true;
      tag.innerHTML = "";
      if (frameBadge) frameBadge.hidden = true;
      return;
    }
    tag.hidden = false;
    tag.innerHTML = `<span>试看第 ${view.playingSample.index + 1} 句</span><button type="button" class="vwSampleBack" data-action="back-to-version">回到成片</button>`;
    if (frameBadge) {
      frameBadge.textContent = `试看第 ${view.playingSample.index + 1} 句`;
      frameBadge.hidden = false;
    }
  }

  function playSample(beat, abs) {
    const row = view.rows.find((item) => item.id === beat);
    const video = videoEl();
    hidePreview();
    view.stopAt = null;
    view.playingSample = { beat, index: row ? row.index : 0, start: row?.start ?? 0 };
    renderSampleTag();
    video.hidden = false;
    view.el.querySelector(".vwPlayerEmpty").hidden = true;
    video.src = assetUrl(abs, Date.now() / 1000);
    applyPlaybackRate();
    video.play().catch(() => {});
  }

  function backToVersion(seekTo = null) {
    loadCurrentVersion();
    if (seekTo !== null) seek(seekTo);
    updatePlayback();
  }

  function seek(seconds) {
    const video = videoEl();
    if (!video) return;
    if (view.playingSample) loadCurrentVersion();
    view.stopAt = null;
    const go = () => {
      video.currentTime = Math.max(0, seconds + 0.001);
      updatePlayback();
    };
    if (video.readyState >= 1) go();
    else video.addEventListener("loadedmetadata", go, { once: true });
  }

  /* 在原位置放一遍：换完镜头马上看到它配上这句话的样子 */
  function playInPlace(start, end) {
    const video = videoEl();
    if (!video) return;
    if (view.playingSample) loadCurrentVersion();
    const go = () => {
      video.currentTime = Math.max(0, start + 0.001);
      view.stopAt = end;
      video.play().catch(() => {});
    };
    if (video.readyState >= 1) go();
    else video.addEventListener("loadedmetadata", go, { once: true });
  }

  function togglePlay() {
    const video = videoEl();
    if (!video?.getAttribute("src")) return;
    view.stopAt = null;
    if (video.paused) {
      if (pendingMusicGain() !== null) unlockMusicPreview();
      video.play().catch(() => {});
    }
    else video.pause();
  }

  function setPlayingUi() {
    const video = videoEl();
    if (!video || !view) return;
    const playing = !video.paused && !video.ended;
    view.el.dataset.playing = String(playing);
    const label = playing ? "暂停" : "播放";
    for (const button of view.el.querySelectorAll('[data-action="toggle-play"]')) {
      button.innerHTML = playing ? ICONS.pause : ICONS.play;
      button.setAttribute("aria-label", label);
    }
    const mute = view.el.querySelector(".vwMuteBtn");
    if (mute) {
      mute.innerHTML = video.muted ? ICONS.mute : ICONS.sound;
      mute.setAttribute("aria-label", video.muted ? "取消静音" : "静音");
    }
  }

  function updateClock() {
    const video = videoEl();
    const clock = view?.el.querySelector(".vwClock");
    if (!video || !clock) return;
    const total = view.playingSample ? video.duration : (view.plan?.duration ?? video.duration);
    clock.textContent = `${Model.fmtTime(video.currentTime || 0)} / ${Model.fmtTime(Number.isFinite(total) ? total : 0)}`;
    const track = view.el.querySelector(".vwStripTrack");
    if (track) track.setAttribute("aria-valuenow", String(Math.round(video.currentTime || 0)));
  }

  function updatePlayback() {
    if (!view) return;
    const video = videoEl();
    if (!video) return;
    updateClock();
    syncMusicPreview(video);
    if (view.playingSample) return;
    const now = video.currentTime || 0;
    if (view.stopAt !== null && now >= view.stopAt - 0.03) {
      view.stopAt = null;
      video.pause();
    }
    // 预览：要删的句子直接跳过，换过的镜头盖在成片上
    if (!video.paused && !view.compareOriginal) {
      const skipTo = Model.skipDeleted(view.liveRows, now);
      if (skipTo !== null) {
        video.currentTime = skipTo + 0.01;
        return;
      }
    }
    syncPreview(now);
    syncHotspots(now);
    const row = Model.rowAtTime(view.rows, now);
    const shot = Model.shotAtTime(row, now);
    if (!view.skim && row) markActiveRow(row.id);
    if (!view.skim) markActiveShot(row && shot ? `${row.id}#${shot.idx}` : null);
    updatePlayhead();
  }

  function markActiveShot(shotKey) {
    if (view.activeShotKey === shotKey) return;
    const prev = view.activeShotKey;
    view.activeShotKey = shotKey;
    if (view.tab !== "script" || view.picker) return;
    const body = view.el.querySelector(".vwPanelBody");
    if (prev) body?.querySelector(`.vwShot[data-shot-key="${CSS.escape(prev)}"]`)?.classList.remove("vwShotCurrent");
    if (shotKey) body?.querySelector(`.vwShot[data-shot-key="${CSS.escape(shotKey)}"]`)?.classList.add("vwShotCurrent");
  }

  /* 暂停时画面上的字幕、字卡可以直接点，右上角给「换这个镜头」。播放时点画面仍是暂停，不抢这个习惯 */
  function syncHotspots(now) {
    const box = view?.el.querySelector(".vwHotspots");
    if (!box) return;
    const video = videoEl();
    const off = !video || !video.paused || view.playingSample || view.picker || view.dragging || !view.plan
      || !video.getAttribute("src");
    const spots = off ? [] : Model.frameHotspots({
      plan: view.plan,
      rows: view.rows,
      hook: view.hook,
      time: now,
      landscape: view.el.dataset.orient === "landscape",
    });
    const key = JSON.stringify(spots);
    if (key === box.dataset.key) return;
    box.dataset.key = key;
    box.hidden = spots.length === 0;
    box.innerHTML = spots.map(hotspotHtml).join("");
  }

  function hotspotHtml(spot) {
    const place = `style="top:${(spot.top * 100).toFixed(2)}%;height:${((spot.bottom - spot.top) * 100).toFixed(2)}%"`;
    if (spot.kind === "caption") {
      return `<button type="button" class="vwHot vwHotCaption" data-action="frame-caption" data-beat="${esc(spot.beat)}" ${place}
        aria-label="改这句字幕：${esc(spot.text)}"><span class="vwHotTip">点击改这句字幕</span></button>`;
    }
    if (spot.kind === "text") {
      if (spot.isHook) {
        return `<button type="button" class="vwHot vwHotText" data-action="edit-hook" ${place}
          aria-label="直接修改开头钩子：${esc(spot.text)}"><span class="vwHotTip">开头钩子 · 点击直接改</span></button>`;
      }
      if (Number.isInteger(spot.idx)) {
        return `<button type="button" class="vwHot vwHotText" data-action="edit-text-card" data-beat="${esc(spot.beat)}" data-idx="${spot.idx}" ${place}
          aria-label="直接修改字卡：${esc(spot.text)}"><span class="vwHotTip">字卡 · 点击直接改</span></button>`;
      }
      return `<button type="button" class="vwHot vwHotText" data-action="frame-text" data-beat="${esc(spot.beat)}" data-text="${esc(spot.text)}" ${place}
        aria-label="告诉 AI 这个字卡怎么改：${esc(spot.text)}"><span class="vwHotTip">字卡 · 点击提意见</span></button>`;
    }
    return `<button type="button" class="vwHotChip" data-action="frame-shot" data-beat="${esc(spot.beat)}" data-shot="${spot.shot}">${ICONS.swap}<span>换这个镜头</span></button>`;
  }

  /* 从画面跳到右边脚本里对应的那一句 */
  function showRow(beat) {
    if (view.picker) closePicker();
    const row = view.rows.find((item) => item.id === beat);
    if (!row) return null;
    const filteredOut = !Model.rowMatchesQuery(row, view.scriptQuery) || (view.onlyModified && !Model.rowHasChanges(row));
    if (filteredOut) {
      view.scriptQuery = "";
      view.onlyModified = false;
    }
    if (view.tab !== "script" || filteredOut) {
      view.tab = "script";
      view.editing = null;
      renderTabs();
      renderPanel(true);
    }
    markActiveRow(beat, true);
    const rowEl = view.el.querySelector(`.vwRow[data-beat="${CSS.escape(beat)}"]`);
    if (rowEl) scrollRowIntoView(rowEl, "smooth");
    return rowEl;
  }

  /* 改完一处在右下角留几秒「撤销」，比只有 Ctrl+Z 好找；不占布局，不推动别的东西 */
  function showUndo(label) {
    const pill = view?.el.querySelector(".vwUndo");
    if (!pill) return;
    pill.querySelector(".vwUndoText").textContent = `已${label}`;
    pill.hidden = false;
    clearTimeout(view.undoTimer);
    const current = view;
    view.undoTimer = setTimeout(() => { if (view === current) hideUndo(); }, UNDO_SHOW_MS);
  }

  function hideUndo() {
    const pill = view?.el.querySelector(".vwUndo");
    if (pill) pill.hidden = true;
    clearTimeout(view?.undoTimer);
  }

  function hidePreview() {
    const box = view?.el;
    if (!box) return;
    const previewVideo = box.querySelector(".vwPreviewVideo");
    if (previewVideo && !previewVideo.hidden) {
      previewVideo.pause();
      previewVideo.hidden = true;
    }
    const image = box.querySelector(".vwPreviewImage");
    if (image) image.hidden = true;
    const caption = box.querySelector(".vwPreviewCaption");
    if (caption) caption.hidden = true;
    const tag = box.querySelector(".vwPreviewTag");
    if (tag) tag.hidden = true;
  }

  function hideLiveLayer() {
    const layer = view?.el.querySelector(".vwLiveLayer");
    if (layer) {
      layer.hidden = true;
      layer.dataset.key = "";
    }
    const toggle = view?.el.querySelector(".vwLiveToggle");
    if (toggle) toggle.hidden = true;
  }

  /* 实时画面合成层：把字卡、开头钩子、改字字幕（包括正在打字的草稿）0 延迟叠到画面上 */
  function syncLiveLayer(now) {
    const box = view?.el;
    if (!box) return;
    const layer = box.querySelector(".vwLiveLayer");
    const toggle = box.querySelector(".vwLiveToggle");
    if (!layer || !toggle) return;
    if (view.playingSample || !view.plan) {
      hideLiveLayer();
      return;
    }
    const isPending = (edit) => !isEditRendered(edit);
    const visuals = hasLiveVisualChanges();
    const music = pendingMusicGain() !== null;
    if (!visuals && !music) {
      hideLiveLayer();
      return;
    }
    toggle.hidden = false;
    toggle.classList.toggle("vwLiveToggleOrig", view.compareOriginal);
    const canCompare = Boolean((visuals && view.cleanMedia) || (music && view.musicAudio?.buffers));
    const label = view.compareOriginal ? "原成片 · 看修改"
      : canCompare ? (visuals && view.usingCleanVideo ? "实时预览 · 对比原片" : "配乐试听 · 对比原片")
      : view.cleanRequest ? "正在准备实时预览"
      : view.cleanError ? "预览准备失败 · 重试"
      : music && view.musicAudio?.loadingFor ? "正在准备试听"
      : music && view.musicAudio?.failed ? "配乐试听加载失败"
      : "播放原片 · 修改将在新版本显示";
    toggle.disabled = !canCompare && !view.cleanError;
    if (toggle.textContent !== label) toggle.textContent = label;

    if (view.compareOriginal || !view.usingCleanVideo) {
      layer.hidden = true;
      layer.dataset.key = "";
      return;
    }

    const landscape = box.dataset.orient === "landscape";
    const overlay = Model.liveOverlaysAt({ rows: view.liveRows, hook: view.liveHook, plan: view.plan, time: now, landscape, isPending });
    let cards = overlay.cards;

    // 正在编辑字卡/钩子时，按键立刻实时反映在左侧画面
    const ec = view.editingCard;
    if (ec) {
      const y = Model.resolveTextY(ec.draftPos, landscape);
      const draftCard = {
        isHook: ec.isHook,
        beat: ec.beat || null,
        idx: ec.idx ?? null,
        text: ec.draftText || "",
        sub: ec.draftSub || "",
        badge: ec.draftBadge || "",
        style: ec.isHook ? "title" : (ec.style || "tag"),
        y: typeof y === "number" ? y : 0.25,
        changed: true,
        editing: true,
      };
      cards = cards.filter((c) => !(c.isHook === ec.isHook && (ec.isHook || (c.beat === ec.beat && c.idx === ec.idx))));
      if (draftCard.text.trim()) cards = [...cards, draftCard];
    }

    // 正在编辑口播文字时，实时预览草稿字幕
    let caption = overlay.caption;
    if (view.editing) {
      const editRow = view.rows.find((r) => r.id === view.editing.beat);
      const draftSay = box.querySelector('[data-editor="say"]')?.value ?? view.editing.draft;
      if (editRow && typeof draftSay === "string" && now >= (editRow.start ?? -1) && now < (editRow.end ?? -1)) {
        caption = Model.liveCaptionFor({ ...editRow, say: draftSay, setSay: { id: "_draft" } }, now, view.plan.cues, () => true);
      }
    }
    const key = JSON.stringify({ cards, caption, captionPos: overlay.captionPos });
    if (key === layer.dataset.key) {
      layer.hidden = !(cards.length || caption);
      return;
    }
    layer.dataset.key = key;
    if (!cards.length && !caption) {
      layer.hidden = true;
      layer.innerHTML = "";
      return;
    }
    const cardsHtml = cards.map((c) => {
      const styleClass = `vwLiveCard-${c.isHook ? "hook" : (c.style || "tag")}`;
      return `<div class="vwLiveCard ${styleClass} ${c.editing ? "vwLiveCardEditing" : ""}" style="top:${(c.y * 100).toFixed(2)}%">
        ${c.badge ? `<span class="vwLiveCardBadge">${esc(c.badge)}</span>` : ""}
        <div class="vwLiveCardText">${esc(c.text)}</div>
        ${c.sub ? `<div class="vwLiveCardSub">${esc(c.sub)}</div>` : ""}
      </div>`;
    }).join("");
    const capPosClass = `vwLiveCaption-${overlay.captionPos || "bottom"}`;
    const capHtml = caption
      ? `<div class="vwLiveCaption ${capPosClass}">${esc(caption)}</div>`
      : "";
    layer.hidden = false;
    layer.innerHTML = `${cardsHtml}${capHtml}`;
  }

  /* 没生成的换镜头不用等渲染：把素材盖在成片上，声音还是成片的。字幕被盖住了，用文字层补上 */
  function syncPreview(now) {
    const hit = Model.overlayAt(view.liveRows, now, (edit) => !isEditRendered(edit), originalOf);
    if (!hit || view.overlayBroken.has(hit.src) || view.compareOriginal) {
      hidePreview();
      syncLiveLayer(now);
      return;
    }
    const video = videoEl();
    const box = view.el;
    const previewVideo = box.querySelector(".vwPreviewVideo");
    const image = box.querySelector(".vwPreviewImage");
    if (hit.kind === "photo") {
      if (!previewVideo.hidden) {
        previewVideo.pause();
        previewVideo.hidden = true;
      }
      if (image.dataset.src !== hit.src) {
        image.dataset.src = hit.src;
        image.src = assetUrl(hit.src);
      }
      image.hidden = false;
    } else {
      image.hidden = true;
      if (previewVideo.dataset.src !== hit.src) {
        previewVideo.dataset.src = hit.src;
        previewVideo.src = assetUrl(hit.src);
      }
      previewVideo.playbackRate = Number(view.playbackRate) || 1;
      if (previewVideo.readyState >= 1 && Math.abs(previewVideo.currentTime - hit.sourceTime) > PREVIEW_DRIFT_SEC) {
        previewVideo.currentTime = hit.sourceTime;
      }
      if (!video.paused && previewVideo.paused) previewVideo.play().catch(() => {});
      if (video.paused && !previewVideo.paused) previewVideo.pause();
      previewVideo.hidden = previewVideo.readyState < 2;
    }
    const caption = box.querySelector(".vwPreviewCaption");
    if (view.usingCleanVideo) {
      caption.hidden = true;
    } else {
      const text = Model.cueAt(view.plan?.cues, now);
      caption.textContent = text;
      caption.hidden = !text;
    }
    box.querySelector(".vwPreviewTag").hidden = false;
    syncLiveLayer(now);
  }

  function markActiveRow(beat, force = false) {
    if (view.activeBeat === beat && !force) return;
    // 正在这一句里打字时，不能因为播放走到下一句就把输入框收走
    if (!force && view.el.querySelector(".vwRowActive")?.contains(document.activeElement) && document.activeElement.matches("input, textarea")) return;
    const previous = view.activeBeat;
    view.activeBeat = beat;
    updateScriptProgress();
    for (const span of view.el.querySelectorAll(".vwStripBeat")) {
      span.classList.toggle("vwStripBeatActive", span.dataset.stripBeat === beat);
    }
    if (view.tab !== "script" || view.picker) return;
    const body = view.el.querySelector(".vwPanelBody");
    if (previous) body.querySelector(`.vwRow[data-beat="${CSS.escape(previous)}"]`)?.classList.remove("vwRowActive");
    if (!beat) return;
    const rowEl = body.querySelector(`.vwRow[data-beat="${CSS.escape(beat)}"]`);
    if (!rowEl) return;
    rowEl.classList.add("vwRowActive");
    const video = videoEl();
    const userScrolledRecently = Date.now() - view.lastUserScroll < SCROLL_FOLLOW_PAUSE_MS;
    if (!video?.paused && !userScrolledRecently && !view.editing && !force) scrollRowIntoView(rowEl, "smooth");
  }

  function scrollRowIntoView(rowEl, behavior = "auto") {
    const body = view.el.querySelector(".vwPanelBody");
    const top = rowEl.offsetTop - body.offsetTop;
    const bottom = top + rowEl.offsetHeight;
    if (top < body.scrollTop || bottom > body.scrollTop + body.clientHeight) {
      body.scrollTo({ top: Math.max(0, top - 24), behavior });
    }
  }

  function tick() {
    if (!view) return;
    updatePlayback();
    const video = videoEl();
    if (video && !video.paused && !video.ended) view.rafId = requestAnimationFrame(tick);
  }

  /* ── 缩略图 ─────────────────────────────────────── */
  function ensureShotThumbs() {
    const version = currentVersion();
    if (!version || !view.env?.ok || !view.plan?.shots?.length) return;
    const current = view;
    const key = versionMediaKey(version);
    if (current.thumbsRequested.has(key)) return;
    const requestId = String(++jobRequestSequence);
    current.thumbsRequested.set(key, requestId);
    deps.invoke("video_start_job", {
      path: current.projectPath,
      kind: "thumbs_shots",
      args: { video: version.name, requestId },
    }).catch((err) => {
      current.thumbsRequested.delete(key);
      console.warn("thumbs_shots failed", err);
    });
  }

  function placeShotThumb(key, shotIndex, abs) {
    view.thumbs.set(`${key}#${shotIndex}`, abs);
    if (key !== versionMediaKey(currentVersion())) return;
    const url = assetUrl(abs);
    for (const holder of view.el.querySelectorAll(`.vwScript [data-plan-shot="${shotIndex}"]`)) {
      if (holder.tagName === "IMG") holder.src = url;
      else {
        const img = document.createElement("img");
        img.src = url;
        img.alt = "";
        img.dataset.planShot = String(shotIndex);
        holder.replaceWith(img);
      }
    }
    const tile = view.el.querySelector(`[data-strip-shot="${shotIndex}"]`);
    if (tile && !tile.querySelector("img")) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      tile.append(img);
    }
  }

  /* ── 任务事件 ───────────────────────────────────── */
  function handleJobEvent(payload) {
    if (!view || !payload || payload.project !== view.projectPath) return;
    const { kind, status, event } = payload;
    if (kind === "clean_preview") {
      const request = view.cleanRequest;
      if (!request || payload.requestId !== request.token || request.key !== versionMediaKey(currentVersion())) return;
      if (status === "event" && event && Object.hasOwn(event, "cleanVideo")) finishCleanRequest(event);
      else if (["done", "error", "cancelled"].includes(status)) finishCleanRequest(null);
      return;
    }
    if (kind === "voice_sample") {
      const request = view.voiceRequest;
      if (!request || request.token !== payload.requestId) return;
      if (status === "event" && event?.voiceSample) {
        view.voiceRequest = null;
        if (view.doc.revision === request.revision) showVoiceSample(event);
        else deps.showToast("修改已更新，请重新试听");
        renderPanel();
      } else if (["done", "error", "cancelled"].includes(status)) {
        view.voiceRequest = null;
        if (status === "error") deps.showToast(`试听没生成出来：${payload.message || "请稍后再试"}`);
        renderPanel();
      }
      return;
    }
    if (kind === "thumbs_shots") {
      const request = [...view.thumbsRequested].find(([, id]) => id === payload.requestId);
      if (!request) return;
      const [key] = request;
      if (status === "event" && event?.thumb && Number.isInteger(event.shot)) placeShotThumb(key, event.shot, event.thumb);
      if (status === "error" || status === "cancelled") view.thumbsRequested.delete(key);
      return;
    }
    if (kind === "thumbs_sources") {
      const picker = view.picker;
      const request = picker?.sourceRequest;
      if (!request || payload.requestId !== request.token) return;
      if (status === "event" && event?.source) addPickerSource(event.source);
      if (status === "event" && event?.strip) stripCache.set(event.strip.path, event.strip);
      if (status === "event" && event?.thumbsDone) setPickerLoading(false);
      if (status === "done" || status === "error" || status === "cancelled") {
        request.finished = true;
        picker.sourceRequest = null;
        setPickerLoading(false);
      }
      return;
    }
    if (kind === "sample") {
      const beat = view.sampleRequests.get(payload.requestId);
      if (!beat) return;
      const playable = status === "event" && event?.video;
      if (!playable && !["done", "error", "cancelled"].includes(status)) return;
      view.sampleRequests.delete(payload.requestId);
      view.sampleBusy.delete(beat);
      if (playable) playSample(beat, event.video);
      if (status === "error") deps.showToast(`试看没生成出来：${payload.message || "请稍后再试"}`);
      renderPanel();
      return;
    }
    if (kind === "render") {
      if (status === "start") {
        view.renderBusy = true;
        view.renderJobId = payload.jobId;
        view.renderQa = false;
        view.renderError = null;
        renderHead();
        renderStatus();
      }
      if (status === "event" && event?.video) {
        view.renderQa = true;
        renderStatus();
        void refresh();
      }
      if (status === "done" || status === "error" || status === "cancelled") {
        view.renderBusy = false;
        view.renderQa = false;
        view.renderJobId = null;
        if (status === "cancelled") deps.showToast("已取消");
        if (status === "error") view.renderError = { cmd: "render", message: payload.message || "请稍后再试" };
        void refresh();
      }
      return;
    }
    if (kind === "edits_status" && (status === "done" || status === "error")) void refresh();
  }

  function scheduleStatusCheck() {
    if (!view || !view.env?.ok) return;
    clearTimeout(view.statusTimer);
    view.statusTimer = setTimeout(() => {
      if (!view) return;
      deps.invoke("video_start_job", { path: view.projectPath, kind: "edits_status", args: {} }).catch(() => {});
    }, STATUS_DEBOUNCE_MS);
  }

  /* ── 改动落盘 ───────────────────────────────────── */
  async function writeDoc(projectPath, next, base) {
    const res = await deps.invoke("video_write_edits", {
      path: projectPath,
      edits: { ...next, revision: base.revision },
      expectedRevision: base.revision,
    });
    return res.revision;
  }

  function trackRemovedEdits(current, before, after) {
    const renderPending = isRendering() || deps.isAgentGenerating?.() === true;
    return Model.trackRemovedEdits(before, after, [current.plan, current.data.plan], renderPending);
  }

  /* label 为空的写入（比如标记已发送）不进撤销栈 */
  async function mutateDoc(change, label = null) {
    const current = view;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const base = current.doc;
      const next = trackRemovedEdits(current, base, change(base));
      try {
        const revision = await writeDoc(current.projectPath, next, base);
        if (view !== current) return true;
        if (label) current.history = Model.recordHistory(current.history, base, next, label);
        current.doc = { ...next, revision };
        afterDocChange();
        if (label) showUndo(label);
        return true;
      } catch (err) {
        if (!String(err).includes("REVISION_CONFLICT")) {
          deps.showToast(`保存失败：${err}`);
          return false;
        }
        const data = await deps.invoke("video_read_project", { path: current.projectPath });
        if (view !== current) return false;
        current.doc = Model.normalizeDoc(data.edits);
      }
    }
    deps.showToast("保存失败：文件被占用，请再试一次");
    return false;
  }

  function afterDocChange() {
    rebuildRows();
    syncVideoSource();
    renderHead();
    renderTabs();
    renderPanel(true);
    syncPicker();
    renderStrip();
    updatePlayback();
    scheduleStatusCheck();
  }

  async function stepHistory(direction) {
    const current = view;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const base = current.doc;
      const step = direction === "undo"
        ? Model.undoHistory(current.history, base)
        : Model.redoHistory(current.history, base);
      if (!step) return;
      const next = trackRemovedEdits(current, base, step.doc);
      try {
        const revision = await writeDoc(current.projectPath, next, base);
        if (view !== current) return;
        current.history = step.history;
        current.doc = { ...next, revision };
        afterDocChange();
        hideUndo();
        deps.showToast(`${direction === "undo" ? "已撤销" : "已重做"}：${step.label}`);
        return;
      } catch (err) {
        if (!String(err).includes("REVISION_CONFLICT")) {
          deps.showToast(`撤销失败：${err}`);
          return;
        }
        const data = await deps.invoke("video_read_project", { path: current.projectPath });
        if (view !== current) return;
        current.doc = Model.normalizeDoc(data.edits);
      }
    }
  }

  async function pruneOldSentNotes() {
    const latest = view.data.versions.find((item) => item.name === view.data.latest);
    if (!latest || latest.kind !== "final") return;
    const next = Model.pruneSentNotes(view.doc, latest.mtime);
    if (next.notes.length !== view.doc.notes.length) await mutateDoc((doc) => Model.pruneSentNotes(doc, latest.mtime));
  }

  /* ── 应用修改：一个按钮，系统决定怎么处理 ────────── */
  async function applyChanges() {
    if (view.pendingSend) {
      view.pendingSend = false;
      renderHead();
      return;
    }
    const route = Model.routeApply({ editCount: pendingTotal(), noteCount: unsentNotes().length });
    if (route === "ai") {
      if (deps.isAgentGenerating?.()) {
        view.pendingSend = true;
        renderHead();
        deps.showToast("AI 还在忙，这轮结束后自动发给它");
        return;
      }
      sendNow();
      return;
    }
    if (route === "render") await startRender();
  }

  async function startRender() {
    const current = view;
    if (isRendering()) return;
    if (conflictIds().size) {
      deps.showToast("请先在「待处理」解决修改冲突，再生成新版本");
      return;
    }
    const offline = (view.data.missingSources || []).length;
    if (offline > 0) {
      const names = Model.offlineSummary(view.data.missingSources).names.slice(0, 2).join("、");
      const ok = await deps.confirm(`有 ${offline} 个素材读不到（${names}），生成很可能失败。还要继续吗？`, { confirmLabel: "继续生成", danger: false });
      if (!ok || view !== current || isRendering()) return;
    }
    view.renderBusy = true;
    view.renderError = null;
    renderHead();
    renderStatus();
    try {
      await deps.invoke("video_start_job", { path: current.projectPath, kind: "render", args: {} });
    } catch (err) {
      if (view !== current) return;
      view.renderBusy = false;
      const busy = String(err).includes("JOB_BUSY");
      view.renderError = busy ? null : { cmd: "render", message: String(err) };
      if (busy) deps.showToast("这条视频正在生成，等它结束再试");
      renderHead();
      renderStatus();
    }
  }

  function sendNow() {
    const notes = unsentNotes();
    if (notes.length === 0) return;
    const text = Model.buildAiMessage({
      projectPath: view.projectPath,
      versionName: view.versionName,
      rows: view.rows,
      notes,
      editCount: pendingTotal(),
    });
    if (!deps.sendToAgent(text)) {
      deps.showToast("发送失败：Fellow 还没连上，稍后再试");
      return;
    }
    const ids = notes.map((note) => note.id);
    const at = Math.floor(Date.now() / 1000);
    void mutateDoc((doc) => Model.markNotesSent(doc, ids, at));
    deps.showToast("已交给 AI");
  }

  function onAgentState(generating) {
    if (!view) return;
    if (!generating && view.pendingSend) {
      view.pendingSend = false;
      sendNow();
    }
    if (view.data) {
      renderHead();
      renderStatus();
    }
  }

  /* ── 编辑一句话 ─────────────────────────────────── */
  function startEditing(beat) {
    const row = view.rows.find((item) => item.id === beat);
    if (!row || row.deleted) return;
    videoEl()?.pause();
    view.editingCard = null;
    view.editing = { beat, showTts: Boolean(row.setTts || row.sayTts) };
    view.compareOriginal = false;
    syncVideoSource();
    renderPanel(true);
    syncLiveLayer(videoEl()?.currentTime || 0);
  }

  async function commitEditing() {
    const editing = view.editing;
    if (!editing) return;
    const row = view.rows.find((item) => item.id === editing.beat);
    if (!row) {
      view.editing = null;
      syncVideoSource();
      renderPanel(true);
      syncLiveLayer(videoEl()?.currentTime || 0);
      return;
    }
    const say = view.el.querySelector('[data-editor="say"]')?.value.trim() ?? "";
    const ttsField = view.el.querySelector('[data-editor="tts"]');
    const tts = ttsField ? ttsField.value.trim() : (row.sayTts || "");
    view.editing = null;
    if (!say) {
      deps.showToast("口播不能为空；不要这句就点「删除这句」");
      syncVideoSource();
      renderPanel(true);
      syncLiveLayer(videoEl()?.currentTime || 0);
      return;
    }
    const rawBeat = view.data.edl.beats[row.index];
    const textChanged = say !== row.say;
    const ttsChanged = tts !== (row.sayTts || "");
    if (!textChanged && !ttsChanged) {
      syncVideoSource();
      renderPanel(true);
      syncLiveLayer(videoEl()?.currentTime || 0);
      return;
    }
    await mutateDoc((doc) => {
      let next = doc;
      // 改了字却没动读音框：框里还是旧句子的读音，带上去配音就会读旧内容，必须丢掉
      if (textChanged) next = Model.upsertEdit(next, Model.makeSetSay(row, say, ttsChanged ? tts : undefined));
      else if (ttsChanged && tts) next = Model.upsertEdit(next, Model.makeSetTts(row, rawBeat, tts));
      else if (ttsChanged && row.setTts) next = Model.removeEdit(next, row.setTts.id);
      return next;
    }, `改第 ${row.index + 1} 句`);
  }

  /* ── 实时编辑开头钩子 / 画面字卡 ──────────────────── */
  function openHookEditor() {
    const hook = view.hook;
    if (!hook || !hook.exists || hook.deleted) return;
    videoEl()?.pause();
    if (view.picker) closePicker();
    if (view.tab !== "script") {
      view.tab = "script";
      renderTabs();
    }
    view.scriptQuery = "";
    view.onlyModified = false;
    view.editing = null;
    view.compareOriginal = false;
    view.editingCard = {
      isHook: true,
      draftText: hook.text,
      draftSub: hook.sub || "",
      draftPos: hook.pos ?? "upper",
      originalPos: hook.pos ?? "upper",
      editId: hook.edit?.id || null,
    };
    if (typeof hook.start === "number") seek(hook.start + 0.15);
    syncVideoSource();
    renderPanel(true);
    syncLiveLayer(hook.start + 0.15);
    const input = view.el.querySelector('[data-card-field="text"]');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  function openTextCardEditor(beat, idx) {
    const row = view.rows.find((item) => item.id === beat);
    const card = row?.cards?.find((item) => item.idx === idx);
    if (!row || !card || card.deleted) return;
    videoEl()?.pause();
    showRow(beat);
    view.editing = null;
    view.compareOriginal = false;
    view.editingCard = {
      isHook: false,
      beat,
      idx,
      style: card.style,
      draftText: card.text,
      draftSub: card.sub || "",
      draftBadge: card.badge || "",
      draftPos: card.pos ?? "upper",
      originalPos: card.pos ?? "upper",
      editId: card.setText?.id || null,
    };
    const previewAt = typeof card.start === "number" ? card.start + 0.12 : (row.start ?? 0);
    if (typeof previewAt === "number") seek(previewAt);
    syncVideoSource();
    renderPanel(true);
    syncLiveLayer(previewAt);
    const input = view.el.querySelector('[data-card-field="text"]');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  function cancelCardEdit() {
    if (!view.editingCard) return;
    view.editingCard = null;
    syncVideoSource();
    renderPanel(true);
    syncLiveLayer(videoEl()?.currentTime || 0);
  }

  async function saveCardEdit() {
    const ec = view.editingCard;
    if (!ec) return;
    const text = String(ec.draftText || "").trim();
    if (!text) {
      deps.showToast(ec.isHook ? "钩子标题不能为空；不要就点「删除钩子」" : "字卡文字不能为空；不要就点「删除字卡」");
      return;
    }
    const pos = ec.draftPos === "custom" ? ec.originalPos : ec.draftPos;
    view.editingCard = null;
    if (ec.isHook) {
      await mutateDoc(
        (doc) => Model.upsertEdit(doc, Model.makeSetHook(view.data.edl, { text, sub: ec.draftSub, pos })),
        "改开头钩子",
      );
      return;
    }
    const row = view.rows.find((item) => item.id === ec.beat);
    const card = row?.cards?.find((item) => item.idx === ec.idx);
    if (!row || !card) {
      renderPanel(true);
      return;
    }
    await mutateDoc(
      (doc) => Model.upsertEdit(doc, Model.makeSetText(row, card, { text, sub: ec.draftSub, badge: ec.draftBadge, pos })),
      `改第 ${row.index + 1} 句字卡`,
    );
  }

  async function deleteEditingCard() {
    const ec = view.editingCard;
    if (!ec) return;
    view.editingCard = null;
    if (ec.isHook) {
      await mutateDoc(
        (doc) => Model.upsertEdit(doc, Model.makeSetHook(view.data.edl, { text: "" })),
        "删除开头钩子",
      );
      return;
    }
    const row = view.rows.find((item) => item.id === ec.beat);
    const card = row?.cards?.find((item) => item.idx === ec.idx);
    if (!row || !card) {
      renderPanel(true);
      return;
    }
    await mutateDoc(
      (doc) => Model.upsertEdit(doc, Model.makeDeleteText(row, card)),
      `删除第 ${row.index + 1} 句字卡`,
    );
  }

  /* ── 换镜头面板：占右边，播放器留在左边当预览 ────── */
  function pickerShot() {
    const picker = view.picker;
    const row = view.rows.find((item) => item.id === picker.beat);
    return { row, shot: row?.shots.find((item) => item.idx === picker.shotIdx) || null };
  }

  /* 路径写法可能和素材格子的键不一样（斜杠、大小写），换成格子用的那个键 */
  function itemKeyOf(items, path) {
    if (!path || !items || items.has(path)) return path;
    for (const key of items.keys()) if (Model.samePath(key, path)) return key;
    return path;
  }

  function pickerOriginal(shot, items) {
    const orig = Model.resolveOriginalShot(shot, { items, projectDir: view.data?.abs || "" });
    return { ...orig, path: itemKeyOf(items, orig.path) };
  }

  function pickerSelectionFor(shot, items) {
    if (!shot) return { selectedPath: null, selectedIn: null };
    if (shot.replace) {
      return {
        selectedPath: itemKeyOf(items, shot.replace.value?.src || null),
        selectedIn: typeof shot.replace.value?.in === "number" ? shot.replace.value.in : null,
      };
    }
    const orig = pickerOriginal(shot, items);
    return { selectedPath: orig.path, selectedIn: orig.inSec };
  }

  async function openPicker(beat, shotIdx) {
    const row = view.rows.find((item) => item.id === beat);
    const shot = row?.shots.find((item) => item.idx === shotIdx);
    if (!shot) return;
    videoEl()?.pause();
    view.stopAt = null;
    if (shot.start !== null) seek(shot.start);
    const initial = pickerSelectionFor(shot, view.sourceItems);
    cancelSourceRequest(view.picker);
    view.picker = {
      beat,
      shotIdx,
      need: Model.shotDuration(shot),
      folders: [],
      folder: null,
      items: new Map(),
      tiles: new Map(),
      used: Model.usedSourceKeys(view.rows, originalOf),
      filter: "all",
      query: "",
      onlyUnused: false,
      noteDrafts: new Map(),
      selectedPath: initial.selectedPath,
      selectedIn: initial.selectedIn,
      original: null,
      busy: false,
      loading: false,
      sourceRequest: null,
      skimTile: null,
    };
    renderTabs();
    renderPickerPanel();
    const current = view;
    const picker = current.picker;
    try {
      const res = await deps.invoke("video_list_sources", { path: view.projectPath });
      if (view !== current || view.picker !== picker) return;
      view.picker.folders = res.folders || [];
      for (const asset of res.assets || []) {
        view.picker.items.set(asset.path, Model.mergeSource(null, {
          ...asset,
          sizeMb: asset.sizeMb ?? asset.size_mb,
          dur: asset.dur ?? asset.duration,
        }));
      }
      view.sourceItems = view.picker.items;
      view.picker.used = Model.usedSourceKeys(view.rows, originalOf);
      const latestShot = pickerShot().shot;
      const synced = pickerSelectionFor(latestShot, view.picker.items);
      view.picker.selectedPath = synced.selectedPath;
      view.picker.selectedIn = synced.selectedIn;
      view.picker.original = latestShot ? pickerOriginal(latestShot, view.picker.items) : null;
      const activeDir = Model.dirName(synced.selectedPath || shot.path);
      const preferred = res.folders?.find((folder) => folder.exists !== false && Model.samePath(activeDir, folder.abs))
        || res.folders?.find((folder) => folder.exists !== false)
        || null;
      renderPickerControls();
      if (preferred) selectFolder(preferred.abs);
      else renderPickerGrid();
    } catch (err) {
      if (view !== current || view.picker !== picker) return;
      deps.showToast(`读取素材失败：${err}`);
      renderPickerGrid();
    }
  }

  function renderPickerPanel() {
    const body = view.el.querySelector(".vwPanelBody");
    const { row, shot } = pickerShot();
    const picker = view.picker;
    const draft = picker.noteDrafts.get(picker.shotIdx) || "";
    const shotTabs = (row?.shots?.length || 0) > 1
      ? `<div class="vwPickerShots" role="group" aria-label="同句镜头切换">${row.shots.map((s) => `
          <button type="button" class="vwPickerShotTab ${s.idx === picker.shotIdx ? "vwPickerShotTabOn" : ""} ${s.replace ? "vwPickerShotTabEdited" : ""}"
            data-action="switch-picker-shot" data-shot="${s.idx}">镜头 ${s.idx + 1}</button>`).join("")}</div>`
      : "";
    body.innerHTML = `
      <div class="vwPicker" role="group" aria-label="换镜头">
        <header class="vwPickerHead">
          <div class="vwPickerTitle">
            <button type="button" class="vwPickerBack" data-action="close-picker" title="返回脚本（Esc）">${ICONS.back}<span>脚本</span></button>
            <span class="vwPickerSep" aria-hidden="true">/</span>
            <strong>第 ${(row?.index ?? 0) + 1} 句 · 镜头 ${(shot?.idx ?? 0) + 1}</strong>
            ${picker.need !== null ? `<span class="vwNeedBadge">需要 ${picker.need.toFixed(1)}s</span>` : ""}
          </div>
          <button type="button" class="vwBtn vwBtnSmall vwPickerRestore" data-action="restore-shot" ${shot?.replace ? "" : "hidden"}>恢复原镜头</button>
        </header>
        ${shotTabs}
        <p class="vwPickerSay">${esc(row?.say || "")}</p>
        <p class="vwPickerTip">在视频缩略图上左右滑动可预览并定起点，点击即从此秒起替换</p>
        <div class="vwPickerControls"></div>
        <div class="vwPickerGrid"></div>
        <div class="vwNoteCompose">
          <input type="text" class="vwNoteInput" data-note-beat="${esc(picker.beat)}" data-note-shot="${shot?.idx ?? ""}" value="${esc(draft)}" placeholder="不想自己选？写下想要的画面，回车或点「添加修改」" aria-label="写下想要的画面修改意见" />
          <button type="button" class="vwNoteSend" data-action="submit-note" ${draft.trim() ? "" : "disabled"}>添加修改</button>
        </div>
      </div>`;
    body.scrollTop = 0;
    renderPickerControls();
    renderPickerGrid();
  }

  function renderPickerControls() {
    const box = view?.el.querySelector(".vwPickerControls");
    const picker = view?.picker;
    if (!box || !picker) return;
    const folders = picker.folders.map((folder) => `
      <option value="${esc(folder.abs)}" ${folder.abs === picker.folder ? "selected" : ""} ${folder.exists === false ? "disabled" : ""}>${esc(folder.label || Model.baseName(folder.abs))}${folder.exists === false ? "（读不到）" : ""}</option>`).join("");
    box.innerHTML = `
      <div class="vwPickerControlRow">
        <div class="vwSearchBox vwPickerSearchBox">
          <span class="vwSearchIcon">${ICONS.search}</span>
          <input type="text" class="vwSearchInput" data-input="picker-query" value="${esc(picker.query)}"
            placeholder="搜文件名或画面描述…" aria-label="搜索候选素材" />
          <button type="button" class="vwSearchClear" data-action="clear-picker-query" aria-label="清空搜索" ${picker.query ? "" : "hidden"}>${ICONS.close}</button>
        </div>
        ${picker.folders.length ? `<select class="vwFolderSelect" data-change="picker-folder" aria-label="素材文件夹">${folders}</select>` : ""}
        <button type="button" class="vwLink" data-action="pick-other" data-mode="folder">其它文件夹…</button>
      </div>
      <div class="vwPickerControlRow">
        <div class="vwSegmented" role="group" aria-label="素材类型">
          ${[["all", "全部"], ["video", "视频"], ["photo", "照片"]].map(([key, label]) => `
            <button type="button" class="${picker.filter === key ? "vwSegActive" : ""}" data-action="pick-filter" data-filter="${key}" aria-pressed="${picker.filter === key}">${label}</button>`).join("")}
        </div>
        <label class="vwCheck"><input type="checkbox" data-change="picker-unused" ${picker.onlyUnused ? "checked" : ""} /> 只看没用过的</label>
        <span class="vwControlsSpacer"></span>
        <span class="vwPickerCount"></span>
      </div>`;
    updatePickerCount();
  }

  function updatePickerCount() {
    const el = view?.el.querySelector(".vwPickerCount");
    const picker = view?.picker;
    if (!el || !picker) return;
    el.textContent = picker.loading && picker.tiles.size === 0 ? "读取中…" : `${picker.tiles.size} 个素材`;
  }

  function cancelSourceRequest(picker) {
    const request = picker?.sourceRequest;
    if (!request) return;
    picker.sourceRequest = null;
    if (request.jobId) deps.invoke("video_cancel_job", { jobId: request.jobId }).catch(() => {});
  }

  function selectFolder(abs) {
    const current = view;
    const picker = current.picker;
    if (!picker) return;
    cancelSourceRequest(picker);
    const request = { token: String(++jobRequestSequence) };
    picker.sourceRequest = request;
    picker.folder = abs;
    picker.loading = true;
    renderPickerControls();
    renderPickerGrid();
    deps.invoke("video_start_job", {
      path: current.projectPath,
      kind: "thumbs_sources",
      args: { folder: abs, requestId: request.token },
    }).then(({ jobId }) => {
      if (picker.sourceRequest === request) request.jobId = jobId;
      else if (!request.finished) deps.invoke("video_cancel_job", { jobId }).catch(() => {});
    }).catch((err) => {
      if (picker.sourceRequest !== request) return;
      picker.sourceRequest = null;
      deps.showToast(`读取素材失败：${err}`);
      setPickerLoading(false);
    });
  }

  function setPickerLoading(loading) {
    if (!view?.picker) return;
    view.picker.loading = loading;
    updatePickerEmpty();
    updatePickerCount();
  }

  function matchesPicker(item) {
    const picker = view.picker;
    if (picker.folder && !Model.samePath(Model.dirName(item.path), picker.folder)) return false;
    if (picker.filter !== "all" && item.kind !== picker.filter) return false;
    if (picker.onlyUnused && picker.used.has(Model.pathKey(item.path))) return false;
    if (picker.query && !Model.sourceMatchesQuery(item, picker.query)) return false;
    return true;
  }

  /* 素材是一个个流进来的，只追加和原地更新，不重绘整个网格：否则正在滑动的格子会闪 */
  function addPickerSource(source) {
    const picker = view.picker;
    if (!picker) return;
    if (source.thumb) sourceThumbs.set(source.path, source.thumb);
    const merged = Model.mergeSource(picker.items.get(source.path), source);
    picker.items.set(source.path, merged);
    const tile = picker.tiles.get(source.path);
    if (tile) {
      // 用户正在这个格子上滑动时不重绘，下次再更新
      if (picker.skimTile !== tile) fillTile(tile, merged);
      return;
    }
    if (!matchesPicker(merged)) return;
    const grid = view.el.querySelector(".vwPickerGrid");
    if (!grid) return;
    appendTile(grid, merged);
    updatePickerEmpty();
    updatePickerCount();
  }

  function appendTile(grid, item) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "vwSource";
    tile.dataset.action = "pick-source";
    tile.dataset.path = item.path;
    fillTile(tile, item);
    view.picker.tiles.set(item.path, tile);
    grid.append(tile);
  }

  function fillTile(tile, item) {
    const picker = view.picker;
    const selected = picker.selectedPath === item.path;
    // 原镜头每次换镜头 / 撤销后由 syncPicker 重算，这里只读缓存，避免每个格子都扫一遍素材清单
    if (picker.original === null) {
      const { shot } = pickerShot();
      picker.original = shot ? pickerOriginal(shot, picker.items) : null;
    }
    const isOriginal = Boolean(picker.original) && Model.isOriginalShotSource(pickerShot().shot, item, { original: picker.original });
    const isVideo = item.kind === "video";
    const durNum = Number(item.dur) || 0;
    const tooShort = isVideo && durNum > 0 && picker.need && durNum < picker.need;
    tile.classList.toggle("vwSourceSelected", selected);
    tile.title = item.notes ? `${item.notes}（${item.name}）` : item.name;
    let badge = "";
    if (isOriginal) badge = '<span class="vwSourceUsed vwSourceOriginal">原镜头</span>';
    else if (picker.used.has(Model.pathKey(item.path))) badge = '<span class="vwSourceUsed">已用</span>';
    tile.innerHTML = `
      <span class="vwSourceThumb">
        ${item.thumb ? `<img src="${esc(assetUrl(item.thumb))}" alt="" loading="lazy" />` : `<span class="vwShotPlaceholder">${shotKindIcon(item.kind)}</span>`}
        <span class="vwSkimFrame" hidden></span>
        <span class="vwSkimLine" hidden></span>
        <span class="vwSkimBadge" hidden></span>
        ${badge}
        ${isVideo && durNum ? `<span class="vwShotDur ${tooShort ? "vwShotDurShort" : ""}">${esc(durNum.toFixed(1))}s${tooShort ? "·略短" : ""}</span>` : ""}
        ${selected && isVideo && typeof picker.selectedIn === "number" ? `<span class="vwSourceIn">从 ${esc(picker.selectedIn.toFixed(1))}s 起</span>` : ""}
      </span>
      <span class="vwSourceName">${esc(item.notes || item.name)}</span>`;
  }

  function renderPickerGrid() {
    const picker = view?.picker;
    const grid = view?.el.querySelector(".vwPickerGrid");
    if (!picker || !grid) return;
    const top = grid.scrollTop;
    grid.innerHTML = "";
    picker.tiles.clear();
    picker.skimTile = null;
    for (const item of picker.items.values()) {
      if (matchesPicker(item)) appendTile(grid, item);
    }
    grid.scrollTop = top;
    updatePickerEmpty();
    updatePickerCount();
  }

  function updatePickerEmpty() {
    const picker = view?.picker;
    const grid = view?.el.querySelector(".vwPickerGrid");
    if (!picker || !grid) return;
    grid.querySelector(".vwPickerEmpty")?.remove();
    if (picker.tiles.size > 0) return;
    const note = document.createElement("p");
    note.className = "vwPickerEmpty vwEmptyLarge";
    note.textContent = picker.loading ? "正在读取素材…" : (picker.folder ? "这里没有符合条件的素材。" : "先选一个文件夹。");
    grid.append(note);
  }

  function skimTile(tile, event) {
    const picker = view.picker;
    const item = picker.items.get(tile.dataset.path);
    if (!item || item.kind !== "video") return;
    const thumb = tile.querySelector(".vwSourceThumb");
    const rect = thumb.getBoundingClientRect();
    const strip = stripCache.get(item.path);
    const info = Model.skimInfo((event.clientX - rect.left) / rect.width, Number(item.dur) || 0, strip?.frames || 1);
    const line = tile.querySelector(".vwSkimLine");
    line.hidden = false;
    line.style.left = `${info.fraction * 100}%`;
    const badge = tile.querySelector(".vwSkimBadge");
    if (badge) {
      const clamped = Model.clampIn(info.time, Number(item.dur) || 0, picker.need);
      badge.textContent = `${clamped.in.toFixed(1)}s 起`;
      badge.hidden = false;
    }
    const frame = tile.querySelector(".vwSkimFrame");
    if (strip) {
      const cover = Model.stripCover({ tile: info.tile, frames: strip.frames, tileW: strip.tileW, tileH: strip.tileH, boxW: rect.width, boxH: rect.height });
      if (frame.dataset.image !== strip.image) {
        frame.dataset.image = strip.image;
        frame.style.backgroundImage = `url("${assetUrl(strip.image)}")`;
      }
      frame.style.backgroundSize = cover.size;
      frame.style.backgroundPosition = cover.position;
      frame.hidden = false;
    }
    tile.dataset.skimTime = String(info.time);
    picker.skimTile = tile;
  }

  function clearSkim(tile) {
    if (!tile) return;
    tile.querySelector(".vwSkimLine")?.setAttribute("hidden", "");
    tile.querySelector(".vwSkimFrame")?.setAttribute("hidden", "");
    tile.querySelector(".vwSkimBadge")?.setAttribute("hidden", "");
    delete tile.dataset.skimTime;
  }

  /* 换镜头、恢复原镜头、Ctrl+Z 撤销后，把面板顶栏按钮和选中格子同步到最新状态 */
  function syncPicker() {
    const picker = view?.picker;
    if (!picker) return;
    const { shot } = pickerShot();
    if (!shot) {
      closePicker();
      return;
    }
    const restoreBtn = view.el.querySelector(".vwPickerRestore");
    if (restoreBtn) restoreBtn.hidden = !shot.replace;

    const prevPath = picker.selectedPath;
    const prevOriginal = picker.original?.path;
    const next = pickerSelectionFor(shot, picker.items);
    picker.selectedPath = next.selectedPath;
    picker.selectedIn = next.selectedIn;
    // 撤掉 / 放回已出片的换镜头会改变「时间表还是不是原样」，原镜头可能跟着变
    picker.original = pickerOriginal(shot, picker.items);

    const paths = new Set([prevPath, next.selectedPath, prevOriginal, picker.original.path].filter(Boolean));
    const prevUsed = picker.used;
    picker.used = Model.usedSourceKeys(view.rows, originalOf);
    for (const path of picker.tiles.keys()) {
      const key = Model.pathKey(path);
      if (prevUsed.has(key) !== picker.used.has(key)) paths.add(path);
    }
    for (const path of paths) {
      const tile = picker.tiles.get(path);
      const item = picker.items.get(path);
      if (!tile || !item) continue;
      if (picker.skimTile !== tile) {
        fillTile(tile, item);
      } else {
        const selected = picker.selectedPath === path;
        tile.classList.toggle("vwSourceSelected", selected);
        let inBadge = tile.querySelector(".vwSourceIn");
        if (selected && item.kind === "video" && typeof picker.selectedIn === "number") {
          if (!inBadge) {
            inBadge = document.createElement("span");
            inBadge.className = "vwSourceIn";
            tile.querySelector(".vwSourceThumb")?.append(inBadge);
          }
          inBadge.textContent = `从 ${picker.selectedIn.toFixed(1)}s 起`;
        } else {
          inBadge?.remove();
        }
      }
    }
    const { row } = pickerShot();
    if (row) {
      for (const tab of view.el.querySelectorAll(".vwPickerShotTab")) {
        const idx = Number(tab.dataset.shot);
        const s = row.shots.find((item) => item.idx === idx);
        tab.classList.toggle("vwPickerShotTabEdited", Boolean(s?.replace));
      }
    }
  }

  function switchPickerShot(shotIdx) {
    const picker = view?.picker;
    if (!picker || picker.shotIdx === shotIdx) return;
    const row = view.rows.find((item) => item.id === picker.beat);
    const shot = row?.shots.find((item) => item.idx === shotIdx);
    if (!shot) return;
    videoEl()?.pause();
    view.stopAt = null;
    if (shot.start !== null) seek(shot.start);
    picker.shotIdx = shotIdx;
    picker.need = Model.shotDuration(shot);
    const synced = pickerSelectionFor(shot, picker.items);
    picker.selectedPath = synced.selectedPath;
    picker.selectedIn = synced.selectedIn;
    picker.original = pickerOriginal(shot, picker.items);
    renderPickerPanel();
  }

  /* 点一下就换上，留在面板里接着比较；不满意再点别的，或者点「恢复原镜头」 */
  async function pickSource(tile) {
    const picker = view.picker;
    const item = picker.items.get(tile.dataset.path);
    const { row, shot } = pickerShot();
    if (!item || !shot || !row) return;
    const isVideo = item.kind === "video";
    const orig = pickerOriginal(shot, picker.items);
    const isOrig = Model.isOriginalShotSource(shot, item, { original: orig });
    const skimmed = tile.dataset.skimTime !== undefined;

    const defaultIn = isOrig && typeof orig.inSec === "number" ? orig.inSec : 0.5;
    const wanted = skimmed ? Number(tile.dataset.skimTime) : defaultIn;
    const clamp = isVideo ? Model.clampIn(wanted, Number(item.dur) || 0, picker.need) : { in: 0, tooShort: false };
    const backToOrig = isOrig && (!skimmed || !isVideo || (typeof orig.inSec === "number" && Math.abs(clamp.in - orig.inSec) < 0.01));

    if (backToOrig) {
      if (shot.replace) await restorePickerShot();
      else playPickerShot();
      return;
    }

    // 上一下还在保存时再点，会基于旧文档再写一遍，撤销历史里多出一条空步骤
    if (picker.busy) return;
    picker.busy = true;
    const edit = Model.makeReplaceShot(shot, { src: item.path, inSec: clamp.in, kind: item.kind });
    const ok = await mutateDoc((doc) => Model.upsertEdit(doc, edit), `换第 ${row.index + 1} 句的镜头`);
    if (view?.picker === picker) picker.busy = false;
    if (!ok || !view?.picker) return;
    if (clamp.tooShort) deps.showToast("这段素材比镜头短，生成时会放慢");
    playPickerShot();
  }

  function playPickerShot() {
    const fresh = pickerShot().shot;
    if (fresh?.start !== null && fresh?.start !== undefined) playInPlace(fresh.start, fresh.end);
  }

  /* 顶栏按钮和点原镜头格子共用；连点只算一次，不然撤销历史里会多出一条空步骤 */
  async function restorePickerShot() {
    const picker = view.picker;
    const { row, shot } = pickerShot();
    if (!picker || !shot?.replace || picker.busy) return;
    const editId = shot.replace.id;
    picker.busy = true;
    const ok = await mutateDoc((doc) => Model.removeEdit(doc, editId), `恢复第 ${(row?.index ?? 0) + 1} 句的原镜头`);
    if (view?.picker === picker) picker.busy = false;
    if (!ok || !view?.picker) return;
    playPickerShot();
  }

  function closePicker() {
    const picker = view.picker;
    if (!picker) return;
    cancelSourceRequest(picker);
    view.picker = null;
    view.tab = "script";
    renderTabs();
    renderPanel(true);
    const rowEl = view.el.querySelector(`.vwRow[data-beat="${CSS.escape(picker.beat)}"]`);
    if (rowEl) scrollRowIntoView(rowEl);
    view.el.focus({ preventScroll: true });
    syncHotspots(videoEl()?.currentTime || 0);
  }

  function submitNoteInput(input) {
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    const beat = input.dataset.noteBeat || null;
    const shot = input.dataset.noteShot ? Number(input.dataset.noteShot) : null;
    const row = view.rows.find((item) => item.id === beat);
    const time = shot !== null ? row?.shots.find((item) => item.idx === shot)?.start ?? null : row?.start ?? null;
    const picker = view.picker;
    const draft = input.value;
    picker?.noteDrafts.delete(shot);
    input.value = "";
    const sendBtn = input.closest(".vwNoteCompose")?.querySelector(".vwNoteSend");
    if (sendBtn) sendBtn.disabled = true;
    void mutateDoc((doc) => Model.addNote(doc, { beat, shot, time, text }), "添加修改意见").then((saved) => {
      if (!picker || view?.picker !== picker) return;
      const onSubmittedShot = picker.shotIdx === shot;
      if (!saved && !picker.noteDrafts.has(shot)) {
        picker.noteDrafts.set(shot, draft);
        if (onSubmittedShot) renderPickerPanel();
      } else if (saved && onSubmittedShot && picker.noteDrafts.size === 0) {
        closePicker();
      }
    });
  }

  function focusNoteWithPrefix(beat, prefixText) {
    const rowEl = showRow(beat);
    const input = rowEl?.querySelector(".vwNoteInput");
    if (!input) return;
    input.value = prefixText;
    const sendBtn = input.closest(".vwNoteCompose")?.querySelector(".vwNoteSend");
    if (sendBtn) sendBtn.disabled = !input.value.trim();
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  }

  /* ── 交互 ───────────────────────────────────────── */
  const actions = {
    "toggle-play"() { togglePlay(); },
    "step-beat"(target) { stepBeat(Number(target.dataset.delta) || 1); },
    "cycle-rate"() {
      view.playbackRate = Model.nextPlaybackRate(view.playbackRate);
      applyPlaybackRate();
    },
    "toggle-mute"() {
      const video = videoEl();
      video.muted = !video.muted;
      setPlayingUi();
    },
    fullscreen() {
      const frame = view.el.querySelector(".vwFrame");
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else frame.requestFullscreen?.().catch(() => {});
    },
    "undo-history"() { void stepHistory("undo"); },
    "redo-history"() { void stepHistory("redo"); },
    "toggle-shortcuts"() {
      setShortcutsOpen(!view.shortcutsOpen);
    },
    tab(target) {
      view.tab = target.dataset.tab;
      view.editing = null;
      renderTabs();
      renderPanel(true);
    },
    "clear-script-query"() {
      view.scriptQuery = "";
      const input = view.el.querySelector('[data-input="script-query"]');
      if (input) input.value = "";
      const clearBtn = view.el.querySelector('[data-action="clear-script-query"]');
      if (clearBtn) clearBtn.hidden = true;
      const list = view.el.querySelector(".vwScript");
      if (list) list.innerHTML = scriptRowsHtml();
      input?.focus();
    },
    "clear-script-filter"() {
      view.scriptQuery = "";
      view.onlyModified = false;
      renderPanel(true);
    },
    "toggle-only-modified"() {
      view.onlyModified = !view.onlyModified;
      renderPanel(true);
    },
    /* 点一句：跳到这里并选中；已经选中时再点文字才是编辑，和 Finder 改名一样 */
    "row-select"(target) {
      const row = view.rows.find((item) => item.id === target.dataset.beat);
      if (!row) return;
      if (row.start !== null) seek(row.start);
      markActiveRow(row.id, true);
    },
    "row-text"(target) {
      const beat = target.dataset.beat;
      const row = view.rows.find((item) => item.id === beat);
      if (!row) return;
      if (view.activeBeat === beat) {
        startEditing(beat);
        return;
      }
      if (row.start !== null) seek(row.start);
      markActiveRow(beat, true);
    },
    "edit-beat"(target) {
      const beat = target.dataset.beat;
      const row = view.rows.find((item) => item.id === beat);
      if (!row || row.deleted) return;
      if (row.start !== null) seek(row.start);
      markActiveRow(beat, true);
      startEditing(beat);
    },
    "toggle-compare"() {
      if (view.cleanError) {
        view.cleanError = false;
        ensureCleanPreview();
        updatePlayback();
        return;
      }
      view.compareOriginal = !view.compareOriginal;
      syncVideoSource();
      updatePlayback();
    },
    "edit-hook"() { openHookEditor(); },
    "edit-text-card"(target) { openTextCardEditor(target.dataset.beat, Number(target.dataset.idx)); },
    "save-card-edit"() { void saveCardEdit(); },
    "cancel-card-edit"() { cancelCardEdit(); },
    "delete-editing-card"() { void deleteEditingCard(); },
    "ask-card-ai"() {
      const ec = view.editingCard;
      if (!ec || ec.isHook) return;
      const beat = ec.beat;
      const text = ec.draftText || "";
      cancelCardEdit();
      focusNoteWithPrefix(beat, `字卡「${text}」：`);
    },
    "cancel-edit"() {
      view.editing = null;
      syncVideoSource();
      renderPanel(true);
      syncLiveLayer(videoEl()?.currentTime || 0);
    },
    "commit-edit"() {
      void commitEditing();
    },
    "submit-note"(target) {
      const input = target.closest(".vwNoteCompose")?.querySelector(".vwNoteInput");
      submitNoteInput(input);
    },
    "row-text-card"(target) {
      focusNoteWithPrefix(target.dataset.beat, `字卡「${target.dataset.text}」：`);
    },
    "jump-row"(target) {
      const row = view.rows.find((item) => item.id === target.dataset.beat);
      if (!row) return;
      view.tab = "script";
      view.scriptQuery = "";
      view.onlyModified = false;
      renderTabs();
      renderPanel(true);
      if (row.start !== null) seek(row.start);
      markActiveRow(row.id, true);
      const rowEl = view.el.querySelector(`.vwRow[data-beat="${CSS.escape(row.id)}"]`);
      if (rowEl) scrollRowIntoView(rowEl, "smooth");
    },
    "show-tts"() {
      const field = view.el.querySelector('[data-editor="say"]');
      view.editing.draft = field?.value;
      view.editing.showTts = true;
      renderPanel(true);
      view.el.querySelector('[data-editor="tts"]')?.focus();
    },
    async "remove-note"(target) {
      await mutateDoc((doc) => Model.removeNote(doc, target.dataset.id), "删除意见");
    },
    async unrevert(target) {
      const edit = view.doc.removedEdits.find((item) => item.id === target.dataset.id);
      if (edit) await mutateDoc((doc) => Model.restoreEdit(doc, edit), "撤销恢复");
    },
    async "undo-edit"(target) {
      if (view.editingCard?.editId === target.dataset.id) view.editingCard = null;
      await mutateDoc((doc) => Model.removeEdit(doc, target.dataset.id), "撤销改动");
    },
    async "keep-mine"(target) {
      const conflict = view.data.editsStatus?.conflicts?.find((item) => item.id === target.dataset.id);
      if (!conflict?.current) return;
      await mutateDoc((doc) => {
        const next = Model.normalizeDoc(doc);
        const now = Math.floor(Date.now() / 1000);
        next.edits = next.edits.map((edit) => (edit.id === target.dataset.id ? { ...edit, base: conflict.current, createdAt: now } : edit));
        return next;
      }, "用我的版本");
    },
    async "delete-beat"(target) {
      const row = view.rows.find((item) => item.id === target.dataset.beat);
      if (!row) return;
      if (view.rows.filter((item) => !item.deleted).length <= 1) {
        deps.showToast("至少要留一句");
        return;
      }
      await mutateDoc((doc) => Model.upsertEdit(doc, Model.makeDeleteBeat(row)), `删除第 ${row.index + 1} 句`);
    },
    async speed(target) {
      const voice = view.data.edl.voice || {};
      const existing = view.doc.edits.find((edit) => edit.op === "set_voice");
      const current = Number(existing?.value?.speed ?? voice.speed ?? 1);
      const next = Math.round(Math.min(2, Math.max(0.5, current + Number(target.dataset.delta))) * 100) / 100;
      await mutateDoc((doc) => {
        if (next === Number(voice.speed ?? 1)) return existing ? Model.removeEdit(doc, existing.id) : doc;
        return Model.upsertEdit(doc, Model.makeVoiceEdit(view.data.edl, { speed: next }));
      }, "改语速");
    },
    async "music-gain"(target) {
      const music = view.data.edl?.music;
      if ((!music && !view.plan?.music) || music === "none") return;
      if (view.cleanMedia?.music || view.cleanRequest || currentVersion()?.hasCleanBase) unlockMusicPreview();
      const baseGain = typeof music === "object" && typeof music.gain_db === "number" ? music.gain_db : 0;
      const existing = view.doc.edits.find((edit) => edit.op === "set_music");
      const current = Number(existing?.value?.gain_db ?? baseGain);
      const next = Math.round(Math.min(12, Math.max(-30, current + Number(target.dataset.delta))) * 10) / 10;
      await mutateDoc((doc) => {
        if (next === baseGain) return existing ? Model.removeEdit(doc, existing.id) : doc;
        return Model.upsertEdit(doc, Model.makeSetMusic(view.data.edl, next));
      }, "调配乐音量");
    },
    "close-voice"() {
      closeVoiceSample();
      renderPanel();
    },
    async "voice-sample"(target) {
      const current = view;
      if (current.voiceRequest) return;
      closeVoiceSample();
      const request = { beat: target.dataset.beat, token: String(++jobRequestSequence), revision: current.doc.revision };
      current.voiceRequest = request;
      renderPanel();
      try {
        await deps.invoke("video_start_job", {
          path: current.projectPath, kind: "voice_sample",
          args: { beat: request.beat, requestId: request.token },
        });
      } catch (error) {
        if (view !== current || current.voiceRequest !== request) return;
        current.voiceRequest = null;
        deps.showToast(`试听没生成出来：${error}`);
        renderPanel();
      }
    },
    async sample(target) {
      const current = view;
      const beat = target.dataset.beat;
      if (current.sampleBusy.has(beat)) return;
      const requestId = String(++jobRequestSequence);
      current.sampleBusy.add(beat);
      current.sampleRequests.set(requestId, beat);
      target.disabled = true;
      target.innerHTML = `${ICONS.playSmall}<span>生成试看中…</span>`;
      try {
        await deps.invoke("video_start_job", { path: current.projectPath, kind: "sample", args: { beat, requestId } });
      } catch (err) {
        if (view !== current || !current.sampleRequests.delete(requestId)) return;
        current.sampleBusy.delete(beat);
        deps.showToast(String(err).includes("JOB_BUSY") ? "这一句正在生成" : `试看没生成出来：${err}`);
        renderPanel();
      }
    },
    "back-to-version"() { backToVersion(); },
    apply() { void applyChanges(); },
    async "cancel-render"() {
      const current = view;
      const jobId = current.renderJobId;
      if (!jobId) return;
      const ok = await deps.confirm("确定取消吗？已经处理好的镜头有缓存，下次不用重来。", { confirmLabel: "取消生成", danger: false });
      if (!ok || view !== current || current.renderJobId !== jobId) return;
      deps.invoke("video_cancel_job", { jobId }).catch((err) => deps.showToast(`取消失败：${err}`));
    },
    continue(target) {
      const text = `继续完成这条视频（工程：${view.projectPath}），现在停在「${target.dataset.step}」这一步。`;
      if (!deps.sendToAgent(text)) deps.showToast("发送失败：Fellow 还没连上，稍后再试");
    },
    ask(target) {
      const text = `${target.dataset.text}（工程：${view.projectPath}）`;
      if (!deps.sendToAgent(text)) deps.showToast("发送失败：Fellow 还没连上，稍后再试");
    },
    "switch-latest"() {
      view.versionName = view.pendingLatest;
      view.pendingLatest = null;
      view.followLatest = true;
      void switchVersion(view.versionName);
    },
    "open-cover"(target) {
      const prefix = view.projectPath ? `${view.projectPath}/` : "";
      deps.openNote(`${prefix}out/${target.dataset.name}`);
    },
    "open-doc"(target) { deps.openNote(target.dataset.path); },
    async "copy-text"(target) {
      const holder = target.closest(".vwCopyable");
      if (!holder) return;
      const clone = holder.cloneNode(true);
      clone.querySelector(".vwCopy")?.remove();
      const ok = await writeClipboard(Model.cleanCopyText(clone.textContent));
      if (!ok) {
        deps.showToast("复制失败");
        return;
      }
      target.textContent = "已复制";
      target.classList.add("vwCopied");
      setTimeout(() => {
        target.textContent = "复制";
        target.classList.remove("vwCopied");
      }, 1200);
    },
    async "copy-platform"(target) {
      const section = target.closest(".vwPlatform");
      if (!section) return;
      const clone = section.cloneNode(true);
      clone.querySelectorAll(".vwCopy, .vwCopyAll").forEach((btn) => btn.remove());
      const lines = [...clone.querySelectorAll("li, pre")].map((el) => Model.cleanCopyText(el.textContent)).filter(Boolean);
      const text = lines.length ? lines.join("\n\n") : Model.cleanCopyText(clone.textContent);
      const ok = await writeClipboard(text);
      if (!ok) {
        deps.showToast("复制失败");
        return;
      }
      target.textContent = "已复制";
      target.classList.add("vwCopied");
      setTimeout(() => {
        target.textContent = "复制整块";
        target.classList.remove("vwCopied");
      }, 1200);
    },
    "open-picker"(target) { void openPicker(target.dataset.beat, Number(target.dataset.shot)); },
    "switch-picker-shot"(target) { switchPickerShot(Number(target.dataset.shot)); },
    "clear-picker-query"() {
      if (!view?.picker) return;
      view.picker.query = "";
      const input = view.el.querySelector('[data-input="picker-query"]');
      if (input) input.value = "";
      const clearBtn = view.el.querySelector('[data-action="clear-picker-query"]');
      if (clearBtn) clearBtn.hidden = true;
      renderPickerGrid();
      input?.focus();
    },
    "frame-caption"(target) {
      showRow(target.dataset.beat);
      startEditing(target.dataset.beat);
    },
    "frame-text"(target) {
      focusNoteWithPrefix(target.dataset.beat, `字卡「${target.dataset.text}」：`);
    },
    "frame-shot"(target) { void openPicker(target.dataset.beat, Number(target.dataset.shot)); },
    "undo-last"() {
      hideUndo();
      void stepHistory("undo");
    },
    "close-picker"() { closePicker(); },
    "restore-shot"() { void restorePickerShot(); },
    "pick-filter"(target) {
      view.picker.filter = target.dataset.filter;
      renderPickerControls();
      renderPickerGrid();
    },
    "pick-source"(target) { void pickSource(target); },
    async "pick-other"(target) {
      try {
        const res = await deps.invoke("video_pick_source", { path: view.projectPath, mode: target.dataset.mode });
        if (!res || !view?.picker) return;
        const folder = res.isFolder ? res.abs : Model.dirName(res.abs);
        if (!view.picker.folders.some((item) => item.abs === folder)) {
          view.picker.folders.push({ abs: folder, label: Model.baseName(folder), exists: true });
        }
        selectFolder(folder);
      } catch (err) {
        deps.showToast(`选择素材失败：${err}`);
      }
    },
  };

  async function switchVersion(name) {
    const current = view;
    const data = current.data;
    resetPreviewMedia();
    await loadPlanFor(name);
    if (view !== current || view.data !== data || view.versionName !== name) return;
    rebuildRows();
    loadCurrentVersion();
    renderAll();
    ensureShotThumbs();
    ensureCleanPreview();
  }

  function wireView() {
    const el = view.el;
    el.addEventListener("click", (event) => {
      if (view.shortcutsOpen && !event.target.closest?.(".vwShortcutWrap")) {
        setShortcutsOpen(false);
      }
      // 从最里层往外找第一个有动作的元素，行里的按钮不会触发选中整行
      const target = event.target.closest("[data-action]");
      if (!target || !el.contains(target) || target.disabled) return;
      actions[target.dataset.action]?.(target, event);
    });
    // 双击脚本文字直接进入编辑，不用先选中再点
    el.addEventListener("dblclick", (event) => {
      const sayEl = event.target.closest?.('.vwSay[data-beat]');
      if (!sayEl) return;
      const beat = sayEl.dataset.beat;
      const row = view.rows.find((item) => item.id === beat);
      if (!row || row.deleted) return;
      if (row.start !== null) seek(row.start);
      markActiveRow(beat, true);
      startEditing(beat);
    });
    // 点取消/保存按钮时阻断 mousedown 抢焦点导致 focusout 误保存
    el.addEventListener("mousedown", (event) => {
      const btn = event.target.closest?.('[data-action="cancel-edit"], [data-action="commit-edit"]');
      if (btn) event.preventDefault();
    });
    el.addEventListener("change", (event) => {
      const kind = event.target.dataset?.change;
      if (kind === "version") {
        const name = event.target.value;
        view.followLatest = name === view.data.latest;
        view.versionName = name;
        view.pendingLatest = null;
        void switchVersion(name);
      } else if (kind === "picker-folder") {
        selectFolder(event.target.value);
      } else if (kind === "picker-unused") {
        view.picker.onlyUnused = event.target.checked;
        renderPickerGrid();
      } else if (event.target.dataset?.cardField === "pos" && view.editingCard) {
        view.editingCard.draftPos = event.target.value === "custom" ? view.editingCard.originalPos : event.target.value;
        syncLiveLayer(videoEl()?.currentTime || 0);
      }
    });
    el.addEventListener("input", (event) => {
      const target = event.target;
      if (target.dataset?.cardField && view.editingCard) {
        const field = target.dataset.cardField;
        if (field === "text") view.editingCard.draftText = target.value;
        else if (field === "sub") view.editingCard.draftSub = target.value;
        else if (field === "badge") view.editingCard.draftBadge = target.value;
        syncLiveLayer(videoEl()?.currentTime || 0);
      } else if (target.classList?.contains("vwSayEditor")) {
        autoGrow(target);
        const countEl = target.closest("[data-editor-box]")?.querySelector(".vwEditorCount");
        if (countEl) countEl.textContent = editorCharHint(target.value, target.dataset.originalSay || "");
        if (view.editing) {
          view.editing.draft = target.value;
          syncLiveLayer(videoEl()?.currentTime || 0);
        }
      } else if (target.classList?.contains("vwNoteInput")) {
        const sendBtn = target.closest(".vwNoteCompose")?.querySelector(".vwNoteSend");
        if (sendBtn) sendBtn.disabled = !target.value.trim();
        if (view.picker) {
          const { noteDrafts, shotIdx } = view.picker;
          if (target.value) noteDrafts.set(shotIdx, target.value);
          else noteDrafts.delete(shotIdx);
        }
      } else if (target.dataset?.input === "script-query") {
        view.scriptQuery = target.value;
        const clearBtn = el.querySelector('[data-action="clear-script-query"]');
        if (clearBtn) clearBtn.hidden = !view.scriptQuery;
        const list = el.querySelector(".vwScript");
        if (list) list.innerHTML = scriptRowsHtml();
      } else if (target.dataset?.input === "picker-query" && view.picker) {
        view.picker.query = target.value;
        const clearBtn = el.querySelector('[data-action="clear-picker-query"]');
        if (clearBtn) clearBtn.hidden = !view.picker.query;
        renderPickerGrid();
      }
    });
    // 点到编辑框外面就保存，和 Apple 备忘录一样不用找保存按钮
    el.addEventListener("focusout", (event) => {
      // 重绘时输入框被移除也会触发 focusout，那不是用户点到了外面，不能当成保存
      if (!view?.editing || view.rerendering) return;
      const box = event.target.closest?.("[data-editor-box]");
      if (!box || box.contains(event.relatedTarget)) return;
      void commitEditing();
    });
    el.addEventListener("focusin", (event) => {
      if (event.target.classList?.contains("vwNoteInput")) videoEl()?.pause();
    });
    el.addEventListener("keydown", handleFieldKey);
    el.addEventListener("pointermove", (event) => {
      if (!view?.picker) return;
      const tile = event.target.closest?.(".vwSource");
      if (view.picker.skimTile && view.picker.skimTile !== tile) {
        clearSkim(view.picker.skimTile);
        view.picker.skimTile = null;
      }
      if (tile) skimTile(tile, event);
    });
    el.querySelector(".vwPanelBody").addEventListener("wheel", () => { if (view) view.lastUserScroll = Date.now(); }, { passive: true });
    wireStrip(el.querySelector(".vwStrip"));

    const video = el.querySelector(".vwVideo");
    video.addEventListener("click", togglePlay);
    video.addEventListener("play", () => {
      cancelAnimationFrame(view.rafId);
      view.rafId = requestAnimationFrame(tick);
      setPlayingUi();
    });
    video.addEventListener("pause", () => {
      if (!view) return;
      setPlayingUi();
      updatePlayback();
      if (view.pendingLatest) renderStatus();
    });
    video.addEventListener("ended", () => {
      if (!view) return;
      setPlayingUi();
      // 试看放完自动回到成片，并停在这一句
      if (view.playingSample) backToVersion(view.playingSample.start);
    });
    video.addEventListener("timeupdate", updateClock);
    video.addEventListener("seeked", () => {
      if (!view) return;
      if (view.pendingSeek !== null) {
        const next = view.pendingSeek;
        view.pendingSeek = null;
        view.lastSeekAt = Date.now();
        video.currentTime = Math.max(0, next);
      }
      updatePlayback();
    });
    video.addEventListener("volumechange", setPlayingUi);
    video.addEventListener("play", () => {
      el.querySelector(".vwVoiceSample audio").pause();
    });
    video.addEventListener("loadedmetadata", () => {
      if (!view) return;
      applyPlaybackRate();
      updateClock();
      if (view.playingSample) return;
      const planDuration = view.plan?.duration;
      view.durationMismatch = Boolean(planDuration && Math.abs(video.duration - planDuration) > 0.5);
    });
    video.addEventListener("error", () => {
      if (!view || !video.getAttribute("src")) return;
      if (view.usingCleanVideo) {
        finishCleanRequest(null);
        return;
      }
      const empty = el.querySelector(".vwPlayerEmpty");
      empty.hidden = false;
      empty.textContent = "这个版本放不了，文件可能已被清理或还在写入。";
      video.hidden = true;
    });
    // 暂停时跳到换过的镜头：盖层素材这时才开始加载，加载好 / 跳到位以后要再同步一次才会显示出来
    for (const type of ["loadeddata", "seeked"]) {
      el.querySelector(".vwPreviewVideo").addEventListener(type, () => {
        if (!view || view.playingSample) return;
        const main = videoEl();
        if (main?.paused) syncPreview(main.currentTime || 0);
      });
    }
    for (const selector of [".vwPreviewVideo", ".vwPreviewImage"]) {
      el.querySelector(selector).addEventListener("error", (event) => {
        if (!view) return;
        const src = event.target.dataset.src;
        if (src) view.overlayBroken.add(src);
        hidePreview();
      });
    }

    const frameObserver = new ResizeObserver(() => { if (view?.data) fitFrame(); });
    frameObserver.observe(el.querySelector(".vwPlayerBox"));
    view.observers.push(frameObserver);

    view.onDocKey = handleDocKey;
    document.addEventListener("keydown", view.onDocKey);
    el.focus({ preventScroll: true });
  }

  /* 输入框里的按键 */
  function handleFieldKey(event) {
    const target = event.target;
    if (target.classList?.contains("vwNoteInput") && event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      submitNoteInput(target);
      return;
    }
    if (target.dataset?.cardField && !event.isComposing) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelCardEdit();
        return;
      }
      if (event.key === "Enter" && target.tagName === "INPUT") {
        event.preventDefault();
        void saveCardEdit();
        return;
      }
    }
    if (target.dataset?.editor && !event.isComposing) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        view.editing = null;
        syncVideoSource();
        renderPanel(true);
        syncLiveLayer(videoEl()?.currentTime || 0);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void commitEditing();
      }
    }
  }

  /* 全局快捷键：焦点不在工作台里也能用，但不抢别的输入框和弹窗 */
  function handleDocKey(event) {
    if (!view) return;
    const target = event.target;
    if (!(target === document.body || view.el.contains(target))) return;
    if (document.getElementById("dialog-overlay")?.hidden === false) return;
    const typing = target.matches?.("input, textarea, select, [contenteditable='true']");
    const mod = event.ctrlKey || event.metaKey;

    if (mod && !typing && !event.altKey && (event.key === "z" || event.key === "Z" || event.key === "y")) {
      event.preventDefault();
      const redo = event.key === "y" || event.shiftKey;
      void stepHistory(redo ? "redo" : "undo");
      return;
    }
    if (event.key === "Escape" && view.shortcutsOpen) {
      event.stopPropagation();
      setShortcutsOpen(false);
      return;
    }
    if (event.key === "Escape" && view.editingCard) {
      event.stopPropagation();
      cancelCardEdit();
      return;
    }
    if (event.key === "Escape" && view.picker) {
      event.stopPropagation();
      closePicker();
      return;
    }
    if (typing || mod || event.altKey) return;
    const interactive = target.matches?.("button, a");
    if (event.key === " " && !interactive) {
      event.preventDefault();
      togglePlay();
      return;
    }
    // 精细跳转：Shift+←/→ 一秒，逗号 / 句号一帧（逐帧时先暂停，看接缝用）
    const step = event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")
      ? (event.key === "ArrowLeft" ? -1 : 1)
      : (event.key === "," || event.key === "." ? (event.key === "," ? -1 : 1) / (view.plan?.fps || 30) : 0);
    if (step && !view.picker) {
      const video = videoEl();
      if (!video?.getAttribute("src")) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.shiftKey) video.pause();
      const end = Number.isFinite(video.duration) ? video.duration : (view.plan?.duration || 0);
      seekQuick(Math.min(Math.max(0, (video.currentTime || 0) + step), Math.max(0, end - 0.01)));
      return;
    }
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !view.picker) {
      event.preventDefault();
      event.stopPropagation();
      stepBeat(event.key === "ArrowLeft" ? -1 : 1);
    }
  }

  root.InkfellowVideoWorkbench = {
    EXTENSION,
    init,
    mount,
    leave,
    isProjectTab,
    isProject,
    listProjects,
    projectOfTab,
    tabForProject,
    tabLabel,
    makeNote,
    loadProjects,
    onAgentState,
  };
})(globalThis);

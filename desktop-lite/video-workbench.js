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

  const svg = (body) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICONS = {
    play: `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.5 2.8v10.4a.6.6 0 0 0 .92.5l8.1-5.2a.6.6 0 0 0 0-1l-8.1-5.2a.6.6 0 0 0-.92.5z"/></svg>`,
    pause: `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3.5" y="2.5" width="3.2" height="11" rx="0.8"/><rect x="9.3" y="2.5" width="3.2" height="11" rx="0.8"/></svg>`,
    sound: svg('<path d="M3 6v4h2.5L9 13V3L5.5 6H3z"/><path d="M11.5 5.8a3 3 0 0 1 0 4.4"/>'),
    mute: svg('<path d="M3 6v4h2.5L9 13V3L5.5 6H3z"/><path d="M11.5 6.2l3 3.6M14.5 6.2l-3 3.6"/>'),
    fullscreen: svg('<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>'),
    video: svg('<rect x="2" y="3.5" width="12" height="9" rx="1.6"/><path d="M6.8 6.2l3.2 1.8-3.2 1.8V6.2z"/>'),
    photo: svg('<rect x="2" y="3" width="12" height="10" rx="1.6"/><circle cx="5.7" cy="6.5" r="1"/><path d="M2.6 11.6l3.2-3.2 2.6 2.6 2-2 3 3"/>'),
    scene: svg('<path d="M8 2.2l1.7 3.7 4 .5-3 2.7.9 4L8 11.1l-3.6 2 .9-4-3-2.7 4-.5z"/>'),
    warn: svg('<path d="M8 2.2l6.3 11.3H1.7z"/><path d="M8 6.4v3.2M8 11.6v.1"/>'),
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
    return mtime ? `${url}${url.includes("?") ? "&" : "?"}v=${Math.floor(mtime)}` : url;
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
      plan: null,
      planSource: "none",
      versionName: null,
      followLatest: true,
      pendingLatest: null,
      tab: "script",
      thumbs: new Map(),
      thumbsRequested: new Set(),
      editing: null,
      playingSample: null,
      stopAt: null,
      skim: null,
      dragging: false,
      pendingSeek: null,
      sampleBusy: new Set(),
      sampleJobs: new Map(),
      renderBusy: false,
      renderQa: false,
      renderJobId: null,
      renderError: null,
      picker: null,
      pendingSend: false,
      env: null,
      durationMismatch: false,
      panelDirty: false,
      lastUserScroll: 0,
      activeBeat: null,
      rafId: 0,
      refreshTimer: null,
      refreshQueued: false,
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
    if (current.picker?.jobId) deps.invoke("video_cancel_job", { jobId: current.picker.jobId }).catch(() => {});
    view = null;
    cancelAnimationFrame(current.rafId);
    clearTimeout(current.refreshTimer);
    clearTimeout(current.statusTimer);
    document.removeEventListener("keydown", current.onDocKey);
    for (const observer of current.observers) observer.disconnect();
    for (const video of current.el.querySelectorAll("video")) {
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
    try {
      const data = await deps.invoke("video_read_project", { path: current.projectPath });
      if (view !== current) return;
      await applyData(data);
    } catch (err) {
      if (view !== current) return;
      if (!view.data) renderFatal(err);
      else console.warn("video_read_project failed", err);
    }
  }

  async function applyData(data) {
    const previousLatest = view.data?.latest ?? null;
    view.data = data;
    const title = data.edl?.project;
    if (title && projectTitles.get(view.projectPath) !== title) {
      projectTitles.set(view.projectPath, title);
      deps.onProjectsChanged?.();
    }
    view.doc = Model.normalizeDoc(data.edits);
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

    await loadPlanFor(target);
    if (!view) return;
    rebuildRows();
    if (switched || !videoEl()?.getAttribute("src")) loadCurrentVersion();
    renderAll();
    ensureShotThumbs();
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
      if (view !== current) return;
      view.plan = res.plan;
      view.planSource = res.planSource;
    } catch {
      view.plan = data.plan;
      view.planSource = "latest";
    }
  }

  function rebuildRows() {
    view.rows = Model.buildRows({ edl: view.data.edl, plan: view.plan, edits: view.doc });
  }

  function currentVersion() {
    return view.data?.versions.find((item) => item.name === view.versionName) || null;
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
                <div class="vwPreviewCaption" hidden></div>
                <span class="vwPreviewTag" hidden>预览</span>
                <button type="button" class="vwBigPlay" data-action="toggle-play" aria-label="播放" tabindex="-1">${ICONS.play}</button>
                <div class="vwPlayerEmpty" hidden></div>
              </div>
            </div>
            <div class="vwControls">
              <button type="button" class="vwIconBtn vwPlayBtn" data-action="toggle-play" aria-label="播放">${ICONS.play}</button>
              <span class="vwClock">00:00 / 00:00</span>
              <span class="vwSampleTag" hidden></span>
              <span class="vwControlsSpacer"></span>
              <button type="button" class="vwIconBtn vwMuteBtn" data-action="toggle-mute" aria-label="静音">${ICONS.sound}</button>
              <button type="button" class="vwIconBtn" data-action="fullscreen" aria-label="全屏">${ICONS.fullscreen}</button>
            </div>
          </section>
          <section class="vwPanel" aria-label="脚本与修改">
            <div class="vwTabs" role="tablist"></div>
            <div class="vwPanelBody" tabindex="-1"></div>
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
    const list = view.data?.editsStatus?.conflicts;
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

  function renderHead() {
    const data = view.data;
    const plan = view.plan;
    const title = data.edl?.project || data.name;
    const versions = data.versions.filter((item) => item.kind !== "other" || item.name === view.versionName);
    const options = versions.map((item) => {
      const label = item.name === data.latest ? `${versionLabel(item.name)}（最新）` : versionLabel(item.name);
      return `<option value="${esc(item.name)}" ${item.name === view.versionName ? "selected" : ""}>${esc(label)}</option>`;
    }).join("");
    const edits = pendingEdits().length;
    const notes = unsentNotes().length;
    const total = edits + notes;
    const route = Model.routeApply({ editCount: edits, noteCount: notes });
    const blocked = route === "render" && !view.env?.ok;
    let button = "";
    if (view.pendingSend) {
      button = `<button type="button" class="vwBtn" data-action="apply">等 AI 忙完再发（点击取消）</button>`;
    } else if (aiIsHandlingNotes() && notes === 0) {
      // AI 处理期间又写了新意见时，按钮要还能点（会排到这轮之后），不能把新意见卡住
      button = `<button type="button" class="vwBtn" disabled>AI 正在处理…</button>`;
    } else if (total > 0) {
      const hint = route === "ai"
        ? "你写的意见会交给 AI，它改好后生成新版本"
        : "按你的改动直接生成新版本，不经过 AI，不花模型额度";
      button = `<button type="button" class="vwBtn vwBtnPrimary" data-action="apply" ${isRendering() || blocked ? "disabled" : ""}
        title="${esc(blocked ? (view.env?.message || "找不到剪辑引擎") : hint)}">应用修改（${total}）</button>`;
    }
    view.el.querySelector(".vwHead").innerHTML = `
      <div class="vwHeadMain">
        <h2 class="vwTitle" title="${esc(data.path)}">${esc(title)}</h2>
        ${versions.length > 1
          ? `<select class="vwVersion" data-change="version" aria-label="选择版本">${options}</select>`
          : (versions.length === 1 ? `<span class="vwMeta">${esc(versionLabel(versions[0].name))}</span>` : "")}
        ${plan?.duration ? `<span class="vwMeta">${esc(Model.humanDuration(plan.duration))}</span>` : ""}
      </div>
      <div class="vwHeadActions">${button}</div>`;
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
    const count = pendingEdits().length + unsentNotes().length + conflicts;
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
    const typing = body.contains(document.activeElement) && document.activeElement.matches("input, textarea");
    if (!force && (view.editing || typing)) {
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
    return view.thumbs.get(`${view.versionName}#${shot.planIndex}`) || null;
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

  function scriptHtml() {
    if (view.rows.length === 0) return `<p class="vwEmpty">这条视频还没有内容。</p>`;
    return `<div class="vwScript">${view.rows.map(rowHtml).join("")}</div>`;
  }

  function rowHtml(row) {
    const editing = view.editing?.beat === row.id ? view.editing : null;
    const sampleBusy = view.sampleBusy.has(row.id);
    const deleteEdit = view.doc.edits.find((edit) => edit.op === "delete_beat" && edit.beat === row.id);
    const classes = ["vwRow"];
    if (row.deleted) classes.push("vwRowDeleted");
    if (row.id === view.activeBeat) classes.push("vwRowActive");
    if (row.setSay || row.setTts) classes.push("vwRowChanged");
    const missing = view.data.missingSources || [];

    // 删掉的句子只留文字和「恢复」：成片里已经没有它的画面，换镜头也没有意义
    const shots = row.deleted ? "" : row.shots.map((shot) => {
      const duration = Model.shotDuration(shot);
      const lost = Model.isMissingSource(shot.path, missing) && !shot.replace;
      return `<button type="button" class="vwShot ${shot.replace ? "vwShotChanged" : ""} ${lost ? "vwShotLost" : ""}"
          data-action="open-picker" data-beat="${esc(row.id)}" data-shot="${shot.idx}"
          aria-label="换这个镜头：${esc(shot.name)}" title="${esc(lost ? `素材读不到：${shot.path}` : `${shot.name}，点击换一个`)}">
          ${shotThumbHtml(shot)}
          ${duration !== null ? `<span class="vwShotDur">${duration.toFixed(1)}</span>` : ""}
          ${lost ? `<span class="vwShotBadge">${ICONS.warn}</span>` : ""}
        </button>`;
    }).join("");

    const say = editing
      ? sayEditorHtml(row, editing)
      : `<p class="vwSay" data-action="row-text" data-beat="${esc(row.id)}">${esc(row.say) || '<span class="vwMuted">（这一段没有口播）</span>'}</p>`;

    const notes = [
      ...row.notes.map((note) => noteHtml(note, "")),
      ...row.shots.flatMap((shot) => shot.notes.map((note) => noteHtml(note, `第 ${shot.idx + 1} 个镜头`))),
    ].join("");

    return `
      <article class="${classes.join(" ")}" data-beat="${esc(row.id)}" data-action="row-select">
        <span class="vwRowTime">${esc(row.start === null ? "" : Model.fmtTime(row.start))}</span>
        <div class="vwRowBody">
          ${say}
          ${row.setSay && !editing ? `<p class="vwWas">原文：${esc(row.originalSay)}</p>` : ""}
          ${row.deleted && deleteEdit ? `<p class="vwWas">${isEditRendered(deleteEdit) ? "这句已经删掉了" : "这句会被删掉"} <button type="button" class="vwLink" data-action="undo-edit" data-id="${esc(deleteEdit.id)}">恢复</button></p>` : ""}
          ${row.deleted ? "" : `<div class="vwShots">${shots}</div>`}
          ${row.texts.length && !row.deleted ? `<p class="vwTexts">${esc(row.texts.map((text) => text.text).join(" · "))}</p>` : ""}
          ${notes}
          ${row.deleted ? "" : `
          <div class="vwRowBar">
            <input type="text" class="vwNoteInput" data-note-beat="${esc(row.id)}" placeholder="告诉 AI 这句哪里不好，回车加入" aria-label="告诉 AI 这句哪里不好" />
            <button type="button" class="vwBarBtn" data-action="sample" data-beat="${esc(row.id)}" ${sampleBusy || !view.env?.ok ? "disabled" : ""}>${sampleBusy ? "生成中…" : "试看这句"}</button>
            <button type="button" class="vwBarBtn" data-action="delete-beat" data-beat="${esc(row.id)}">删除这句</button>
          </div>`}
        </div>
      </article>`;
  }

  function sayEditorHtml(row, editing) {
    return `
      <div class="vwEditor" data-editor-box>
        <textarea class="vwSayEditor" rows="2" aria-label="口播文字" data-editor="say">${esc(editing.draft ?? row.say)}</textarea>
        ${editing.showTts
          ? `<label class="vwTtsField">配音读作（字幕不变）<input type="text" class="vwInput" data-editor="tts" value="${esc(editing.ttsDraft ?? row.sayTts)}" placeholder="把难读的词换成同音字" /></label>`
          : `<button type="button" class="vwLink" data-action="show-tts">有字读错了？</button>`}
        <span class="vwHint">回车保存，Esc 取消</span>
      </div>`;
  }

  function noteHtml(note, prefix) {
    return `<p class="vwNote ${note.sentAt ? "vwNoteSent" : ""}">
      <span class="vwNoteTag">${note.sentAt ? "已告诉 AI" : "告诉 AI"}</span>${prefix ? `${esc(prefix)}：` : ""}${esc(note.text)}
      ${note.sentAt ? "" : `<button type="button" class="vwLink" data-action="remove-note" data-id="${esc(note.id)}">删除</button>`}
    </p>`;
  }

  /* ── 待处理 ─────────────────────────────────────── */
  function describeCurrent(current) {
    if (typeof current.say === "string") return current.say;
    if (typeof current.say_tts === "string") return `读作 ${current.say_tts}`;
    if (current.scene) return `动画 ${current.scene}`;
    if (current.src) return `${Model.baseName(current.src)}${typeof current.in === "number" ? `（${current.in} 秒起）` : ""}`;
    if (current.speed !== undefined) return `语速 ${current.speed} 倍`;
    if (current.rate !== undefined) return `语速 ${current.rate}`;
    return "";
  }

  function changesHtml() {
    const status = view.data.editsStatus;
    const edits = view.doc.edits;
    const conflicts = conflictIds();
    const conflicted = edits.filter((edit) => conflicts.has(edit.id));
    const pending = pendingEdits();
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
    const nothing = conflicted.length + notes.length + pending.length === 0;

    return `
      <div class="vwChanges">
        ${conflicted.length ? `
          <section class="vwChangeGroup">
            <h3>需要你决定</h3>
            <ul class="vwChangeList">${conflicted.map(editRow).join("")}</ul>
          </section>` : ""}
        ${notes.length ? `
          <section class="vwChangeGroup">
            <h3>告诉 AI 的</h3>
            <ul class="vwChangeList">${notes.map(noteRow).join("")}</ul>
          </section>` : ""}
        ${pending.length ? `
          <section class="vwChangeGroup">
            <h3>你改的</h3>
            <ul class="vwChangeList">${pending.map(editRow).join("")}</ul>
          </section>` : ""}
        ${nothing ? `<p class="vwEmptyLarge">没有待处理的修改。在脚本里点一句话就能改字，点缩略图就能换镜头。</p>` : ""}
        <section class="vwChangeGroup">
          <input type="text" class="vwNoteInput vwNoteGlobal" data-note-beat="" placeholder="对整条视频有想法？告诉 AI，回车加入" aria-label="告诉 AI 对整条视频的想法" />
        </section>
        ${canSetSpeed ? `
          <details class="vwChangeGroup">
            <summary>配音语速</summary>
            <p class="vwHint">改语速会重配所有句子，MiniMax 按字数计费。</p>
            <div class="vwSpeed">
              <button type="button" class="vwBtn vwBtnSmall" data-action="speed" data-delta="-0.05">慢一点</button>
              <span class="vwSpeedValue">${Number(currentSpeed).toFixed(2)} 倍</span>
              <button type="button" class="vwBtn vwBtnSmall" data-action="speed" data-delta="0.05">快一点</button>
            </div>
          </details>` : ""}
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
          <button type="button" class="vwCover" data-action="open-cover" data-name="${esc(cover.name)}" title="${esc(cover.name)}">
            <img src="${esc(assetUrl(cover.abs, cover.mtime))}" alt="${esc(cover.name)}" loading="lazy" />
          </button>`).join("")}</div>`
      : `<button type="button" class="vwBtn vwBtnSmall" data-action="ask" data-text="帮这条视频做一张封面">让 AI 做封面</button>`;
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
            : `<h3>标题和描述</h3><button type="button" class="vwBtn vwBtnSmall" data-action="ask" data-text="帮这条视频写发布文案，包括抖音、视频号、小红书的标题和描述">让 AI 写文案</button>`}
        </section>
        ${docs.length ? `<section class="vwDocLinks">${docs.map(([label, path]) => `
          <button type="button" class="vwLink" data-action="open-doc" data-path="${esc(path)}">${esc(label)}</button>`).join("")}</section>` : ""}
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
        current.append(node);
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
        if (shot.replace && !isEditRendered(shot.replace) && shot.planIndex >= 0) replacedIndex.add(shot.planIndex);
      }
    }
    const tiles = plan.shots.map((shot, index) => {
      const start = shot.start / fps;
      const length = shot.frames / fps;
      const thumb = view.thumbs.get(`${view.versionName}#${index}`);
      return `<span class="vwStripShot vwStripShot-${esc(shot.kind)} ${replacedIndex.has(index) ? "vwStripChanged" : ""} ${Model.isMissingSource(shot.path, missing) ? "vwStripLost" : ""}"
        style="left:${pct(start)};width:${pct(length)}" data-strip-shot="${index}">${thumb ? `<img src="${esc(assetUrl(thumb))}" alt="" loading="lazy" />` : ""}</span>`;
    }).join("");
    const deleted = view.rows.filter((row) => row.deleted && row.start !== null)
      .map((row) => `<span class="vwStripDeleted" style="left:${pct(row.start)};width:${pct(row.end - row.start)}"></span>`).join("");
    box.innerHTML = `
      <div class="vwStripTrack" role="slider" tabindex="0" aria-label="播放位置" aria-valuemin="0" aria-valuemax="${Math.round(plan.duration)}" aria-valuenow="0">
        ${tiles}${deleted}
        <span class="vwSkimLine" hidden></span>
        <span class="vwSkimTime" hidden></span>
        <span class="vwPlayhead"></span>
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
      const { fraction, time } = stripTime(event, track);
      const line = track.querySelector(".vwSkimLine");
      const label = track.querySelector(".vwSkimTime");
      line.hidden = false;
      label.hidden = false;
      line.style.left = `${fraction * 100}%`;
      label.style.left = `${Math.min(96, Math.max(4, fraction * 100))}%`;
      label.textContent = Model.fmtTime(time);
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
      if (track) {
        track.querySelector(".vwSkimLine").hidden = true;
        track.querySelector(".vwSkimTime").hidden = true;
      }
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
  function loadCurrentVersion(keepTime = false) {
    const video = videoEl();
    const empty = view.el.querySelector(".vwPlayerEmpty");
    const version = currentVersion();
    view.playingSample = null;
    renderSampleTag();
    view.durationMismatch = false;
    if (!version) {
      video.hidden = true;
      video.removeAttribute("src");
      empty.hidden = false;
      empty.textContent = "还没有成片。AI 做好后这里会自动显示。";
      return;
    }
    video.hidden = false;
    empty.hidden = true;
    const time = keepTime ? video.currentTime : 0;
    video.src = assetUrl(version.abs, version.mtime);
    if (time) video.currentTime = time;
  }

  function renderSampleTag() {
    const tag = view.el.querySelector(".vwSampleTag");
    if (!tag) return;
    if (!view.playingSample) {
      tag.hidden = true;
      tag.innerHTML = "";
      return;
    }
    tag.hidden = false;
    tag.innerHTML = `试看第 ${view.playingSample.index + 1} 句 <button type="button" class="vwLink" data-action="back-to-version">回到成片</button>`;
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
    if (video.paused) video.play().catch(() => {});
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
    if (view.playingSample) return;
    const now = video.currentTime || 0;
    if (view.stopAt !== null && now >= view.stopAt - 0.03) {
      view.stopAt = null;
      video.pause();
    }
    // 预览：要删的句子直接跳过，换过的镜头盖在成片上
    if (!video.paused) {
      const skipTo = Model.skipDeleted(view.rows, now);
      if (skipTo !== null) {
        video.currentTime = skipTo + 0.01;
        return;
      }
    }
    syncPreview(now);
    const row = Model.rowAtTime(view.rows, now);
    if (!view.skim && row) markActiveRow(row.id);
    updatePlayhead();
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

  /* 没生成的换镜头不用等渲染：把素材盖在成片上，声音还是成片的。字幕被盖住了，用文字层补上 */
  function syncPreview(now) {
    const hit = Model.overlayAt(view.rows, now, (edit) => !isEditRendered(edit));
    if (!hit || view.overlayBroken.has(hit.src)) {
      hidePreview();
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
      if (previewVideo.readyState >= 1 && Math.abs(previewVideo.currentTime - hit.sourceTime) > PREVIEW_DRIFT_SEC) {
        previewVideo.currentTime = hit.sourceTime;
      }
      if (!video.paused && previewVideo.paused) previewVideo.play().catch(() => {});
      if (video.paused && !previewVideo.paused) previewVideo.pause();
      previewVideo.hidden = previewVideo.readyState < 2;
    }
    const caption = box.querySelector(".vwPreviewCaption");
    const text = Model.cueAt(view.plan?.cues, now);
    caption.textContent = text;
    caption.hidden = !text;
    box.querySelector(".vwPreviewTag").hidden = false;
  }

  function markActiveRow(beat, force = false) {
    if (view.activeBeat === beat && !force) return;
    // 正在这一句里打字时，不能因为播放走到下一句就把输入框收走
    if (!force && view.el.querySelector(".vwRowActive")?.contains(document.activeElement) && document.activeElement.matches("input, textarea")) return;
    const previous = view.activeBeat;
    view.activeBeat = beat;
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
    if (view.thumbsRequested.has(version.name)) return;
    view.thumbsRequested.add(version.name);
    deps.invoke("video_start_job", {
      path: view.projectPath,
      kind: "thumbs_shots",
      args: { video: version.name },
    }).catch((err) => console.warn("thumbs_shots failed", err));
  }

  function versionOfThumb(thumbPath) {
    const normal = String(thumbPath).replace(/\\/g, "/");
    for (const version of view.data?.versions || []) {
      const stem = version.name.replace(/\.[^.]+$/, "");
      if (normal.includes(`/shots/${version.name}/`) || normal.includes(`/shots/${stem}/`)) return version.name;
    }
    return view.versionName;
  }

  function placeShotThumb(version, shotIndex, abs) {
    view.thumbs.set(`${version}#${shotIndex}`, abs);
    if (version !== view.versionName) return;
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
    if (kind === "thumbs_shots") {
      if (status === "event" && event?.thumb && Number.isInteger(event.shot)) {
        placeShotThumb(versionOfThumb(event.thumb), event.shot, event.thumb);
      }
      return;
    }
    if (kind === "thumbs_sources") {
      if (status === "event" && event?.source) addPickerSource(event.source);
      if (status === "event" && event?.strip) stripCache.set(event.strip.path, event.strip);
      if (status === "event" && event?.thumbsDone) setPickerLoading(false);
      if (status === "done" || status === "error" || status === "cancelled") setPickerLoading(false);
      return;
    }
    if (kind === "sample") {
      if (status === "event" && event?.video) {
        view.sampleBusy.delete(event.beat);
        playSample(event.beat, event.video);
        renderPanel();
      }
      if (status === "error" || status === "cancelled") {
        const beat = view.sampleJobs.get(payload.jobId) || [...view.sampleBusy][0];
        if (beat) view.sampleBusy.delete(beat);
        view.sampleJobs.delete(payload.jobId);
        if (status === "error") deps.showToast(`试看没生成出来：${payload.message || "请稍后再试"}`);
        renderPanel();
      }
      if (status === "done") {
        const beat = view.sampleJobs.get(payload.jobId);
        view.sampleJobs.delete(payload.jobId);
        if (beat && view.sampleBusy.delete(beat)) renderPanel();
      }
      return;
    }
    if (kind === "render") {
      if (status === "start") {
        view.renderBusy = true;
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
  async function writeDoc(next, base) {
    const res = await deps.invoke("video_write_edits", {
      path: view.projectPath,
      edits: { ...next, revision: base.revision },
      expectedRevision: base.revision,
    });
    return res.revision;
  }

  /* label 为空的写入（比如标记已发送）不进撤销栈 */
  async function mutateDoc(change, label = null) {
    const current = view;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const base = current.doc;
      const next = change(base);
      try {
        const revision = await writeDoc(next, base);
        if (view !== current) return true;
        if (label) current.history = Model.recordHistory(current.history, base, label);
        current.doc = { ...next, revision };
        afterDocChange();
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
    renderHead();
    renderTabs();
    renderPanel(true);
    renderStrip();
    updatePlayback();
    scheduleStatusCheck();
  }

  async function stepHistory(direction) {
    const step = direction === "undo"
      ? Model.undoHistory(view.history, view.doc)
      : Model.redoHistory(view.history, view.doc);
    if (!step) return;
    const current = view;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const base = current.doc;
      try {
        const revision = await writeDoc({ ...base, edits: step.doc.edits, notes: step.doc.notes }, base);
        if (view !== current) return;
        current.history = step.history;
        current.doc = { ...base, edits: step.doc.edits, notes: step.doc.notes, revision };
        afterDocChange();
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
    const route = Model.routeApply({ editCount: pendingEdits().length, noteCount: unsentNotes().length });
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
    if (isRendering()) return;
    const offline = (view.data.missingSources || []).length;
    if (offline > 0) {
      const names = Model.offlineSummary(view.data.missingSources).names.slice(0, 2).join("、");
      const ok = await deps.confirm(`有 ${offline} 个素材读不到（${names}），生成很可能失败。还要继续吗？`, { confirmLabel: "继续生成", danger: false });
      if (!ok || !view) return;
    }
    view.renderBusy = true;
    view.renderError = null;
    renderHead();
    renderStatus();
    try {
      const { jobId } = await deps.invoke("video_start_job", { path: view.projectPath, kind: "render", args: {} });
      if (view?.renderBusy) {
        view.renderJobId = jobId;
        renderStatus();
      }
    } catch (err) {
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
      editCount: pendingEdits().length,
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
    view.editing = { beat, showTts: Boolean(row.setTts || row.sayTts) };
    renderPanel(true);
  }

  async function commitEditing() {
    const editing = view.editing;
    if (!editing) return;
    const row = view.rows.find((item) => item.id === editing.beat);
    if (!row) {
      view.editing = null;
      renderPanel(true);
      return;
    }
    const say = view.el.querySelector('[data-editor="say"]')?.value.trim() ?? "";
    const ttsField = view.el.querySelector('[data-editor="tts"]');
    const tts = ttsField ? ttsField.value.trim() : (row.sayTts || "");
    view.editing = null;
    if (!say) {
      deps.showToast("口播不能为空；不要这句就点「删除这句」");
      renderPanel(true);
      return;
    }
    const rawBeat = view.data.edl.beats[row.index];
    const textChanged = say !== row.say;
    const ttsChanged = tts !== (row.sayTts || "");
    if (!textChanged && !ttsChanged) {
      renderPanel(true);
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

  /* ── 换镜头面板：占右边，播放器留在左边当预览 ────── */
  function pickerShot() {
    const picker = view.picker;
    const row = view.rows.find((item) => item.id === picker.beat);
    return { row, shot: row?.shots.find((item) => item.idx === picker.shotIdx) || null };
  }

  async function openPicker(beat, shotIdx) {
    const row = view.rows.find((item) => item.id === beat);
    const shot = row?.shots.find((item) => item.idx === shotIdx);
    if (!shot) return;
    videoEl()?.pause();
    view.stopAt = null;
    if (shot.start !== null) seek(shot.start);
    view.picker = {
      beat,
      shotIdx,
      need: Model.shotDuration(shot),
      folders: [],
      folder: null,
      items: new Map(),
      tiles: new Map(),
      used: new Set((view.plan?.shots || []).map((item) => item.path).filter(Boolean)),
      filter: "all",
      onlyUnused: false,
      selectedPath: shot.replace?.value?.src || shot.path || null,
      selectedIn: typeof shot.replace?.value?.in === "number" ? shot.replace.value.in : shot.inSec,
      loading: false,
      jobId: null,
      skimTile: null,
    };
    renderTabs();
    renderPickerPanel();
    const current = view;
    try {
      const res = await deps.invoke("video_list_sources", { path: view.projectPath });
      if (view !== current || !view.picker) return;
      view.picker.folders = res.folders || [];
      for (const asset of res.assets || []) {
        view.picker.items.set(asset.path, Model.mergeSource(null, {
          ...asset,
          sizeMb: asset.sizeMb ?? asset.size_mb,
          dur: asset.dur ?? asset.duration,
        }));
      }
      const preferred = res.folders?.find((folder) => folder.exists !== false && Model.dirName(shot.path) === folder.abs)
        || res.folders?.find((folder) => folder.exists !== false)
        || null;
      renderPickerControls();
      if (preferred) selectFolder(preferred.abs);
      else renderPickerGrid();
    } catch (err) {
      deps.showToast(`读取素材失败：${err}`);
      renderPickerGrid();
    }
  }

  function renderPickerPanel() {
    const body = view.el.querySelector(".vwPanelBody");
    const { row, shot } = pickerShot();
    const picker = view.picker;
    body.innerHTML = `
      <div class="vwPicker" role="group" aria-label="换镜头">
        <header class="vwPickerHead">
          <div class="vwPickerTitle">
            <strong>换这个镜头</strong>
            <span class="vwMeta">${picker.need !== null ? `需要 ${picker.need.toFixed(1)} 秒` : ""}</span>
          </div>
          <button type="button" class="vwBtn vwBtnSmall" data-action="close-picker">完成</button>
        </header>
        <p class="vwPickerSay">${esc(row?.say || "")}</p>
        <div class="vwPickerControls"></div>
        <div class="vwPickerGrid"></div>
        <input type="text" class="vwNoteInput" data-note-beat="${esc(picker.beat)}" data-note-shot="${shot?.idx ?? ""}" placeholder="不想自己选？告诉 AI 想要什么画面，回车加入" aria-label="告诉 AI 想要什么画面" />
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
      ${picker.folders.length ? `<select class="vwFolderSelect" data-change="picker-folder" aria-label="素材文件夹">${folders}</select>` : ""}
      <button type="button" class="vwLink" data-action="pick-other" data-mode="folder">其它文件夹…</button>
      <span class="vwControlsSpacer"></span>
      <div class="vwSegmented" role="group" aria-label="素材类型">
        ${[["all", "全部"], ["video", "视频"], ["photo", "照片"]].map(([key, label]) => `
          <button type="button" class="${picker.filter === key ? "vwSegActive" : ""}" data-action="pick-filter" data-filter="${key}" aria-pressed="${picker.filter === key}">${label}</button>`).join("")}
      </div>
      <label class="vwCheck"><input type="checkbox" data-change="picker-unused" ${picker.onlyUnused ? "checked" : ""} /> 只看没用过的</label>`;
  }

  function selectFolder(abs) {
    const picker = view.picker;
    if (!picker) return;
    if (picker.jobId) deps.invoke("video_cancel_job", { jobId: picker.jobId }).catch(() => {});
    picker.folder = abs;
    picker.loading = true;
    picker.jobId = null;
    renderPickerControls();
    renderPickerGrid();
    deps.invoke("video_start_job", {
      path: view.projectPath,
      kind: "thumbs_sources",
      args: { folder: abs },
    }).then(({ jobId }) => {
      if (view?.picker && view.picker.folder === abs) view.picker.jobId = jobId;
    }).catch((err) => {
      deps.showToast(`读取素材失败：${err}`);
      setPickerLoading(false);
    });
  }

  function setPickerLoading(loading) {
    if (!view?.picker) return;
    view.picker.loading = loading;
    if (!loading) view.picker.jobId = null;
    updatePickerEmpty();
  }

  function matchesPicker(item) {
    const picker = view.picker;
    if (picker.folder && Model.dirName(item.path) !== picker.folder) return false;
    if (picker.filter !== "all" && item.kind !== picker.filter) return false;
    if (picker.onlyUnused && picker.used.has(item.path)) return false;
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
    const isVideo = item.kind === "video";
    tile.classList.toggle("vwSourceSelected", selected);
    tile.title = item.notes || item.name;
    tile.innerHTML = `
      <span class="vwSourceThumb">
        ${item.thumb ? `<img src="${esc(assetUrl(item.thumb))}" alt="" loading="lazy" />` : `<span class="vwShotPlaceholder">${shotKindIcon(item.kind)}</span>`}
        <span class="vwSkimFrame" hidden></span>
        <span class="vwSkimLine" hidden></span>
        ${picker.used.has(item.path) ? '<span class="vwSourceUsed">已用</span>' : ""}
        ${isVideo && item.dur ? `<span class="vwShotDur">${esc(Number(item.dur).toFixed(1))}</span>` : ""}
        ${selected && isVideo && typeof picker.selectedIn === "number" ? `<span class="vwSourceIn">从 ${esc(picker.selectedIn.toFixed(1))} 秒起</span>` : ""}
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
  }

  function updatePickerEmpty() {
    const picker = view?.picker;
    const grid = view?.el.querySelector(".vwPickerGrid");
    if (!picker || !grid) return;
    grid.querySelector(".vwPickerEmpty")?.remove();
    if (picker.tiles.size > 0) return;
    const note = document.createElement("p");
    note.className = "vwPickerEmpty vwEmpty";
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
    delete tile.dataset.skimTime;
  }

  /* 点一下就换上，留在面板里接着比较；不满意再点别的，或者撤销 */
  async function pickSource(tile) {
    const picker = view.picker;
    const item = picker.items.get(tile.dataset.path);
    const { row, shot } = pickerShot();
    if (!item || !shot || !row) return;
    const isVideo = item.kind === "video";
    const wanted = tile.dataset.skimTime !== undefined
      ? Number(tile.dataset.skimTime)
      : (item.path === shot.path && typeof shot.inSec === "number" ? shot.inSec : 0.5);
    const clamp = isVideo ? Model.clampIn(wanted, Number(item.dur) || 0, picker.need) : { in: 0, tooShort: false };
    const edit = Model.makeReplaceShot(shot, { src: item.path, inSec: clamp.in, kind: item.kind });
    const previous = picker.selectedPath ? picker.tiles.get(picker.selectedPath) : null;
    picker.selectedPath = item.path;
    picker.selectedIn = isVideo ? clamp.in : null;
    const ok = await mutateDoc((doc) => Model.upsertEdit(doc, edit), `换第 ${row.index + 1} 句的镜头`);
    if (!ok || !view?.picker) return;
    if (previous && previous !== tile) fillTile(previous, picker.items.get(previous.dataset.path));
    if (picker.skimTile !== tile) fillTile(tile, item);
    else {
      tile.classList.add("vwSourceSelected");
      let badge = tile.querySelector(".vwSourceIn");
      if (isVideo) {
        if (!badge) {
          badge = document.createElement("span");
          badge.className = "vwSourceIn";
          tile.querySelector(".vwSourceThumb").append(badge);
        }
        badge.textContent = `从 ${clamp.in.toFixed(1)} 秒起`;
      }
    }
    if (clamp.tooShort) deps.showToast("这段素材比镜头短，生成时会放慢");
    const fresh = pickerShot().shot;
    if (fresh?.start !== null && fresh?.start !== undefined) playInPlace(fresh.start, fresh.end);
  }

  function closePicker() {
    const picker = view.picker;
    if (!picker) return;
    if (picker.jobId) deps.invoke("video_cancel_job", { jobId: picker.jobId }).catch(() => {});
    view.picker = null;
    renderTabs();
    renderPanel(true);
    const rowEl = view.el.querySelector(`.vwRow[data-beat="${CSS.escape(picker.beat)}"]`);
    if (rowEl) scrollRowIntoView(rowEl);
    view.el.focus({ preventScroll: true });
  }

  /* ── 交互 ───────────────────────────────────────── */
  const actions = {
    "toggle-play"() { togglePlay(); },
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
    tab(target) {
      view.tab = target.dataset.tab;
      view.editing = null;
      renderTabs();
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
    "jump-row"(target) {
      const row = view.rows.find((item) => item.id === target.dataset.beat);
      if (!row) return;
      view.tab = "script";
      renderTabs();
      renderPanel(true);
      if (row.start !== null) seek(row.start);
      markActiveRow(row.id, true);
      const rowEl = view.el.querySelector(`.vwRow[data-beat="${CSS.escape(row.id)}"]`);
      if (rowEl) scrollRowIntoView(rowEl);
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
    async "undo-edit"(target) {
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
    async sample(target) {
      const beat = target.dataset.beat;
      if (view.sampleBusy.has(beat)) return;
      view.sampleBusy.add(beat);
      target.disabled = true;
      target.textContent = "生成中…";
      try {
        const { jobId } = await deps.invoke("video_start_job", { path: view.projectPath, kind: "sample", args: { beat } });
        if (view?.sampleBusy.has(beat)) view.sampleJobs.set(jobId, beat);
      } catch (err) {
        view.sampleBusy.delete(beat);
        deps.showToast(String(err).includes("JOB_BUSY") ? "这一句正在生成" : `试看没生成出来：${err}`);
        renderPanel();
      }
    },
    "back-to-version"() { backToVersion(); },
    apply() { void applyChanges(); },
    async "cancel-render"() {
      if (!view.renderJobId) return;
      const ok = await deps.confirm("确定取消吗？已经处理好的镜头有缓存，下次不用重来。", { confirmLabel: "取消生成", danger: false });
      if (!ok || !view?.renderJobId) return;
      deps.invoke("video_cancel_job", { jobId: view.renderJobId }).catch((err) => deps.showToast(`取消失败：${err}`));
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
    "open-picker"(target) { void openPicker(target.dataset.beat, Number(target.dataset.shot)); },
    "close-picker"() { closePicker(); },
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
    await loadPlanFor(name);
    if (!view) return;
    rebuildRows();
    loadCurrentVersion();
    renderAll();
    ensureShotThumbs();
  }

  function wireView() {
    const el = view.el;
    el.addEventListener("click", (event) => {
      // 从最里层往外找第一个有动作的元素，行里的按钮不会触发选中整行
      const target = event.target.closest("[data-action]");
      if (!target || !el.contains(target) || target.disabled) return;
      actions[target.dataset.action]?.(target, event);
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
      }
    });
    el.addEventListener("input", (event) => {
      if (event.target.classList?.contains("vwSayEditor")) autoGrow(event.target);
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
    video.addEventListener("loadedmetadata", () => {
      if (!view) return;
      updateClock();
      if (view.playingSample) return;
      const planDuration = view.plan?.duration;
      view.durationMismatch = Boolean(planDuration && Math.abs(video.duration - planDuration) > 0.5);
    });
    video.addEventListener("error", () => {
      if (!view || !video.getAttribute("src")) return;
      const empty = el.querySelector(".vwPlayerEmpty");
      empty.hidden = false;
      empty.textContent = "这个版本放不了，文件可能已被清理或还在写入。";
      video.hidden = true;
    });
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
      const text = target.value.trim();
      if (!text) return;
      const beat = target.dataset.noteBeat || null;
      const shot = target.dataset.noteShot ? Number(target.dataset.noteShot) : null;
      const row = view.rows.find((item) => item.id === beat);
      const time = shot !== null ? row?.shots.find((item) => item.idx === shot)?.start ?? null : row?.start ?? null;
      target.value = "";
      const closing = Boolean(view.picker);
      void mutateDoc((doc) => Model.addNote(doc, { beat, shot, time, text }), "告诉 AI").then(() => {
        if (closing && view?.picker) closePicker();
      });
      return;
    }
    if (target.dataset?.editor && !event.isComposing) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        view.editing = null;
        renderPanel(true);
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
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !view.picker) {
      const timed = view.rows.filter((row) => row.start !== null);
      if (timed.length === 0) return;
      const now = videoEl()?.currentTime || 0;
      const currentIndex = timed.findIndex((row) => now >= row.start - 0.001 && now < row.end);
      const delta = event.key === "ArrowLeft" ? -1 : 1;
      const next = timed[Math.min(timed.length - 1, Math.max(0, (currentIndex < 0 ? 0 : currentIndex) + delta))];
      if (next) {
        event.preventDefault();
        event.stopPropagation();
        seek(next.start);
        markActiveRow(next.id, true);
        const rowEl = view.el.querySelector(`.vwRow[data-beat="${CSS.escape(next.id)}"]`);
        if (rowEl) scrollRowIntoView(rowEl, "smooth");
      }
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

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../desktop-lite/video-workbench-model.js", import.meta.url), "utf8");
const context = vm.createContext({});
vm.runInContext(source, context);
const Model = context.InkfellowVideoModel;
const plain = (value) => JSON.parse(JSON.stringify(value));

test("a render snapshot only marks the exact saved version of an edit as applied", () => {
  const first = { id: "card-edit", op: "set_text", beat: "b01", text: 0, value: { text: "第一稿" }, createdAt: 100 };
  const second = { ...first, value: { text: "第二稿" }, createdAt: 105 };
  const snapshot = { renderedAt: 110, editsApplied: [first.id], appliedEdits: [first] };
  assert.equal(Model.isEditInPlan(snapshot, first), true);
  assert.equal(Model.isEditInPlan(snapshot, second), false);
  assert.equal(Model.isEditInPlan({ ...snapshot, appliedEdits: undefined }, first), true);
});

test("a default-position card keeps its actual source fields and stable timeline index", () => {
  const source = { beats: [{ id: "b01", texts: [{ text: "第一张" }, { text: "第二张" }] }] };
  const planned = { fps: 30, duration: 4, beats: [{ id: "b01", i: 0, start: 0, frames: 120 }],
    texts: [{ beat: 0, idx: 1, text: "第二张", start: 2.5, end: 3.5 }] };
  const [row] = Model.buildRows({ edl: source, plan: planned });
  assert.equal(row.cards[1].start, 2.5);
  const change = Model.makeSetText(row, row.cards[1], { text: "修改后", pos: "upper" });
  assert.deepEqual(plain(change.base), { text: "第二张" });
  const rows = Model.buildRows({ edl: source, plan: planned, edits: { edits: [Model.makeDeleteText(row, row.cards[0]), change] } });
  const before = Model.liveOverlaysAt({ rows, plan: planned, time: 0.5 });
  const during = Model.liveOverlaysAt({ rows, plan: planned, time: 2.7 });
  assert.equal(before.cards.length, 0);
  assert.equal(during.cards[0].text, "修改后");
});

test("workbench falls back to the original video and ignores a previous version's clean job", async () => {
  const script = await readFile(new URL("../desktop-lite/video-workbench.js", import.meta.url), "utf8");
  const instrumented = script.replace("  root.InkfellowVideoWorkbench = {",
    "  root.test = { use: (state) => { view = state; }, handleJobEvent, syncLiveLayer, versionMediaKey };\n  root.InkfellowVideoWorkbench = {");
  vm.runInContext(instrumented, context);
  const { use, handleJobEvent, syncLiveLayer, versionMediaKey } = context.test;
  const toggle = { hidden: true, disabled: false, textContent: "", classList: { toggle() {} } };
  const layer = { hidden: false, dataset: {} };
  const version = { name: "demo_v2.mp4", mediaRevision: "123", size: 100 };
  const state = {
    el: { querySelector: (selector) => ({ ".vwLiveLayer": layer, ".vwLiveToggle": toggle })[selector] },
    projectPath: "demo",
    data: { versions: [version], edl: {} },
    versionName: version.name,
    plan: { duration: 3 },
    doc: { edits: [] },
    liveRows: [],
    editingCard: { draftText: "新版字幕" },
    cleanRequest: { token: "current", key: versionMediaKey(version) },
  };
  use(state);
  syncLiveLayer(0);
  assert.equal(layer.hidden, true);
  assert.match(toggle.textContent, /正在准备/);
  handleJobEvent({ project: "demo", kind: "clean_preview", requestId: "previous", status: "event",
    event: { cleanVideo: "wrong.mp4" } });
  assert.equal(state.cleanMedia, undefined);
  handleJobEvent({ project: "demo", kind: "clean_preview", requestId: "current", status: "error" });
  assert.equal(state.cleanRequest, null);
  assert.equal(state.cleanError, true);
  syncLiveLayer(0);
  assert.equal(layer.hidden, true);
  assert.equal(toggle.disabled, false);
  assert.match(toggle.textContent, /重试/);
});

test("video jobs keep their request owner when switching folders or receiving overlapping sample results", async () => {
  const script = await readFile(new URL("../desktop-lite/video-workbench.js", import.meta.url), "utf8");
  const sandbox = vm.createContext({ InkfellowVideoModel: Model });
  vm.runInContext(script.replace("  root.InkfellowVideoWorkbench = {",
    "  root.test = { use: (state, options) => { view = state; deps = options; }, handleJobEvent, selectFolder, actions };\n"
    + "  root.InkfellowVideoWorkbench = {"), sandbox);
  const { use, handleJobEvent, selectFolder, actions } = sandbox.test;
  const starts = [];
  const cancelled = [];
  const toasts = [];
  const picker = {};
  const state = {
    el: { querySelector: () => null },
    projectPath: "demo",
    picker,
    sampleBusy: new Set(),
    sampleRequests: new Map(),
  };
  use(state, {
    invoke(command, params) {
      if (command === "video_cancel_job") {
        cancelled.push(params.jobId);
        return Promise.resolve();
      }
      return new Promise(resolve => starts.push({ params, resolve }));
    },
    showToast(message) { toasts.push(message); },
  });
  const emit = (start, status) => handleJobEvent({
    project: "demo", kind: start.params.kind, requestId: start.params.args.requestId, status,
  });

  selectFolder("first");
  selectFolder("second");
  emit(starts[0], "cancelled");
  assert.equal(picker.loading, true);
  starts[0].resolve({ jobId: "old" });
  emit(starts[1], "done");
  starts[1].resolve({ jobId: "finished" });
  await Promise.resolve();
  assert.deepEqual(cancelled, ["old"]);
  assert.equal(picker.loading, false);
  assert.equal(picker.sourceRequest, null);

  const first = actions.sample({ dataset: { beat: "b01" } });
  const second = actions.sample({ dataset: { beat: "b02" } });
  emit(starts[3], "error");
  assert.deepEqual([...state.sampleBusy], ["b01"]);
  assert.equal(toasts.length, 1);
  emit(starts[2], "done");
  starts[2].resolve({ jobId: "b01" });
  starts[3].resolve({ jobId: "b02" });
  await Promise.all([first, second]);
  assert.equal(state.sampleBusy.size, 0);
});

const edl = {
  voice: { provider: "minimax", speed: 0.9 },
  beats: [
    {
      id: "b01",
      say: "第一句",
      shots: [
        { src: "D:\\素材\\a.mp4", in: 2, fit: "cover", focus: 0.5 },
        { src: "D:\\素材\\b.jpg", motion: "push", cut_at_word: "一句" },
      ],
    },
    { id: "b02", say: "第二句", say_tts: "第二巨", shots: [{ scene: "stat", value: 26 }] },
    { id: "b03", say: "第三句", shots: [{ src: "D:\\素材\\c.mp4" }] },
  ],
};

const plan = {
  fps: 30,
  duration: 12,
  beats: [
    { i: 0, id: "b01", start: 0, frames: 150, say: "第一句" },
    { i: 1, id: "b02", start: 150, frames: 120, say: "第二句" },
    { i: 2, id: "b03", start: 270, frames: 90, say: "第三句" },
  ],
  shots: [
    { beat: 0, idx: 0, kind: "video", path: "D:\\素材\\a.mp4", in: 2, start: 0, frames: 90 },
    { beat: 0, idx: 1, kind: "photo", path: "D:\\素材\\b.jpg", in: 0, start: 90, frames: 60 },
    { beat: 1, idx: 0, kind: "scene", path: "", scene: "stat", start: 150, frames: 120 },
    { beat: 2, idx: 0, kind: "video", path: "D:\\素材\\c.mp4", in: 0, start: 270, frames: 90 },
  ],
  texts: [{ beat: 1, text: "26 公里", style: "num" }, { beat: null, text: "钩子", style: "title", hook: true }],
};

test("fmtTime formats minutes, hours, and invalid input", () => {
  assert.equal(Model.fmtTime(0), "00:00");
  assert.equal(Model.fmtTime(83.9), "01:23");
  assert.equal(Model.fmtTime(3725), "1:02:05");
  assert.equal(Model.fmtTime(null), "--:--");
});

test("buildRows joins edl order with plan timing and hides the hook card from beat texts", () => {
  const rows = Model.buildRows({ edl, plan, edits: null });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].start, 0);
  assert.equal(rows[0].end, 5);
  assert.equal(rows[1].start, 5);
  assert.equal(rows[0].shots[0].end, 3);
  assert.equal(rows[0].shots[1].start, 3);
  assert.equal(rows[0].shots[0].name, "a.mp4");
  assert.equal(rows[1].shots[0].name, "动画：stat");
  assert.deepEqual(plain(rows[1].texts), [{ text: "26 公里", style: "num" }]);
  assert.equal(rows[0].texts.length, 0);
});

test("buildRows survives an old plan without beat ids and a beat the plan has never seen", () => {
  const oldPlan = { ...plan, beats: plan.beats.map(({ id, ...rest }) => rest) };
  const changed = { ...edl, beats: [...edl.beats, { id: "b04", say: "新增的一句", shots: [{ src: "d.mp4" }] }] };
  const rows = Model.buildRows({ edl: changed, plan: oldPlan, edits: null });
  assert.equal(rows[2].start, 9);
  assert.equal(rows[3].start, null);
  assert.equal(rows[3].planIndex, null);
});

test("buildRows matches by text when AI renumbered beats", () => {
  const renumbered = { ...edl, beats: [{ ...edl.beats[1], id: "x1" }] };
  const noIds = { ...plan, beats: plan.beats.map(({ id, ...rest }) => rest) };
  const rows = Model.buildRows({ edl: renumbered, plan: noIds, edits: null });
  assert.equal(rows[0].start, 5);
});

test("buildRows works before any plan exists", () => {
  const rows = Model.buildRows({ edl, plan: null, edits: null });
  assert.equal(rows[0].start, null);
  assert.equal(rows[0].shots[0].inSec, 2);
  assert.equal(rows[1].shots[0].kind, "scene");
});

test("set_say shows the new text, remembers the original, and reverting removes the edit", () => {
  let rows = Model.buildRows({ edl, plan, edits: null });
  let doc = Model.upsertEdit(null, Model.makeSetSay(rows[0], "改过的第一句"));
  rows = Model.buildRows({ edl, plan, edits: doc });
  assert.equal(rows[0].say, "改过的第一句");
  assert.equal(rows[0].originalSay, "第一句");
  assert.equal(doc.edits.length, 1);

  doc = Model.upsertEdit(doc, Model.makeSetSay(rows[0], "再改一次"));
  assert.equal(doc.edits.length, 1);
  assert.equal(doc.edits[0].base.say, "第一句");
  assert.equal(doc.edits[0].value.say, "再改一次");

  doc = Model.upsertEdit(doc, Model.makeSetSay(rows[0], "第一句"));
  assert.equal(doc.edits.length, 0);
});

test("replace_shot keeps the earliest base, carries framing for same kind, and drops it across kinds", () => {
  const rows = Model.buildRows({ edl, plan, edits: null });
  const first = Model.makeReplaceShot(rows[0].shots[0], { src: "D:\\素材\\x.mp4", inSec: 1.234, kind: "video" });
  assert.deepEqual(plain(first.base), { src: "D:\\素材\\a.mp4", in: 2 });
  assert.deepEqual(plain(first.value), { src: "D:\\素材\\x.mp4", in: 1.23, fit: "cover", focus: 0.5 });

  const toPhoto = Model.makeReplaceShot(rows[0].shots[0], { src: "D:\\素材\\y.jpg", inSec: 3, kind: "photo" });
  assert.deepEqual(plain(toPhoto.value), { src: "D:\\素材\\y.jpg" });

  const fromScene = Model.makeReplaceShot(rows[1].shots[0], { src: "D:\\素材\\x.mp4", inSec: 0, kind: "video" });
  assert.deepEqual(plain(fromScene.base), { scene: "stat" });
  assert.equal(fromScene.value.fit, undefined);

  let doc = Model.upsertEdit(null, first);
  doc = Model.upsertEdit(doc, Model.makeReplaceShot(rows[0].shots[0], { src: "D:\\素材\\z.mp4", inSec: 0, kind: "video" }));
  assert.equal(doc.edits.length, 1);
  assert.deepEqual(plain(doc.edits[0].base), { src: "D:\\素材\\a.mp4", in: 2 });
  assert.equal(doc.edits[0].id, first.id);
});

test("replacing a shot with its original source and in-point removes the edit", () => {
  const rows = Model.buildRows({ edl, plan, edits: null });
  let doc = Model.upsertEdit(null, Model.makeReplaceShot(rows[0].shots[0], { src: "D:\\素材\\x.mp4", inSec: 1, kind: "video" }));
  doc = Model.upsertEdit(doc, Model.makeReplaceShot(rows[0].shots[0], { src: "D:\\素材\\a.mp4", inSec: 2, kind: "video" }));
  assert.equal(doc.edits.length, 0);
});

test("a text edit discards the old reading, because the reading belongs to the old sentence", () => {
  let rows = Model.buildRows({ edl, plan, edits: null });
  assert.equal(rows[1].sayTts, "第二巨");
  const doc = Model.upsertEdit(null, Model.makeSetSay(rows[1], "新的第二句"));
  rows = Model.buildRows({ edl, plan, edits: doc });
  assert.equal(rows[1].sayTts, "", "改字后旧读音不能留着");
  const withReading = Model.upsertEdit(null, Model.makeSetSay(rows[1], "新的第二句", "新的第二巨"));
  rows = Model.buildRows({ edl, plan, edits: withReading });
  assert.equal(rows[1].sayTts, "新的第二巨");
});

test("shot names prefer the real file name over a material id", () => {
  const withId = { beats: [{ id: "b01", say: "甲", shots: [{ src: "V75", in: 0.3 }] }] };
  const planned = { fps: 30, beats: [{ i: 0, id: "b01", start: 0, frames: 30, say: "甲" }], shots: [{ beat: 0, idx: 0, kind: "video", path: "D:\\素材\\VID_1.mp4", in: 0.3, start: 0, frames: 30 }] };
  assert.equal(Model.buildRows({ edl: withId, plan: planned, edits: null })[0].shots[0].name, "VID_1.mp4");
  assert.equal(Model.buildRows({ edl: withId, plan: null, edits: null })[0].shots[0].name, "V75");
});

test("delete_beat marks the row, and removeEdit restores it", () => {
  let rows = Model.buildRows({ edl, plan, edits: null });
  let doc = Model.upsertEdit(null, Model.makeDeleteBeat(rows[2]));
  rows = Model.buildRows({ edl, plan, edits: doc });
  assert.equal(rows[2].deleted, true);
  doc = Model.removeEdit(doc, doc.edits[0].id);
  rows = Model.buildRows({ edl, plan, edits: doc });
  assert.equal(rows[2].deleted, false);
});

test("set_voice records only the keys it changes", () => {
  const edit = Model.makeVoiceEdit(edl, { speed: 1.05 });
  assert.deepEqual(plain(edit.base), { speed: 0.9 });
  assert.deepEqual(plain(edit.value), { speed: 1.05 });
  assert.equal(Model.editKey(edit), "voice");
});

test("rowAtTime and shotAtTime find the playing beat and shot", () => {
  const rows = Model.buildRows({ edl, plan, edits: null });
  assert.equal(Model.rowAtTime(rows, 0).id, "b01");
  assert.equal(Model.rowAtTime(rows, 5).id, "b02");
  assert.equal(Model.rowAtTime(rows, 99), null);
  assert.equal(Model.shotAtTime(rows[0], 3.5).idx, 1);
  assert.equal(Model.shotAtTime(null, 1), null);
});

test("buildAiMessage matches the contract format", () => {
  const rows = Model.buildRows({ edl, plan, edits: null });
  const text = Model.buildAiMessage({
    projectPath: "旅居/视频_元江",
    versionName: "元江_v4.mp4",
    rows,
    notes: [
      { beat: "b01", shot: 0, text: "画面太暗" },
      { beat: "b02", shot: null, text: "节奏太慢" },
      { beat: null, shot: null, text: "整体再快一点" },
    ],
    editCount: 2,
  });
  assert.equal(text, [
    "【视频修改单】工程：旅居/视频_元江（当前 元江_v4.mp4）",
    "1. b01 第1个镜头（00:00–00:03，a.mp4 2秒起）：画面太暗",
    "2. b02（00:05）：节奏太慢",
    "3. 全片：整体再快一点",
    "工作台还有 2 处人工改动已写入 edits.json，出片时会自动叠加，不用手改。",
  ].join("\n"));
});

test("buildAiMessage omits the edits line when nothing is pending", () => {
  const rows = Model.buildRows({ edl, plan, edits: null });
  const text = Model.buildAiMessage({ projectPath: "p", versionName: null, rows, notes: [{ beat: "b03", shot: 0, text: "换" }], editCount: 0 });
  assert.ok(text.startsWith("【视频修改单】工程：p（当前 还没有成片）"));
  assert.ok(!text.includes("edits.json"));
});

test("notes flow: add, mark sent, prune after a newer version, and keep unsent ones", () => {
  let doc = Model.addNote(null, { beat: "b01", shot: null, text: "甲" });
  doc = Model.addNote(doc, { beat: "b02", shot: null, text: "乙" });
  assert.equal(plain(Model.pendingCounts(doc)).notes, 2);
  doc = Model.markNotesSent(doc, [doc.notes[0].id], 1000);
  assert.deepEqual(plain(Model.pendingCounts(doc)), { edits: 0, notes: 1, sent: 1 });
  assert.equal(Model.pruneSentNotes(doc, 999).notes.length, 2);
  const after = Model.pruneSentNotes(doc, 1001);
  assert.equal(after.notes.length, 1);
  assert.equal(after.notes[0].text, "乙");
});

test("statusOfEdit reports conflict, absorbed, applied, and pending", () => {
  const status = {
    applied: ["a"],
    absorbed: ["b"],
    conflicts: [{ id: "c", reason: "base_changed", message: "这句已被 AI 改过" }],
  };
  assert.equal(Model.statusOfEdit("a", status).state, "applied");
  assert.equal(Model.statusOfEdit("b", status).state, "absorbed");
  assert.equal(Model.statusOfEdit("c", status).message, "这句已被 AI 改过");
  assert.equal(Model.statusOfEdit("d", status).state, "pending");
  assert.equal(Model.statusOfEdit("d", null).state, "pending");
});

test("describeEdit explains every op in plain words", () => {
  const rows = Model.buildRows({ edl, plan, edits: null });
  assert.equal(Model.describeEdit({ op: "set_say", beat: "b01", value: { say: "新" } }, rows), "第 1 句改字：新");
  assert.equal(Model.describeEdit({ op: "delete_beat", beat: "b03", base: { say: "第三句" } }, rows), "第 3 句删除：第三句");
  assert.equal(
    Model.describeEdit({ op: "replace_shot", beat: "b01", shot: 1, value: { src: "D:\\素材\\x.mp4", in: 3 } }, rows),
    "第 1 句第 2 个镜头换成 x.mp4（3 秒起）",
  );
  assert.equal(Model.describeEdit({ op: "set_voice", value: { speed: 1.05 } }, rows), "语速改为 1.05 倍");
});

test("describeRunning and runningProgress stay honest about where the time goes", () => {
  assert.equal(Model.describeRunning(null), "");
  assert.equal(Model.describeRunning({ cmd: "render", stage: "shots", done: 12, total: 20 }), "正在生成新版本：镜头 12/20");
  assert.equal(Model.describeRunning({ cmd: "render", stage: "final", preview: true }), "正在生成预览：合成导出");
  assert.equal(Model.describeRunning({ cmd: "sample", stage: "run" }), "正在生成试看…");
  const allShotsDone = Model.runningProgress({ cmd: "render", stage: "shots", done: 20, total: 20 });
  assert.ok(allShotsDone <= 0.25, "镜头渲染完不能显示成快结束了");
  assert.ok(Model.runningProgress({ stage: "final" }) > 0.9);
});

test("deriveSteps infers an old project from files, including steps with no trace", () => {
  const steps = Model.deriveSteps({
    facts: { manifest: false, script: true, voiceCount: 3, plan: true, preview: false, qa: true, final: true, cover: true, publish: true },
    journal: [],
    running: null,
    versions: [{ kind: "final" }],
    covers: [],
  });
  const state = Object.fromEntries(steps.map((step) => [step.key, step.state]));
  assert.equal(state.final, "done");
  assert.equal(state.probe, "done", "素材清单在别的工程时，走到后面也要算做过");
  assert.equal(state.preview, "pending", "预览是可选步骤，不能倒推成做过");
});

test("deriveSteps marks the running step as active and reads the journal", () => {
  const steps = Model.deriveSteps({
    facts: { script: true },
    journal: [{ cmd: "probe", stage: "run", status: "done" }, { cmd: "voice", stage: "run", status: "done" }],
    running: { cmd: "render", stage: "shots", preview: false },
    versions: [],
    covers: [],
  });
  const state = Object.fromEntries(steps.map((step) => [step.key, step.state]));
  assert.equal(state.probe, "done");
  assert.equal(state.voice, "done");
  assert.equal(state.final, "active");
  assert.equal(state.cover, "pending");
});

test("stoppedStep only fires when nothing is running and the journal has gone quiet", () => {
  const steps = Model.deriveSteps({ facts: { script: true, voiceCount: 2 }, journal: [], running: null, versions: [], covers: [] });
  const quiet = [{ ts: 100, stage: "run", status: "done", cmd: "voice" }];
  assert.equal(Model.stoppedStep({ steps, running: null, agentGenerating: false, journal: quiet, nowSeconds: 200 }).key, "plan");
  assert.equal(Model.stoppedStep({ steps, running: null, agentGenerating: true, journal: quiet, nowSeconds: 200 }), null);
  assert.equal(Model.stoppedStep({ steps, running: { cmd: "render" }, agentGenerating: false, journal: quiet, nowSeconds: 200 }), null);
  assert.equal(Model.stoppedStep({ steps, running: null, agentGenerating: false, journal: quiet, nowSeconds: 110 }), null);
  const finished = Model.deriveSteps({ facts: { final: true }, journal: [], running: null, versions: [], covers: [] });
  assert.equal(Model.stoppedStep({ steps: finished, running: null, agentGenerating: false, journal: [], nowSeconds: 200 }), null);
});

test("lastCommandFailure reports only an unrecovered failure", () => {
  const failed = [{ stage: "run", status: "done", cmd: "voice" }, { stage: "run", status: "error", cmd: "render", msg: "素材不在原位置" }];
  assert.equal(Model.lastCommandFailure(failed).message, "素材不在原位置");
  assert.equal(Model.lastCommandFailure([...failed, { stage: "run", status: "done", cmd: "render" }]), null);
  assert.equal(Model.lastCommandFailure([]), null);
});

test("offlineSummary only blames a drive when every source on it is gone", () => {
  assert.equal(Model.offlineSummary([]), null);
  const moved = Model.offlineSummary(["D:\\素材\\a.mp4", "D:\\素材\\b.mp4"], 12);
  assert.equal(moved.count, 2);
  assert.equal(moved.wholeDrive, false, "只缺两个文件多半是被挪走了，不能说盘没插");
  assert.deepEqual(plain(moved.names), ["a.mp4", "b.mp4"]);
  const unplugged = Model.offlineSummary(["E:\\手机\\a.mp4", "e:\\手机\\b.mp4"], 2);
  assert.equal(unplugged.wholeDrive, true);
  assert.equal(unplugged.drive, "E:");
  const mixed = Model.offlineSummary(["E:\\a.mp4", "D:\\b.mp4"], 2);
  assert.equal(mixed.wholeDrive, false);
});

test("old plans without text beat fields fall back to the texts written in edl", () => {
  const withTexts = { beats: [{ id: "b01", say: "甲", texts: [{ text: "字卡", style: "tag" }], shots: [{ src: "a.mp4" }] }] };
  const oldPlan = { fps: 30, beats: [{ i: 0, start: 0, frames: 30, say: "甲" }], shots: [], texts: [{ text: "字卡", style: "tag", start: 0, end: 1 }] };
  const rows = Model.buildRows({ edl: withTexts, plan: oldPlan, edits: null });
  assert.deepEqual(plain(rows[0].texts), [{ text: "字卡", style: "tag" }]);
});

test("an edit only counts as done once it is in a final version, not just a preview", () => {
  const edit = { id: "e1", createdAt: 100 };
  const finalPlan = { renderedAt: 200, editsApplied: ["e1"] };
  const finalLatest = { versions: [{ name: "a_v1.mp4", kind: "final", mtime: 200, hasPlan: true }], latest: "a_v1.mp4", plan: finalPlan };
  assert.equal(Model.isEditInFinal(finalLatest, edit), true);
  assert.equal(Model.isEditInFinal({ ...finalLatest, plan: { renderedAt: 200, editsApplied: [] } }, edit), false, "冲突没进成片");
  assert.equal(Model.isEditInFinal(finalLatest, { id: "e1", createdAt: 300 }), false, "出片之后又改了");

  const previewLatest = {
    versions: [
      { name: "a_v1.mp4", kind: "final", mtime: 90, hasPlan: true },
      { name: "a_preview.mp4", kind: "preview", mtime: 200, hasPlan: true },
    ],
    latest: "a_preview.mp4",
    plan: finalPlan,
  };
  assert.equal(Model.isEditInPlan(previewLatest.plan, edit), true, "预览里已经有了，不用再盖预览层");
  assert.equal(Model.isEditInFinal(previewLatest, edit), false, "但正式版里还没有，主按钮要留着");
  assert.equal(Model.isEditInFinal({ versions: [{ name: "p.mp4", kind: "preview", mtime: 200 }], latest: "p.mp4", plan: finalPlan }, edit), false);
  const oldFinal = { versions: [{ name: "a_v1.mp4", kind: "final", mtime: 200, hasPlan: false }], latest: "a_v1.mp4", plan: { duration: 5 } };
  assert.equal(Model.isEditInFinal(oldFinal, edit), false, "老工程没有快照时不能假定生效");
});

test("routeApply: opinions go to AI, certain edits render directly", () => {
  assert.equal(Model.routeApply({ editCount: 0, noteCount: 0 }), "none");
  assert.equal(Model.routeApply({ editCount: 3, noteCount: 0 }), "render");
  assert.equal(Model.routeApply({ editCount: 3, noteCount: 1 }), "ai", "有意见就要 AI 判断，改动会被它一起带上");
  assert.equal(Model.routeApply({ editCount: 0, noteCount: 2 }), "ai");
});

test("visibleSteps hides the whole stepper once the video is finished", () => {
  const unfinished = Model.deriveSteps({ facts: { script: true }, journal: [], running: null, versions: [], covers: [] });
  assert.equal(Model.visibleSteps(unfinished).length, 9);
  const finished = Model.deriveSteps({ facts: { final: true, plan: true }, journal: [], running: null, versions: [{ kind: "final" }], covers: [] });
  assert.equal(Model.visibleSteps(finished).length, 0, "做完了就不要再摆一排进度点");
});

test("pickStatus says only the most urgent thing", () => {
  const all = {
    running: { cmd: "render", stage: "shots", done: 1, total: 2 },
    renderBusy: true,
    renderQa: true,
    canCancel: true,
    failure: { cmd: "render", message: "坏了" },
    conflictCount: 2,
    stopped: { label: "配音" },
    pendingLatestLabel: "v5",
    envProblem: "没有引擎",
  };
  const status = Model.pickStatus(all);
  assert.equal(status.kind, "working");
  assert.equal(status.action, "cancel-render");
  assert.equal(Model.pickStatus({ ...all, running: null }).text, "新版本已生成，正在自检…");
  assert.match(Model.pickStatus({ ...all, running: null, renderQa: false, renderBusy: false }).text, /没成功：坏了/);
  assert.equal(Model.pickStatus({ conflictCount: 2 }).action, "tab");
  assert.equal(Model.pickStatus({ stopped: { label: "配音" } }).step, "配音");
  assert.equal(Model.pickStatus({ pendingLatestLabel: "v5" }).action, "switch-latest");
  assert.match(Model.pickStatus({ envProblem: "没有引擎" }).text, /没有引擎/);
  assert.equal(Model.pickStatus({}), null, "没事的时候这一行不存在");
  assert.equal(Model.pickStatus({ running: { cmd: "render", stage: "final" }, canCancel: false }).action, null, "AI 启动的出片不能从这里取消");
});

test("overlayAt previews a pending swap at the right source time", () => {
  let rows = Model.buildRows({ edl, plan, edits: null });
  const doc = Model.upsertEdit(null, Model.makeReplaceShot(rows[0].shots[0], { src: "D:\\素材\\x.mp4", inSec: 10, kind: "video" }));
  rows = Model.buildRows({ edl, plan, edits: doc });
  const hit = Model.overlayAt(rows, 1.5);
  assert.equal(hit.kind, "video");
  assert.equal(hit.src, "D:\\素材\\x.mp4");
  assert.equal(hit.sourceTime, 11.5);
  assert.equal(Model.overlayAt(rows, 3.5), null, "别的镜头不盖");
  assert.equal(Model.overlayAt(rows, 1.5, () => false), null, "已进成片的改动不用再盖");
  const photo = Model.upsertEdit(null, Model.makeReplaceShot(rows[0].shots[1], { src: "D:\\素材\\y.jpg", kind: "photo" }));
  assert.equal(Model.overlayAt(Model.buildRows({ edl, plan, edits: photo }), 3.5).kind, "photo");
});

test("skipDeleted jumps over a sentence that is going away", () => {
  let rows = Model.buildRows({ edl, plan, edits: null });
  rows = Model.buildRows({ edl, plan, edits: Model.upsertEdit(null, Model.makeDeleteBeat(rows[1])) });
  assert.equal(Model.skipDeleted(rows, 6), 9);
  assert.equal(Model.skipDeleted(rows, 1), null);
});

test("cueAt finds the caption showing at a moment", () => {
  const cues = [{ start: 0, end: 1, text: "甲" }, { start: 1, end: 2, text: "乙" }];
  assert.equal(Model.cueAt(cues, 1.5), "乙");
  assert.equal(Model.cueAt(cues, 5), "");
  assert.equal(Model.cueAt(null, 1), "");
});

test("skimInfo maps pointer position to time and strip tile", () => {
  assert.deepEqual(plain(Model.skimInfo(0.5, 20, 10)), { fraction: 0.5, time: 10, tile: 5 });
  assert.equal(Model.skimInfo(1, 20, 10).tile, 9, "最右边不能越界");
  assert.equal(Model.skimInfo(-3, 20, 10).time, 0);
});

test("clampIn leaves enough footage after the in-point", () => {
  assert.deepEqual(plain(Model.clampIn(5, 20, 3)), { in: 5, tooShort: false });
  assert.deepEqual(plain(Model.clampIn(19, 20, 3)), { in: 17, tooShort: false }, "点得太靠后就往前挪，不用放慢");
  assert.deepEqual(plain(Model.clampIn(1, 2, 3)), { in: 0, tooShort: true });
  assert.deepEqual(plain(Model.clampIn(7.26, 20, null)), { in: 7.3, tooShort: false });
});

test("stripCover keeps the window inside one tile for any aspect ratio", () => {
  // 竖屏格子放横屏帧：高度撑满，宽度裁掉两边
  const wide = Model.stripCover({ tile: 2, frames: 10, tileW: 200, tileH: 112, boxW: 90, boxH: 160 });
  const scale = 160 / 112;
  assert.equal(wide.size, `${(2000 * scale).toFixed(1)}px 160.0px`);
  const x = Number(wide.position.split("px")[0]);
  assert.ok(Math.abs(x - (-(2 * 200 * scale) + (90 - 200 * scale) / 2)) < 0.1);
  assert.ok(-x >= 2 * 200 * scale && -x + 90 <= 3 * 200 * scale, "不能露出相邻帧");
  const tall = Model.stripCover({ tile: 0, frames: 10, tileW: 200, tileH: 356, boxW: 90, boxH: 160 });
  assert.equal(tall.position.split(" ")[0], "0.0px");
});

test("undo and redo restore content and keep labels", () => {
  const a = Model.addNote(null, { beat: "b01", shot: null, text: "甲" });
  const b = Model.addNote(a, { beat: "b01", shot: null, text: "乙" });
  let history = Model.recordHistory({ past: [], future: [] }, a, b, "写意见");
  const undone = Model.undoHistory(history, b);
  assert.equal(undone.label, "写意见");
  assert.equal(undone.doc.notes.length, 1);
  history = undone.history;
  assert.equal(history.future.length, 1);
  const redone = Model.redoHistory(history, undone.doc);
  assert.equal(redone.doc.notes.length, 2);
  assert.equal(Model.undoHistory({ past: [], future: [] }, b), null);
  assert.equal(Model.redoHistory({ past: [], future: [] }, b), null);
  const fresh = Model.recordHistory(redone.history, b, a, "新操作");
  assert.equal(fresh.future.length, 0, "新操作后不能再重做");
});

test("撤销和重做只应用原操作，保留后来发送或清理的意见", () => {
  const initial = Model.normalizeDoc(null);
  const noted = Model.addNote(initial, { beat: "b01", shot: null, text: "慢一点" });
  const row = Model.buildRows({ edl, plan, edits: null })[1];
  const edited = Model.upsertEdit(noted, Model.makeSetSay(row, "新的第二句"));
  const noteHistory = Model.recordHistory({ past: [], future: [] }, initial, noted, "写意见");
  const history = Model.recordHistory(noteHistory, noted, edited, "改第二句");
  const sent = Model.markNotesSent(edited, [noted.notes[0].id], 1000);
  const undone = Model.undoHistory(history, sent);
  assert.equal(undone.doc.edits.length, 0);
  assert.equal(undone.doc.notes[0].sentAt, 1000);

  const pruned = Model.pruneSentNotes(undone.doc, 2000);
  const undoneNote = Model.undoHistory(undone.history, pruned);
  const redoneNote = Model.redoHistory(undoneNote.history, undoneNote.doc);
  assert.equal(redoneNote.doc.notes.length, 0);
  const redoneEdit = Model.redoHistory(redoneNote.history, redoneNote.doc);
  assert.equal(redoneEdit.doc.notes.length, 0);
  assert.equal(redoneEdit.doc.edits[0].value.say, "新的第二句");
});

test("撤销重试时保留其他编辑，并能识别重新读盘后属性顺序不同的同一改动", () => {
  const initial = Model.normalizeDoc(null);
  const rows = Model.buildRows({ edl, plan, edits: initial });
  const edited = Model.upsertEdit(initial, Model.makeSetSay(rows[0], "改第一句"));
  const history = Model.recordHistory({ past: [], future: [] }, initial, edited, "改第一句");
  const external = Model.upsertEdit(edited, Model.makeSetSay(rows[1], "改第二句"));
  const reordered = external.edits.map((edit) => Object.fromEntries(Object.entries(edit).reverse()));
  const undone = Model.undoHistory(history, { ...external, edits: reordered, revision: 3 });
  assert.equal(undone.doc.revision, 3);
  assert.deepEqual(plain(undone.doc.edits.map((edit) => edit.value.say)), ["改第二句"]);
});

test("cleanCopyText strips the character-count note before copying", () => {
  assert.equal(Model.cleanCopyText("元江过冬住哪？看你住多久（12 字）"), "元江过冬住哪？看你住多久");
  assert.equal(Model.cleanCopyText("没有备注的标题"), "没有备注的标题");
  assert.equal(Model.cleanCopyText("A(20字)"), "A");
  assert.equal(Model.cleanCopyText("住 3 个月（北方）"), "住 3 个月（北方）", "普通括号不能动");
});

test("时长文案和播放器同一个取整规则，不差 1 秒", () => {
  assert.equal(Model.humanDuration(42.6), "42 秒");
  assert.equal(Model.fmtTime(42.6), "00:42");
  assert.equal(Model.humanDuration(60), "1 分钟");
  assert.equal(Model.humanDuration(125.9), "2 分 5 秒");
  assert.equal(Model.humanDuration(Number.NaN), "");
});

test("回到工作台：还是那条视频就接着看，出了新版本就从头看新版", () => {
  const saved = { version: "a_v3.mp4", time: 20.5, tab: "changes", scrollTop: 300, picker: { beat: "b03", shotIdx: 1 } };
  assert.deepEqual(plain(Model.resolveResume(saved, "a_v3.mp4")), {
    tab: "changes", time: 20.5, scrollTop: 300, picker: { beat: "b03", shotIdx: 1 },
  });
  assert.deepEqual(plain(Model.resolveResume(saved, "a_v4.mp4")), {
    tab: "changes", time: 0, scrollTop: 0, picker: null,
  }, "离开期间出了新版本，面板标签照旧，其余从头");
  assert.equal(Model.resolveResume(null, "a_v3.mp4"), null);
  assert.deepEqual(plain(Model.resolveResume({ version: "a_v3.mp4", time: "x", tab: "bad", scrollTop: -1, picker: { beat: 1 } }, "a_v3.mp4")), {
    tab: "script", time: 0, scrollTop: 0, picker: null,
  }, "存坏的数据当没有");
});

test("路径比较不管斜杠方向、大小写和 ..", () => {
  assert.equal(Model.normalizePath("D:/jiang/a/../b/./c.mp4"), "D:\\jiang\\b\\c.mp4");
  assert.equal(Model.normalizePath("/Users/x/../y.mp4"), "/Users/y.mp4");
  assert.equal(Model.samePath("D:/Jiang/视频/a.MP4", "d:\\jiang\\视频\\a.mp4"), true);
  assert.equal(Model.samePath("D:\\a\\b.mp4", "D:\\a\\c.mp4"), false);
  assert.equal(Model.samePath("", ""), false);
});

test("按 edl 引用原文找素材：编号不分大小写、文件名、正斜杠或带 .. 的路径、相对工程目录", () => {
  const items = new Map([
    ["D:\\素材\\001.mp4", { id: "V01", name: "001.mp4", path: "D:\\素材\\001.mp4", kind: "video" }],
    ["D:\\素材\\002.jpg", { id: "P02", name: "002.jpg", path: "D:\\素材\\002.jpg", kind: "photo" }],
    ["D:\\proj\\work\\card.png", { id: "P03", name: "card.png", path: "D:\\proj\\work\\card.png", kind: "photo" }],
  ]);
  assert.equal(Model.findSourceItem(items, "v01")?.id, "V01");
  assert.equal(Model.findSourceItem(items, "002.jpg")?.id, "P02");
  assert.equal(Model.findSourceItem(items, "D:/素材/001.mp4")?.id, "V01");
  assert.equal(Model.findSourceItem(items, "D:\\proj\\..\\素材\\002.jpg")?.id, "P02");
  assert.equal(Model.findSourceItem(items, "work/card.png", "D:\\proj")?.id, "P03");
  assert.equal(Model.findSourceItem(items, "V99"), null);
  assert.equal(Model.findSourceItem(null, "V01"), null);
});

test("原镜头：没换过时用时间表里引擎解析好的路径", () => {
  const rows = Model.buildRows({ edl, plan, edits: null });
  const shot = rows[0].shots[0];
  assert.equal(shot.planReplaced, false);
  assert.deepEqual(plain(Model.resolveOriginalShot(shot)), {
    kind: "video", path: "D:\\素材\\a.mp4", rawSrc: "D:\\素材\\a.mp4", inSec: 2,
  });
  assert.equal(Model.resolveOriginalShot(rows[1].shots[0]).kind, "scene");
});

test("原镜头：换过并出了片后，时间表里是换上的素材，要按 edl 原文找回最初那个", () => {
  // edl 用正斜杠写路径（真实工程里有），清单里是反斜杠
  const fwd = plain(edl);
  fwd.beats[0].shots[0].src = "D:/素材/a.mp4";
  const items = new Map([
    ["D:\\素材\\a.mp4", { path: "D:\\素材\\a.mp4", kind: "video" }],
    ["D:\\素材\\x.mp4", { path: "D:\\素材\\x.mp4", kind: "video" }],
    ["D:\\素材\\y.mp4", { path: "D:\\素材\\y.mp4", kind: "video" }],
  ]);
  const replaced = plain(plan);
  replaced.shots[0] = { ...replaced.shots[0], path: "D:\\素材\\x.mp4", in: 1 };
  replaced.renderedAt = 2000;
  replaced.editsApplied = ["e1"];

  // 出片后又点了 y：upsertEdit 沿用 e1、刷新 createdAt，按时间看「没出片」，但成片里已经是 x 了
  const repicked = { edits: [{ id: "e1", op: "replace_shot", beat: "b01", shot: 0, createdAt: 3000,
    base: { src: "D:/素材/a.mp4", in: 2 }, value: { src: "D:\\素材\\y.mp4", in: 0.5 } }] };
  const shot = Model.buildRows({ edl: fwd, plan: replaced, edits: repicked })[0].shots[0];
  assert.equal(Model.isEditInPlan(replaced, shot.replace), false);
  assert.equal(shot.planReplaced, true);

  const orig = Model.resolveOriginalShot(shot, { items });
  assert.equal(orig.path, "D:\\素材\\a.mp4");
  assert.equal(orig.inSec, 2);
  assert.equal(Model.isOriginalShotSource(shot, items.get("D:\\素材\\a.mp4"), { items }), true);
  assert.equal(Model.isOriginalShotSource(shot, items.get("D:\\素材\\x.mp4"), { items }), false, "上一次换上的 x 不是原镜头");
  assert.equal(Model.isOriginalShotSource(shot, items.get("D:\\素材\\y.mp4"), { items }), false);

  // 清单还没读到时也不能把 x 当原镜头：退回 edl 原文
  const early = Model.resolveOriginalShot(shot);
  assert.equal(Model.samePath(early.path, "D:\\素材\\a.mp4"), true);

  // 编号引用、清单里没有对应项时找不到就是找不到，不拿时间表里的 x 顶替
  const byId = plain(fwd);
  byId.beats[0].shots[0].src = "V01";
  const idShot = Model.buildRows({ edl: byId, plan: replaced, edits: repicked })[0].shots[0];
  assert.equal(Model.resolveOriginalShot(idShot, { items }).path, null);
  const withId = new Map([...items, ["D:\\素材\\a.mp4", { id: "V01", path: "D:\\素材\\a.mp4", kind: "video" }]]);
  assert.equal(Model.resolveOriginalShot(idShot, { items: withId }).path, "D:\\素材\\a.mp4");
});

test("撤掉已出片的改动：算待生成，AI 吸收了的、又改成别的、成片里没有的都不算", () => {
  const rendered = plain(plan);
  rendered.shots[0] = { ...rendered.shots[0], path: "D:\\素材\\x.mp4", in: 1 };
  rendered.renderedAt = 2000;
  rendered.editsApplied = ["e1", "e2"];
  const e1 = { id: "e1", op: "replace_shot", beat: "b01", shot: 0, createdAt: 1000,
    base: { src: "D:\\素材\\a.mp4", in: 2 }, value: { src: "D:\\素材\\x.mp4", in: 1 } };
  const e2 = { id: "e2", op: "set_say", beat: "b02", createdAt: 1000, base: { say: "第二句" }, value: { say: "改过的第二句" } };
  const e3 = { id: "e3", op: "set_say", beat: "b03", createdAt: 2500, base: { say: "第三句" }, value: { say: "还没出片" } };

  const before = Model.normalizeDoc({ edits: [e1, e2, e3] });
  const after = Model.trackRemovedEdits(before, Model.normalizeDoc({ edits: [] }), [rendered]);
  assert.deepEqual(plain(after.removedEdits.map((edit) => edit.id)), ["e1", "e2"]);
  const reloaded = plain(after);
  const reverted = Model.revertedEdits({ plan: rendered, edl, doc: reloaded });
  assert.deepEqual(plain(reverted.map((edit) => edit.id)), ["e1", "e2"], "e3 没进过成片，删了就是删了");
  const whileRendering = Model.trackRemovedEdits(before, Model.normalizeDoc({ edits: [] }), [rendered], true);
  const completed = { ...rendered, renderedAt: 3000, editsApplied: [e3.id] };
  assert.deepEqual(plain(Model.revertedEdits({ plan: completed, edl, doc: whileRendering })), [e3]);

  // 用户又换了别的素材：新改动本身就是待生成，不重复算
  const again = { id: "e9", op: "replace_shot", beat: "b01", shot: 0, createdAt: 3000, base: e1.base, value: { src: "D:\\素材\\y.mp4" } };
  assert.equal(Model.revertedEdits({ plan: rendered, edl, doc: { edits: [again], removedEdits: [e1] } }).length, 0);
  // 放回去了
  assert.equal(Model.revertedEdits({ plan: rendered, edl, doc: { edits: [e1], removedEdits: [e1] } }).length, 0);
  // AI 已经把换镜头写进 edl：再生成也还是 x，不算撤回
  const absorbed = plain(edl);
  absorbed.beats[0].shots[0] = { src: "D:\\素材\\x.mp4", in: 1 };
  assert.equal(Model.revertedEdits({ plan: rendered, edl: absorbed, doc: { edits: [], removedEdits: [e1] } }).length, 0);

  // 撤销「恢复」：原样放回，成片里就是它
  const restored = Model.trackRemovedEdits(reloaded, Model.restoreEdit(reloaded, e1), [rendered]);
  assert.deepEqual(plain(restored.edits), [e1]);
  assert.deepEqual(plain(restored.removedEdits), [e2]);
  assert.equal(Model.describeRevert(e1, Model.buildRows({ edl, plan, edits: null })), "第 1 句第 1 个镜头恢复原镜头");
  assert.equal(Model.describeRevert(e2, Model.buildRows({ edl, plan, edits: null })), "第 2 句恢复原文");
});

test("撤掉已出片的换镜头后，预览盖回原镜头，原镜头标记也跟着回到 edl 原样", () => {
  const rendered = plain(plan);
  rendered.shots[0] = { ...rendered.shots[0], path: "D:\\素材\\x.mp4", in: 1 };
  rendered.renderedAt = 2000;
  rendered.editsApplied = ["e1"];
  const e1 = { id: "e1", op: "replace_shot", beat: "b01", shot: 0, createdAt: 1000,
    base: { src: "D:\\素材\\a.mp4", in: 2 }, value: { src: "D:\\素材\\x.mp4", in: 1 } };
  const reverted = Model.revertedEdits({ plan: rendered, edl, doc: { edits: [], removedEdits: [e1] } });
  const rows = Model.buildRows({ edl, plan: rendered, edits: { edits: [] }, reverted });
  const shot = rows[0].shots[0];
  assert.equal(shot.replace, null);
  assert.equal(shot.revert.id, "e1");
  assert.equal(shot.planReplaced, true);
  assert.equal(Model.resolveOriginalShot(shot).path, "D:\\素材\\a.mp4", "时间表里的 x 不能当原镜头");

  const resolve = (item) => Model.resolveOriginalShot(item);
  assert.deepEqual(plain(Model.overlayAt(rows, 1, () => true, resolve)), {
    kind: "video", src: "D:\\素材\\a.mp4", shot: plain(shot), sourceTime: 3,
  });
  assert.equal(Model.overlayAt(rows, 1, () => true), null, "没有原素材路径就不盖");
  assert.equal(Model.overlayAt(rows, 3.5, () => true, resolve), null, "其他镜头不受影响");

  // 没撤掉时照常：已出片的换镜头不盖预览
  const kept = Model.buildRows({ edl, plan: rendered, edits: { edits: [e1] } });
  assert.equal(Model.overlayAt(kept, 1, (edit) => !Model.isEditInPlan(rendered, edit), resolve), null);
});

test("换回 edl 原来的素材就撤销这条改动，edl 用正斜杠写路径也认", () => {
  const fwd = plain(edl);
  fwd.beats[0].shots[0].src = "D:/素材/a.mp4";
  const shot = Model.buildRows({ edl: fwd, plan, edits: null })[0].shots[0];
  let doc = Model.upsertEdit(null, Model.makeReplaceShot(shot, { src: "D:\\素材\\x.mp4", inSec: 1, kind: "video" }));
  assert.equal(doc.edits.length, 1);
  doc = Model.upsertEdit(doc, Model.makeReplaceShot(shot, { src: "D:\\素材\\a.mp4", inSec: 2, kind: "video" }));
  assert.equal(doc.edits.length, 0, "换回原素材原起点 = 没改");
  doc = Model.upsertEdit(doc, Model.makeReplaceShot(shot, { src: "D:\\素材\\a.mp4", inSec: 4, kind: "video" }));
  assert.equal(doc.edits.length, 1, "同一个素材换了起点还是改动");
});

test("「已用」按改动后的样子算：换上的算、换下的不算、要删的句子不算、路径写法不同也是同一个", () => {
  const e1 = { id: "e1", op: "replace_shot", beat: "b01", shot: 0, createdAt: 1, base: { src: "D:\\素材\\a.mp4", in: 2 }, value: { src: "D:/素材/X.mp4" } };
  const del = { id: "e2", op: "delete_beat", beat: "b03", createdAt: 1, base: { say: "第三句" } };
  const rows = Model.buildRows({ edl, plan, edits: { edits: [e1, del] } });
  const used = Model.usedSourceKeys(rows);
  assert.equal(used.has(Model.pathKey("D:\\素材\\x.mp4")), true, "换上的 x");
  assert.equal(used.has(Model.pathKey("D:\\素材\\a.mp4")), false, "被换下的 a");
  assert.equal(used.has(Model.pathKey("D:\\素材\\b.jpg")), true);
  assert.equal(used.has(Model.pathKey("D:\\素材\\c.mp4")), false, "第三句要删掉");
  assert.equal(used.size, 2, "动画镜头不占素材");

  // 撤掉已出片的换镜头后，用的是 resolveOriginal 找回的原素材，不是时间表里的
  const rendered = plain(plan);
  rendered.shots[0] = { ...rendered.shots[0], path: "D:\\素材\\x.mp4" };
  rendered.renderedAt = 2000;
  rendered.editsApplied = ["e1"];
  const reverted = Model.revertedEdits({ plan: rendered, edl, doc: { edits: [], removedEdits: [{ ...e1, value: { src: "D:\\素材\\x.mp4" } }] } });
  const revRows = Model.buildRows({ edl, plan: rendered, edits: null, reverted });
  const revUsed = Model.usedSourceKeys(revRows, (shot) => Model.resolveOriginalShot(shot));
  assert.equal(revUsed.has(Model.pathKey("D:\\素材\\a.mp4")), true);
  assert.equal(revUsed.has(Model.pathKey("D:\\素材\\x.mp4")), false);
});

test("画面上能点的地方：字幕、当时在屏上的字卡、当前镜头；横竖屏位置不同", () => {
  const withCues = {
    ...plain(plan),
    cues: [{ start: 0.1, end: 2, text: "第一句", beat: 0 }, { start: 5.2, end: 8, text: "二", beat: 1 }],
    texts: [
      { style: "title", text: "钩子", pos: "upper", start: 0, end: 1.5, beat: null },
      { style: "loc", text: "地点", pos: "lower", start: 1, end: 3, beat: 0 },
      { style: "tag", text: "坏位置", pos: 640, start: 0, end: 3, beat: 0 },
    ],
    captions_cfg: { position: "bottom" },
  };
  const rows = Model.buildRows({ edl, plan: withCues, edits: null });
  const spots = plain(Model.frameHotspots({ plan: withCues, rows, time: 1.2 }));
  assert.deepEqual(spots.map((spot) => spot.kind), ["caption", "text", "text", "shot"], "字卡排在字幕后面，盖得住");
  assert.deepEqual(spots[0], { kind: "caption", beat: "b01", text: "第一句", top: 0.66, bottom: 0.82 });
  assert.equal(spots[1].text, "钩子");
  assert.ok(Math.abs(spots[1].top - 0.175) < 1e-9 && Math.abs(spots[1].bottom - 0.325) < 1e-9, "标题字卡更高");
  assert.equal(spots[2].text, "地点");
  assert.deepEqual(spots[3], { kind: "shot", beat: "b01", shot: 0 });

  const later = plain(Model.frameHotspots({ plan: withCues, rows, time: 3.5 }));
  assert.deepEqual(later.map((spot) => spot.kind), ["shot"], "没字幕的空档只剩换镜头");
  assert.equal(later[0].shot, 1);

  const wide = plain(Model.frameHotspots({ plan: { ...withCues, captions_cfg: { position: "bottom" } }, rows, time: 1.2, landscape: true }));
  assert.deepEqual([wide[0].top, wide[0].bottom], [0.75, 0.93]);

  // 要删掉的句子、没有时间表时不给点
  const deleted = Model.buildRows({ edl, plan: withCues, edits: { edits: [{ id: "d", op: "delete_beat", beat: "b01", base: { say: "第一句" } }] } });
  assert.equal(Model.frameHotspots({ plan: withCues, rows: deleted, time: 1.2 }).length, 0);
  assert.equal(Model.frameHotspots({ plan: null, rows, time: 1.2 }).length, 0);
});

test("试看改后效果：只有存在未出片的本地改动或全片改语速时才出现", () => {
  const baseRows = Model.buildRows({ edl, plan, edits: null });
  assert.equal(Model.rowNeedsSample(baseRows[0]), false, "没改过的句子不显示");
  assert.equal(Model.rowNeedsSample(baseRows[0], { voicePending: true }), true, "全片改语速后任意未删句都可试看");

  let doc = Model.upsertEdit(null, Model.makeSetSay(baseRows[0], "改过字"));
  doc = Model.upsertEdit(doc, Model.makeReplaceShot(baseRows[2].shots[0], { src: "D:\\素材\\x.mp4", inSec: 1, kind: "video" }));
  doc = Model.upsertEdit(doc, Model.makeDeleteBeat(baseRows[1]));
  const rows = Model.buildRows({ edl, plan, edits: doc });
  assert.equal(Model.rowNeedsSample(rows[0]), true, "改过字需要试看");
  assert.equal(Model.rowNeedsSample(rows[0], { isRendered: () => true }), false, "已进当前成片的改动不需要再试看");
  assert.equal(Model.rowNeedsSample(rows[1], { voicePending: true }), false, "删掉的句子不显示试看");
  assert.equal(Model.rowNeedsSample(rows[2]), true, "换过镜头需要试看");
});

test("帧条悬停提示：时间加这一句开头，太长截断", () => {
  const rows = Model.buildRows({ edl, plan, edits: null });
  assert.equal(Model.stripLabel(rows, 1), "00:01 · 第一句");
  assert.equal(Model.stripLabel([{ ...rows[0], say: "一二三四五六七八九十甲乙丙丁戊己" }], 1), "00:01 · 一二三四五六七八九十甲乙丙丁…");
  assert.equal(Model.stripLabel(rows, 99), "01:39", "超出范围只给时间");
});

test("播放倍速循环与格式化", () => {
  assert.equal(Model.nextPlaybackRate(1), 1.25);
  assert.equal(Model.nextPlaybackRate(1.25), 1.5);
  assert.equal(Model.nextPlaybackRate(1.5), 2);
  assert.equal(Model.nextPlaybackRate(2), 1);
  assert.equal(Model.formatPlaybackRate(1), "1x");
  assert.equal(Model.formatPlaybackRate(1.25), "1.25x");
});

test("主操作按钮文案按路由清晰区分直接渲染与发给 AI", () => {
  assert.equal(Model.applyButtonMeta({ editCount: 0, noteCount: 0 }).route, "none");
  const renderMeta = Model.applyButtonMeta({ editCount: 2, noteCount: 0 });
  assert.equal(renderMeta.route, "render");
  assert.equal(renderMeta.label, "生成新版本（2）");
  const aiMeta = Model.applyButtonMeta({ editCount: 2, noteCount: 1 });
  assert.equal(aiMeta.route, "ai");
  assert.equal(aiMeta.label, "发给 AI 处理（3）");
});

test("脚本筛选：支持按口播、字卡、意见、素材名搜索，并支持仅看改动", () => {
  let doc = Model.upsertEdit(null, Model.makeSetSay(Model.buildRows({ edl, plan, edits: null })[0], "修改后的开头"));
  doc = Model.addNote(doc, { beat: "b03", shot: null, text: "这句加点空镜" });
  const rows = Model.buildRows({ edl, plan, edits: doc });

  assert.equal(Model.filterRows(rows, { query: "26 公里" }).map((r) => r.id).join(","), "b02");
  assert.equal(Model.filterRows(rows, { query: "空镜" }).map((r) => r.id).join(","), "b03");
  assert.equal(Model.filterRows(rows, { query: "第一句" }).map((r) => r.id).join(","), "b01", "应能搜到改字前的原文");
  assert.equal(Model.filterRows(rows, { onlyModified: true }).map((r) => r.id).join(","), "b01,b03");
  assert.equal(Model.filterRows(rows, { query: "开头", onlyModified: true }).map((r) => r.id).join(","), "b01");
});

test("候选素材搜索：同时匹配文件名、备注与编号（不区分大小写）", () => {
  const item = { id: "V12", name: "IMG_2048.MP4", notes: "元江江边日落航拍" };
  assert.equal(Model.sourceMatchesQuery(item, "日落"), true);
  assert.equal(Model.sourceMatchesQuery(item, "img_2048"), true);
  assert.equal(Model.sourceMatchesQuery(item, "v12"), true);
  assert.equal(Model.sourceMatchesQuery(item, "泳池"), false);
  assert.equal(Model.sourceMatchesQuery(item, ""), true);
});

test("实时编辑字卡、开头钩子与配乐音量：支持改字、删字卡、改回原样自动撤销及实时叠层计算", () => {
  const richEdl = {
    ...plain(edl),
    hook: { text: "梯田里过哈尼新年", sub: "玉溪元江", pos: "upper", dur: 2.6 },
    music: { track: "bgm.wav", gain_db: -1 },
    beats: [
      { ...plain(edl.beats[0]), texts: [{ text: "昆明自驾 2.5 小时", style: "tag", pos: "upper" }, { text: "那诺梯田", style: "loc", pos: "lower" }] },
      ...plain(edl.beats.slice(1)),
    ],
  };
  const richPlan = {
    ...plain(plan),
    texts: [
      { hook: true, beat: null, style: "title", text: "梯田里过哈尼新年", sub: "玉溪元江", pos: "upper", start: 0, end: 2.6 },
      { beat: 0, idx: 0, style: "tag", text: "昆明自驾 2.5 小时", pos: "upper", start: 0.5, end: 2.5 },
      { beat: 0, idx: 1, style: "loc", text: "那诺梯田", pos: "lower", start: 2.0, end: 4.5 },
    ],
  };

  let rows = Model.buildRows({ edl: richEdl, plan: richPlan, edits: null });
  assert.equal(rows[0].cards.length, 2);
  let doc = Model.upsertEdit(null, Model.makeSetText(rows[0], rows[0].cards[0], { text: "昆明出发 2.5 小时", pos: "center" }));
  doc = Model.upsertEdit(doc, Model.makeDeleteText(rows[0], rows[0].cards[1]));
  doc = Model.upsertEdit(doc, Model.makeSetHook(richEdl, { text: "元江哈尼十月年", sub: "那诺梯田", pos: "top" }));
  doc = Model.upsertEdit(doc, Model.makeSetMusic(richEdl, -5));
  assert.equal(doc.edits.length, 4);

  rows = Model.buildRows({ edl: richEdl, plan: richPlan, edits: doc });
  const hook = Model.buildHook({ edl: richEdl, plan: richPlan, edits: doc });
  assert.equal(rows[0].cards[0].text, "昆明出发 2.5 小时");
  assert.equal(rows[0].cards[0].pos, "center");
  assert.equal(rows[0].cards[1].deleted, true);
  assert.equal(hook.text, "元江哈尼十月年");
  assert.equal(Model.rowHasChanges(rows[0]), true);

  const live = Model.liveOverlaysAt({ rows, hook, plan: richPlan, time: 1.5, landscape: false });
  assert.equal(live.cards.length, 2, "钩子 + 第 1 张字卡应实时显示，已删的第 2 张不显示");
  assert.equal(live.cards[0].isHook, true);
  assert.equal(live.cards[0].text, "元江哈尼十月年");
  assert.equal(live.cards[1].text, "昆明出发 2.5 小时");
  assert.equal(Model.hasPendingLiveVisualEdits({ rows, hook }), true);

  // 改回原样自动移除改动
  doc = Model.upsertEdit(doc, Model.makeSetText(rows[0], rows[0].cards[0], { text: "昆明自驾 2.5 小时", pos: "upper" }));
  doc = Model.upsertEdit(doc, Model.makeSetMusic(richEdl, -1));
  assert.equal(doc.edits.length, 2);
});

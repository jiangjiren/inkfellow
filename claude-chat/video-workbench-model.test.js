import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../desktop-lite/video-workbench-model.js", import.meta.url), "utf8");
const context = vm.createContext({});
vm.runInContext(source, context);
const Model = context.InkfellowVideoModel;
const plain = (value) => JSON.parse(JSON.stringify(value));

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
  let history = Model.recordHistory({ past: [], future: [] }, a, "写意见");
  const undone = Model.undoHistory(history, b);
  assert.equal(undone.label, "写意见");
  assert.equal(undone.doc.notes.length, 1);
  history = undone.history;
  assert.equal(history.future.length, 1);
  const redone = Model.redoHistory(history, undone.doc);
  assert.equal(redone.doc.notes.length, 2);
  assert.equal(Model.undoHistory({ past: [], future: [] }, b), null);
  assert.equal(Model.redoHistory({ past: [], future: [] }, b), null);
  const fresh = Model.recordHistory(redone.history, b, "新操作");
  assert.equal(fresh.future.length, 0, "新操作后不能再重做");
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

/* 视频工作台的纯逻辑：不碰 DOM，方便在 node 里测试。接口约定见 _design/video-workbench-contract.md */
(function (root) {
  const STEP_DEFS = [
    { key: "probe", label: "素材" },
    { key: "script", label: "口播稿" },
    { key: "voice", label: "配音" },
    { key: "plan", label: "分镜" },
    { key: "preview", label: "预览" },
    { key: "qa", label: "自检" },
    { key: "final", label: "正式版" },
    { key: "cover", label: "封面" },
    { key: "publish", label: "文案" },
  ];

  const STAGE_LABELS = {
    run: "准备中",
    plan: "排时间轴",
    shots: "处理镜头",
    assemble: "拼接画面",
    mix: "混音",
    final: "合成导出",
  };

  const PHOTO_RE = /\.(jpe?g|png|webp|bmp|heic|heif|tiff?)$/i;

  function fmtTime(seconds) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "--:--";
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function baseName(path) {
    return String(path || "").split(/[\\/]/).pop() || "";
  }

  function dirName(path) {
    const text = String(path || "");
    const cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
    return cut > 0 ? text.slice(0, cut) : "";
  }

  /* edl 里的 src 是原文：可能是正斜杠、带 ..、相对工程目录；清单和时间表里是引擎解析过的绝对路径。
     比较前统一成同一种写法，否则同一个文件会被当成两个 */
  function isAbsolutePath(path) {
    return /^[a-zA-Z]:[\\/]/.test(path) || /^[\\/]/.test(path);
  }

  function normalizePath(path) {
    const text = String(path || "").trim();
    if (!text) return "";
    const sep = text.includes("\\") || /^[a-zA-Z]:/.test(text) ? "\\" : "/";
    const lead = /^[\\/]{2}/.test(text) ? sep + sep : (/^[\\/]/.test(text) ? sep : "");
    const out = [];
    for (const part of text.split(/[\\/]+/)) {
      if (!part || part === ".") continue;
      if (part === ".." && out.length && out[out.length - 1] !== ".." && !/^[a-zA-Z]:$/.test(out[out.length - 1])) out.pop();
      else out.push(part);
    }
    return lead + out.join(sep);
  }

  function joinPath(dir, ref) {
    const base = String(dir || "");
    if (!base || isAbsolutePath(ref)) return normalizePath(ref);
    const sep = base.includes("\\") ? "\\" : "/";
    return normalizePath(`${base}${sep}${ref}`);
  }

  /* 比较用的键：Windows 路径不分大小写，斜杠方向无所谓 */
  function pathKey(path) {
    return normalizePath(path).replace(/\\/g, "/").toLowerCase();
  }

  function samePath(a, b) {
    return Boolean(a) && Boolean(b) && pathKey(a) === pathKey(b);
  }

  function normalizeDoc(doc) {
    return {
      version: 1,
      revision: Number(doc?.revision) || 0,
      edits: Array.isArray(doc?.edits) ? doc.edits : [],
      notes: Array.isArray(doc?.notes) ? doc.notes : [],
      removedEdits: Array.isArray(doc?.removedEdits) ? doc.removedEdits : [],
    };
  }

  function beatIdOf(beat, index) {
    return beat?.id || `b${String(index + 1).padStart(2, "0")}`;
  }

  function newId(prefix) {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  /* 改动和意见的定位键：同一个目标只留一条 */
  function editKey(edit) {
    if (edit.op === "replace_shot") return `shot:${edit.beat}:${edit.shot}`;
    if (edit.op === "set_text" || edit.op === "delete_text") return `text:${edit.beat}:${edit.text}`;
    if (edit.op === "set_voice") return "voice";
    if (edit.op === "set_hook") return "hook";
    if (edit.op === "set_music") return "music";
    if (edit.op === "delete_beat") return `delete:${edit.beat}`;
    return `${edit.op}:${edit.beat}`;
  }

  function sameValue(a, b) {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  }

  function sameFields(a, b, keys) {
    return keys.every((k) => {
      const va = a?.[k];
      const vb = b?.[k];
      if (typeof va === "string" || typeof vb === "string") return String(va || "").trim() === String(vb || "").trim();
      return (va ?? null) === (vb ?? null);
    });
  }

  /* 把一条改动并入文档。同目标的旧改动被替换，base 沿用最早那条（它才是 edl 里的原始值）。
     改回原样时直接撤销这条改动。 */
  function upsertEdit(doc, edit) {
    const next = normalizeDoc(doc);
    const key = editKey(edit);
    const existing = next.edits.find((item) => editKey(item) === key);
    const merged = { ...edit, id: existing?.id || edit.id || newId("e"), base: existing?.base ?? edit.base };
    const others = next.edits.filter((item) => editKey(item) !== key);
    const backToBase =
      (merged.op === "set_say" && merged.value?.say === merged.base?.say && !merged.value?.say_tts) ||
      (merged.op === "set_say_tts" && (merged.value?.say_tts ?? "") === (merged.base?.say_tts ?? "")) ||
      (merged.op === "replace_shot"
        // base.src 是 edl 原文（可能是正斜杠），value.src 是清单里的路径，写法不同也是同一个文件
        && (merged.value?.src === merged.base?.src || samePath(merged.value?.src, merged.base?.src))
        && (merged.value?.in ?? null) === (merged.base?.in ?? null)) ||
      (merged.op === "set_text" && sameFields(merged.value, { ...merged.base, pos: merged.base?.pos ?? "upper" }, ["text", "sub", "badge", "pos"])) ||
      (merged.op === "set_hook" && sameFields(merged.value, merged.base, ["text", "sub", "pos"])) ||
      (merged.op === "set_music" && (merged.value?.gain_db ?? null) === (merged.base?.gain_db ?? null));
    next.edits = backToBase ? others : [...others, merged];
    return next;
  }

  function removeEdit(doc, id) {
    const next = normalizeDoc(doc);
    next.edits = next.edits.filter((item) => item.id !== id);
    return next;
  }

  function addNote(doc, note) {
    const next = normalizeDoc(doc);
    next.notes = [...next.notes, { id: newId("n"), createdAt: Math.floor(Date.now() / 1000), sentAt: null, ...note }];
    return next;
  }

  function removeNote(doc, id) {
    const next = normalizeDoc(doc);
    next.notes = next.notes.filter((item) => item.id !== id);
    return next;
  }

  function markNotesSent(doc, ids, at) {
    const next = normalizeDoc(doc);
    const wanted = new Set(ids);
    next.notes = next.notes.map((note) => (wanted.has(note.id) ? { ...note, sentAt: at } : note));
    return next;
  }

  /* 出了新版之后，已发送的意见就完成了使命 */
  function pruneSentNotes(doc, latestMtime) {
    const next = normalizeDoc(doc);
    if (!latestMtime) return next;
    next.notes = next.notes.filter((note) => !note.sentAt || note.sentAt >= latestMtime);
    return next;
  }

  /* plan 和 edl 的段落对应：优先 id，其次同下标同文字，最后按文字找 */
  function matchPlanBeat(planBeats, editBeat, index) {
    const id = editBeat?.id;
    if (id) {
      const byId = planBeats.find((beat) => beat.id === id);
      if (byId) return byId;
    }
    const same = planBeats[index];
    if (same && (same.say || "") === (editBeat?.say || "")) return same;
    const say = editBeat?.say || "";
    if (say) {
      const bySay = planBeats.filter((beat) => (beat.say || "") === say);
      if (bySay.length === 1) return bySay[0];
    }
    return null;
  }

  function shotDisplayName(shot) {
    if (shot?.scene) return `动画：${shot.scene}`;
    return baseName(shot?.src || "");
  }

  /* 把 edl、plan、edits 合成脚本视图的行。edl 决定有哪些段，plan 提供时间。
     reverted：已经进了这版成片、又被用户撤掉的改动（见 revertedEdits），成片画面和下次生成的结果对不上 */
  function buildRows({ edl, plan, edits, reverted = [] }) {
    const doc = normalizeDoc(edits);
    const beats = Array.isArray(edl?.beats) ? edl.beats : [];
    const planBeats = Array.isArray(plan?.beats) ? plan.beats : [];
    const planShots = Array.isArray(plan?.shots) ? plan.shots : [];
    const planTexts = Array.isArray(plan?.texts) ? plan.texts : [];
    const fps = Number(plan?.fps) || 30;

    return beats.map((beat, index) => {
      const id = beatIdOf(beat, index);
      const planBeat = matchPlanBeat(planBeats, beat, index);
      const planIndex = planBeat ? (planBeat.i ?? planBeats.indexOf(planBeat)) : null;
      const start = planBeat ? planBeat.start / fps : null;
      const end = planBeat ? (planBeat.start + planBeat.frames) / fps : null;
      const beatEdits = doc.edits.filter((edit) => edit.beat === id);
      const setSay = beatEdits.find((edit) => edit.op === "set_say") || null;
      const setTts = beatEdits.find((edit) => edit.op === "set_say_tts") || null;
      const deleted = beatEdits.some((edit) => edit.op === "delete_beat");
      const shotsInPlan = planIndex == null ? [] : planShots.filter((shot) => shot.beat === planIndex);
      const rawShots = Array.isArray(beat.shots) ? beat.shots : [];

      const shots = rawShots.map((raw, idx) => {
        const planned = shotsInPlan.find((shot) => shot.idx === idx) || null;
        const replace = beatEdits.find((edit) => edit.op === "replace_shot" && edit.shot === idx) || null;
        const revert = replace
          ? null
          : ((reverted || []).find((edit) => edit.op === "replace_shot" && edit.beat === id && edit.shot === idx) || null);
        return {
          idx,
          raw,
          beat: id,
          kind: planned?.kind || (raw.scene ? "scene" : null),
          name: planned?.path ? baseName(planned.path) : shotDisplayName(raw),
          path: planned?.path || raw.src || "",
          inSec: typeof planned?.in === "number" ? planned.in : (typeof raw.in === "number" ? raw.in : null),
          start: planned ? planned.start / fps : null,
          end: planned ? (planned.start + planned.frames) / fps : null,
          planIndex: planned ? planShots.indexOf(planned) : -1,
          replace,
          revert,
          // 时间表里这个镜头已经不是 edl 原来的素材了（换过且出了片），它的 path/in 不能当原镜头用
          planReplaced: Boolean(revert) || Boolean(replace && planIncludesEdit(plan, replace)),
          notes: doc.notes.filter((note) => note.beat === id && note.shot === idx),
        };
      });

      const rawTexts = Array.isArray(beat.texts) ? beat.texts : [];
      const beatPlanTexts = planIndex == null || !planTexts.some((text) => text.beat !== undefined)
        ? []
        : planTexts.filter((text) => text.beat === planIndex);
      const cards = rawTexts.map((rawTx, txIdx) => {
        const indexed = beatPlanTexts.some((item) => Number.isInteger(item.idx));
        const plannedTx = (indexed ? beatPlanTexts.find((item) => item.idx === txIdx) : beatPlanTexts[txIdx]) || null;
        const setText = beatEdits.find((edit) => edit.op === "set_text" && edit.text === txIdx) || null;
        const deleteText = beatEdits.find((edit) => edit.op === "delete_text" && edit.text === txIdx) || null;
        const origText = rawTx.text || "";
        const origSub = rawTx.sub || "";
        const origBadge = rawTx.badge || "";
        const origPos = rawTx.pos ?? plannedTx?.pos ?? "upper";
        return {
          idx: txIdx,
          beat: id,
          style: rawTx.style || plannedTx?.style || "tag",
          text: setText ? (setText.value?.text ?? origText) : origText,
          originalText: origText,
          sub: setText && "sub" in (setText.value || {}) ? (setText.value.sub || "") : origSub,
          originalSub: origSub,
          badge: setText && "badge" in (setText.value || {}) ? (setText.value.badge || "") : origBadge,
          originalBadge: origBadge,
          pos: setText && setText.value?.pos !== undefined ? setText.value.pos : origPos,
          originalPos: origPos,
          sourcePos: rawTx.pos,
          start: typeof plannedTx?.start === "number" ? plannedTx.start : start,
          end: typeof plannedTx?.end === "number" ? plannedTx.end : end,
          deleted: Boolean(deleteText),
          setText,
          deleteText,
        };
      });

      return {
        index,
        id,
        planIndex,
        say: setSay ? setSay.value.say : (beat.say || ""),
        originalSay: beat.say || "",
        sayTts: setTts
          ? setTts.value.say_tts
          : (setSay ? (setSay.value.say_tts || "") : (beat.say_tts || "")),
        start,
        end,
        deleted,
        setSay,
        setTts,
        shots,
        cards,
        // 老工程的 plan.texts 没有 beat 字段，只能取 edl 里写的字卡
        texts: planIndex == null || !planTexts.some((text) => text.beat !== undefined)
          ? (Array.isArray(beat.texts) ? beat.texts.map((text) => ({ text: text.text, style: text.style })) : [])
          : planTexts.filter((text) => text.beat === planIndex).map((text) => ({ text: text.text, style: text.style })),
        notes: doc.notes.filter((note) => note.beat === id && (note.shot === null || note.shot === undefined)),
      };
    });
  }

  function buildHook({ edl, plan, edits }) {
    const doc = normalizeDoc(edits);
    const raw = edl?.hook && typeof edl.hook === "object" ? edl.hook : null;
    const planHook = Array.isArray(plan?.texts) ? plan.texts.find((t) => t.hook) : null;
    const edit = doc.edits.find((item) => item.op === "set_hook") || null;
    const originalText = raw?.text || "";
    const originalSub = raw?.sub || "";
    const originalPos = raw?.pos ?? planHook?.pos ?? "upper";
    const text = edit?.value?.text ?? originalText;
    const sub = edit && "sub" in (edit.value || {}) ? (edit.value.sub || "") : originalSub;
    const pos = edit && edit.value?.pos !== undefined ? edit.value.pos : originalPos;
    const deleted = Boolean(edit && !String(text).trim());
    const exists = Boolean(originalText || (edit && String(edit.value?.text || "").trim()));
    const dur = Number(raw?.dur) || 2.8;
    const start = typeof planHook?.start === "number" ? planHook.start : 0;
    const end = typeof planHook?.end === "number" ? planHook.end : Math.min(dur, Number(plan?.duration) || dur);
    return { exists, text, originalText, sub, originalSub, pos, originalPos, start, end, deleted, edit };
  }

  function rowAtTime(rows, seconds) {
    let found = null;
    for (const row of rows) {
      if (row.start === null) continue;
      if (seconds >= row.start - 0.001 && seconds < row.end) found = row;
    }
    return found;
  }

  function shotAtTime(row, seconds) {
    if (!row) return null;
    return row.shots.find((shot) => shot.start !== null && seconds >= shot.start - 0.001 && seconds < shot.end) || null;
  }

  function makeSetSay(row, say, sayTts) {
    const value = { say };
    if (sayTts) value.say_tts = sayTts;
    return {
      id: newId("e"),
      op: "set_say",
      beat: row.id,
      base: { say: row.originalSay },
      value,
      createdAt: Math.floor(Date.now() / 1000),
    };
  }

  function makeSetTts(row, rawBeat, sayTts) {
    return {
      id: newId("e"),
      op: "set_say_tts",
      beat: row.id,
      base: rawBeat?.say_tts ? { say_tts: rawBeat.say_tts } : {},
      value: { say_tts: sayTts },
      createdAt: Math.floor(Date.now() / 1000),
    };
  }

  function makeDeleteBeat(row) {
    return {
      id: newId("e"),
      op: "delete_beat",
      beat: row.id,
      base: { say: row.originalSay },
      createdAt: Math.floor(Date.now() / 1000),
    };
  }

  function makeReplaceShot(shot, { src, inSec, kind }) {
    const raw = shot.raw || {};
    const base = {};
    if (raw.src !== undefined) base.src = raw.src;
    if (raw.in !== undefined) base.in = raw.in;
    if (raw.scene !== undefined) base.scene = raw.scene;
    const value = { src };
    if (kind === "video" && typeof inSec === "number") value.in = Math.round(inSec * 100) / 100;
    const sameKind = (raw.scene ? "scene" : null) !== "scene" && kind === shot.kind;
    if (sameKind && kind === "video") {
      for (const key of ["fit", "focus", "focus_y"]) {
        if (raw[key] !== undefined) value[key] = raw[key];
      }
    }
    return {
      id: newId("e"),
      op: "replace_shot",
      beat: shot.beat,
      shot: shot.idx,
      base,
      value,
      createdAt: Math.floor(Date.now() / 1000),
    };
  }

  function makeVoiceEdit(edl, change) {
    const voice = edl?.voice && typeof edl.voice === "object" ? edl.voice : {};
    const base = {};
    for (const key of Object.keys(change)) {
      if (voice[key] !== undefined) base[key] = voice[key];
    }
    return { id: newId("e"), op: "set_voice", base, value: change, createdAt: Math.floor(Date.now() / 1000) };
  }

  function makeSetText(row, card, { text, sub, badge, pos }) {
    const base = { text: card.originalText };
    if (card.originalSub) base.sub = card.originalSub;
    if (card.originalBadge) base.badge = card.originalBadge;
    if (card.sourcePos !== undefined) base.pos = card.sourcePos;
    const value = { text: String(text || "").trim() };
    if (sub !== undefined) value.sub = String(sub || "").trim();
    if (badge !== undefined) value.badge = String(badge || "").trim();
    if (pos !== undefined) value.pos = pos;
    return {
      id: newId("e"),
      op: "set_text",
      beat: row.id,
      text: card.idx,
      base,
      value,
      createdAt: Math.floor(Date.now() / 1000),
    };
  }

  function makeDeleteText(row, card) {
    return {
      id: newId("e"),
      op: "delete_text",
      beat: row.id,
      text: card.idx,
      base: { text: card.originalText },
      createdAt: Math.floor(Date.now() / 1000),
    };
  }

  function makeSetHook(edl, { text, sub, pos }) {
    const raw = edl?.hook && typeof edl.hook === "object" ? edl.hook : {};
    const base = {};
    if (raw.text !== undefined) base.text = raw.text;
    if (raw.sub !== undefined) base.sub = raw.sub;
    if (raw.pos !== undefined) base.pos = raw.pos;
    const value = { text: String(text ?? "").trim() };
    if (value.text) {
      if (sub !== undefined) value.sub = String(sub || "").trim();
      if (pos !== undefined) value.pos = pos;
    }
    return {
      id: newId("e"),
      op: "set_hook",
      base,
      value,
      createdAt: Math.floor(Date.now() / 1000),
    };
  }

  function makeSetMusic(edl, gainDb) {
    const raw = edl?.music && typeof edl.music === "object" ? edl.music : {};
    const base = {};
    if (raw.gain_db !== undefined) base.gain_db = raw.gain_db;
    const clamped = Math.round(Math.min(12, Math.max(-30, Number(gainDb))) * 10) / 10;
    return {
      id: newId("e"),
      op: "set_music",
      base,
      value: { gain_db: clamped },
      createdAt: Math.floor(Date.now() / 1000),
    };
  }

  function statusOfEdit(editId, status) {
    const conflicts = Array.isArray(status?.conflicts) ? status.conflicts : [];
    const conflict = conflicts.find((item) => item.id === editId);
    if (conflict) return { state: "conflict", message: conflict.message || "这处改动和 AI 的修改冲突了" };
    if (Array.isArray(status?.absorbed) && status.absorbed.includes(editId)) {
      return { state: "absorbed", message: "AI 已经改好了，这条可以撤掉" };
    }
    if (Array.isArray(status?.applied) && status.applied.includes(editId)) {
      return { state: "applied", message: "生成新版本时生效" };
    }
    return { state: "pending", message: "生成新版本时生效" };
  }

  /* 改动的一句话说明，修改单列表和发给 AI 的提示都用它 */
  function describeEdit(edit, rows) {
    const row = rows.find((item) => item.id === edit.beat);
    const where = row ? `第 ${row.index + 1} 句` : (edit.beat || "");
    if (edit.op === "set_say") return `${where}改字：${edit.value?.say || ""}`;
    if (edit.op === "set_say_tts") return `${where}改读音：${edit.value?.say_tts || ""}`;
    if (edit.op === "delete_beat") return `${where}删除：${edit.base?.say || row?.originalSay || ""}`;
    if (edit.op === "replace_shot") {
      const inText = typeof edit.value?.in === "number" ? `（${edit.value.in} 秒起）` : "";
      return `${where}第 ${(edit.shot ?? 0) + 1} 个镜头换成 ${baseName(edit.value?.src)}${inText}`;
    }
    if (edit.op === "set_voice") {
      const value = edit.value?.speed !== undefined ? `${edit.value.speed} 倍` : (edit.value?.rate || "");
      return `语速改为 ${value}`;
    }
    if (edit.op === "set_text") {
      return `${where}字卡改为「${edit.value?.text || ""}」`;
    }
    if (edit.op === "delete_text") {
      return `${where}删除字卡「${edit.base?.text || ""}」`;
    }
    if (edit.op === "set_hook") {
      return edit.value?.text ? `开头钩子改为「${edit.value.text}」` : "删除开头钩子";
    }
    if (edit.op === "set_music") {
      const g = Number(edit.value?.gain_db ?? 0);
      return `配乐音量改为 ${g > 0 ? `+${g}` : g} dB`;
    }
    return where;
  }

  /* 发给 AI 的修改单，格式见接口约定 */
  function buildAiMessage({ projectPath, versionName, rows, notes, editCount }) {
    const lines = [`【视频修改单】工程：${projectPath}（当前 ${versionName || "还没有成片"}）`];
    notes.forEach((note, index) => {
      const row = rows.find((item) => item.id === note.beat);
      const number = index + 1;
      if (!row) {
        lines.push(`${number}. 全片：${note.text}`);
        return;
      }
      const shot = Number.isInteger(note.shot) ? row.shots.find((item) => item.idx === note.shot) : null;
      if (shot) {
        const range = shot.start !== null ? `${fmtTime(shot.start)}–${fmtTime(shot.end)}，` : "";
        const source = shot.kind === "scene" ? shot.name : `${shot.name}${shot.inSec !== null ? ` ${shot.inSec}秒起` : ""}`;
        lines.push(`${number}. ${row.id} 第${shot.idx + 1}个镜头（${range}${source}）：${note.text}`);
      } else {
        lines.push(`${number}. ${row.id}（${fmtTime(row.start)}）：${note.text}`);
      }
    });
    if (editCount > 0) {
      lines.push(`工作台还有 ${editCount} 处人工改动已写入 edits.json，出片时会自动叠加，不用手改。`);
    }
    return lines.join("\n");
  }

  function describeRunning(running) {
    if (!running) return "";
    if (running.cmd === "sample") return "正在生成试看…";
    const stage = STAGE_LABELS[running.stage] || "处理中";
    const what = running.preview ? "正在生成预览" : "正在生成新版本";
    if (running.stage === "shots" && running.total) return `${what}：镜头 ${running.done || 0}/${running.total}`;
    return `${what}：${stage}`;
  }

  function runningProgress(running) {
    if (!running) return null;
    // 镜头阶段常年只占全程的一小部分，真正耗时在后面的拼接和导出，不能把它显示成整体进度
    const weights = { run: 0.02, plan: 0.04, shots: 0.25, assemble: 0.45, mix: 0.55, final: 0.92 };
    if (running.stage === "shots" && running.total) {
      return 0.04 + (0.21 * (running.done || 0)) / running.total;
    }
    return weights[running.stage] ?? null;
  }

  function lastDoneCommands(journal) {
    const done = new Map();
    for (const event of Array.isArray(journal) ? journal : []) {
      if (event?.stage === "run" && event.status === "done" && event.cmd) done.set(event.cmd, event);
    }
    return done;
  }

  /* 进度条：有日志信日志，老工程按文件推断。两个来源取并集，因为 AI 的自定义脚本不进日志 */
  function deriveSteps({ facts, journal, running, versions, covers }) {
    const f = facts || {};
    const done = lastDoneCommands(journal);
    const hasFinal = Boolean(f.final) || (versions || []).some((version) => version.kind === "final");
    const hasPreview = Boolean(f.preview) || (versions || []).some((version) => version.kind === "preview");
    const hasCover = Boolean(f.cover) || (covers || []).length > 0;
    const complete = {
      probe: Boolean(f.manifest) || done.has("probe"),
      script: Boolean(f.script),
      voice: (f.voiceCount || 0) > 0 || done.has("voice"),
      plan: Boolean(f.plan) || done.has("validate"),
      preview: hasPreview,
      qa: Boolean(f.qa) || done.has("qa"),
      final: hasFinal,
      cover: hasCover,
      publish: Boolean(f.publish),
    };
    // 走到后面的步骤时前面的一定做过，哪怕没留下痕迹（比如素材清单放在别的工程）
    let seenLater = false;
    for (let i = STEP_DEFS.length - 1; i >= 0; i -= 1) {
      const key = STEP_DEFS[i].key;
      if (complete[key]) seenLater = true;
      else if (seenLater && !["cover", "publish", "preview", "qa"].includes(key)) complete[key] = true;
    }

    let activeKey = null;
    if (running) {
      if (running.cmd === "render") activeKey = running.preview ? "preview" : "final";
      else if (running.cmd === "qa") activeKey = "qa";
      else if (running.cmd === "voice") activeKey = "voice";
      else if (running.cmd === "probe") activeKey = "probe";
      else if (running.cmd === "cover") activeKey = "cover";
      else if (running.cmd === "validate") activeKey = "plan";
    }

    return STEP_DEFS.map((step) => ({
      ...step,
      state: step.key === activeKey ? "active" : (complete[step.key] ? "done" : "pending"),
    }));
  }

  /* 判断 AI 是不是半路停了：没有进程在跑、AI 也不在生成、但正式版还没出来 */
  function stoppedStep({ steps, running, agentGenerating, journal, nowSeconds }) {
    if (running || agentGenerating) return null;
    const finalStep = steps.find((step) => step.key === "final");
    if (!finalStep || finalStep.state === "done") return null;
    const events = Array.isArray(journal) ? journal : [];
    const last = events[events.length - 1];
    if (last?.ts && nowSeconds - last.ts < 30) return null;
    const pending = steps.find((step) => step.state === "pending");
    return pending || null;
  }

  function lastCommandFailure(journal) {
    const events = Array.isArray(journal) ? journal : [];
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event?.stage !== "run") continue;
      if (event.status === "error") return { cmd: event.cmd, message: event.msg || "出错了", ts: event.ts };
      if (event.status === "done") return null;
    }
    return null;
  }

  /* 素材读不到的原因：全部读不到才可能是盘没插，只缺几个多半是被挪走了 */
  function offlineSummary(missing, totalSources = 0) {
    const list = Array.isArray(missing) ? missing : [];
    if (list.length === 0) return null;
    const drives = new Map();
    for (const path of list) {
      const drive = /^[A-Za-z]:/.test(path) ? path.slice(0, 2).toUpperCase() : "";
      drives.set(drive, (drives.get(drive) || 0) + 1);
    }
    const [topDrive] = [...drives.entries()].sort((a, b) => b[1] - a[1])[0];
    const wholeDrive = drives.size === 1 && Boolean(topDrive) && totalSources > 0 && list.length >= totalSources;
    return { count: list.length, drive: topDrive, wholeDrive, names: list.slice(0, 5).map(baseName) };
  }

  /* 这条改动在这份时间表对应的成片里吗 */
  function isEditInPlan(plan, edit) {
    if (!plan?.renderedAt) return false;
    if (Array.isArray(plan.appliedEdits)) {
      const rendered = plan.appliedEdits.find((item) => item.id === edit.id);
      return Boolean(rendered
        && sameHistoryValue(rendered, edit));
    }
    if (Array.isArray(plan.editsApplied) && !plan.editsApplied.includes(edit.id)) return false;
    return (edit.createdAt || 0) < plan.renderedAt;
  }

  /* 这份成片用过这条改动吗（哪怕之后又改了值）。upsertEdit 会沿用 id、刷新 createdAt，
     所以「成片里的样子已经不是 edl 原样」只能看 id，不能用 isEditInPlan 的时间判断 */
  function planIncludesEdit(plan, edit) {
    if (!plan?.renderedAt || !edit) return false;
    if (Array.isArray(plan.editsApplied)) return plan.editsApplied.includes(edit.id);
    return isEditInPlan(plan, edit);
  }

  /* edl 在这条改动的目标处还是改动前的样子吗。AI 已经把改动写进 edl（吸收）时就不是了 */
  function editTargetAtBase(edl, edit) {
    const base = edit?.base || {};
    if (edit?.op === "set_voice") {
      const voice = edl?.voice && typeof edl.voice === "object" ? edl.voice : {};
      return Object.keys(edit.value || {}).every((key) => sameValue(voice[key], base[key]));
    }
    if (edit?.op === "set_hook") {
      const hook = edl?.hook && typeof edl.hook === "object" ? edl.hook : {};
      return Object.keys(base).every((key) => sameValue(hook[key], base[key]));
    }
    if (edit?.op === "set_music") {
      const music = edl?.music && typeof edl.music === "object" ? edl.music : {};
      return sameValue(music.gain_db, base.gain_db);
    }
    const beats = Array.isArray(edl?.beats) ? edl.beats : [];
    const beat = beats.find((item, index) => beatIdOf(item, index) === edit?.beat);
    if (!beat) return false;
    if (edit.op === "set_say" || edit.op === "delete_beat") return beat.say === base.say;
    if (edit.op === "set_say_tts") return (beat.say_tts ?? "") === (base.say_tts ?? "");
    if (edit.op === "set_text" || edit.op === "delete_text") {
      const tx = Array.isArray(beat.texts) ? beat.texts[edit.text] : null;
      if (!tx) return false;
      return Object.keys(base).every((key) => sameValue(tx[key], base[key]));
    }
    if (edit.op === "replace_shot") {
      const shot = Array.isArray(beat.shots) ? beat.shots[edit.shot] : null;
      if (!shot) return false;
      return ["src", "in", "scene"].every((key) => (shot[key] ?? null) === (base[key] ?? null));
    }
    return false;
  }

  /* 已经进入成片的改动被撤掉时，把记录和剩余改动一起写入 edits.json。 */
  function trackRemovedEdits(before, after, plans, renderPending = false) {
    const active = new Set(after.edits.map((edit) => edit.id));
    const removed = new Map(before.removedEdits.map((edit) => [edit.id, edit]));
    for (const edit of before.edits) {
      if (!active.has(edit.id) && (renderPending || plans.some((plan) => planIncludesEdit(plan, edit)))) removed.set(edit.id, edit);
    }
    for (const id of active) removed.delete(id);
    return { ...after, removedEdits: [...removed.values()] };
  }

  /* 这版成片里仍然有被撤掉的改动，下次生成才会回到原样。 */
  function revertedEdits({ plan, edl, doc }) {
    const current = normalizeDoc(doc);
    const keys = new Set(current.edits.map(editKey));
    const seen = new Set();
    const out = [];
    for (const edit of current.removedEdits) {
      if (!edit || keys.has(editKey(edit)) || seen.has(editKey(edit))) continue;
      if (!planIncludesEdit(plan, edit) || !editTargetAtBase(edl, edit)) continue;
      seen.add(editKey(edit));
      out.push(edit);
    }
    return out;
  }

  /* 撤销「撤掉」：把原来那条改动原样放回去（id、createdAt 不变，成片里就是它） */
  function restoreEdit(doc, edit) {
    const next = normalizeDoc(doc);
    const key = editKey(edit);
    next.edits = [...next.edits.filter((item) => editKey(item) !== key), edit];
    return next;
  }

  function describeRevert(edit, rows) {
    const row = rows.find((item) => item.id === edit.beat);
    const where = row ? `第 ${row.index + 1} 句` : (edit.beat || "");
    if (edit.op === "replace_shot") return `${where}第 ${(edit.shot ?? 0) + 1} 个镜头恢复原镜头`;
    if (edit.op === "set_say") return `${where}恢复原文`;
    if (edit.op === "set_say_tts") return `${where}恢复原读音`;
    if (edit.op === "delete_beat") return `${where}恢复这句`;
    if (edit.op === "set_voice") return "语速恢复原样";
    if (edit.op === "set_text") return `${where}字卡恢复原样`;
    if (edit.op === "delete_text") return `${where}恢复字卡`;
    if (edit.op === "set_hook") return "开头钩子恢复原样";
    if (edit.op === "set_music") return "配乐音量恢复原样";
    return where;
  }

  /* 只有进了正式版才算生效。AI 只出了预览时改动还不算完成，否则「应用修改」消失，用户就没法生成正式版了 */
  function isEditInFinal({ versions, latest, plan }, edit) {
    const list = Array.isArray(versions) ? versions : [];
    if (list.find((item) => item.name === latest)?.kind === "final") return isEditInPlan(plan, edit);
    const final = list.find((item) => item.kind === "final");
    return Boolean(final?.hasPlan && (edit.createdAt || 0) < final.mtime);
  }

  /* 主按钮只有一个，系统替用户决定怎么处理：有意见要 AI 判断，只有确定的改动就直接生成 */
  function routeApply({ editCount, noteCount }) {
    if (noteCount > 0) return "ai";
    if (editCount > 0) return "render";
    return "none";
  }

  /* 片子做完后进度没有意义，只在还没出成片时显示。可选步骤没做过不算没完成 */
  function visibleSteps(steps) {
    const finalStep = steps.find((step) => step.key === "final");
    if (finalStep?.state === "done") return [];
    return steps;
  }

  /* 状态只占一行，同一时间只说最要紧的一件事 */
  function pickStatus({ running, renderBusy, renderQa, canCancel, failure, conflictCount, stopped, pendingLatestLabel, envProblem }) {
    if (running) {
      return { kind: "working", text: describeRunning(running), progress: runningProgress(running), action: canCancel ? "cancel-render" : null, actionLabel: "取消" };
    }
    if (renderQa) return { kind: "working", text: "新版本已生成，正在自检…", progress: 0.97 };
    if (renderBusy) return { kind: "working", text: "正在生成新版本：准备中", progress: 0.02, action: canCancel ? "cancel-render" : null, actionLabel: "取消" };
    if (failure) return { kind: "error", text: `上次${failure.cmd === "render" ? "生成" : "处理"}没成功：${failure.message}` };
    if (conflictCount > 0) return { kind: "error", text: `有 ${conflictCount} 处改动和 AI 改到了同一个地方`, action: "tab", actionTab: "changes", actionLabel: "去看看" };
    if (stopped) return { kind: "info", text: `AI 停在「${stopped.label}」这一步了`, action: "continue", actionLabel: "继续", step: stopped.label };
    if (pendingLatestLabel) return { kind: "info", text: `新版本 ${pendingLatestLabel} 已生成`, action: "switch-latest", actionLabel: "切换" };
    if (envProblem) return { kind: "info", text: `试看和生成新版本暂时用不了：${envProblem}` };
    return null;
  }

  function isPhotoPath(path) {
    return PHOTO_RE.test(String(path || ""));
  }

  /* 还没生成的换镜头，播放时就地盖在成片上预览。返回此刻应该显示什么。
     撤掉了已出片的换镜头时，成片里还是换上的素材，要盖回原镜头；原素材路径由 resolveOriginal 给 */
  function overlayAt(rows, seconds, isPending = () => true, resolveOriginal = null) {
    const row = rowAtTime(rows, seconds);
    const shot = shotAtTime(row, seconds);
    if (shot?.revert && !shot.replace) {
      const orig = resolveOriginal ? resolveOriginal(shot) : null;
      if (!orig?.path || orig.kind === "scene") return null;
      if (isPhotoPath(orig.path)) return { kind: "photo", src: orig.path, shot };
      const from = typeof orig.inSec === "number" ? orig.inSec : 0;
      return { kind: "video", src: orig.path, shot, sourceTime: from + (seconds - shot.start) };
    }
    if (!shot?.replace || !isPending(shot.replace)) return null;
    const src = shot.replace.value?.src;
    if (!src) return null;
    if (isPhotoPath(src)) return { kind: "photo", src, shot };
    const from = typeof shot.replace.value?.in === "number" ? shot.replace.value.in : 0;
    return { kind: "video", src, shot, sourceTime: from + (seconds - shot.start) };
  }

  /* 画面上能点的地方：字幕、字卡、当前镜头。位置照引擎排版（assgen.py）的比例估，
     竖屏字幕底边在 1 - 400/1920，字卡按 pos 落在固定高度 */
  const CAPTION_BANDS = {
    portrait: { bottom: [0.66, 0.82], middle: [0.43, 0.57], top: [0.14, 0.28] },
    landscape: { bottom: [0.75, 0.93], middle: [0.43, 0.57], top: [0.13, 0.27] },
  };
  const TEXT_Y = {
    portrait: { top: 0.16, upper: 0.25, center: 0.45, lower: 0.62, "above-caption": 0.655 },
    landscape: { top: 0.14, upper: 0.24, center: 0.46, lower: 0.62, "above-caption": 0.68 },
  };

  const TEXT_POS_OPTIONS = [
    ["top", "顶部"],
    ["upper", "偏上"],
    ["center", "居中"],
    ["lower", "偏下"],
    ["above-caption", "字幕上方"],
  ];

  function resolveTextY(pos, landscape = false) {
    const orient = landscape ? "landscape" : "portrait";
    if (typeof pos === "number") return pos >= 0 && pos <= 1 ? pos : null;
    return TEXT_Y[orient][pos || "upper"] ?? TEXT_Y[orient].upper;
  }

  /* 改过口播文字但还没重渲时，按标点和 13 字上限切分并线性估算当前显示的字幕句，让改字能秒看 */
  function liveCaptionFor(row, time, planCues, isPending = () => true) {
    if (!row || row.deleted) return "";
    if (row.setSay && isPending(row.setSay) && row.start !== null && row.end !== null && row.end > row.start) {
      const say = String(row.say || "").trim();
      if (!say) return "";
      const rawParts = say.split(/[，。！？、；：,.!?;]+/).map((s) => s.trim()).filter(Boolean);
      const chunks = [];
      for (const part of rawParts.length ? rawParts : [say]) {
        if (part.length <= 13) chunks.push(part);
        else for (let i = 0; i < part.length; i += 13) chunks.push(part.slice(i, i + 13));
      }
      const totalChars = chunks.reduce((sum, s) => sum + s.length, 0) || 1;
      const ratio = Math.min(0.9999, Math.max(0, (time - row.start) / (row.end - row.start)));
      let acc = 0;
      for (const chunk of chunks) {
        acc += chunk.length / totalChars;
        if (ratio <= acc) return chunk;
      }
      return chunks[chunks.length - 1] || "";
    }
    return cueAt(planCues, time);
  }

  /* 判断是否有未进入当前成片的实时画面改动（字卡、钩子、改字字幕） */
  function hasPendingLiveVisualEdits({ rows, hook, isPending = () => true }) {
    if (hook?.edit && isPending(hook.edit)) return true;
    for (const row of rows || []) {
      if (row.setSay && isPending(row.setSay)) return true;
      for (const card of row.cards || []) {
        if ((card.setText && isPending(card.setText)) || (card.deleteText && isPending(card.deleteText))) return true;
      }
    }
    return false;
  }

  /* 计算当前时刻应在播放器上实时渲染的字卡、钩子和字幕 */
  function liveOverlaysAt({ rows, hook, plan, time, landscape = false, isPending = () => true }) {
    const cards = [];
    if (hook && hook.exists && !hook.deleted && hook.text && time >= hook.start && time < hook.end) {
      const y = resolveTextY(hook.pos, landscape);
      if (typeof y === "number") {
        cards.push({
          isHook: true,
          beat: null,
          idx: null,
          text: hook.text,
          sub: hook.sub || "",
          badge: "",
          style: "title",
          pos: hook.pos,
          y,
          changed: Boolean(hook.edit && isPending(hook.edit)),
        });
      }
    }
    const row = rowAtTime(rows, time);
    if (row && !row.deleted) {
      for (const card of row.cards || []) {
        if (card.deleted || !card.text) continue;
        if (card.start !== null && card.end !== null && !(time >= card.start && time < card.end)) continue;
        const y = resolveTextY(card.pos, landscape);
        if (typeof y !== "number") continue;
        cards.push({
          isHook: false,
          beat: row.id,
          idx: card.idx,
          text: card.text,
          sub: card.sub || "",
          badge: card.badge || "",
          style: card.style || "tag",
          pos: card.pos,
          y,
          changed: Boolean(card.setText && isPending(card.setText)),
        });
      }
    }
    const caption = liveCaptionFor(row, time, plan?.cues, isPending);
    const captionPos = plan?.captions_cfg?.position || "bottom";
    const captionChanged = Boolean(row?.setSay && isPending(row.setSay));
    return { cards, caption, captionPos, captionChanged };
  }

  function frameHotspots({ plan, rows, hook = null, time, landscape = false }) {
    const orient = landscape ? "landscape" : "portrait";
    const row = rowAtTime(rows, time);
    if (!plan || !row || row.deleted) return [];
    const clamp01 = (value) => Math.min(1, Math.max(0, value));
    const spots = [];
    const cue = (plan.cues || []).find((item) => time >= item.start && time < item.end && item.text);
    const band = CAPTION_BANDS[orient][plan.captions_cfg?.position || "bottom"];
    if (cue && band) spots.push({ kind: "caption", beat: row.id, text: cue.text, top: band[0], bottom: band[1] });
    // 字卡画在字幕上面，排在后面才能盖住重叠的部分
    for (const text of plan.texts || []) {
      if (!(time >= text.start && time < text.end) || !text.text) continue;
      if (text.hook && hook?.deleted) continue;
      let liveText = text.text;
      let livePos = text.pos;
      let cardIdx = text.idx;
      if (text.hook && hook?.edit) {
        liveText = hook.text || text.text;
        livePos = hook.pos ?? text.pos;
      } else if (!text.hook && Array.isArray(row.cards)) {
        const card = Number.isInteger(text.idx)
          ? row.cards.find((c) => c.idx === text.idx)
          : row.cards.find((c) => c.originalText === text.text);
        if (card?.deleted) continue;
        if (card) {
          liveText = card.text || text.text;
          livePos = card.pos ?? text.pos;
          cardIdx = card.idx;
        }
      }
      const y = typeof livePos === "number" ? (livePos <= 1 ? livePos : null) : TEXT_Y[orient][livePos || "upper"];
      if (typeof y !== "number") continue;
      const half = text.style === "title" ? 0.075 : 0.05;
      const spot = { kind: "text", beat: row.id, text: liveText, top: clamp01(y - half), bottom: clamp01(y + half) };
      if (text.hook) spot.isHook = true;
      if (Number.isInteger(cardIdx)) spot.idx = cardIdx;
      spots.push(spot);
    }
    const shot = shotAtTime(row, time);
    if (shot) spots.push({ kind: "shot", beat: row.id, shot: shot.idx });
    return spots;
  }

  /* 只有这句有尚未进入当前成片的本地改动（改字、改读音、换镜头、撤回已出片换镜头或改了全片语速）时，才需要「试看改后效果」 */
  function rowNeedsSample(row, { isRendered = () => false, voicePending = false } = {}) {
    if (!row || row.deleted) return false;
    if (voicePending) return true;
    if (row.setSay && !isRendered(row.setSay)) return true;
    if (row.setTts && !isRendered(row.setTts)) return true;
    return Array.isArray(row.shots) && row.shots.some((shot) =>
      (shot.replace && !isRendered(shot.replace)) || (shot.revert && !shot.replace));
  }

  const PLAYBACK_RATES = [1, 1.25, 1.5, 2];

  function nextPlaybackRate(current) {
    const idx = PLAYBACK_RATES.findIndex((rate) => Math.abs(rate - Number(current || 1)) < 0.01);
    return PLAYBACK_RATES[(idx + 1) % PLAYBACK_RATES.length];
  }

  function formatPlaybackRate(rate) {
    const num = Number(rate) || 1;
    return `${Number.isInteger(num) ? num : num}x`;
  }

  function applyButtonMeta({ editCount, noteCount }) {
    const route = routeApply({ editCount, noteCount });
    const total = (Number(editCount) || 0) + (Number(noteCount) || 0);
    if (route === "ai") {
      return {
        route,
        total,
        label: `发给 AI 处理（${total}）`,
        hint: "你写的意见会交给 AI，它改好后生成新版本",
      };
    }
    if (route === "render") {
      return {
        route,
        total,
        label: `生成新版本（${total}）`,
        hint: "按你的改动直接生成新版本，不经过 AI，不花模型额度",
      };
    }
    return { route: "none", total: 0, label: "", hint: "" };
  }

  function rowHasChanges(row) {
    if (!row) return false;
    if (row.setSay || row.setTts || row.deleted) return true;
    if (Array.isArray(row.cards) && row.cards.some((card) => Boolean(card.setText || card.deleteText))) return true;
    if (Array.isArray(row.notes) && row.notes.some((note) => !note.sentAt)) return true;
    return Array.isArray(row.shots) && row.shots.some((shot) => Boolean(shot.replace || shot.revert)
      || (Array.isArray(shot.notes) && shot.notes.some((note) => !note.sentAt)));
  }

  function rowMatchesQuery(row, query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return true;
    const parts = [
      row?.say,
      row?.originalSay,
      ...(Array.isArray(row?.cards) ? row.cards.flatMap((c) => [c.text, c.originalText, c.sub, c.badge]) : []),
      ...(Array.isArray(row?.texts) ? row.texts.map((t) => t.text) : []),
      ...(Array.isArray(row?.notes) ? row.notes.map((n) => n.text) : []),
      ...(Array.isArray(row?.shots) ? row.shots.flatMap((s) => [s.name, ...(s.notes || []).map((n) => n.text)]) : []),
    ];
    return parts.some((part) => String(part || "").toLowerCase().includes(q));
  }

  function filterRows(rows, { query = "", onlyModified = false } = {}) {
    return (Array.isArray(rows) ? rows : []).filter((row) => {
      if (onlyModified && !rowHasChanges(row)) return false;
      return rowMatchesQuery(row, query);
    });
  }

  function sourceMatchesQuery(item, query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return true;
    return [item?.name, item?.notes, item?.id].some((part) => String(part || "").toLowerCase().includes(q));
  }

  /* 帧条上悬停时的提示：时间 + 这一句的开头 */
  function stripLabel(rows, time, max = 14) {
    const row = rowAtTime(rows, time);
    const say = String(row?.say || "").trim();
    const head = say.length > max ? `${say.slice(0, max)}…` : say;
    return head ? `${fmtTime(time)} · ${head}` : fmtTime(time);
  }

  /* 删掉的句子预览时直接跳过 */
  function skipDeleted(rows, seconds) {
    const row = rowAtTime(rows, seconds);
    return row?.deleted ? row.end : null;
  }

  /* 和播放器同一个取整规则（向下取整），标题和时钟才不会差 1 秒 */
  function humanDuration(seconds) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
    const total = Math.floor(seconds);
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (m === 0) return `${s} 秒`;
    return s === 0 ? `${m} 分钟` : `${m} 分 ${s} 秒`;
  }

  /* 离开工作台时记下的现场能恢复多少：还是那条视频才回到原来的位置，
     离开期间出了新版本就从头看新版，面板标签照旧 */
  function resolveResume(saved, version) {
    if (!saved || typeof saved !== "object") return null;
    const sameVideo = Boolean(version) && saved.version === version;
    const positive = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
    const picker = saved.picker;
    return {
      tab: ["script", "changes", "publish"].includes(saved.tab) ? saved.tab : "script",
      time: sameVideo ? positive(saved.time) : 0,
      scrollTop: sameVideo ? positive(saved.scrollTop) : 0,
      picker: sameVideo && picker && typeof picker.beat === "string" && Number.isInteger(picker.shotIdx)
        ? { beat: picker.beat, shotIdx: picker.shotIdx }
        : null,
    };
  }

  function cueAt(cues, seconds) {
    if (!Array.isArray(cues)) return "";
    return cues.find((cue) => seconds >= cue.start && seconds < cue.end)?.text || "";
  }

  /* 鼠标在素材上滑动：位置换算成时间和帧条的第几格 */
  function skimInfo(fraction, duration, frames) {
    const f = Math.min(1, Math.max(0, Number(fraction) || 0));
    const count = Math.max(1, Math.floor(frames) || 1);
    return { fraction: f, time: f * (Number(duration) || 0), tile: Math.min(count - 1, Math.floor(f * count)) };
  }

  /* 定起点时给后面留够这个镜头要用的长度，够不到就贴着结尾；素材比镜头还短时才不够 */
  function clampIn(time, duration, need) {
    const dur = Number(duration) || 0;
    const want = Math.max(0, Number(time) || 0);
    const usable = need ? Math.max(0, dur - need) : dur;
    const value = Math.min(want, usable);
    return { in: Math.round(value * 10) / 10, tooShort: Boolean(need && dur && dur < need) };
  }

  /* 帧条是一张横向拼图，按 cover 方式把第 tile 格放进格子里；窗口始终落在这一格内，不会露出相邻帧 */
  function stripCover({ tile, frames, tileW, tileH, boxW, boxH }) {
    const scale = Math.max(boxW / tileW, boxH / tileH);
    const w = tileW * scale;
    const h = tileH * scale;
    return {
      size: `${(w * frames).toFixed(1)}px ${h.toFixed(1)}px`,
      position: `${(-(tile * w) + (boxW - w) / 2).toFixed(1)}px ${((boxH - h) / 2).toFixed(1)}px`,
    };
  }

  function sameHistoryValue(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => sameHistoryValue(a[key], b[key]));
  }

  function applyHistoryItems(items, expected, desired, keyOf) {
    const result = new Map(items.map((item) => [keyOf(item), item]));
    const from = new Map(expected.map((item) => [keyOf(item), item]));
    const to = new Map(desired.map((item) => [keyOf(item), item]));
    for (const key of new Set([...from.keys(), ...to.keys()])) {
      const previous = from.get(key);
      const next = to.get(key);
      // 意见发送、清理或外部改动后，保留磁盘上更新过的记录。
      if (sameHistoryValue(previous, next) || !sameHistoryValue(result.get(key), previous)) continue;
      if (next) result.set(key, next);
      else result.delete(key);
    }
    return [...result.values()];
  }

  function applyHistoryChange(current, expected, desired) {
    return {
      ...current,
      edits: applyHistoryItems(current.edits, expected.edits, desired.edits, editKey),
      notes: applyHistoryItems(current.notes, expected.notes, desired.notes, (note) => note.id),
    };
  }

  function recordHistory(history, before, after, label, limit = 100) {
    const past = [...history.past, { before: normalizeDoc(before), after: normalizeDoc(after), label }];
    return { past: past.slice(-limit), future: [] };
  }

  function undoHistory(history, current) {
    if (history.past.length === 0) return null;
    const entry = history.past[history.past.length - 1];
    current = normalizeDoc(current);
    const doc = applyHistoryChange(current, entry.after, entry.before);
    return {
      history: { past: history.past.slice(0, -1), future: [...history.future, { before: doc, after: current, label: entry.label }] },
      doc,
      label: entry.label,
    };
  }

  function redoHistory(history, current) {
    if (history.future.length === 0) return null;
    const entry = history.future[history.future.length - 1];
    current = normalizeDoc(current);
    const doc = applyHistoryChange(current, entry.before, entry.after);
    return {
      history: { past: [...history.past, { before: current, after: doc, label: entry.label }], future: history.future.slice(0, -1) },
      doc,
      label: entry.label,
    };
  }

  /* 文案里的字数备注是给人看的，复制到平台时要去掉 */
  function cleanCopyText(text) {
    return String(text || "").replace(/[（(]\s*\d+\s*字\s*[）)]\s*$/, "").trim();
  }

  function isMissingSource(path, missing) {
    return Array.isArray(missing) && missing.includes(path);
  }

  function pendingCounts(doc) {
    const normalized = normalizeDoc(doc);
    return {
      edits: normalized.edits.length,
      notes: normalized.notes.filter((note) => !note.sentAt).length,
      sent: normalized.notes.filter((note) => note.sentAt).length,
    };
  }

  /* 候选素材合并：manifest 给备注和编号，文件夹枚举给缩略图和尺寸 */
  function mergeSource(existing, incoming) {
    return { ...existing, ...incoming, notes: incoming.notes || existing?.notes || "", used: existing?.used || incoming.used || [] };
  }

  /* 需要这个镜头占多久，用来提示候选素材够不够长 */
  function shotDuration(shot) {
    if (!shot || shot.start === null || shot.end === null) return null;
    return Math.max(0, shot.end - shot.start);
  }

  /* 按 edl 里的引用原文在素材清单里找素材，规则和引擎一致：编号（不分大小写）→ 文件名 → 路径 */
  function findSourceItem(items, ref, projectDir = "") {
    if (!items || !ref) return null;
    const lower = String(ref).toLowerCase();
    const key = pathKey(joinPath(projectDir, ref));
    let byName = null;
    let byPath = null;
    for (const item of typeof items.values === "function" ? items.values() : items) {
      if (!item) continue;
      if (item.id && String(item.id).toLowerCase() === lower) return item;
      if (!byName && item.name === ref) byName = item;
      if (!byPath && item.path && pathKey(item.path) === key) byPath = item;
    }
    return byName || byPath;
  }

  function looksLikePath(ref) {
    return /[\\/]/.test(ref) || /\.[a-z0-9]{2,5}$/i.test(ref);
  }

  /* 找出这个镜头最初配的素材（edl 原样，没被换镜头覆盖前），供面板标「原镜头」、恢复后回显和盖预览。
     优先按 edl 引用在清单里找；时间表的 path 是引擎解析好的，但只有没被换过（planReplaced 为假）时才可信 */
  function resolveOriginalShot(shot, { items = null, projectDir = "" } = {}) {
    const none = { kind: null, path: null, rawSrc: null, inSec: null };
    if (!shot) return none;
    const raw = shot.raw || {};
    if (raw.scene) return { ...none, kind: "scene" };
    const rawSrc = typeof raw.src === "string" && raw.src ? raw.src : null;
    const planOriginal = !shot.planReplaced;
    const item = findSourceItem(items, rawSrc, projectDir);
    let path = item?.path || null;
    if (!path && planOriginal && shot.path) path = shot.path;
    if (!path && rawSrc && looksLikePath(rawSrc) && (isAbsolutePath(rawSrc) || projectDir)) path = joinPath(projectDir, rawSrc);
    const inSec = typeof raw.in === "number"
      ? raw.in
      : (planOriginal && typeof shot.inSec === "number" ? shot.inSec : null);
    return {
      kind: item?.kind || (path ? (isPhotoPath(path) ? "photo" : "video") : null),
      path,
      rawSrc,
      inSec,
    };
  }

  /* 片子里用到的素材（按改动后的样子算：换上的算、换下的不算、要删的句子不算），返回 pathKey 集合。
     resolveOriginal 给没换过的镜头找文件路径，不给就用时间表里的 path */
  function usedSourceKeys(rows, resolveOriginal = null) {
    const keys = new Set();
    for (const row of rows || []) {
      if (row.deleted) continue;
      for (const shot of row.shots || []) {
        let path = null;
        if (shot.replace) path = shot.replace.value?.src || null;
        else if (!shot.raw?.scene) path = (resolveOriginal ? resolveOriginal(shot)?.path : null) || shot.path || null;
        if (path) keys.add(pathKey(path));
      }
    }
    return keys;
  }

  function isOriginalShotSource(shot, item, options) {
    if (!shot || !item || shot.raw?.scene) return false;
    const orig = options?.original || resolveOriginalShot(shot, options);
    if (orig.path && samePath(item.path, orig.path)) return true;
    if (orig.rawSrc && item.id && String(item.id).toLowerCase() === orig.rawSrc.toLowerCase()) return true;
    return false;
  }

  root.InkfellowVideoModel = {
    STEP_DEFS,
    fmtTime,
    baseName,
    dirName,
    normalizeDoc,
    editKey,
    sameValue,
    upsertEdit,
    removeEdit,
    addNote,
    removeNote,
    markNotesSent,
    pruneSentNotes,
    buildRows,
    buildHook,
    rowAtTime,
    shotAtTime,
    makeSetSay,
    makeSetTts,
    makeDeleteBeat,
    makeReplaceShot,
    makeVoiceEdit,
    makeSetText,
    makeDeleteText,
    makeSetHook,
    makeSetMusic,
    TEXT_POS_OPTIONS,
    resolveTextY,
    liveCaptionFor,
    hasPendingLiveVisualEdits,
    liveOverlaysAt,
    statusOfEdit,
    describeEdit,
    buildAiMessage,
    describeRunning,
    runningProgress,
    deriveSteps,
    stoppedStep,
    lastCommandFailure,
    offlineSummary,
    isEditInPlan,
    isEditInFinal,
    routeApply,
    visibleSteps,
    pickStatus,
    isPhotoPath,
    overlayAt,
    frameHotspots,
    rowNeedsSample,
    PLAYBACK_RATES,
    nextPlaybackRate,
    formatPlaybackRate,
    applyButtonMeta,
    rowHasChanges,
    rowMatchesQuery,
    filterRows,
    sourceMatchesQuery,
    stripLabel,
    skipDeleted,
    cueAt,
    skimInfo,
    clampIn,
    stripCover,
    recordHistory,
    undoHistory,
    redoHistory,
    cleanCopyText,
    isMissingSource,
    pendingCounts,
    mergeSource,
    shotDuration,
    resolveOriginalShot,
    isOriginalShotSource,
    findSourceItem,
    usedSourceKeys,
    normalizePath,
    pathKey,
    samePath,
    planIncludesEdit,
    editTargetAtBase,
    revertedEdits,
    trackRemovedEdits,
    restoreEdit,
    describeRevert,
    humanDuration,
    resolveResume,
  };
})(globalThis);

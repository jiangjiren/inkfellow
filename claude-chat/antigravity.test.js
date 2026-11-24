import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as provider from "./providers/antigravity.js";
import { getCatalog, resolveModel, runAntigravity } from "./antigravity-runtime.js";

test("model catalog merges efforts, keeps the latest menu version and maps effort safely", () => {
  const catalog = provider.parseModelsList("Fetching...\ngemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\ngemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)\ngemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)\ngemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)\ngemini-4-argon-high\tGemini 4 Argon (High)\ngemini-4-argon-low\tGemini 4 Argon (Low)\ngemini-pro-orchestrator-g1-pro\tOrchestrator (Argon)\n");
  provider.setCatalog(catalog);
  assert.equal(catalog.length, 3);
  assert.deepEqual(catalog[0].efforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(provider.effortForModel("gemini-4-hydrogen", "medium"), "medium");
  assert.equal(provider.effortForModel("gemini-4-hydrogen", "xhigh"), "xhigh");
  assert.equal(provider.effortForModel("gemini-4-hydrogen", "max"), "xhigh");
  assert.equal(provider.effortForModel("gemini-4-hydrogen-xhigh", "high"), null);
  assert.equal(provider.effortForModel("gemini-4-argon", "medium"), "low");
  assert.equal(provider.effortForModel("gemini-4-argon", "max"), "high");
  assert.equal(provider.effortForModel("gemini-pro-orchestrator-g1-pro", "high"), null);
  assert.equal(provider.parseModelsList("Login required"), null);
  provider._resetCatalog();
});

test("defaults and retired selections prefer Hydrogen while respecting the live catalog", () => {
  provider._resetCatalog();
  try {
    assert.equal(resolveModel(), "gemini-4-hydrogen");
    assert.ok(!provider.getCatalog().some(entry => entry.model === "gemini-3.1-pro"));
    provider.setCatalog([
      { model: "gemini-4-argon", label: "Gemini 4 Argon", efforts: ["low", "medium", "high"] },
      { model: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", efforts: ["low", "medium", "high", "xhigh"] },
      { model: "gemini-3.8-flash", label: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"] },
    ]);
    assert.equal(resolveModel(), "gemini-4-hydrogen");
    assert.equal(resolveModel("gemini-3.1-pro"), "gemini-4-hydrogen");
    assert.equal(resolveModel("gemini-3.8-flash"), "gemini-3.8-flash");
    provider.setCatalog([{ model: "gemini-4-argon", label: "Gemini 4 Argon", efforts: ["high"] }]);
    assert.equal(resolveModel("gemini-3.1-pro"), "gemini-4-argon");
  } finally {
    provider._resetCatalog();
  }
});

test("text and tool steps produce persistent messages and settle the matching tool", () => {
  const translate = provider.createTranslator();
  const step = data => translate({ event: "step_update", step_update: data });
  const text = step({ step_index: 0, step_type: "agent_response", text_delta: "你好", state: "ACTIVE" });
  assert.ok(text.some(e => e.event?.delta?.text === "你好"));
  assert.equal(step({ step_index: 0, step_type: "agent_response", state: "DONE" }).at(-1).message.content[0].text, "你好");
  const tool = { step_index: 1, step_type: "tool", tool_name: "view_file", state: "ACTIVE", tool_info: { parameters: { AbsolutePath: "/tmp/test.md" } } };
  const start = step(tool)[0];
  assert.equal(start.name, "Read");
  assert.equal(start.input.file_path, "/tmp/test.md");
  assert.deepEqual(step(tool), []);
  const done = step({ ...tool, state: "DONE", tool_info: { output: "file text" } });
  assert.equal(done[0].message.content[0].tool_use_id, start.id);
  assert.equal(done[1].message.content[0].tool_use_id, start.id);
});

test("usage keeps independent pools and ignores missing percentages", () => {
  const groups = provider.parseUsage(JSON.stringify({ command: { data: { groups: [
    { buckets: [{ id: "gemini-5h", window: "5h", remaining_fraction: 0.75 }] },
    { buckets: [{ id: "3p-weekly", window: "weekly", remaining_fraction: 0.2 }] },
    { buckets: [{ id: "gemini-5h", window: "5h", remaining_fraction: null }] },
  ] } } }));
  assert.equal(groups.length, 2);
  assert.equal(groups[0].fiveHour.remainingPercent, 75);
  assert.equal(groups[1].week.usedPercent, 80);
});

test("CLI runner resumes explicitly, parses final lines, rejects incomplete runs, and aborts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claw-agy-test-"));
  const binary = join(dir, "agy.cjs");
  const original = process.env.AGY_BIN;
  writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if(args.includes('--help')) { console.log('--output-format --mode --effort'); process.exit(0); }
if(args[0]==='models') { console.log('gemini-4-hydrogen-low\\tGemini 4 Hydrogen (Low)\\ngemini-4-hydrogen-xhigh\\tGemini 4 Hydrogen (XHigh)'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(join(dir, "args.json"))}, JSON.stringify(args));
const prompt=args[args.indexOf('-p')+1];
if(prompt==='hang') {setInterval(()=>{},1000);}
else if(prompt==='empty') { process.exit(0); }
else if(prompt==='fail') { process.stdout.write(JSON.stringify({event:'result',result:{status:'ERROR',error:'quota exhausted'}})); }
else { console.log(JSON.stringify({event:'init',init:{conversation_id:'session-one'}})); process.stdout.write(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'OK'}})); }
`, { mode: 0o700 });
  process.env.AGY_BIN = binary;
  provider._resetBinaryCache();
  try {
    assert.equal((await getCatalog({ force: true })).ready, true);
    const options = { prompt: "hello", cwd: dir, model: provider.DEFAULT_MODEL, effort: "medium", permissionMode: "plan", resumeConversationId: "old-session" };
    const sessions = [];
    assert.equal((await runAntigravity({ ...options, onSession: id => sessions.push(id) })).text, "OK");
    assert.deepEqual(sessions, ["session-one"]);
    const args = JSON.parse(readFileSync(join(dir, "args.json")));
    assert.equal(args[args.indexOf("--conversation") + 1], "old-session");
    assert.ok(args.includes("--sandbox"));
    assert.ok(!args.includes("--dangerously-skip-permissions"));
    assert.equal(args[args.indexOf("--effort") + 1], "low");
    assert.equal(args[args.indexOf("--model") + 1], "gemini-4-hydrogen");
    await runAntigravity({ ...options, effort: "max" });
    const highArgs = JSON.parse(readFileSync(join(dir, "args.json")));
    assert.equal(highArgs[highArgs.indexOf("--effort") + 1], "xhigh");
    await assert.rejects(runAntigravity({ ...options, prompt: "empty" }), /未正常完成/);
    await assert.rejects(runAntigravity({ ...options, prompt: "fail" }), /quota exhausted/);
    await assert.rejects(runAntigravity({ ...options, prompt: "hang", signal: AbortSignal.timeout(150) }), { name: "AbortError" });
    await assert.rejects(runAntigravity({ ...options, signal: AbortSignal.abort() }), { name: "AbortError" });
  } finally {
    if (original === undefined) delete process.env.AGY_BIN; else process.env.AGY_BIN = original;
    provider._resetBinaryCache();
    provider._resetCatalog();
    rmSync(dir, { recursive: true, force: true });
  }
});

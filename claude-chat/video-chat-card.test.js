import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
const pathSource = await readFile(new URL("../desktop-lite/video-open-path.js", import.meta.url), "utf8");
const extractSource = html.match(/^function extractVideoPaths\(text\) \{[^]*?^\}/m)?.[0];
assert.ok(extractSource, "extractVideoPaths must be present in the chat HTML");
const context = vm.createContext({});
vm.runInContext(extractSource, context);
vm.runInContext(pathSource, context);
const extract = text => Array.from(context.extractVideoPaths(text));
const project = (path, vault = "D:\\jiang\\writing\\jiang-vault") =>
  context.InkfellowVideoOpenPath.projectFromVideoPath(path, vault);

test("chat's inline application script remains valid JavaScript", () => {
  const scripts = Array.from(html.matchAll(/<script>([^]*?)<\/script>/g));
  assert.ok(scripts.length >= 2);
  assert.doesNotThrow(() => new vm.Script(scripts.at(-1)[1]));
});

test("extracts a real Chinese Windows output path", () => {
  assert.deepEqual(extract("成片：D:\\jiang\\writing\\jiang-vault\\旅居奶爸姜sir-账号\\绿汁镇\\视频\\out\\绿汁镇_v1.mp4"), [
    "D:\\jiang\\writing\\jiang-vault\\旅居奶爸姜sir-账号\\绿汁镇\\视频\\out\\绿汁镇_v1.mp4",
  ]);
});

test("extracts relative paths wrapped in backticks", () => {
  assert.deepEqual(extract("看 `绿汁镇/视频/out/绿汁镇_v1.mp4`"), ["绿汁镇/视频/out/绿汁镇_v1.mp4"]);
});

test("stops before Chinese brackets, punctuation and adjacent duration", () => {
  assert.deepEqual(extract("（视频/out/成片.mp4（72秒）），下一版：视频/out/成片_v2.mp4。"), [
    "视频/out/成片.mp4", "视频/out/成片_v2.mp4",
  ]);
});

test("keeps order and removes duplicate paths", () => {
  assert.deepEqual(extract("a/out/1.mp4，b\\out\\2.mp4；a\\out\\1.mp4"), [
    "a/out/1.mp4", "b\\out\\2.mp4",
  ]);
});

test("ignores mp4 outside out and ordinary text", () => {
  assert.deepEqual(extract("视频/raw/a.mp4，其他文字。"), []);
  assert.deepEqual(extract("已经生成视频，等待审核。"), []);
});

test("resolves Windows absolute paths inside the vault case-insensitively", () => {
  assert.equal(project("d:\\JIANG\\Writing\\JIANG-VAULT\\绿汁镇\\视频\\out\\片.mp4"), "绿汁镇/视频");
});

test("resolves relative output paths", () => {
  assert.equal(project("绿汁镇\\视频\\out\\片.mp4"), "绿汁镇/视频");
  assert.equal(project("绿汁镇/视频/out/片.mp4"), "绿汁镇/视频");
  assert.equal(project("./绿汁镇/视频/out/subdir/片.mp4"), "绿汁镇/视频");
});

test("rejects paths outside vault or with traversal", () => {
  assert.equal(project("D:\\jiang\\writing\\other\\视频\\out\\片.mp4"), null);
  assert.equal(project("D:\\jiang\\writing\\jiang-vault-extra\\视频\\out\\片.mp4"), null);
  assert.equal(project("视频/../别处/out/片.mp4"), null);
  assert.equal(project("视频/raw/片.mp4"), null);
});

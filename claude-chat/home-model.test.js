import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../desktop-lite/home-model.js", import.meta.url), "utf8");
const context = vm.createContext({});
vm.runInContext(source, context);
const Home = context.InkfellowHomeModel;
const plain = (value) => JSON.parse(JSON.stringify(value));
const paths = (files) => plain(files).map((file) => file.path);

const file = (path, updatedAt = 100, extension = path.split(".").pop()) => ({
  type: "file", name: path.split("/").pop(), path, extension, updatedAt,
});
const PROJECTS = [
  { path: "账号/绿汁镇/视频", name: "视频", title: "绿汁镇" },
  { path: "账号/元江/视频", name: "视频", title: "元江过冬旅居" },
];

test("继续你的工作：人打开过的排最前，时间用打开的时间", () => {
  const files = [file("a.md", 500), file("b.md", 400), file("c.md", 300)];
  const result = plain(Home.recentFiles({
    files, projects: [],
    opened: [{ path: "c.md", at: 900 }, { path: "b.md", at: 800 }],
  }));
  assert.deepEqual(result.map((item) => item.path), ["c.md", "b.md", "a.md"]);
  assert.deepEqual(result.map((item) => item.touchedAt), [900, 800, 500]);
});

test("继续你的工作：没打开过的按修改时间补齐，总数不超过上限", () => {
  const files = ["1", "2", "3", "4", "5", "6", "7", "8"].map((n) => file(`${n}.md`, Number(n)));
  const result = Home.recentFiles({ files, projects: [], opened: [{ path: "1.md", at: 900 }], limit: 3 });
  assert.deepEqual(paths(result), ["1.md", "8.md", "7.md"]);
});

test("继续你的工作：视频工程的 work 目录是生成物，打开过也不算", () => {
  const generated = "账号/绿汁镇/视频/work/口播稿_v1.md";
  const result = Home.recentFiles({
    files: [file(generated, 999), file("笔记.md", 1)],
    projects: PROJECTS,
    opened: [{ path: generated, at: 999 }],
  });
  assert.deepEqual(paths(result), ["笔记.md"]);
});

test("继续你的工作：工程里的配套文档不靠修改时间挤占，但自己打开过的要留着", () => {
  const doc = "账号/绿汁镇/视频/发布文案.md";
  const files = [file(doc, 999), file("笔记.md", 1)];
  assert.deepEqual(paths(Home.recentFiles({ files, projects: PROJECTS, opened: [], limit: 1 })), ["笔记.md"]);
  assert.deepEqual(paths(Home.recentFiles({ files, projects: PROJECTS, opened: [{ path: doc, at: 5 }], limit: 1 })), [doc]);
});

test("继续你的工作：笔记都在工程里时不能显示成「还没有笔记」", () => {
  const doc = "账号/绿汁镇/视频/发布文案.md";
  assert.deepEqual(paths(Home.recentFiles({ files: [file(doc, 9)], projects: PROJECTS, opened: [] })), [doc]);
});

test("继续你的工作：已删除的、图片和 PDF 都不出现", () => {
  const files = [file("a.md", 1), file("图.png", 9), file("论文.pdf", 9), file("页面.html", 2)];
  const result = Home.recentFiles({ files, projects: [], opened: [{ path: "已删除.md", at: 900 }, { path: "图.png", at: 899 }] });
  assert.deepEqual(paths(result), ["页面.html", "a.md"]);
});

test("继续你的工作：笔记库根目录本身是工程时，不能把所有笔记都当成工程文件", () => {
  const projects = [{ path: "", name: "vault", title: "根工程" }];
  const result = Home.recentFiles({ files: [file("work/生成.md", 9), file("随手记.md", 1)], projects, opened: [] });
  assert.deepEqual(paths(result), ["随手记.md"]);
});

test("文件的上下文：工程文档显示片名，其余显示所在文件夹，根目录为空", () => {
  assert.equal(Home.contextOf(file("账号/绿汁镇/视频/发布文案.md"), PROJECTS), "绿汁镇");
  assert.equal(Home.contextOf(file("其他/定时任务结果/追踪.md"), PROJECTS), "定时任务结果");
  assert.equal(Home.contextOf(file("随手记.md"), PROJECTS), "");
  // 不能因为路径前缀相同就认错工程
  assert.equal(Home.contextOf(file("账号/绿汁镇/视频_旧/说明.md"), PROJECTS), "视频_旧");
});

test("记录打开：最新的在前、不重复、有上限", () => {
  let list = [];
  for (let i = 0; i < 40; i++) list = Home.recordOpened(list, `${i}.md`, i);
  assert.equal(list.length, 30);
  assert.equal(list[0].path, "39.md");
  list = Home.recordOpened(list, "20.md", 100);
  assert.equal(list[0].path, "20.md");
  assert.equal(list[0].at, 100);
  assert.equal(plain(list).filter((item) => item.path === "20.md").length, 1);
});

test("读取打开记录：坏数据不能把首页带崩", () => {
  assert.deepEqual(plain(Home.parseOpened(null)), []);
  assert.deepEqual(plain(Home.parseOpened("不是 JSON")), []);
  assert.deepEqual(plain(Home.parseOpened('{"a":1}')), []);
  assert.deepEqual(plain(Home.parseOpened('[{"path":"a.md","at":1},{"path":2},null,"x"]')), [{ path: "a.md", at: 1 }]);
});

test("搜索视频：标题、文件夹都能搜，多个词要同时命中，保持原来的顺序", () => {
  const all = PROJECTS;
  assert.deepEqual(paths(Home.filterVideos(all, "")), paths(all));
  assert.deepEqual(paths(Home.filterVideos(all, "   ")), paths(all));
  assert.deepEqual(paths(Home.filterVideos(all, "元江")), ["账号/元江/视频"]);
  assert.deepEqual(paths(Home.filterVideos(all, "账号")), paths(all));
  assert.deepEqual(paths(Home.filterVideos(all, "账号 绿汁")), ["账号/绿汁镇/视频"]);
  assert.deepEqual(paths(Home.filterVideos(all, "元江 绿汁")), []);
  assert.deepEqual(paths(Home.filterVideos([{ path: "x", name: "Agent剪视频", title: null }], "agent")), ["x"]);
});

test("相对时间：今天、昨天、今年、往年", () => {
  const at = (...args) => new Date(...args).getTime() / 1000;
  const now = new Date(2026, 10, 5, 12, 0).getTime();
  assert.equal(Home.relativeTime(at(2026, 10, 5, 7, 11), now), "今天 07:11");
  assert.equal(Home.relativeTime(at(2026, 10, 4, 19, 56), now), "昨天 19:56");
  assert.equal(Home.relativeTime(at(2026, 9, 30, 8, 0), now), "10月30日");
  assert.equal(Home.relativeTime(at(2025, 11, 31, 8, 0), now), "2025年12月31日");
  // 跨月的「昨天」不能算错
  assert.equal(Home.relativeTime(at(2026, 9, 31, 23, 0), new Date(2026, 10, 1, 1, 0).getTime()), "昨天 23:00");
  assert.equal(Home.relativeTime(0, now), "");
  assert.equal(Home.relativeTime(undefined, now), "");
});

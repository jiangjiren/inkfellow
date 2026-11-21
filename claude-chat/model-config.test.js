import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const HERE = new URL(".", import.meta.url);
const EXPECTED_CODEX_MODELS = {
  opusModel: "gpt-6-astra",
  sonnetModel: "gpt-6.1-sol",
  haikuModel: "gpt-6-luna",
};

test("Codex 模型目录不可用时仍配置三档备用模型", async () => {
  const serverSource = await readFile(new URL("server.js", HERE), "utf8");

  for (const [tier, model] of Object.entries(EXPECTED_CODEX_MODELS)) {
    assert.match(serverSource, new RegExp(`${tier}: "${model.replaceAll(".", "\\.")}"`));
  }
});

test("额度展示只渲染接口实际返回的窗口", async () => {
  const frontendSource = await readFile(new URL("public/index.html", HERE), "utf8");
  assert.match(frontendSource, /\.filter\(item => item\.value\?\.usedPercent != null\)/);
  assert.match(frontendSource, /\.map\(item => renderLimitWindow\(item\.label, item\.value, item\.resetFormat\)\)/);
  assert.doesNotMatch(
    frontendSource,
    /const html = `\$\{renderLimitWindow\("5h"[\s\S]*renderLimitWindow\("周"/,
  );
});

test("Codex 长任务只做分级软提示并保留手动停止", async () => {
  const frontendSource = await readFile(new URL("public/index.html", HERE), "utf8");
  assert.match(frontendSource, /const LONG_RUN_NOTICE_MS = 3 \* 60_000/);
  assert.match(frontendSource, /const LONG_RUN_ACTION_MS = 15 \* 60_000/);
  assert.match(frontendSource, />继续等待<\/button>/);
  assert.match(frontendSource, />停止任务<\/button>/);
  assert.match(frontendSource, /longRunStopBtn\.addEventListener\("click", stopCurrentRun\)/);
});

test("历史列表请求不会无限停留在骨架屏", async () => {
  const frontendSource = await readFile(new URL("public/index.html", HERE), "utf8");
  assert.match(frontendSource, /const HISTORY_FETCH_TIMEOUT_MS = 12_000/);
  assert.match(frontendSource, /cache: "no-store"/);
  assert.match(frontendSource, /controller\.abort\(\)/);
  assert.match(frontendSource, />重新加载<\/button>/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import * as legacyEventLog from "./core/event-log.js";

async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function waitForServer(url, proc, stderrRef, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`server exited early (${proc.exitCode}): ${stderrRef.value}`);
    }
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* wait */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`server did not start in time: ${stderrRef.value}`);
}

test("Web mode enforces origin checks, guards local OS openers, and serves safe vault previews", { timeout: 30_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "inkfellow-web-align-"));
  const vault = join(scratch, "vault");
  const dataDir = join(scratch, "data");
  mkdirSync(vault, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(vault, "hello.md"), "# Hello Web\n", "utf8");
  mkdirSync(join(vault, ".secret"), { recursive: true });
  writeFileSync(join(vault, ".secret", "token.txt"), "topsecret", "utf8");

  const port = await freePort();
  const stderrRef = { value: "" };
  const proc = spawn(process.execPath, ["server.js"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      VAULT_PATH: vault,
      CLAUDE_CHAT_DATA_DIR: dataDir,
      DESKTOP_MODE: "false",
      DESKTOP_AGENT_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", chunk => { stderrRef.value += chunk.toString("utf8"); });

  try {
    await waitForServer(`http://127.0.0.1:${port}/api/providers`, proc, stderrRef);

    // 1. Cross-origin API & WS requests are blocked in Web mode.
    const foreignApi = await fetch(`http://127.0.0.1:${port}/api/history`, {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(foreignApi.status, 403);

    const sameOriginApi = await fetch(`http://127.0.0.1:${port}/api/history`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(sameOriginApi.status, 200);

    const wsStatus = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
        headers: { Origin: "https://evil.example" },
      });
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode));
      ws.once("open", () => { ws.close(); resolve(101); });
      ws.once("error", () => {});
    });
    assert.equal(wsStatus, 403);

    // 2. Desktop OS launchers are rejected in Web mode.
    const openFile = await fetch(`http://127.0.0.1:${port}/api/open-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ path: "hello.md" }),
    });
    assert.equal(openFile.status, 400);

    const openArtifact = await fetch(`http://127.0.0.1:${port}/api/orchestrator/artifact/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ path: "hello.md" }),
    });
    assert.equal(openArtifact.status, 400);

    // 3. Safe vault preview serves vault files and blocks dot-dirs / traversal.
    const vaultOk = await fetch(`http://127.0.0.1:${port}/api/vault-file?path=hello.md`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(vaultOk.status, 200);
    assert.equal(await vaultOk.text(), "# Hello Web\n");
    assert.equal(vaultOk.headers.get("x-content-type-options"), "nosniff");

    const vaultDot = await fetch(`http://127.0.0.1:${port}/api/vault-file?path=.secret/token.txt`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(vaultDot.status, 404);

    const vaultEscape = await fetch(`http://127.0.0.1:${port}/api/vault-file?path=../data`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(vaultEscape.status, 404);
  } finally {
    proc.kill();
    await new Promise(r => proc.once("exit", r));
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("Legacy main event-log conversations are automatically imported on startup", { timeout: 30_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "inkfellow-eventlog-mig-"));
  const vault = join(scratch, "vault");
  const dataDir = join(scratch, "data");
  mkdirSync(vault, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const port = await freePort();
  legacyEventLog.configure({ dataDir, port });
  legacyEventLog.replaceFromConversation({
    id: "conv_legacy_1",
    title: "旧版网页对话",
    date: "2026-11-20T08:00:00.000Z",
    messages: [
      { id: "u1", role: "user", text: "你好，旧版记录" },
      { id: "a1", role: "assistant", text: "已完整保留", blocks: [{ type: "text", text: "已完整保留" }], status: "complete" },
    ],
  });

  const stderrRef = { value: "" };
  const proc = spawn(process.execPath, ["server.js"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      VAULT_PATH: vault,
      CLAUDE_CHAT_DATA_DIR: dataDir,
      DESKTOP_MODE: "false",
      DESKTOP_AGENT_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", chunk => { stderrRef.value += chunk.toString("utf8"); });

  try {
    await waitForServer(`http://127.0.0.1:${port}/api/history`, proc, stderrRef);
    const list = await (await fetch(`http://127.0.0.1:${port}/api/history`)).json();
    const migrated = list.find(item => item.id === "conv_legacy_1");
    assert.ok(migrated, "legacy event-log conversation should appear in /api/history");
    assert.equal(migrated.title, "旧版网页对话");

    const full = await (await fetch(`http://127.0.0.1:${port}/api/history/conv_legacy_1`)).json();
    assert.ok(Array.isArray(full.messages) && full.messages.length >= 2);
  } finally {
    proc.kill();
    await new Promise(r => proc.once("exit", r));
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("Aligned index.html wires desktop-lite Fellow UI and Web embed host hooks", async () => {
  const html = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="session-tab-bar"/);
  assert.match(html, /id="ticket-stage-view"/);
  assert.match(html, /id="fellow-memory-popover"/);
  assert.match(html, /id="steering-tray"/);
  assert.match(html, /const isWebEmbed = !isDesktopEmbed && window\.parent !== window;/);
  assert.match(html, /type:\s*"chat-overlay-state"/);
  assert.match(html, /e\.data\?\.type === "close-overlays"/);
  assert.match(html, /api\/vault-file\?path=/);
});

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const source = path.join(root, "claude-chat");
const targetRoot = path.join(root, "desktop-bundle");
const target = path.join(targetRoot, "claude-chat");
const nodeRuntimeTarget = path.join(root, "src-tauri", "bin", "node.exe");

const excludedNames = new Set([
  ".env",
  "auth-profile.json",
  "session.json",
  "history.json",
  "data",
]);

function copyRecursive(from, to) {
  const stat = fs.statSync(from);
  const name = path.basename(from);
  if (excludedNames.has(name)) {
    return;
  }

  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      copyRecursive(path.join(from, entry), path.join(to, entry));
    }
    return;
  }

  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

function prepareNodeRuntime() {
  if (process.platform !== "win32") {
    return;
  }

  const nodeRuntimeSource = process.execPath;
  if (!nodeRuntimeSource.toLowerCase().endsWith("node.exe")) {
    throw new Error(`Cannot locate Windows node.exe from current runtime: ${nodeRuntimeSource}`);
  }

  fs.mkdirSync(path.dirname(nodeRuntimeTarget), { recursive: true });
  fs.copyFileSync(nodeRuntimeSource, nodeRuntimeTarget);
  console.log(`[desktop] prepared Node runtime at ${path.relative(root, nodeRuntimeTarget)}`);
}

if (!fs.existsSync(source)) {
  throw new Error(`claude-chat source not found: ${source}`);
}

if (!fs.existsSync(path.join(source, "node_modules"))) {
  console.warn("[desktop] claude-chat/node_modules is missing; run npm.cmd --prefix claude-chat install before packaging.");
}

prepareNodeRuntime();

fs.rmSync(targetRoot, { recursive: true, force: true });
copyRecursive(source, target);

console.log(`[desktop] prepared claude-chat sidecar at ${path.relative(root, target)}`);

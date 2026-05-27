#!/usr/bin/env node
import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import path from "path";

const args = process.argv.slice(2);

const readOption = (name) => {
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = args.indexOf(`--${name}`);
  if (index >= 0) return args[index + 1];

  return null;
};

const notePath = args.find((arg) => !arg.startsWith("--"));
const token = readOption("token") || randomBytes(12).toString("base64url");
const title = readOption("title");
const expiresAt = readOption("expires-at");
const configPath = process.env.SHARED_NOTES_PATH || path.join(process.cwd(), "shared-notes.json");
const siteUrl = process.env.SITE_URL || "http://localhost:3000";

if (!notePath) {
  console.error("Usage: node scripts/create-share-link.mjs <vault-relative-note-path> [--title <title>] [--expires-at <date>] [--token <token>]");
  process.exit(1);
}

if (!/^[A-Za-z0-9_-]{6,128}$/.test(token)) {
  console.error("Token must be 6-128 URL-safe characters: A-Z, a-z, 0-9, _, -");
  process.exit(1);
}

const readConfig = async () => {
  try {
    return JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
};

const config = await readConfig();

if (config[token]) {
  console.error(`Token already exists: ${token}`);
  process.exit(1);
}

config[token] = {
  path: notePath.replace(/\\/g, "/").replace(/^\/+/, ""),
  enabled: true,
  expiresAt: expiresAt || null,
  noindex: true,
  ...(title ? { title } : {}),
};

await fs.mkdir(path.dirname(configPath), { recursive: true });
await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

console.log(`${siteUrl.replace(/\/+$/, "")}/share/${token}`);

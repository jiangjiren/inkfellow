#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import {
  getShareRegistryPath,
  resolveShareTarget,
  saveShareRecord,
  updateShareRegistry,
} from "../src/lib/shareRegistry.mjs";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      title: { type: "string" },
      "expires-at": { type: "string" },
      token: { type: "string" },
    },
  });
  if (positionals.length !== 1) {
    throw new Error("Usage: node scripts/create-share-link.mjs <vault-relative-note-path> [--title <title>] [--expires-at <date>] [--token <token>]");
  }

  const vaultPath = process.env.VAULT_PATH?.trim() || path.resolve("vault");
  const target = await resolveShareTarget(vaultPath, positionals[0]);
  if (!target) throw new Error("Shareable Markdown or HTML note not found.");

  const { token } = await updateShareRegistry(getShareRegistryPath(), (registry) => ({
    changed: true,
    value: saveShareRecord(registry, target, {
      title: values.title,
      expiresAt: values["expires-at"],
      token: values.token,
    }),
  }));

  const siteUrl = process.env.SITE_URL?.trim() || "http://localhost:3000";
  console.log(`${siteUrl.replace(/\/+$/, "")}/share/${token}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

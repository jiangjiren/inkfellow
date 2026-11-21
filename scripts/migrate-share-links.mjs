#!/usr/bin/env node
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  isSameShareTarget,
  isShareToken,
  readShareRecord,
  readShareRegistry,
  resolveShareTarget,
  shareVaultId,
  updateShareRegistry,
} from "../src/lib/shareRegistry.mjs";

try {
  const [sourcePath, ...args] = process.argv.slice(2);
  if (!sourcePath || args.length < 2 || args.length % 2 !== 0) {
    throw new Error("Usage: node scripts/migrate-share-links.mjs <legacy-registry> <vault-path> <target-registry> [<vault-path> <target-registry> ...]");
  }

  await fs.access(sourcePath);
  const source = await readShareRegistry(path.resolve(sourcePath));
  const destinations = [];
  for (let index = 0; index < args.length; index += 2) {
    const vaultRoot = await fs.realpath(args[index]);
    const registryPath = path.resolve(args[index + 1]);
    if (destinations.some((target) => target.registryPath === registryPath || target.vaultRoot === vaultRoot)) {
      throw new Error("Each vault and target registry must be unique.");
    }
    destinations.push({ vaultRoot, vaultId: shareVaultId(vaultRoot), registryPath, entries: [] });
  }

  const skipped = { missing: 0, ambiguous: 0, invalid: 0 };
  for (const [token, value] of Object.entries(source)) {
    if (!isShareToken(token) || !value || typeof value !== "object" ||
        typeof value.path !== "string" || !value.path.trim()) {
      skipped.invalid++;
      continue;
    }

    const bound = readShareRecord(value);
    const candidates = bound
      ? destinations.filter((target) => target.vaultId === bound.vaultId).map((target) => ({ target, entry: bound }))
      : (await Promise.all(destinations.map(async (target) => {
          const match = await resolveShareTarget(target.vaultRoot, value.path);
          return match && { target, entry: {
            ...match,
            enabled: value.enabled !== false,
            noindex: value.noindex !== false,
            expiresAt: typeof value.expiresAt === "string" ? value.expiresAt : null,
            title: typeof value.title === "string" ? value.title : undefined,
          } };
        }))).filter(Boolean);

    if (candidates.length !== 1) {
      skipped[candidates.length === 0 ? "missing" : "ambiguous"]++;
    } else {
      const [{ target, entry }] = candidates;
      target.entries.push([token, entry]);
    }
  }

  for (const { registryPath, entries } of destinations) {
    const copied = await updateShareRegistry(registryPath, (registry) => {
      let count = 0;
      for (const [token, entry] of entries) {
        const existing = readShareRecord(registry[token]);
        if (existing) {
          if (!isSameShareTarget(existing, entry)) {
            throw new Error(`Share token conflict in ${registryPath}.`);
          }
          continue; // Keep any updates or revocations written after a previous migration.
        }
        registry[token] = entry;
        count++;
      }
      return { changed: count > 0, value: count };
    });
    console.log(`${registryPath}: ${entries.length} matched, ${copied} added`);
  }
  console.log("Legacy records requiring review:", JSON.stringify(skipped));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  normalizeShareExpiration,
  readShareRecord,
  readShareRegistry,
  resolveShareTarget,
  updateShareRegistry,
} from "../src/lib/shareRegistry.mjs";

const exec = promisify(execFile);
const fixture = async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inkfellow-share-test-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const vault = path.join(root, "vault");
  await fs.mkdir(vault);
  return { root, vault, registry: path.join(root, "shares.json") };
};

test("parallel CLI processes retain every share and reuse one token for the same note", async (context) => {
  const { vault, registry } = await fixture(context);
  const env = { ...process.env, VAULT_PATH: vault, SHARED_NOTES_PATH: registry, SITE_URL: "https://example.test" };
  const filenames = Array.from({ length: 8 }, (_, index) => `note-${index}.md`);
  await Promise.all(filenames.map((file) => fs.writeFile(path.join(vault, file), "# Test\n")));

  const output = await Promise.all([...filenames, filenames[0], filenames[0]].map((file) =>
    exec(process.execPath, ["scripts/create-share-link.mjs", file], { env })));
  const shares = await readShareRegistry(registry);
  assert.equal(Object.keys(shares).length, filenames.length);
  assert.equal(output[0].stdout, output.at(-1).stdout);
  assert.equal(output[0].stdout, output.at(-2).stdout);
  for (const result of output) {
    const token = result.stdout.trim().split("/").at(-1);
    assert.ok(readShareRecord(shares[token]));
  }
});

test("file identity survives edits and renames and distinguishes reused paths", async (context) => {
  const { vault } = await fixture(context);
  await fs.writeFile(path.join(vault, "note.md"), "# Original\n");
  const target = await resolveShareTarget(vault, "note.md");
  await fs.writeFile(path.join(vault, "note.md"), "# Updated\n");
  assert.equal((await resolveShareTarget(vault, "note.md")).noteId, target.noteId);
  await fs.rename(path.join(vault, "note.md"), path.join(vault, "renamed.md"));
  assert.equal((await resolveShareTarget(vault, "renamed.md")).noteId, target.noteId);
  await fs.writeFile(path.join(vault, "note.md"), "# Replacement\n");
  assert.notEqual((await resolveShareTarget(vault, "note.md")).noteId, target.noteId);
});

test("migration preserves only unambiguous legacy links and is safe to repeat after revocation", async (context) => {
  const { root, vault, registry } = await fixture(context);
  const other = path.join(root, "other-vault");
  const otherRegistry = path.join(root, "other.json");
  const legacy = path.join(root, "legacy.json");
  await fs.mkdir(other);
  await fs.writeFile(path.join(vault, "one.md"), "# Vault one");
  await fs.writeFile(path.join(other, "two.md"), "# Vault two");
  await fs.writeFile(path.join(vault, "both.md"), "# First");
  await fs.writeFile(path.join(other, "both.md"), "# Second");
  await fs.writeFile(legacy, JSON.stringify({
    uniqueOne: { path: "one.md", title: "Shared title" },
    uniqueTwo: { path: "two.md" },
    ambiguous: { path: "both.md" },
    missingNote: { path: "missing.md" },
  }));

  const migrate = () => exec(process.execPath, [
    "scripts/migrate-share-links.mjs", legacy, vault, registry, other, otherRegistry,
  ]);
  await migrate();
  assert.deepEqual(Object.keys(await readShareRegistry(registry)), ["uniqueOne"]);
  assert.deepEqual(Object.keys(await readShareRegistry(otherRegistry)), ["uniqueTwo"]);
  await updateShareRegistry(registry, (shares) => {
    shares.uniqueOne.enabled = false;
    return { changed: true, value: undefined };
  });
  await migrate();
  const saved = readShareRecord((await readShareRegistry(registry)).uniqueOne);
  assert.equal(saved.title, "Shared title");
  assert.equal(saved.enabled, false);
  assert.equal(Object.keys(await readShareRegistry(legacy)).length, 4);
});

test("expiration rejects invalid dates and past dates", () => {
  for (const invalid of ["not-a-date", "2099-02-29", "2000-01-01", "", 42]) {
    assert.throws(() => normalizeShareExpiration(invalid), { status: 400 });
  }
  assert.equal(normalizeShareExpiration("2099-12-31T12:45:00+08:00"), "2099-12-31T04:45:00.000Z");
  assert.equal(normalizeShareExpiration(null), null);
  assert.equal(normalizeShareExpiration(undefined), undefined);
});

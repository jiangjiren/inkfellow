import { promises as fs } from "fs";
import { randomBytes } from "crypto";
import path from "path";
import { readMarkdownNote, readVaultImageFromNoteDirectory } from "@/lib/notesVault";

export type SharedNoteConfig = {
  path: string;
  enabled?: boolean;
  expiresAt?: string | null;
  noindex?: boolean;
  title?: string;
};

export class SharedNoteAccessError extends Error {
  status: number;

  constructor(message: string, status = 404) {
    super(message);
    this.name = "SharedNoteAccessError";
    this.status = status;
  }
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;

const getSharedNotesPath = () =>
  process.env.SHARED_NOTES_PATH?.trim() || path.join(process.cwd(), "shared-notes.json");

const assertValidToken = (token: string) => {
  if (!TOKEN_PATTERN.test(token)) {
    throw new SharedNoteAccessError("Shared note not found.", 404);
  }
};

const readSharedNotesConfig = async () => {
  try {
    const raw = await fs.readFile(getSharedNotesPath(), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }

    throw error;
  }
};

const writeSharedNotesConfig = async (config: Record<string, unknown>) => {
  const configPath = getSharedNotesPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
};

const normalizeSharedNoteConfig = (value: unknown): SharedNoteConfig | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string" || !record.path.trim()) {
    return null;
  }

  return {
    path: record.path,
    enabled: typeof record.enabled === "boolean" ? record.enabled : undefined,
    expiresAt:
      typeof record.expiresAt === "string" || record.expiresAt === null
        ? record.expiresAt
        : undefined,
    noindex: typeof record.noindex === "boolean" ? record.noindex : undefined,
    title: typeof record.title === "string" ? record.title : undefined,
  };
};

const isSharedNoteActive = (sharedNote: SharedNoteConfig) => {
  if (sharedNote.enabled === false) {
    return false;
  }

  if (!sharedNote.expiresAt) {
    return true;
  }

  const expiresAt = new Date(sharedNote.expiresAt);
  return !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() > Date.now();
};

export const getSharedNoteConfig = async (token: string) => {
  assertValidToken(token);
  const config = await readSharedNotesConfig();
  const sharedNote = normalizeSharedNoteConfig(config[token]);

  if (!sharedNote) {
    throw new SharedNoteAccessError("Shared note not found.", 404);
  }

  if (sharedNote.enabled === false) {
    throw new SharedNoteAccessError("Shared note is disabled.", 410);
  }

  if (sharedNote.expiresAt) {
    const expiresAt = new Date(sharedNote.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new SharedNoteAccessError("Shared note has an invalid expiration.", 500);
    }

    if (expiresAt.getTime() <= Date.now()) {
      throw new SharedNoteAccessError("Shared note has expired.", 410);
    }
  }

  return sharedNote;
};

export const readSharedNote = async (token: string) => {
  const sharedNote = await getSharedNoteConfig(token);
  const note = await readMarkdownNote(sharedNote.path);

  return {
    note,
    share: sharedNote,
  };
};

export const readSharedNoteAsset = async (token: string, assetPath: string) => {
  const sharedNote = await getSharedNoteConfig(token);
  return readVaultImageFromNoteDirectory(assetPath, sharedNote.path);
};

export const findActiveSharedNoteByPath = async (notePath: string) => {
  const note = await readMarkdownNote(notePath);
  const config = await readSharedNotesConfig();

  for (const [token, value] of Object.entries(config)) {
    const sharedNote = normalizeSharedNoteConfig(value);
    if (!sharedNote || sharedNote.path !== note.path || !isSharedNoteActive(sharedNote)) {
      continue;
    }

    return {
      token,
      note,
      share: sharedNote,
    };
  }

  return {
    token: null,
    note,
    share: null,
  };
};

export const createSharedNote = async ({
  notePath,
  title,
  expiresAt = null,
}: {
  notePath: string;
  title?: string | null;
  expiresAt?: string | null;
}) => {
  const note = await readMarkdownNote(notePath);
  const config = await readSharedNotesConfig();
  let token = randomBytes(12).toString("base64url");

  while (config[token]) {
    token = randomBytes(12).toString("base64url");
  }

  config[token] = {
    path: note.path,
    enabled: true,
    expiresAt,
    noindex: true,
    ...(title?.trim() ? { title: title.trim() } : {}),
  } satisfies SharedNoteConfig;

  await writeSharedNotesConfig(config);

  return {
    token,
    note,
  };
};

export const revokeSharedNote = async (token: string) => {
  assertValidToken(token);
  const config = await readSharedNotesConfig();
  const sharedNote = normalizeSharedNoteConfig(config[token]);

  if (!sharedNote) {
    throw new SharedNoteAccessError("Shared note not found.", 404);
  }

  config[token] = {
    ...sharedNote,
    enabled: false,
  } satisfies SharedNoteConfig;

  await writeSharedNotesConfig(config);
};

export const mapSharedNoteError = (error: unknown) => {
  if (error instanceof SharedNoteAccessError) {
    return {
      message: error.message,
      status: error.status,
    };
  }

  console.error(error);
  return {
    message: "Unexpected shared note error.",
    status: 500,
  };
};

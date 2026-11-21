import {
  findShareableNoteById,
  getVaultRoot,
  readShareableNote,
  VaultAccessError,
} from "@/lib/notesVault";
import {
  findShareByTarget,
  getShareRegistryPath,
  isActiveShare,
  isSameShareTarget,
  isShareToken,
  readShareRecord,
  readShareRegistry,
  saveShareRecord,
  SharedNoteAccessError,
  shareVaultId,
  updateShareRegistry,
} from "@/lib/shareRegistry.mjs";

export { SharedNoteAccessError };

const assertValidToken = (token: string) => {
  if (!isShareToken(token)) throw new SharedNoteAccessError("Shared note not found.");
};

const getSharedNoteConfig = async (token: string) => {
  assertValidToken(token);
  const vaultRoot = await getVaultRoot();
  const share = readShareRecord((await readShareRegistry())[token]);

  if (!share || share.vaultId !== shareVaultId(vaultRoot)) {
    throw new SharedNoteAccessError("Shared note not found.");
  }
  if (!isActiveShare(share)) {
    throw new SharedNoteAccessError("Shared note is disabled or has expired.", 410);
  }
  return { share, vaultRoot };
};

export const readSharedNote = async (token: string) => {
  const { share, vaultRoot } = await getSharedNoteConfig(token);
  try {
    const { note } = await readShareableNote(encodeURIComponent(share.path), share.noteId);
    return { note, share };
  } catch (error) {
    if (!(error instanceof VaultAccessError && error.status === 404)) throw error;
  }

  const relocatedPath = await findShareableNoteById(vaultRoot, share.noteId);
  if (!relocatedPath) throw new SharedNoteAccessError("Shared note not found.");

  const { note } = await readShareableNote(encodeURIComponent(relocatedPath), share.noteId);
  // The lookup above remains valid even when the service temporarily cannot
  // save the new path. The stored file identity is still authoritative.
  await updateShareRegistry(getShareRegistryPath(), (registry) => {
    const latest = readShareRecord(registry[token]);
    if (!latest || !isSameShareTarget(share, latest) || latest.path === note.path) {
      return { changed: false, value: undefined };
    }
    registry[token] = { ...latest, path: note.path };
    return { changed: true, value: undefined };
  }).catch((error: unknown) => console.error("Could not update relocated share path.", error));

  return { note, share };
};

const getShareTarget = async (notePath: string) => {
  const vaultRoot = await getVaultRoot();
  const { noteId, note } = await readShareableNote(notePath);
  return { path: note.path, vaultId: shareVaultId(vaultRoot), noteId };
};

export const findActiveSharedNoteByPath = async (notePath: string) => {
  const target = await getShareTarget(notePath);
  return findShareByTarget(await readShareRegistry(), target);
};

export const createSharedNote = async ({
  notePath,
  title,
  expiresAt,
}: {
  notePath: string;
  title?: string | null;
  expiresAt?: string | null;
}) => {
  const target = await getShareTarget(notePath);
  return updateShareRegistry(getShareRegistryPath(), (registry) => {
    const value = saveShareRecord(registry, target, { title, expiresAt });
    return { changed: true, value };
  });
};

export const revokeSharedNote = async (token: string, notePath?: string) => {
  assertValidToken(token);
  const vaultId = shareVaultId(await getVaultRoot());
  const target = notePath === undefined ? null : await getShareTarget(notePath);

  await updateShareRegistry(getShareRegistryPath(), (registry) => {
    const share = readShareRecord(registry[token]);
    if (!share || share.vaultId !== vaultId || (target && !isSameShareTarget(share, target))) {
      throw new SharedNoteAccessError("Shared note not found.");
    }

    let changed = false;
    for (const [entryToken, value] of Object.entries(registry)) {
      const entry = readShareRecord(value);
      if (entry?.enabled && isSameShareTarget(share, entry)) {
        registry[entryToken] = { ...entry, enabled: false };
        changed = true;
      }
    }
    return { changed, value: undefined };
  });
};

export const mapSharedNoteError = (error: unknown) => {
  if (error instanceof SharedNoteAccessError) {
    return { message: error.message, status: error.status };
  }
  if ((error as NodeJS.ErrnoException | null)?.code === "ELOCKED") {
    return { message: "分享服务正在保存其他操作，请稍后重试。", status: 503 };
  }

  console.error(error);
  return { message: "Unexpected shared note error.", status: 500 };
};

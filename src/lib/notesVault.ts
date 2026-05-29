import { promises as fs } from "fs";
import path from "path";
import type {
  NotesDirectoryNode,
  NotesFileNode,
  NotesTreeNode,
} from "@/lib/notesTypes";

const DEFAULT_VAULT_PATH = path.join(process.cwd(), "vault");

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  ".obsidian",
  ".claude",
  ".claudian",
  "node_modules",
]);

const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);

const MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export class VaultAccessError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "VaultAccessError";
    this.status = status;
  }
}

const getConfiguredVaultPath = () => process.env.VAULT_PATH?.trim() || DEFAULT_VAULT_PATH;

const toVaultPath = (relativePath: string) => relativePath.split(path.sep).join("/");

const hasExcludedSegment = (relativePath: string) =>
  relativePath
    .split("/")
    .filter(Boolean)
    .some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment));

const decodeLoose = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const sanitizeRelativePath = (input: string, { allowEmpty = false } = {}) => {
  const decoded = decodeLoose(input).replace(/\\/g, "/").trim();

  if (!decoded) {
    if (allowEmpty) {
      return "";
    }
    throw new VaultAccessError("Missing path.");
  }

  if (decoded.includes("\0")) {
    throw new VaultAccessError("Invalid path.");
  }

  const normalized = path.posix.normalize(decoded.replace(/^\/+/, ""));
  if (!normalized || normalized === ".") {
    if (allowEmpty) {
      return "";
    }
    throw new VaultAccessError("Missing path.");
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) {
    throw new VaultAccessError("Path traversal is not allowed.", 403);
  }

  if (hasExcludedSegment(normalized)) {
    throw new VaultAccessError("This path is excluded.", 403);
  }

  return normalized;
};

const getVaultRoot = async () => {
  const configuredPath = path.resolve(getConfiguredVaultPath());
  try {
    return await fs.realpath(configuredPath);
  } catch {
    throw new VaultAccessError("Vault path is unavailable.", 503);
  }
};

const assertInsideVault = (absolutePath: string, vaultRoot: string) => {
  if (absolutePath !== vaultRoot && !absolutePath.startsWith(`${vaultRoot}${path.sep}`)) {
    throw new VaultAccessError("Path traversal is not allowed.", 403);
  }
};

const resolveExistingVaultPath = async (relativePath: string) => {
  const vaultRoot = await getVaultRoot();
  const sanitizedPath = sanitizeRelativePath(relativePath);
  const candidate = path.resolve(vaultRoot, sanitizedPath);
  assertInsideVault(candidate, vaultRoot);

  let realPath: string;
  try {
    realPath = await fs.realpath(candidate);
  } catch {
    throw new VaultAccessError("File not found.", 404);
  }

  assertInsideVault(realPath, vaultRoot);
  const realRelativePath = toVaultPath(path.relative(vaultRoot, realPath));
  if (hasExcludedSegment(realRelativePath)) {
    throw new VaultAccessError("This path is excluded.", 403);
  }

  return {
    absolutePath: realPath,
    relativePath: realRelativePath,
  };
};

const resolveExistingVaultPathIfAllowed = async (relativePath: string) => {
  try {
    return await resolveExistingVaultPath(relativePath);
  } catch {
    return null;
  }
};

const isMarkdownPath = (relativePath: string) => path.extname(relativePath).toLowerCase() === ".md";

const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const isHtmlPath = (relativePath: string) => HTML_EXTENSIONS.has(path.extname(relativePath).toLowerCase());

const isNoteFile = (name: string) => isMarkdownPath(name) || isHtmlPath(name);

const isImagePath = (relativePath: string) => IMAGE_EXTENSIONS.has(path.extname(relativePath).toLowerCase());

const compareNodes = (left: NotesTreeNode, right: NotesTreeNode) => {
  if (left.type !== right.type) {
    return left.type === "directory" ? -1 : 1;
  }
  return left.name.localeCompare(right.name, "zh-Hans", { numeric: true, sensitivity: "base" });
};

const walkDirectory = async (absolutePath: string, relativePath: string): Promise<NotesDirectoryNode> => {
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  const children: NotesTreeNode[] = [];

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (hasExcludedSegment(childRelativePath)) {
      continue;
    }

    const childAbsolutePath = path.join(absolutePath, entry.name);

    if (entry.isDirectory()) {
      const directory = await walkDirectory(childAbsolutePath, childRelativePath);
      // Include all non-excluded directories, even empty ones (user may have just created them)
      children.push(directory);
      continue;
    }

    if (!entry.isFile() || !isNoteFile(entry.name)) {
      continue;
    }

    const stat = await fs.stat(childAbsolutePath);
    children.push({
      type: "file",
      name: entry.name,
      path: childRelativePath,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
    } satisfies NotesFileNode);
  }

  children.sort(compareNodes);

  return {
    type: "directory",
    name: relativePath ? path.posix.basename(relativePath) : path.basename(await getVaultRoot()),
    path: relativePath,
    children,
  };
};

export const getNotesTree = async () => {
  const vaultRoot = await getVaultRoot();
  return walkDirectory(vaultRoot, "");
};

// 只读取文件元数据（修改时间），不加载内容，供轮询检测变化用
export const statMarkdownNote = async (relativePath: string) => {
  const resolved = await resolveExistingVaultPath(relativePath);
  if (!isMarkdownPath(resolved.relativePath) && !isHtmlPath(resolved.relativePath)) {
    throw new VaultAccessError("Only Markdown and HTML files can be read.", 415);
  }
  const stat = await fs.stat(resolved.absolutePath);
  return {
    path: resolved.relativePath,
    updatedAt: stat.mtime.toISOString(),
  };
};

export const readMarkdownNote = async (relativePath: string) => {
  const resolved = await resolveExistingVaultPath(relativePath);
  if (!isMarkdownPath(resolved.relativePath) && !isHtmlPath(resolved.relativePath)) {
    throw new VaultAccessError("Only Markdown and HTML files can be read.", 415);
  }

  const stat = await fs.stat(resolved.absolutePath);
  if (!stat.isFile()) {
    throw new VaultAccessError("File not found.", 404);
  }

  const content = await fs.readFile(resolved.absolutePath, "utf8");
  return {
    name: path.basename(resolved.relativePath),
    path: resolved.relativePath,
    content,
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
  };
};

const stripFragmentAndQuery = (value: string) => value.split("#", 1)[0].split("?", 1)[0];

const findImageByFileName = async (
  directory: string,
  relativePath: string,
  wantedName: string,
): Promise<string | null> => {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const sortedEntries = [...entries].sort((left, right) =>
    left.name.localeCompare(right.name, "zh-Hans", { numeric: true, sensitivity: "base" }),
  );

  for (const entry of sortedEntries) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (hasExcludedSegment(childRelativePath)) {
      continue;
    }

    const childAbsolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const match = await findImageByFileName(childAbsolutePath, childRelativePath, wantedName);
      if (match) {
        return match;
      }
      continue;
    }

    if (
      entry.isFile() &&
      entry.name.toLocaleLowerCase() === wantedName &&
      isImagePath(entry.name)
    ) {
      return childRelativePath;
    }
  }

  return null;
};

export const readVaultImage = async (assetPath: string, fromPath?: string | null) => {
  const rawAssetPath = decodeLoose(stripFragmentAndQuery(assetPath).split("|", 1)[0])
    .replace(/\\/g, "/")
    .trim();

  if (!rawAssetPath || rawAssetPath.includes("\0")) {
    throw new VaultAccessError("Missing asset path.");
  }

  const assetPathWithoutLeadingSlash = rawAssetPath.replace(/^\/+/, "");
  const candidates: string[] = [];

  if (fromPath) {
    try {
      const cleanFromPath = sanitizeRelativePath(fromPath);
      const fromDirectory = path.posix.dirname(cleanFromPath);
      candidates.push(
        sanitizeRelativePath(
          path.posix.normalize(
            path.posix.join(fromDirectory === "." ? "" : fromDirectory, assetPathWithoutLeadingSlash),
          ),
        ),
      );
    } catch {
      // Ignore invalid context and try vault-root candidates below.
    }
  }

  try {
    candidates.push(sanitizeRelativePath(assetPathWithoutLeadingSlash));
  } catch {
    if (candidates.length === 0) {
      throw new VaultAccessError("Invalid asset path.");
    }
  }

  for (const candidate of candidates) {
    const resolved = await resolveExistingVaultPathIfAllowed(candidate);
    if (!resolved || !isImagePath(resolved.relativePath)) {
      continue;
    }

    const stat = await fs.stat(resolved.absolutePath);
    if (!stat.isFile()) {
      continue;
    }

    const extension = path.extname(resolved.relativePath).toLowerCase();
    return {
      body: await fs.readFile(resolved.absolutePath),
      contentType: MIME_TYPES[extension] ?? "application/octet-stream",
      size: stat.size,
      updatedAt: stat.mtime.toUTCString(),
    };
  }

  const vaultRoot = await getVaultRoot();
  const fileName = path.posix.basename(assetPathWithoutLeadingSlash).toLocaleLowerCase();
  const match = await findImageByFileName(vaultRoot, "", fileName);
  if (!match) {
    throw new VaultAccessError("Image not found.", 404);
  }

  const resolved = await resolveExistingVaultPath(match);
  const stat = await fs.stat(resolved.absolutePath);
  const extension = path.extname(resolved.relativePath).toLowerCase();

  return {
    body: await fs.readFile(resolved.absolutePath),
    contentType: MIME_TYPES[extension] ?? "application/octet-stream",
    size: stat.size,
    updatedAt: stat.mtime.toUTCString(),
  };
};

export const readVaultImageFromNoteDirectory = async (assetPath: string, notePath: string) => {
  const rawAssetPath = decodeLoose(stripFragmentAndQuery(assetPath).split("|", 1)[0])
    .replace(/\\/g, "/")
    .trim();

  if (!rawAssetPath || rawAssetPath.includes("\0")) {
    throw new VaultAccessError("Missing asset path.");
  }

  const cleanNotePath = sanitizeRelativePath(notePath);
  const noteDirectory = path.posix.dirname(cleanNotePath);
  const assetPathWithoutLeadingSlash = rawAssetPath.replace(/^\/+/, "");
  const candidate = sanitizeRelativePath(
    path.posix.normalize(
      path.posix.join(noteDirectory === "." ? "" : noteDirectory, assetPathWithoutLeadingSlash),
    ),
  );
  const resolved = await resolveExistingVaultPath(candidate);

  if (!isImagePath(resolved.relativePath)) {
    throw new VaultAccessError("Only image assets can be read.", 415);
  }

  const stat = await fs.stat(resolved.absolutePath);
  if (!stat.isFile()) {
    throw new VaultAccessError("Image not found.", 404);
  }

  const extension = path.extname(resolved.relativePath).toLowerCase();
  return {
    body: await fs.readFile(resolved.absolutePath),
    contentType: MIME_TYPES[extension] ?? "application/octet-stream",
    size: stat.size,
    updatedAt: stat.mtime.toUTCString(),
  };
};

export const updateMarkdownNote = async (relativePath: string, content: string) => {
  const resolved = await resolveExistingVaultPath(relativePath);
  if (!isMarkdownPath(resolved.relativePath)) {
    throw new VaultAccessError("Only .md files can be edited.", 415);
  }
  await fs.writeFile(resolved.absolutePath, content, "utf8");
  const stat = await fs.stat(resolved.absolutePath);
  return {
    name: path.basename(resolved.relativePath),
    path: resolved.relativePath,
    content,
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
  };
};

export const createMarkdownNote = async (relativePath: string, content = "") => {
  const sanitized = sanitizeRelativePath(relativePath);

  if (!isMarkdownPath(sanitized)) {
    throw new VaultAccessError("Only .md files can be created.", 415);
  }

  const vaultRoot = await getVaultRoot();
  const absolutePath = path.resolve(vaultRoot, sanitized);
  assertInsideVault(absolutePath, vaultRoot);

  // Refuse to overwrite an existing file
  try {
    await fs.access(absolutePath);
    throw new VaultAccessError("A file with this name already exists.", 409);
  } catch (err) {
    if (err instanceof VaultAccessError) throw err;
    // ENOENT → file doesn't exist, which is what we want
  }

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");

  const stat = await fs.stat(absolutePath);
  return {
    name: path.basename(sanitized),
    path: sanitized,
    content,
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
  };
};

export const createFolder = async (relativePath: string) => {
  const sanitized = sanitizeRelativePath(relativePath);

  const vaultRoot = await getVaultRoot();
  const absolutePath = path.resolve(vaultRoot, sanitized);
  assertInsideVault(absolutePath, vaultRoot);

  // Refuse to create if path already exists
  try {
    await fs.access(absolutePath);
    throw new VaultAccessError("A folder with this name already exists.", 409);
  } catch (err) {
    if (err instanceof VaultAccessError) throw err;
    // ENOENT → doesn't exist yet, which is what we want
  }

  await fs.mkdir(absolutePath, { recursive: true });

  // Write a .gitkeep so the folder appears in the file tree
  const keepFile = path.join(absolutePath, ".gitkeep");
  await fs.writeFile(keepFile, "", "utf8");

  return { path: sanitized, name: path.posix.basename(sanitized) };
};

export const mapVaultError = (error: unknown) => {
  if (error instanceof VaultAccessError) {
    return {
      message: error.message,
      status: error.status,
    };
  }

  console.error(error);
  return {
    message: "Unexpected notes vault error.",
    status: 500,
  };
};

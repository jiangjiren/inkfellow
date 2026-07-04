export type NotesFileNode = {
  type: "file";
  name: string;
  path: string;
  size: number;
  updatedAt: string;
};

export type NotesDirectoryNode = {
  type: "directory";
  name: string;
  path: string;
  children: NotesTreeNode[];
};

export type NotesTreeNode = NotesDirectoryNode | NotesFileNode;

export type NotesTreeResponse = {
  root: NotesDirectoryNode;
  generatedAt: string;
  /** 结构指纹：所有节点路径的哈希，仅在增/删/改名时变化，用于客户端轮询比对 */
  rev: string;
};

export type NotesSearchHit = {
  path: string;
  name: string;
  snippet: string;
};

export type NotesSearchResponse = {
  hits: NotesSearchHit[];
};

export type MentionEntryKind = "markdown" | "html" | "pdf" | "image";

export type MentionEntry = {
  path: string;
  title: string;
  aliases: string[];
  kind: MentionEntryKind;
};

export type MentionsResponse = {
  entries: MentionEntry[];
};

export type NotesFileResponse = {
  name: string;
  path: string;
  content: string;
  size: number;
  updatedAt: string;
  aliases?: string[];
};

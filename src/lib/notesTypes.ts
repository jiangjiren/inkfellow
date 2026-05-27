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
};

export type NotesFileResponse = {
  name: string;
  path: string;
  content: string;
  size: number;
  updatedAt: string;
};

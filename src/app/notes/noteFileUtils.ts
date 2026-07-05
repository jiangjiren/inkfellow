// 文件树与阅读区共用的路径/类型小工具（从 NotesExplorer 渐进拆分而来）

export type TreeActionTarget = {
  kind: "file" | "folder";
  name: string;
  path: string;
};

export const stripNoteExtension = (value: string) => value.replace(/\.(md|html?)$/i, "");

// PDF / 图片走只读预览，不经文本加载/编辑流程
export const isPdfPath = (value: string | null | undefined) => /\.pdf$/i.test(value ?? "");
export const isImagePath = (value: string | null | undefined) =>
  /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(value ?? "");

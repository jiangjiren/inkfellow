"use client";

import { memo, useEffect, useRef, type CSSProperties } from "react";
import type { NotesTreeNode } from "@/lib/notesTypes";
import { isImagePath, isPdfPath, stripNoteExtension, type TreeActionTarget } from "./noteFileUtils";
import styles from "./notes.module.css";

function TreeActionMenu({
  target,
  onCreateNote,
  onCreateFolder,
  onImport,
  onRename,
  onDelete,
  onDownload,
}: {
  target: TreeActionTarget;
  onCreateNote: (folder: string) => void;
  onCreateFolder: (folder: string) => void;
  onImport: (folder: string) => void;
  onRename: (target: TreeActionTarget) => void;
  onDelete: (target: TreeActionTarget) => void;
  onDownload: (path: string) => void;
}) {
  const isFolder = target.kind === "folder";
  const canDownload = target.kind === "file" && (isPdfPath(target.path) || isImagePath(target.path));

  return (
    <div className={styles.treeActionMenu} role="menu" onClick={(event) => event.stopPropagation()}>
      {isFolder ? (
        <>
          <button type="button" className={styles.treeActionItem} role="menuitem" onClick={() => onCreateNote(target.path)}>新建笔记</button>
          <button type="button" className={styles.treeActionItem} role="menuitem" onClick={() => onCreateFolder(target.path)}>新建文件夹</button>
          <button type="button" className={styles.treeActionItem} role="menuitem" onClick={() => onImport(target.path)}>导入文件</button>
          <div className={styles.moreMenuDivider} role="separator" />
        </>
      ) : null}
      {canDownload ? (
        <button type="button" className={styles.treeActionItem} role="menuitem" onClick={() => onDownload(target.path)}>下载</button>
      ) : null}
      <button type="button" className={styles.treeActionItem} role="menuitem" onClick={() => onRename(target)}>重命名</button>
      <button type="button" className={`${styles.treeActionItem} ${styles.moreMenuItemDanger}`} role="menuitem" onClick={() => onDelete(target)}>删除</button>
    </div>
  );
}

type TreeItemProps = {
  node: NotesTreeNode;
  level: number;
  activePath: string | null;
  expandedFolders: Set<string>;
  searchQuery: string;
  activeMenuPath: string | null;
  isMobileViewport: boolean;
  renamingTarget: TreeActionTarget | null;
  renameValue: string;
  renameError: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onOpenMenu: (target: TreeActionTarget) => void;
  onCloseMenu: () => void;
  onCreateNote: (folder: string) => void;
  onCreateFolder: (folder: string) => void;
  onImport: (folder: string) => void;
  onRename: (target: TreeActionTarget) => void;
  onDelete: (target: TreeActionTarget) => void;
  onDownload: (path: string) => void;
  onRenameValueChange: (val: string) => void;
  onRenameCommit: () => Promise<void>;
  onRenameCancel: () => void;
};

function TreeItem({
  node,
  level,
  activePath,
  expandedFolders,
  searchQuery,
  activeMenuPath,
  isMobileViewport,
  renamingTarget,
  renameValue,
  renameError,
  onToggle,
  onSelect,
  onOpenMenu,
  onCloseMenu,
  onCreateNote,
  onCreateFolder,
  onImport,
  onRename,
  onDelete,
  onDownload,
  onRenameValueChange,
  onRenameCommit,
  onRenameCancel,
}: TreeItemProps) {
  const isRenaming = renamingTarget?.path === node.path;
  const inlineInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (isRenaming && inlineInputRef.current) {
      inlineInputRef.current.focus();
      inlineInputRef.current.select();
    }
  }, [isRenaming]);

  if (node.type === "file") {
    const isActive = node.path === activePath;
    const isHtml = /\.html?$/i.test(node.name);
    const isPdf = /\.pdf$/i.test(node.name);
    const isImg = isImagePath(node.name);
    const ext = isImg ? node.name.split(".").pop()?.toLowerCase() : null;
    const fileExt = node.name.match(/\.[^.]+$/)?.[0] ?? "";
    const target: TreeActionTarget = { kind: "file", name: node.name, path: node.path };
    return (
      <div
        className={`${styles.treeNodeWrap} ${isRenaming ? styles.treeNodeWrapRenaming : ""}`}
        style={{ "--level": level } as CSSProperties}
        onContextMenu={(event) => {
          if (isRenaming) return;
          event.preventDefault();
          onOpenMenu(target);
        }}
      >
        {isRenaming ? (
          <>
            <div className={styles.treeRenameWrap}>
              <svg className={styles.fileDot} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: "13px", height: "13px" }}>
                <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <input
                ref={inlineInputRef}
                className={styles.treeRenameInput}
                value={renameValue}
                onChange={(e) => { onRenameValueChange(e.target.value); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); void onRenameCommit(); }
                  if (e.key === "Escape") { e.preventDefault(); onRenameCancel(); }
                }}
                onBlur={() => void onRenameCommit()}
                autoComplete="off"
                spellCheck={false}
                aria-label="重命名"
              />
              {fileExt ? <span className={styles.renameExtension}>{fileExt}</span> : null}
            </div>
            {renameError ? <span className={styles.treeRenameError}>{renameError}</span> : null}
          </>
        ) : (
          <>
            <button
              type="button"
              className={`${styles.treeFile} ${isActive ? styles.treeFileActive : ""}`}
              onClick={() => onSelect(node.path)}
              title={node.path}
            >
              <svg className={styles.fileDot} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: "13px", height: "13px" }}>
                <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span className={styles.treeLabel}>{isImg ? node.name.replace(/\.[^.]+$/, "") : isPdf ? node.name.replace(/\.pdf$/i, "") : stripNoteExtension(node.name)}</span>
              {isHtml ? <span className={styles.fileTypeBadge}>html</span> : null}
              {isPdf ? <span className={styles.fileTypeBadge}>pdf</span> : null}
              {isImg ? <span className={styles.fileTypeBadge}>{ext}</span> : null}
            </button>
            <button
              type="button"
              className={styles.treeNodeMore}
              onClick={(event) => {
                event.stopPropagation();
                onOpenMenu(target);
              }}
              aria-label={`${node.name} 的操作`}
              title="更多操作"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="1.5" />
                <circle cx="12" cy="12" r="1.5" />
                <circle cx="19" cy="12" r="1.5" />
              </svg>
            </button>
            {!isMobileViewport && activeMenuPath === node.path ? (
              <TreeActionMenu
                target={target}
                onCreateNote={(folder) => { onCloseMenu(); onCreateNote(folder); }}
                onCreateFolder={(folder) => { onCloseMenu(); onCreateFolder(folder); }}
                onImport={(folder) => { onCloseMenu(); onImport(folder); }}
                onRename={(menuTarget) => { onCloseMenu(); onRename(menuTarget); }}
                onDelete={(menuTarget) => { onCloseMenu(); onDelete(menuTarget); }}
                onDownload={(path) => { onCloseMenu(); onDownload(path); }}
              />
            ) : null}
          </>
        )}
      </div>
    );
  }

  const isExpanded = searchQuery ? true : expandedFolders.has(node.path);
  const target: TreeActionTarget = { kind: "folder", name: node.name, path: node.path };
  return (
    <div className={styles.treeGroup}>
      {node.path ? (
        <div
          className={`${styles.treeNodeWrap} ${isRenaming ? styles.treeNodeWrapRenaming : ""}`}
          style={{ "--level": level } as CSSProperties}
          onContextMenu={(event) => {
            if (isRenaming) return;
            event.preventDefault();
            onOpenMenu(target);
          }}
        >
          {isRenaming ? (
            <>
              <div className={styles.treeRenameWrap}>
                <span className={`${styles.chevron} ${isExpanded ? styles.chevronOpen : ""}`} aria-hidden="true">›</span>
                <svg className={styles.folderGlyph} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: "16px", height: "16px", color: "var(--notes-accent)" }}>
                  {isExpanded ? (
                    <>
                      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" fill="var(--notes-accent-bg)" />
                      <path d="M2 10h20" />
                    </>
                  ) : (
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" fill="var(--notes-accent-bg)" />
                  )}
                </svg>
                <input
                  ref={inlineInputRef}
                  className={styles.treeRenameInput}
                  value={renameValue}
                  onChange={(e) => { onRenameValueChange(e.target.value); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); void onRenameCommit(); }
                    if (e.key === "Escape") { e.preventDefault(); onRenameCancel(); }
                  }}
                  onBlur={() => void onRenameCommit()}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="重命名"
                />
              </div>
              {renameError ? <span className={styles.treeRenameError}>{renameError}</span> : null}
            </>
          ) : (
            <>
              <button
                type="button"
                className={styles.treeFolder}
                onClick={() => onToggle(node.path)}
                title={node.path}
              >
                <span className={`${styles.chevron} ${isExpanded ? styles.chevronOpen : ""}`} aria-hidden="true">
                  ›
                </span>
                <svg className={styles.folderGlyph} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: "16px", height: "16px", color: "var(--notes-accent)" }}>
                  {isExpanded ? (
                    <>
                      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" fill="var(--notes-accent-bg)" />
                      <path d="M2 10h20" />
                    </>
                  ) : (
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" fill="var(--notes-accent-bg)" />
                  )}
                </svg>
                <span className={styles.treeLabel}>{node.name}</span>
              </button>
              <button
                type="button"
                className={styles.treeNodeMore}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenMenu(target);
                }}
                aria-label={`${node.name} 的操作`}
                title="更多操作"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
                  <circle cx="5" cy="12" r="1.5" />
                  <circle cx="12" cy="12" r="1.5" />
                  <circle cx="19" cy="12" r="1.5" />
                </svg>
              </button>
              {!isMobileViewport && activeMenuPath === node.path ? (
                <TreeActionMenu
                  target={target}
                  onCreateNote={(folder) => { onCloseMenu(); onCreateNote(folder); }}
                  onCreateFolder={(folder) => { onCloseMenu(); onCreateFolder(folder); }}
                  onImport={(folder) => { onCloseMenu(); onImport(folder); }}
                  onRename={(menuTarget) => { onCloseMenu(); onRename(menuTarget); }}
                  onDelete={(menuTarget) => { onCloseMenu(); onDelete(menuTarget); }}
                  onDownload={(path) => { onCloseMenu(); onDownload(path); }}
                />
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {isExpanded || !node.path ? (
        <div className={styles.treeChildren}>
          {node.children.map((child) => (
            <MemoTreeItem
              key={`${child.type}:${child.path}`}
              node={child}
              level={node.path ? level + 1 : level}
              activePath={activePath}
              expandedFolders={expandedFolders}
              searchQuery={searchQuery}
              activeMenuPath={activeMenuPath}
              isMobileViewport={isMobileViewport}
              renamingTarget={renamingTarget}
              renameValue={renameValue}
              renameError={renameError}
              onToggle={onToggle}
              onSelect={onSelect}
              onOpenMenu={onOpenMenu}
              onCloseMenu={onCloseMenu}
              onCreateNote={onCreateNote}
              onCreateFolder={onCreateFolder}
              onImport={onImport}
              onRename={onRename}
              onDelete={onDelete}
              onDownload={onDownload}
              onRenameValueChange={onRenameValueChange}
              onRenameCommit={onRenameCommit}
              onRenameCancel={onRenameCancel}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// memo：父组件（NotesExplorer）状态变化频繁，文件树只在树数据 / 选中态 /
// 重命名态变化时才需要重渲染。回调 props 已在调用侧用 useCallback 稳定。
const MemoTreeItem = memo(TreeItem);

export default MemoTreeItem;

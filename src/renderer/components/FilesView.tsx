import * as React from "react";
import { useState, useMemo, useCallback } from "react";
import { FilePlus, FolderPlus, ArrowDownAZ, ArrowDownWideNarrow, ChevronRight, ChevronsDownUp, ChevronsUpDown, FileText, RefreshCw } from "lucide-react";
import type { ArticleMeta } from "../../shared/types";
import { cn } from "../lib/utils";
import { classifyFilename, filterArticlesForTab, type FileCategory } from "../lib/file-classification";
import { computeIngestedRawFiles } from "../lib/ingest-status";

/** Custom data type for drags that start inside the file tree. */
const LUMINA_DRAG_PATH = "application/x-lumina-vault-path";

function vaultParentDir(filename: string): string {
  const n = filename.replace(/\\/g, "/");
  const i = n.lastIndexOf("/");
  return i === -1 ? "" : n.slice(0, i);
}

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** True when the drag likely carries importable OS files (Electron/Chromium varies `types`). */
function dragHasExternalFiles(e: React.DragEvent): boolean {
  const types = e.dataTransfer.types;
  if (typeof types?.includes === "function" && types.includes("Files")) return true;
  try {
    const arr = Array.from(types ?? []);
    if (arr.includes("Files")) return true;
  } catch {
    /* DOMStringList */
  }
  const items = e.dataTransfer.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === "file") return true;
    }
  }
  return false;
}

/** Resolve OS path for a dropped external file (Electron ≥22 hides `File#path`). */
function absolutePathForDroppedFile(file: File): string | null {
  try {
    return window.api.getPathForFile(file);
  } catch {
    /* not a filesystem-backed File in this context */
  }
  const legacy = file as File & { path?: string };
  return legacy.path ?? null;
}

/** Collect absolute paths from a drop (handles `files` and `items` lists). */
function collectDroppedExternalPaths(e: React.DragEvent): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const push = (p: string | null) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    paths.push(p);
  };

  const { files, items } = e.dataTransfer;
  if (files?.length) {
    for (let i = 0; i < files.length; i++) {
      push(absolutePathForDroppedFile(files[i]!));
    }
  }
  if (paths.length === 0 && items) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it?.kind !== "file") continue;
      const f = it.getAsFile();
      if (f) push(absolutePathForDroppedFile(f));
    }
  }
  return paths;
}

/** Build `wiki/…` or `raw/…` from user input; rejects empty or unsafe segments. */
function folderPathForTab(tab: FileCategory, input: string): string | null {
  const normalized = input.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return null;
  const parts = normalized.split("/").filter((p) => p.length > 0 && p !== "." && p !== "..");
  if (parts.length === 0) return null;
  return `${tab}/${parts.join("/")}`;
}

// ── Tree data model ────────────────────────────────────────────

type FileNode = {
  type: "file";
  name: string;
  article: ArticleMeta;
};

type FolderNode = {
  type: "folder";
  name: string;
  path: string; // vault-relative folder path (no trailing slash)
  children: TreeNode[];
};

type TreeNode = FileNode | FolderNode;

/** Derive the display label for a file leaf — strip .md extension only. */
function fileDisplayName(article: ArticleMeta): string {
  const basename = article.filename.split("/").pop() ?? article.filename;
  return basename.toLowerCase().endsWith(".md") ? basename.replace(/\.md$/i, "") : basename;
}

/** Last path segment with extension — used for A–Z / tie-break sorting (real filename). */
function fileBasenameForSort(article: ArticleMeta): string {
  const i = article.filename.lastIndexOf("/");
  return i === -1 ? article.filename : article.filename.slice(i + 1);
}

const NAME_SORT_LOCALE: Intl.LocalesArgument = undefined;
const NAME_SORT_OPTS: Intl.CollatorOptions = { sensitivity: "base", numeric: true };

function compareNameKeys(a: string, b: string): number {
  return a.localeCompare(b, NAME_SORT_LOCALE, NAME_SORT_OPTS);
}

/** Ensure folder nodes exist for a vault-relative path (e.g. `wiki/inbox`). */
function ensureFolderPathInTree(root: FolderNode, folderPath: string): void {
  const parts = folderPath.split("/").filter((p) => p.length > 0);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    const folderName = parts[i]!;
    const pathSeg = parts.slice(0, i + 1).join("/");
    let folder = current.children.find(
      (n): n is FolderNode => n.type === "folder" && n.name === folderName,
    );
    if (!folder) {
      folder = { type: "folder", name: folderName, path: pathSeg, children: [] };
      current.children.push(folder);
    }
    current = folder;
  }
}

/** Build a nested tree from a flat list of ArticleMeta. */
function buildTree(
  articles: ArticleMeta[],
  sortMode: "modified" | "alpha" = "modified",
  extraFolderPaths: readonly string[] = [],
): TreeNode[] {
  const root: FolderNode = { type: "folder", name: "", path: "", children: [] };

  for (const fp of extraFolderPaths) {
    ensureFolderPathInTree(root, fp.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""));
  }

  for (const article of articles) {
    const parts = article.filename.split("/");
    let current = root;

    // Walk / create intermediate folder nodes
    for (let i = 0; i < parts.length - 1; i++) {
      const folderName = parts[i];
      const folderPath = parts.slice(0, i + 1).join("/");
      let folder = current.children.find(
        (n): n is FolderNode => n.type === "folder" && n.name === folderName
      );
      if (!folder) {
        folder = { type: "folder", name: folderName, path: folderPath, children: [] };
        current.children.push(folder);
      }
      current = folder;
    }

    current.children.push({ type: "file", name: fileDisplayName(article), article });
  }

  return sortNodes(root.children, sortMode);
}

/**
 * Sort tree siblings for display. Folders always precede files at each level.
 * - **alpha**: folders A–Z by name; files A–Z by basename (numeric-aware), then full path.
 * - **modified**: folders A–Z by name; files by `modified` (newest first), then basename when dates tie or are missing.
 */
export function sortNodes(nodes: TreeNode[], sortMode: "modified" | "alpha" = "modified"): TreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type === "folder" && b.type === "file") return -1;
    if (a.type === "file" && b.type === "folder") return 1;
    if (a.type === "folder" && b.type === "folder") {
      return compareNameKeys(a.name, b.name);
    }
    const fa = a as FileNode;
    const fb = b as FileNode;
    if (sortMode === "alpha") {
      const c = compareNameKeys(fileBasenameForSort(fa.article), fileBasenameForSort(fb.article));
      if (c !== 0) return c;
      return compareNameKeys(fa.article.filename, fb.article.filename);
    }
    const ta = new Date(fa.article.modified).getTime();
    const tb = new Date(fb.article.modified).getTime();
    const validA = Number.isFinite(ta);
    const validB = Number.isFinite(tb);
    if (validA && validB && ta !== tb) return tb - ta;
    if (validA && !validB) return -1;
    if (!validA && validB) return 1;
    return compareNameKeys(fileBasenameForSort(fa.article), fileBasenameForSort(fb.article));
  });
}

/**
 * Ancestor folder paths for a vault-relative file path.
 *
 * Example: `"wiki/notes/2025/a.md"` → `["wiki", "wiki/notes", "wiki/notes/2025"]`.
 * Used to auto-expand parent folders when a file is selected from outside
 * the tree (wikilink, search, graph) so the highlighted row is visible.
 */
export function ancestorFolderPaths(filename: string): string[] {
  const parts = filename.split("/").filter((p) => p.length > 0);
  const acc: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    acc.push(parts.slice(0, i).join("/"));
  }
  return acc;
}

/** Collect all folder paths in the tree (for default-expand). */
function collectFolderPaths(nodes: TreeNode[], acc: Set<string> = new Set()): Set<string> {
  for (const node of nodes) {
    if (node.type === "folder") {
      acc.add(node.path);
      collectFolderPaths(node.children, acc);
    }
  }
  return acc;
}

/** Get the max depth of currently expanded folders. */
function maxExpandedDepth(expanded: Set<string>): number {
  let max = -1;
  for (const p of expanded) {
    const depth = p.split("/").length - 1;
    if (depth > max) max = depth;
  }
  return max;
}

/** Collect folder paths at a given depth (0-indexed by slash count). */
function collectFolderPathsAtDepth(nodes: TreeNode[], targetDepth: number, currentDepth = 0, acc: Set<string> = new Set()): Set<string> {
  for (const node of nodes) {
    if (node.type === "folder") {
      if (currentDepth <= targetDepth) acc.add(node.path);
      collectFolderPathsAtDepth(node.children, targetDepth, currentDepth + 1, acc);
    }
  }
  return acc;
}

// ── Tree node renderer ─────────────────────────────────────────

interface TreeNodeProps {
  node: TreeNode;
  depth: number;
  selectedFilename: string | null;
  expandedFolders: Set<string>;
  sortMode: "modified" | "alpha";
  /**
   * Vault-relative paths of raw/ files that have been ingested into the
   * wiki (i.e. referenced by some wiki page's `sources` frontmatter).
   * Used to badge those rows in the tree. Empty set ⇒ no badge anywhere.
   */
  ingestedRawSet: Set<string>;
  onSelectArticle: (filename: string) => void;
  onToggleFolder: (path: string) => void;
  onContextMenu?: (e: React.MouseEvent, filename: string) => void;
  dropTargetPath: string | null;
  dragSourcePath: string | null;
  onDragStartRow: (e: React.DragEvent, path: string) => void;
  onDragEndRow: () => void;
  onDragOverTarget: (e: React.DragEvent, targetFolderPath: string) => void;
  onDropOnTarget: (e: React.DragEvent, targetFolderPath: string) => void;
}

const TreeNodeRow: React.FC<TreeNodeProps> = ({
  node,
  depth,
  selectedFilename,
  expandedFolders,
  sortMode,
  ingestedRawSet,
  onSelectArticle,
  onToggleFolder,
  onContextMenu,
  dropTargetPath,
  dragSourcePath,
  onDragStartRow,
  onDragEndRow,
  onDragOverTarget,
  onDropOnTarget,
}) => {
  /** Same base indent as folder rows so files line up with the folder chevron column. */
  const indent = 6 + depth * 16;
  /** Folder row: chevron (11px) + gap-1 (4px) — reserve the same width before file label for text alignment with folder names. */
  const fileLeadingReserve = "w-[15px] shrink-0";

  if (node.type === "file") {
    const isSelected = node.article.filename === selectedFilename;
    const isPdf = node.article.filename.toLowerCase().endsWith(".pdf");
    const dropInto = vaultParentDir(node.article.filename);
    const isDropHighlight = dropTargetPath !== null && normPath(dropTargetPath) === normPath(dropInto);
    const isIngested = ingestedRawSet.has(node.article.filename);
    return (
      <button
        type="button"
        data-filename={node.article.filename}
        title={isIngested ? `${node.article.title} — ingested into the wiki` : node.article.title}
        draggable
        onDragStart={(e) => onDragStartRow(e, node.article.filename)}
        onDragEnd={onDragEndRow}
        onDragOver={(e) => onDragOverTarget(e, dropInto)}
        onDrop={(e) => onDropOnTarget(e, dropInto)}
        onClick={() => onSelectArticle(node.article.filename)}
        onContextMenu={(e) => onContextMenu?.(e, node.article.filename)}
        style={{ paddingLeft: `${indent}px`, paddingTop: "5px", paddingBottom: "5px", paddingRight: "12px", fontSize: "12.5px" }}
        className={cn(
          // Removed parent `truncate` — it conflicts with flex children
          // and was clipping the trailing "Ingested" pill on long file
          // names. The label span owns truncation now via flex-1 min-w-0.
          "flex items-center gap-1 w-full text-left transition-colors",
          "focus-visible:outline-none cursor-grab active:cursor-grabbing",
          isDropHighlight && "bg-primary-bg/40",
          isSelected
            ? "bg-primary-bg text-text-primary"
            : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
        )}
      >
        {isPdf ? (
          <span className={`${fileLeadingReserve} flex items-center justify-start`}>
            <FileText size={13} className="shrink-0 text-red-400" />
          </span>
        ) : (
          <span className={fileLeadingReserve} aria-hidden />
        )}
        <span className="flex-1 min-w-0 truncate">{node.name}</span>
        {isIngested && (
          // Compact dot-style badge. We avoid a wide text pill ("INGESTED")
          // because it competes for horizontal space with long file names
          // in the (often narrow) sidebar. A 6px green dot is unmistakable,
          // always visible regardless of row width, and the tooltip still
          // says "ingested into the wiki" for accessibility / clarity.
          <span
            aria-label="Ingested"
            data-testid="ingested-badge"
            className="ml-1 shrink-0 inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500 ring-2 ring-emerald-500/20"
          />
        )}
      </button>
    );
  }

  // Folder node
  const isExpanded = expandedFolders.has(node.path);
  const isDropHighlight = dropTargetPath !== null && normPath(dropTargetPath) === normPath(node.path);
  return (
    <div>
      <button
        type="button"
        draggable
        onDragStart={(e) => onDragStartRow(e, node.path)}
        onDragEnd={onDragEndRow}
        onDragOver={(e) => onDragOverTarget(e, node.path)}
        onDrop={(e) => onDropOnTarget(e, node.path)}
        onClick={() => onToggleFolder(node.path)}
        style={{ paddingLeft: `${indent}px`, paddingTop: "5px", paddingBottom: "5px", paddingRight: "12px", fontSize: "12.5px" }}
        className={cn(
          "flex items-center gap-0 w-full",
          "text-text-primary hover:bg-surface-hover transition-colors cursor-grab active:cursor-grabbing",
          "focus-visible:outline-none",
          isDropHighlight && "bg-primary-bg/40"
        )}
      >
        <span className={`${fileLeadingReserve} flex items-center justify-start pointer-events-none`}>
          <ChevronRight
            size={11}
            className={cn(
              "shrink-0 text-text-secondary transition-transform duration-150",
              isExpanded && "rotate-90"
            )}
          />
        </span>
        <span className="truncate font-medium min-w-0">{node.name}</span>
      </button>
      {isExpanded && (
        <div
          className={cn("relative min-h-0", node.children.length === 0 && "py-1")}
          onDragOver={(e) => onDragOverTarget(e, node.path)}
          onDrop={(e) => onDropOnTarget(e, node.path)}
        >
          {/* Vertical guide line — only when there are children (empty expanded folders stay compact). */}
          {node.children.length > 0 && (
            <div
              className="absolute top-0 bottom-0 w-px bg-border/50"
              style={{ left: `${indent + 5}px` }}
            />
          )}
          {sortNodes(node.children, sortMode).map((child) => (
            <TreeNodeRow
              key={child.type === "file" ? child.article.filename : child.path}
              node={child}
              depth={depth + 1}
              selectedFilename={selectedFilename}
              expandedFolders={expandedFolders}
              sortMode={sortMode}
              ingestedRawSet={ingestedRawSet}
              onSelectArticle={onSelectArticle}
              onToggleFolder={onToggleFolder}
              onContextMenu={onContextMenu}
              dropTargetPath={dropTargetPath}
              dragSourcePath={dragSourcePath}
              onDragStartRow={onDragStartRow}
              onDragEndRow={onDragEndRow}
              onDragOverTarget={onDragOverTarget}
              onDropOnTarget={onDropOnTarget}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// ── FilesView ──────────────────────────────────────────────────

export interface FilesViewProps {
  articles: ArticleMeta[];
  /** Folders under wiki/ or raw/ that exist on disk but contain no files (shown in tree). */
  emptyFolderPaths?: string[];
  selectedFilename: string | null;
  loading: boolean;
  error: string | null;
  onSelectArticle: (filename: string) => void;
  onNewArticle: (targetFolder?: string) => void;
  onNewFolder: (folderPath: string) => void;
  /** Rescan vault file list (e.g. after external changes). */
  onRefresh?: () => void | Promise<void>;
  onOpenInNewTab?: (filename: string) => void;
  onToggleBookmark?: (filename: string) => void;
  isBookmarked?: (filename: string) => boolean;
}

// ── TabBar (inline) ────────────────────────────────────────────

interface TabBarProps {
  activeTab: FileCategory;
  wikiCount: number;
  rawCount: number;
  onTabChange: (tab: FileCategory) => void;
}

const tabs: { key: FileCategory; label: string }[] = [
  { key: "wiki", label: "Wiki" },
  { key: "raw", label: "Raw" },
];

function TabBar({ activeTab, wikiCount, rawCount, onTabChange }: TabBarProps) {
  const counts: Record<FileCategory, number> = { wiki: wikiCount, raw: rawCount };

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const currentIndex = tabs.findIndex((t) => t.key === activeTab);
      let nextIndex = -1;

      if (e.key === "ArrowRight") {
        nextIndex = (currentIndex + 1) % tabs.length;
      } else if (e.key === "ArrowLeft") {
        nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      }

      if (nextIndex >= 0) {
        e.preventDefault();
        onTabChange(tabs[nextIndex].key);
        // Focus the newly active tab button
        const container = e.currentTarget;
        const buttons = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
        buttons[nextIndex]?.focus();
      }
    },
    [activeTab, onTabChange],
  );

  return (
    <div
      role="tablist"
      className="flex gap-1 px-3"
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.key;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onTabChange(tab.key)}
            className={cn(
              "px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer",
              "focus-visible:ring-2 focus-visible:ring-primary-border focus-visible:outline-none",
              isActive
                ? "bg-accent/20 text-accent"
                : "text-text-secondary hover:bg-surface-hover",
            )}
          >
            {tab.label} ({counts[tab.key]})
          </button>
        );
      })}
    </div>
  );
}

// ── FilesView ──────────────────────────────────────────────────

export function FilesView({
  articles,
  emptyFolderPaths = [],
  selectedFilename,
  loading,
  error,
  onSelectArticle,
  onNewArticle,
  onNewFolder,
  onRefresh,
  onOpenInNewTab,
  onToggleBookmark,
  isBookmarked,
}: FilesViewProps) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; filename: string } | null>(null);
  const [treeDropTarget, setTreeDropTarget] = useState<string | null>(null);
  const [dragSourcePath, setDragSourcePath] = useState<string | null>(null);

  const handleCtx = useCallback((e: React.MouseEvent, filename: string) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, filename });
  }, []);

  // Close context menu on any click
  React.useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [ctxMenu]);

  React.useEffect(() => {
    const clear = () => setTreeDropTarget(null);
    window.addEventListener("dragend", clear);
    return () => window.removeEventListener("dragend", clear);
  }, []);

  // Default to the tab containing the initially-selected file so that a vault
  // restored with a raw/PDF open doesn't land on an empty Wiki tab.
  const [activeTab, setActiveTab] = useState<FileCategory>(() =>
    selectedFilename ? classifyFilename(selectedFilename) : "wiki",
  );
  const [sortMode, setSortMode] = useState<"modified" | "alpha">("modified");

  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderError, setNewFolderError] = useState<string | null>(null);
  const newFolderInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!newFolderOpen) return;
    const t = window.setTimeout(() => {
      newFolderInputRef.current?.focus();
      newFolderInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(t);
  }, [newFolderOpen]);

  React.useEffect(() => {
    if (!newFolderOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setNewFolderOpen(false);
        setNewFolderError(null);
        setNewFolderName("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newFolderOpen]);

  // Per-tab selection tracking — stores the last selected filename per tab for highlight restoration
  const [tabSelections, setTabSelections] = useState<{
    wiki: string | null;
    raw: string | null;
  }>(() => {
    const init: { wiki: string | null; raw: string | null } = { wiki: null, raw: null };
    if (selectedFilename) init[classifyFilename(selectedFilename)] = selectedFilename;
    return init;
  });

  // Sync tabSelections when selectedFilename prop changes from outside (wikilink
  // navigation, search, graph). Route the highlight to the tab the file
  // actually lives in and switch the active tab to match — otherwise jumping
  // from a Wiki page to a Raw PDF (or vice-versa) leaves the sidebar showing
  // the previous tab with no highlight at all.
  const prevSelectedRef = React.useRef(selectedFilename);
  if (prevSelectedRef.current !== selectedFilename) {
    prevSelectedRef.current = selectedFilename;
    if (selectedFilename !== null && selectedFilename !== "__new__") {
      const targetTab = classifyFilename(selectedFilename);
      setTabSelections((prev) =>
        prev[targetTab] === selectedFilename ? prev : { ...prev, [targetTab]: selectedFilename },
      );
      if (targetTab !== activeTab) setActiveTab(targetTab);
    }
  }

  // Filter articles by active tab (excludes config files automatically)
  const wikiArticles = useMemo(() => filterArticlesForTab(articles, "wiki"), [articles]);
  const rawArticles = useMemo(() => filterArticlesForTab(articles, "raw"), [articles]);
  const wikiExtraFolders = useMemo(
    () => emptyFolderPaths.filter((p) => p === "wiki" || p.startsWith("wiki/")),
    [emptyFolderPaths],
  );
  const rawExtraFolders = useMemo(
    () => emptyFolderPaths.filter((p) => p === "raw" || p.startsWith("raw/")),
    [emptyFolderPaths],
  );
  const wikiTree = useMemo(
    () => buildTree(wikiArticles, sortMode, wikiExtraFolders),
    [wikiArticles, sortMode, wikiExtraFolders],
  );
  const rawTree = useMemo(
    () => buildTree(rawArticles, sortMode, rawExtraFolders),
    [rawArticles, sortMode, rawExtraFolders],
  );
  const tree = activeTab === "wiki" ? wikiTree : rawTree;

  // Which raw/ files have been ingested? Recomputed only when the article
  // list identity changes (vault rescans + watcher events). The function
  // is pure and bounded by O(articles + sources), so memoising on
  // `articles` is sufficient — no need to react to selection / drag state.
  const ingestedRawSet = useMemo(
    () => computeIngestedRawFiles(articles),
    [articles],
  );

  const tabRootPrefix = useMemo(() => {
    const list = activeTab === "wiki" ? wikiArticles : rawArticles;
    const first = list[0]?.filename;
    if (first) return first.split("/")[0];
    return activeTab === "wiki" ? "wiki" : "raw";
  }, [activeTab, wikiArticles, rawArticles]);

  const onDragStartRow = useCallback((e: React.DragEvent, path: string) => {
    e.dataTransfer.setData(LUMINA_DRAG_PATH, path);
    e.dataTransfer.effectAllowed = "copyMove";
    setDragSourcePath(path);
  }, []);

  const onDragEndRow = useCallback(() => {
    setDragSourcePath(null);
  }, []);

  const onDragOverTarget = useCallback(
    (e: React.DragEvent, targetFolderPath: string) => {
      const hasFiles = dragHasExternalFiles(e);
      const fromTree = dragSourcePath !== null;
      if (!hasFiles && !fromTree) return;

      if (dragSourcePath) {
        const n = normPath(dragSourcePath);
        const t = normPath(targetFolderPath);
        if (t === n || t.startsWith(`${n}/`)) {
          e.dataTransfer.dropEffect = "none";
          return;
        }
      }
      e.preventDefault();
      e.stopPropagation();
      setTreeDropTarget(targetFolderPath);
      e.dataTransfer.dropEffect = hasFiles ? "copy" : "move";
    },
    [dragSourcePath],
  );

  const onDropOnTarget = useCallback(
    async (e: React.DragEvent, targetFolderPath: string) => {
      e.preventDefault();
      e.stopPropagation();
      const fromData = e.dataTransfer.getData(LUMINA_DRAG_PATH);
      const src = fromData || dragSourcePath;
      setTreeDropTarget(null);
      setDragSourcePath(null);

      const expandTarget = () => {
        setPerTabExpanded((prev) => {
          const cur = new Set(prev[activeTab]);
          cur.add(targetFolderPath);
          return { ...prev, [activeTab]: cur };
        });
      };

      try {
        if (src) {
          if (normPath(vaultParentDir(src)) === normPath(targetFolderPath)) return;
          await window.api.moveVaultEntry(src, targetFolderPath);
          expandTarget();
        } else {
          const paths = collectDroppedExternalPaths(e);
          if (paths.length) {
            await window.api.importExternalPaths(paths, targetFolderPath);
            expandTarget();
          }
        }
      } catch (err) {
        console.error(err);
        window.alert(err instanceof Error ? err.message : "Operation failed");
      }
    },
    [dragSourcePath, activeTab],
  );

  const onTreePaneDragOver = useCallback(
    (e: React.DragEvent) => {
      const hasFiles = dragHasExternalFiles(e);
      const fromTree = dragSourcePath !== null;
      if (!hasFiles && !fromTree) return;

      if (dragSourcePath) {
        const n = normPath(dragSourcePath);
        const t = normPath(tabRootPrefix);
        if (t === n || t.startsWith(`${n}/`)) {
          e.dataTransfer.dropEffect = "none";
          return;
        }
      }
      e.preventDefault();
      setTreeDropTarget(tabRootPrefix);
      e.dataTransfer.dropEffect = hasFiles ? "copy" : "move";
    },
    [dragSourcePath, tabRootPrefix],
  );

  const onTreePaneDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      await onDropOnTarget(e, tabRootPrefix);
    },
    [onDropOnTarget, tabRootPrefix],
  );

  // Per-tab folder expansion state — each tab remembers its own expanded folders
  const [perTabExpanded, setPerTabExpanded] = useState<{
    wiki: Set<string>;
    raw: Set<string>;
  }>(() => ({
    wiki: collectFolderPaths(wikiTree),
    raw: collectFolderPaths(rawTree),
  }));

  // When new folders appear (articles change), add them to both tabs' sets
  const prevWikiTreeRef = React.useRef(wikiTree);
  const prevRawTreeRef = React.useRef(rawTree);
  if (prevWikiTreeRef.current !== wikiTree || prevRawTreeRef.current !== rawTree) {
    prevWikiTreeRef.current = wikiTree;
    prevRawTreeRef.current = rawTree;
    const wikiPaths = collectFolderPaths(wikiTree);
    const rawPaths = collectFolderPaths(rawTree);
    setPerTabExpanded((prev) => {
      const nextWiki = new Set(prev.wiki);
      wikiPaths.forEach((p) => nextWiki.add(p));
      const nextRaw = new Set(prev.raw);
      rawPaths.forEach((p) => nextRaw.add(p));
      return { wiki: nextWiki, raw: nextRaw };
    });
  }

  // Auto-expand ancestor folders of the selected file so the highlighted
  // row is visible. Runs whenever the external selection changes — covers
  // wikilink navigation, search jumps, graph clicks, and Back/Forward.
  // Only adds to the expanded set (never collapses), so user-collapsed
  // folders elsewhere stay collapsed.
  React.useEffect(() => {
    if (!selectedFilename || selectedFilename === "__new__") return;
    const targetTab = classifyFilename(selectedFilename);
    const ancestors = ancestorFolderPaths(selectedFilename);
    if (ancestors.length === 0) return;
    setPerTabExpanded((prev) => {
      const cur = prev[targetTab];
      let changed = false;
      const next = new Set(cur);
      for (const p of ancestors) {
        if (!next.has(p)) {
          next.add(p);
          changed = true;
        }
      }
      if (!changed) return prev;
      return { ...prev, [targetTab]: next };
    });
  }, [selectedFilename]);

  // Scroll the highlighted row into view after the tab/expansion state has
  // settled. Uses a data-filename attribute on the file button so we don't
  // have to thread refs through TreeNodeRow. Depends on perTabExpanded so
  // the scroll runs again once any newly-expanded ancestor folders mount.
  const treeScrollRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!selectedFilename || selectedFilename === "__new__") return;
    if (classifyFilename(selectedFilename) !== activeTab) return;
    const container = treeScrollRef.current;
    if (!container) return;
    const id = window.requestAnimationFrame(() => {
      const escaped = (window.CSS && typeof CSS.escape === "function")
        ? CSS.escape(selectedFilename)
        : selectedFilename.replace(/"/g, '\\"');
      const row = container.querySelector<HTMLElement>(`[data-filename="${escaped}"]`);
      if (row) row.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(id);
  }, [selectedFilename, activeTab, perTabExpanded]);

  // When a file is selected, store it in the active tab's selection and forward to parent
  const handleSelectArticle = useCallback(
    (filename: string) => {
      setTabSelections((prev) => ({ ...prev, [activeTab]: filename }));
      onSelectArticle(filename);
    },
    [activeTab, onSelectArticle],
  );

  // When switching tabs, just change the active tab — highlight comes from tabSelections
  const handleTabChange = useCallback((tab: FileCategory) => {
    setActiveTab(tab);
  }, []);

  // The highlight filename for the tree: use the active tab's stored selection
  const highlightFilename = tabSelections[activeTab];

  // Active tab's expansion set
  const expandedFolders = perTabExpanded[activeTab];

  const toggleFolder = (path: string) => {
    setPerTabExpanded((prev) => {
      const current = prev[activeTab];
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { ...prev, [activeTab]: next };
    });
  };

  // Expand one more level beyond the current deepest expanded depth
  const handleExpandLevel = useCallback(() => {
    setPerTabExpanded((prev) => {
      const current = prev[activeTab];
      const currentMaxDepth = maxExpandedDepth(current);
      const nextDepth = currentMaxDepth + 1;
      const paths = collectFolderPathsAtDepth(tree, nextDepth);
      return { ...prev, [activeTab]: paths };
    });
  }, [activeTab, tree]);

  // Collapse all folders
  const handleCollapseAll = useCallback(() => {
    setPerTabExpanded((prev) => ({ ...prev, [activeTab]: new Set<string>() }));
  }, [activeTab]);

  const openNewFolderDialog = useCallback(() => {
    setNewFolderName("");
    setNewFolderError(null);
    setNewFolderOpen(true);
  }, []);

  const cancelNewFolderDialog = useCallback(() => {
    setNewFolderOpen(false);
    setNewFolderError(null);
    setNewFolderName("");
  }, []);

  const submitNewFolder = useCallback(() => {
    const trimmed = newFolderName.trim();
    if (!trimmed) return;
    const rel = folderPathForTab(activeTab, trimmed);
    if (!rel) {
      setNewFolderError("Invalid name — use safe segments only (no .. or empty parts).");
      return;
    }
    void onNewFolder(rel);
    cancelNewFolderDialog();
  }, [newFolderName, activeTab, onNewFolder, cancelNewFolderDialog]);

  const toggleSort = useCallback(() => {
    setSortMode((prev) => (prev === "modified" ? "alpha" : "modified"));
  }, []);

  const handleRefresh = useCallback(() => {
    if (!onRefresh) return;
    void Promise.resolve(onRefresh()).catch((err) => {
      console.error(err);
      window.alert(err instanceof Error ? err.message : "Refresh failed");
    });
  }, [onRefresh]);

  return (
    <div className="flex flex-col h-full min-h-0 min-w-0">
      {/* Tab Bar */}
      <div className="px-0 pt-3 pb-1">
        <TabBar
          activeTab={activeTab}
          wikiCount={wikiArticles.length}
          rawCount={rawArticles.length}
          onTabChange={handleTabChange}
        />
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-1 px-3 py-2">
        <ToolbarButton title="New Markdown" onClick={() => {
          const sel = tabSelections[activeTab];
          const parentDir = sel ? vaultParentDir(sel) : activeTab;
          onNewArticle(parentDir || activeTab);
        }}>
          <FilePlus size={15} />
        </ToolbarButton>
        <ToolbarButton title="New Folder" onClick={openNewFolderDialog}>
          <FolderPlus size={15} />
        </ToolbarButton>
        <ToolbarButton title={sortMode === "modified" ? "Sort: Recent" : "Sort: A-Z"} onClick={toggleSort}>
          {sortMode === "modified" ? <ArrowDownWideNarrow size={15} /> : <ArrowDownAZ size={15} />}
        </ToolbarButton>
        <ToolbarButton title="Expand Level" onClick={handleExpandLevel}>
          <ChevronsUpDown size={15} />
        </ToolbarButton>
        <ToolbarButton title="Collapse All" onClick={handleCollapseAll}>
          <ChevronsDownUp size={15} />
        </ToolbarButton>
        {onRefresh && (
          <ToolbarButton title="Refresh file tree" onClick={handleRefresh}>
            <RefreshCw size={15} />
          </ToolbarButton>
        )}
      </div>

      {/* Tree */}
      <div
        ref={treeScrollRef}
        className={cn(
          "flex flex-1 min-h-0 flex-col overflow-y-auto py-1",
          treeDropTarget !== null &&
            normPath(treeDropTarget) === normPath(tabRootPrefix) &&
            "bg-primary-bg/25 rounded-md",
        )}
        onDragOver={onTreePaneDragOver}
        onDrop={onTreePaneDrop}
      >
        {loading && articles.length === 0 && (
          <p className="px-4 py-6 text-sm text-text-secondary pointer-events-none shrink-0">Loading…</p>
        )}
        {error && (
          <p className="px-4 py-6 text-sm text-red-400 pointer-events-none shrink-0">{error}</p>
        )}
        {!error && !loading && tree.length === 0 && (
          <p className="px-4 py-6 text-sm text-text-secondary pointer-events-none shrink-0">No articles yet — drop files here</p>
        )}
        {!error &&
          tree.length > 0 &&
          (!loading || articles.length > 0) &&
          tree.map((node) => (
            <TreeNodeRow
              key={node.type === "file" ? node.article.filename : node.path}
              node={node}
              depth={0}
              selectedFilename={highlightFilename}
              expandedFolders={expandedFolders}
              sortMode={sortMode}
              ingestedRawSet={ingestedRawSet}
              onSelectArticle={handleSelectArticle}
              onToggleFolder={toggleFolder}
              onContextMenu={handleCtx}
              dropTargetPath={treeDropTarget}
              dragSourcePath={dragSourcePath}
              onDragStartRow={onDragStartRow}
              onDragEndRow={onDragEndRow}
              onDragOverTarget={onDragOverTarget}
              onDropOnTarget={onDropOnTarget}
            />
          ))}
      </div>

      {/* Context menu */}
      {newFolderOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 px-4"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) cancelNewFolderDialog();
          }}
        >
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="lumina-new-folder-title"
            className="w-full max-w-sm rounded-lg border border-border bg-sidebar-bg p-4 shadow-xl"
            onMouseDown={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              submitNewFolder();
            }}
          >
            <h2 id="lumina-new-folder-title" className="text-sm font-semibold text-text-primary">
              New folder
            </h2>
            <p className="mt-1.5 text-xs leading-relaxed text-text-secondary">
              Path is under{" "}
              <code className="rounded bg-surface-hover px-1 py-0.5 text-text-primary">{activeTab}/</code> in the
              current vault. Nothing is created until you enter a name and choose Create; Cancel closes without
              changes.
            </p>
            <input
              ref={newFolderInputRef}
              type="text"
              value={newFolderName}
              onChange={(e) => {
                setNewFolderName(e.target.value);
                setNewFolderError(null);
              }}
              className="mt-3 w-full rounded-md border border-border bg-main-bg px-2.5 py-2 text-sm text-text-primary placeholder:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-border"
              placeholder="e.g. inbox or notes/2025"
              autoComplete="off"
            />
            {newFolderError ? <p className="mt-2 text-xs text-red-400">{newFolderError}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={cancelNewFolderDialog}
                className="rounded-md border border-border bg-main-bg px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-hover hover:text-text-primary cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!newFolderName.trim()}
                className="rounded-md border border-primary-border bg-accent/15 px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
              >
                Create
              </button>
            </div>
          </form>
        </div>
      )}

      {ctxMenu && (
        <div
          className="fixed z-50 bg-sidebar-bg border border-border rounded-lg shadow-xl py-1 w-fit"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          {onOpenInNewTab && (
            <button type="button" onClick={() => { onOpenInNewTab(ctxMenu.filename); setCtxMenu(null); }}
              className="block w-full text-left px-3 py-1.5 text-xs whitespace-nowrap text-text-secondary hover:bg-surface-hover hover:text-text-primary cursor-pointer">
              Open in new tab
            </button>
          )}
          <button type="button" onClick={() => { window.api.revealInFinder(ctxMenu.filename); setCtxMenu(null); }}
            className="block w-full text-left px-3 py-1.5 text-xs whitespace-nowrap text-text-secondary hover:bg-surface-hover hover:text-text-primary cursor-pointer">
            Reveal in Finder
          </button>
          {onToggleBookmark && (
            <button type="button" onClick={() => { onToggleBookmark(ctxMenu.filename); setCtxMenu(null); }}
              className="block w-full text-left px-3 py-1.5 text-xs whitespace-nowrap text-text-secondary hover:bg-surface-hover hover:text-text-primary cursor-pointer">
              {isBookmarked?.(ctxMenu.filename) ? 'Remove bookmark' : 'Bookmark'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Toolbar icon button ────────────────────────────────────────

function ToolbarButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors cursor-pointer",
        "focus-visible:ring-2 focus-visible:ring-primary-border focus-visible:outline-none"
      )}
    >
      {children}
    </button>
  );
}

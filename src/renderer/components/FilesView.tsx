import * as React from "react";
import { useState, useMemo, useCallback } from "react";
import { FilePlus, FolderPlus, ArrowDownAZ, ArrowDownWideNarrow, ChevronRight, ChevronsDownUp, ChevronsUpDown, FileText } from "lucide-react";
import type { ArticleMeta } from "../../shared/types";
import { cn } from "../lib/utils";
import { filterArticlesForTab, type FileCategory } from "../lib/file-classification";

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

/** Build a nested tree from a flat list of ArticleMeta. */
function buildTree(articles: ArticleMeta[], sortMode: "modified" | "alpha" = "modified"): TreeNode[] {
  const root: FolderNode = { type: "folder", name: "", path: "", children: [] };

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

/** Folders first (alpha), then files sorted by chosen mode. */
function sortNodes(nodes: TreeNode[], sortMode: "modified" | "alpha" = "modified"): TreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type === "folder" && b.type === "file") return -1;
    if (a.type === "file" && b.type === "folder") return 1;
    if (a.type === "folder" && b.type === "folder") {
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    }
    if (sortMode === "alpha") {
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    }
    // Both files — most recently modified first
    const ta = new Date((a as FileNode).article.modified).getTime();
    const tb = new Date((b as FileNode).article.modified).getTime();
    return tb - ta;
  });
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
  onSelectArticle: (filename: string) => void;
  onToggleFolder: (path: string) => void;
}

const TreeNodeRow: React.FC<TreeNodeProps> = ({
  node,
  depth,
  selectedFilename,
  expandedFolders,
  sortMode,
  onSelectArticle,
  onToggleFolder,
}) => {
  const indent = 6 + depth * 16;

  if (node.type === "file") {
    const isSelected = node.article.filename === selectedFilename;
    const isPdf = node.article.filename.toLowerCase().endsWith(".pdf");
    return (
      <button
        type="button"
        title={node.article.title}
        onClick={() => onSelectArticle(node.article.filename)}
        style={{ paddingLeft: `${indent + 18}px`, paddingTop: "5px", paddingBottom: "5px", paddingRight: "12px", fontSize: "12.5px" }}
        className={cn(
          "flex items-center gap-1.5 w-full text-left truncate transition-colors",
          "focus-visible:outline-none",
          isSelected
            ? "bg-primary-bg text-text-primary"
            : "text-text-secondary hover:bg-surface-hover hover:text-text-primary cursor-pointer"
        )}
      >
        {isPdf && <FileText size={13} className="shrink-0 text-red-400" />}
        <span className="truncate">{node.name}</span>
      </button>
    );
  }

  // Folder node
  const isExpanded = expandedFolders.has(node.path);
  return (
    <div>
      <button
        type="button"
        onClick={() => onToggleFolder(node.path)}
        style={{ paddingLeft: `${indent}px`, paddingTop: "5px", paddingBottom: "5px", paddingRight: "12px", fontSize: "12.5px" }}
        className={cn(
          "flex items-center gap-1 w-full",
          "text-text-primary hover:bg-surface-hover transition-colors cursor-pointer",
          "focus-visible:outline-none"
        )}
      >
        <ChevronRight
          size={11}
          className={cn(
            "shrink-0 text-text-secondary transition-transform duration-150",
            isExpanded && "rotate-90"
          )}
        />
        <span className="truncate font-medium">{node.name}</span>
      </button>
      {isExpanded && (
        <div className="relative">
          {/* Vertical guide line */}
          <div
            className="absolute top-0 bottom-0 w-px bg-border/50"
            style={{ left: `${indent + 5}px` }}
          />
          {sortNodes(node.children, sortMode).map((child) => (
            <TreeNodeRow
              key={child.type === "file" ? child.article.filename : child.path}
              node={child}
              depth={depth + 1}
              selectedFilename={selectedFilename}
              expandedFolders={expandedFolders}
              sortMode={sortMode}
              onSelectArticle={onSelectArticle}
              onToggleFolder={onToggleFolder}
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
  selectedFilename: string | null;
  loading: boolean;
  error: string | null;
  onSelectArticle: (filename: string) => void;
  onNewArticle: () => void;
  onNewFolder: (folderPath: string) => void;
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
  selectedFilename,
  loading,
  error,
  onSelectArticle,
  onNewArticle,
  onNewFolder,
}: FilesViewProps) {
  const [activeTab, setActiveTab] = useState<FileCategory>("wiki");
  const [sortMode, setSortMode] = useState<"modified" | "alpha">("modified");

  // Per-tab selection tracking — stores the last selected filename per tab for highlight restoration
  const [tabSelections, setTabSelections] = useState<{
    wiki: string | null;
    raw: string | null;
  }>({ wiki: selectedFilename, raw: null });

  // Sync tabSelections when selectedFilename prop changes from outside
  const prevSelectedRef = React.useRef(selectedFilename);
  if (prevSelectedRef.current !== selectedFilename) {
    prevSelectedRef.current = selectedFilename;
    if (selectedFilename !== null) {
      setTabSelections((prev) => ({ ...prev, [activeTab]: selectedFilename }));
    }
  }

  // Filter articles by active tab (excludes config files automatically)
  const wikiArticles = useMemo(() => filterArticlesForTab(articles, "wiki"), [articles]);
  const rawArticles = useMemo(() => filterArticlesForTab(articles, "raw"), [articles]);
  const wikiTree = useMemo(() => buildTree(wikiArticles, sortMode), [wikiArticles, sortMode]);
  const rawTree = useMemo(() => buildTree(rawArticles, sortMode), [rawArticles, sortMode]);
  const tree = activeTab === "wiki" ? wikiTree : rawTree;

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

  // New folder prompt
  const handleNewFolder = useCallback(() => {
    const name = window.prompt("Folder name:");
    if (!name?.trim()) return;
    onNewFolder(name.trim());
  }, [onNewFolder]);

  const toggleSort = useCallback(() => {
    setSortMode((prev) => (prev === "modified" ? "alpha" : "modified"));
  }, []);

  return (
    <div className="flex flex-col h-full">
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
        <ToolbarButton title="New Markdown" onClick={onNewArticle}>
          <FilePlus size={15} />
        </ToolbarButton>
        <ToolbarButton title="New Folder" onClick={handleNewFolder}>
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
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {loading && (
          <p className="px-4 py-6 text-sm text-text-secondary">Loading…</p>
        )}
        {!loading && error && (
          <p className="px-4 py-6 text-sm text-red-400">{error}</p>
        )}
        {!loading && !error && tree.length === 0 && (
          <p className="px-4 py-6 text-sm text-text-secondary">No articles yet</p>
        )}
        {!loading &&
          !error &&
          tree.map((node) => (
            <TreeNodeRow
              key={node.type === "file" ? node.article.filename : node.path}
              node={node}
              depth={0}
              selectedFilename={highlightFilename}
              expandedFolders={expandedFolders}
              sortMode={sortMode}
              onSelectArticle={handleSelectArticle}
              onToggleFolder={toggleFolder}
            />
          ))}
      </div>
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

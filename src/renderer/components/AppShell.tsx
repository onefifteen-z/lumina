import React, { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext } from 'react';
import type { WikiAPI, ArticleMeta } from '../../shared/types';
import { getConfigFiles } from '../lib/file-classification';
import {
  readStoredPanelWidth,
  writeStoredPanelWidth,
  LEFT_PANEL_WIDTH_KEY,
  RIGHT_PANEL_WIDTH_KEY,
} from '../lib/panel-width';
import ArticleBrowser from './ArticleBrowser';
import ArticleEditor from './ArticleEditor';
import SettingsPanel from './SettingsPanel';
import ChatView from './ChatView';
import type { ThinkingEntry } from './ChatView';
import { NetworkStatusProvider, useNetworkStatus } from '../hooks/useNetworkStatus';
import GenerateArticleDialog from './GenerateArticleDialog';
import { IconRail, type SidebarView } from './IconRail';
import { FilesView } from './FilesView';
import { SearchView } from './SearchView';
import { SearchPopup } from './SearchPopup';
import { FindBar } from './FindBar';
import { DebugLogPanel } from './DebugLogPanel';
import { BookmarksView } from './BookmarksView';
import { TocPanel, type TocHeading } from './TocPanel';
import { ThinkingSidebar } from './chat/ThinkingSidebar';
import { ContentToolbar } from './ContentToolbar';
import { GraphView } from './GraphView';
import { VaultSwitcher } from './VaultSwitcher';
import { VaultInitDialog } from './VaultInitDialog';
import { WelcomeScreen } from './WelcomeScreen';
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  X,
  FileText,
  Plus,
} from 'lucide-react';
import { TooltipProvider } from './ui/tooltip';
import {
  SidebarProvider,
  Sidebar,
  SidebarContent,
  useSidebar,
} from './ui/sidebar';

// ── Declare window.api for TypeScript ──────────────────────────

declare global {
  interface Window {
    api: WikiAPI;
  }
}

// ── Navigation types ───────────────────────────────────────────

/** @deprecated Use SidebarView instead. Kept for backward compatibility. */
export type NavView = SidebarView;

export interface NavigationContext {
  view: SidebarView;
  /** Navigate to a sidebar view. Also accepts legacy 'browse' (→ 'files') and 'edit' values. */
  navigate: (view: string) => void;
  /** Vault-relative filename of the article being edited, or null when not editing */
  editingFilename: string | null;
  /** Navigate to the editor for a specific article by its vault-relative filename */
  editArticle: (filename: string) => void;
  /** Create a new article — opens blank editor */
  createNewArticle: (targetFolder?: string) => void;
  /** Vault-relative folder path for new article placement (e.g. "wiki/notes") */
  targetFolder: string | null;
  /** Pre-populated content from LLM generation (when opening editor after generate) */
  generatedContent: string | null;
  /** Clear the generated content after it's been consumed */
  clearGeneratedContent: () => void;
  /** Switch to the files view and select the given article for viewing */
  viewArticle: (filename: string) => void;
  /** Refresh the sidebar file tree after changes */
  refreshFileTree: () => void;
  /**
   * Optional title to seed into the editor when entering "new article" mode.
   * Used by the "Create CLAUDE.md from template" flow so saving writes
   * `claude.md` without forcing the user to retype the name.
   */
  prefilledTitle: string | null;
  /** Clear the prefilled title once the editor has consumed it. */
  clearPrefilledTitle: () => void;
}

const NavContext = createContext<NavigationContext>({
  view: 'files',
  navigate: () => { },
  editingFilename: null,
  editArticle: () => { },
  createNewArticle: () => { },
  targetFolder: null,
  generatedContent: null,
  clearGeneratedContent: () => { },
  viewArticle: () => { },
  refreshFileTree: () => { },
  prefilledTitle: null,
  clearPrefilledTitle: () => { },
});

export const useNavigation = () => useContext(NavContext);

// ── Theme helpers ──────────────────────────────────────────────

function resolveTheme(theme: 'light' | 'dark' | 'system'): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.setAttribute('data-theme', theme);
  if (theme === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

// ── Offline Banner ──────────────────────────────────────────

const OfflineBanner: React.FC = () => {
  const { isOffline } = useNetworkStatus();
  if (!isOffline) return null;
  return (
    <div className="offline-banner" role="status">
      <span className="offline-banner__icon" aria-hidden="true">⚠️</span>
      Offline — LLM features unavailable
    </div>
  );
};

// ── NewTabPage ─────────────────────────────────────────────────

const NewTabPage: React.FC<{ onNewNote: () => void; onGoToFile: () => void; onClose: () => void }> = ({ onNewNote, onGoToFile, onClose }) => {
  const isMac = navigator.platform.includes('Mac');
  const mod = isMac ? '⌘' : 'Ctrl+';
  const linkClass = "text-primary hover:text-primary-hover text-sm cursor-pointer transition-colors";

  return (
    <div className="flex-1 flex items-center justify-center bg-main-bg">
      <div className="flex flex-col items-center gap-4">
        <button type="button" onClick={onNewNote} className={linkClass}>Create new note ({mod}N)</button>
        <button type="button" onClick={onGoToFile} className={linkClass}>Go to file ({mod}O)</button>
        <button type="button" onClick={onClose} className={linkClass}>Close</button>
      </div>
    </div>
  );
};

// ── SidebarLayout (inner component that uses useSidebar) ───────

const SidebarLayout: React.FC<{
  activeView: SidebarView;
  onViewChange: (view: string) => void;
  editingFilename: string | null;
  articles: ArticleMeta[];
  selectedFilename: string | null;
  articlesLoading: boolean;
  articlesError: string | null;
  onSelectArticle: (filename: string) => void;
  selectWithHistory: (filename: string) => void;
  /** Open a vault file from the graph: keep `__view:graph` in the stack so Back returns to the graph. */
  onOpenArticleFromGraph: (filename: string) => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onHistoryBack: () => void;
  onHistoryForward: () => void;
  onNewArticle: (targetFolder?: string) => void;
  onNewFolder: (folderPath: string) => void;
  onRefreshFileTree: () => void | Promise<void>;
  emptyWikiRawFolders: string[];
  currentTheme: 'light' | 'dark' | 'system';
  onToggleTheme: () => void;
  headings: TocHeading[];
  onHeadingsChange: (headings: TocHeading[]) => void;
  vaultName: string;
  vaultPath: string;
  onVaultSwitched: (newPath: string, newName: string) => void;
  bookmarks: Set<string>;
  onToggleBookmark: (filename: string) => void;
  hasClaudeMd: boolean;
  vaultReloadKey: number;
  onCreateEmptyClaudeMd: () => void;
}> = ({
  activeView,
  onViewChange,
  editingFilename,
  articles,
  selectedFilename,
  articlesLoading,
  articlesError,
  onSelectArticle,
  selectWithHistory,
  onOpenArticleFromGraph,
  canGoBack,
  canGoForward,
  onHistoryBack,
  onHistoryForward,
  onNewArticle,
  onNewFolder,
  onRefreshFileTree,
  emptyWikiRawFolders,
  currentTheme,
  onToggleTheme,
  headings,
  onHeadingsChange,
  vaultName,
  vaultPath,
  onVaultSwitched,
  bookmarks,
  onToggleBookmark,
  hasClaudeMd,
  vaultReloadKey,
  onCreateEmptyClaudeMd,
}) => {
    const { open, setOpen } = useSidebar();
    const { editArticle, navigate, viewArticle } = useNavigation();

    // Derive config files from articles for the ConfigMenu
    const configFiles = useMemo(() => getConfigFiles(articles), [articles]);

    const [rightCollapsed, setRightCollapsed] = useState(false);
    const [leftWidth, setLeftWidth] = useState(() => readStoredPanelWidth(LEFT_PANEL_WIDTH_KEY, 240, 160, 480));
    const [rightWidth, setRightWidth] = useState(() => readStoredPanelWidth(RIGHT_PANEL_WIDTH_KEY, 260, 140, 400));
    const [isLeftResizing, setIsLeftResizing] = useState(false);
    const [isRightResizing, setIsRightResizing] = useState(false);

    useEffect(() => { writeStoredPanelWidth(LEFT_PANEL_WIDTH_KEY, leftWidth); }, [leftWidth]);
    useEffect(() => { writeStoredPanelWidth(RIGHT_PANEL_WIDTH_KEY, rightWidth); }, [rightWidth]);
    const [chatThinkingData, setChatThinkingData] = useState<ThinkingEntry | null>(null);
    const closeThinkingRef = React.useRef<(() => void) | null>(null);

    // Auto-expand the right panel when a Thinking entry first becomes available,
    // so opening the chip in ChatView reveals the panel even if the user had
    // collapsed the right side previously.
    const prevThinkingRef = React.useRef<ThinkingEntry | null>(null);
    React.useEffect(() => {
      if (!prevThinkingRef.current && chatThinkingData) setRightCollapsed(false);
      prevThinkingRef.current = chatThinkingData;
    }, [chatThinkingData]);

    /** Editing the article that is already open in the reader — keep tabs / TOC chrome. */
    const inlineEditActive =
      editingFilename !== null &&
      editingFilename !== '' &&
      selectedFilename !== null &&
      editingFilename === selectedFilename;

    /** Titlebar tabs + TOC behave like the reader (not full-screen editor). */
    const readerLayoutChrome = editingFilename === null || inlineEditActive;

    // ── Tabs ──────────────────────────────────────────────────
    const [tabs, setTabs] = useState<string[]>(() => selectedFilename ? [selectedFilename] : []);
    const activeTab = selectedFilename;

    // Sync: when a file is selected, replace active tab or switch to it if already open
    const prevSelectedRef2 = React.useRef(selectedFilename);
    if (prevSelectedRef2.current !== selectedFilename && selectedFilename) {
      const oldActive = prevSelectedRef2.current;
      prevSelectedRef2.current = selectedFilename;
      setTabs(prev => {
        if (prev.includes(selectedFilename)) return prev;
        if (prev.length === 0) return [selectedFilename];
        // Replace the previously active tab
        const idx = oldActive ? prev.indexOf(oldActive) : -1;
        if (idx === -1) return [...prev, selectedFilename];
        const next = [...prev];
        next[idx] = selectedFilename;
        return next;
      });
    }

    const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

    const openInNewTab = useCallback((filename: string) => {
      setTabs(prev => prev.includes(filename) ? prev : [...prev, filename]);
      onSelectArticle(filename);
    }, [onSelectArticle]);

    const closeTab = useCallback((filename: string) => {
      setTabs(prev => {
        const next = prev.filter(t => t !== filename);
        if (filename === selectedFilename) {
          const idx = prev.indexOf(filename);
          const newActive = next[Math.min(idx, next.length - 1)] ?? null;
          onSelectArticle(newActive ?? '');
        }
        return next;
      });
    }, [selectedFilename, onSelectArticle]);

    // Navigation history is managed by AppShell and passed as props.

    const handleLeftResizeStart = (e: React.MouseEvent) => {
      e.preventDefault();
      setIsLeftResizing(true);
      document.body.classList.add('is-resizing');
      const startX = e.clientX;
      const startWidth = leftWidth;
      const onMove = (ev: MouseEvent) => {
        setLeftWidth(Math.max(160, Math.min(480, startWidth + (ev.clientX - startX))));
      };
      const onUp = () => {
        setIsLeftResizing(false);
        document.body.classList.remove('is-resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };

    const handleRightResizeStart = (e: React.MouseEvent) => {
      e.preventDefault();
      setIsRightResizing(true);
      document.body.classList.add('is-resizing');
      const startX = e.clientX;
      const startWidth = rightWidth;
      const onMove = (ev: MouseEvent) => {
        setRightWidth(Math.max(140, Math.min(400, startWidth - (ev.clientX - startX))));
      };
      const onUp = () => {
        setIsRightResizing(false);
        document.body.classList.remove('is-resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };

    const handleViewChange = useCallback(
      (view: SidebarView) => {
        // Search always opens the floating popup
        if (view === 'search') {
          onViewChange(view);
          return;
        }
        if (view === activeView) {
          // Clicking the active icon toggles sidebar open/closed
          setOpen(!open);
        } else {
          // Switching to a different view
          onViewChange(view);
          // Clear thinking sidebar when leaving chat
          if (activeView === 'chat' && view !== 'chat') setChatThinkingData(null);
          // Settings/chat don't use the sidebar panel, so collapse it
          if (view === 'settings' || view === 'chat') {
            setOpen(false);
          } else if (!open) {
            // Open sidebar if switching to a panel view while collapsed
            setOpen(true);
          }
        }
      },
      [activeView, open, setOpen, onViewChange]
    );

    // Determine if sidebar panel should show content (not for settings or chat)
    const showSidebarPanel = activeView !== 'settings' && activeView !== 'chat';

    return (
      <div className="flex flex-col h-full w-full">
        {/* Full-width titlebar — drag region for macOS hiddenInset traffic lights */}
        <div
          style={{ height: "40px", flexShrink: 0, position: "relative", WebkitAppRegion: "drag" } as React.CSSProperties}
          className="bg-rail-bg border-b border-border shrink-0"
        >
          {/* Left sidebar toggle — inside the sidebar near its right edge.
              When sidebar is closed, clamp to 78px so it stays clear of
              macOS traffic lights (close/minimize/zoom end at ≈67px). */}
          {showSidebarPanel && (
            <div
              style={{
                position: "absolute",
                // Button is 32px wide; place its right edge 4px inside the sidebar's right edge.
                // When closed, snap to 78px (clear of traffic lights).
                left: open ? `${44 + leftWidth - 36}px` : "78px",
                top: 0, bottom: 0,
                display: "flex", alignItems: "center",
                WebkitAppRegion: "no-drag",
              } as React.CSSProperties}
            >
              <button
                type="button"
                onClick={() => setOpen(!open)}
                className="flex items-center justify-center w-8 h-8 rounded-md text-text-secondary hover:bg-surface-hover hover:text-text-primary transition-colors cursor-pointer focus-visible:outline-none"
                aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
              >
                {open ? <PanelLeftClose size={20} /> : <PanelLeftOpen size={20} />}
              </button>
            </div>
          )}

          {/* Tabs in titlebar */}
          {activeView !== 'settings' && activeView !== 'chat' && activeView !== 'graph' && readerLayoutChrome && (
            <div
              style={{
                position: "absolute",
                left: open ? `${44 + leftWidth}px` : "110px",
                right: `${(!rightCollapsed && headings.length > 0) ? rightWidth + 53 : 48}px`,
                top: 0, bottom: 0,
                display: "flex", alignItems: "end",
                overflow: "hidden",
                WebkitAppRegion: "drag",
              } as React.CSSProperties}
            >
              <div className="flex items-end gap-0.5 overflow-x-auto px-1" style={{ scrollbarWidth: "none" }}>
                {tabs.map((t, i) => {
                  const label = t === '__new__' ? 'New tab' : (t.split('/').pop()?.replace(/\.md$/i, '') ?? t);
                  const isActive = t === activeTab;
                  const isPdf = t.toLowerCase().endsWith('.pdf');
                  return (
                    <div
                      key={t}
                      draggable
                      onDragStart={(e) => { e.dataTransfer.setData('text/plain', String(i)); e.dataTransfer.effectAllowed = 'move'; }}
                      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverIdx(i); }}
                      onDragLeave={() => setDragOverIdx(null)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragOverIdx(null);
                        const from = Number(e.dataTransfer.getData('text/plain'));
                        if (from !== i) setTabs(prev => { const next = [...prev]; const [item] = next.splice(from, 1); next.splice(i, 0, item); return next; });
                      }}
                      onDragEnd={() => setDragOverIdx(null)}
                      className={`group relative flex items-center gap-1.5 px-3 h-[30px] text-[11px] rounded-t-lg cursor-pointer shrink-0 max-w-[160px] transition-colors ${isActive ? 'bg-main-bg text-primary' : 'text-text-secondary hover:bg-surface-hover'}`}
                      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                      onClick={() => onSelectArticle(t)}
                    >
                      {dragOverIdx === i && <div className="absolute left-0 top-1 bottom-1 w-0.5 rounded-full bg-primary" />}
                      {isPdf && <FileText size={11} className="shrink-0 text-red-400" />}
                      <span className="truncate">{label}</span>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); closeTab(t); }}
                        className="shrink-0 opacity-0 group-hover:opacity-100 hover:text-text-primary transition-opacity"
                        aria-label="Close tab"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  );
                })}
                <button
                  type="button"
                  onClick={() => {
                    if (!tabs.includes('__new__')) setTabs(prev => [...prev, '__new__']);
                    onSelectArticle('__new__');
                  }}
                  className="flex items-center justify-center w-6 h-6 mb-[2px] rounded-md text-text-secondary hover:bg-surface-hover hover:text-text-primary transition-colors cursor-pointer shrink-0"
                  style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                  aria-label="New tab"
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>
          )}

          {/* Right TOC toggle */}
          {activeView !== 'settings' && activeView !== 'chat' && activeView !== 'graph' && readerLayoutChrome && headings.length > 0 && (
            <div
              style={{
                position: "absolute",
                right: "16px",
                top: 0, bottom: 0,
                display: "flex", alignItems: "center",
                WebkitAppRegion: "no-drag",
              } as React.CSSProperties}
            >
              <button
                type="button"
                onClick={() => setRightCollapsed(c => !c)}
                className="flex items-center justify-center w-8 h-8 rounded-md text-text-secondary hover:bg-surface-hover hover:text-text-primary transition-colors cursor-pointer focus-visible:outline-none"
                aria-label={rightCollapsed ? "Expand table of contents" : "Collapse table of contents"}
              >
                {rightCollapsed ? <PanelRightOpen size={20} /> : <PanelRightClose size={20} />}
              </button>
            </div>
          )}

          {/* Right Thinking panel toggle (chat view) */}
          {activeView === 'chat' && editingFilename === null && chatThinkingData && (
            <div
              style={{
                position: "absolute",
                right: "16px",
                top: 0, bottom: 0,
                display: "flex", alignItems: "center",
                WebkitAppRegion: "no-drag",
              } as React.CSSProperties}
            >
              <button
                type="button"
                onClick={() => setRightCollapsed(c => !c)}
                className="flex items-center justify-center w-8 h-8 rounded-md text-text-secondary hover:bg-surface-hover hover:text-text-primary transition-colors cursor-pointer focus-visible:outline-none"
                aria-label={rightCollapsed ? "Expand thinking panel" : "Collapse thinking panel"}
              >
                {rightCollapsed ? <PanelRightOpen size={20} /> : <PanelRightClose size={20} />}
              </button>
            </div>
          )}
        </div>
        <div className="flex flex-1 overflow-hidden">
          {/* Icon Rail — always visible */}
          <IconRail
            activeView={activeView}
            onViewChange={handleViewChange}
            isSidebarOpen={open}
            currentTheme={currentTheme}
            onToggleTheme={onToggleTheme}
            configFiles={configFiles}
            onSelectConfigFile={viewArticle}
            hasClaudeMd={hasClaudeMd}
            onCreateEmptyClaudeMd={onCreateEmptyClaudeMd}
          />

          {/* Sidebar Panel */}
          {showSidebarPanel && (
            <>
              <Sidebar panelWidth={leftWidth}>
                <SidebarContent>
                  {(activeView === 'files' || activeView === 'graph') && (
                    <FilesView
                      articles={articles}
                      emptyFolderPaths={emptyWikiRawFolders}
                      selectedFilename={selectedFilename}
                      loading={articlesLoading}
                      error={articlesError}
                      onSelectArticle={(f) =>
                        activeView === 'graph' ? onOpenArticleFromGraph(f) : selectWithHistory(f)
                      }
                      onNewArticle={onNewArticle}
                      onNewFolder={onNewFolder}
                      onRefresh={onRefreshFileTree}
                      onOpenInNewTab={openInNewTab}
                      onToggleBookmark={onToggleBookmark}
                      isBookmarked={(f) => bookmarks.has(f)}
                    />
                  )}
                  {activeView === 'bookmarks' && (
                    <BookmarksView
                      articles={articles}
                      bookmarkedFilenames={[...bookmarks].sort((a, b) =>
                        a.localeCompare(b, undefined, { sensitivity: 'base' }),
                      )}
                      selectedFilename={selectedFilename}
                      onOpenBookmark={(filename) => {
                        selectWithHistory(filename);
                        onViewChange('files');
                      }}
                      onRemoveBookmark={onToggleBookmark}
                    />
                  )}
                </SidebarContent>
                {/* Vault switcher pinned to sidebar bottom */}
                <VaultSwitcher
                  currentVaultPath={vaultPath}
                  currentVaultName={vaultName}
                  onSwitched={onVaultSwitched}
                />
              </Sidebar>
              {open && (
                <div
                  className={`lumina-resize-handle${isLeftResizing ? ' is-dragging' : ''}`}
                  onMouseDown={handleLeftResizeStart}
                />
              )}
            </>
          )}

          {/* Main Content Area + TOC */}
          <div className="flex flex-1 overflow-hidden">
            {/* Main column: toolbar + article */}
            <div className="flex flex-col flex-1 overflow-hidden">
              {/* Content toolbar — shown only above the main article area */}
              {(() => {
                const isEditingMode = editingFilename !== null;
                const isNewArticle = editingFilename === '';
                const toolbarFilename = isEditingMode
                  ? (editingFilename === '' ? null : editingFilename)
                  : selectedFilename;
                const showToolbar =
                  activeView !== 'settings' &&
                  activeView !== 'chat' &&
                  !isEditingMode &&
                  (activeView === 'graph' || toolbarFilename !== null || isNewArticle);
                if (!showToolbar) return null;
                return (
                  <ContentToolbar
                    filename={toolbarFilename}
                    vaultName={vaultName}
                    isEditing={isEditingMode}
                    isNewArticle={isNewArticle}
                    isBookmarked={toolbarFilename ? bookmarks.has(toolbarFilename) : false}
                    canGoBack={canGoBack}
                    canGoForward={canGoForward}
                    onBack={onHistoryBack}
                    onForward={onHistoryForward}
                    onToggleBookmark={() => toolbarFilename && onToggleBookmark(toolbarFilename)}
                    onToggleEditMode={() => {
                      if (isEditingMode) {
                        navigate('files');
                      } else if (selectedFilename) {
                        editArticle(selectedFilename);
                      }
                    }}
                  />
                );
              })()}
              <main className="flex flex-col flex-1 overflow-hidden bg-main-bg">
                <OfflineBanner />
                {activeView === 'settings' && editingFilename === null && <SettingsPanel />}
                {activeView === 'chat' && editingFilename === null && <ChatView onThinkingChange={setChatThinkingData} closeThinkingRef={closeThinkingRef} vaultKey={vaultReloadKey} />}
                {activeView === 'graph' && editingFilename === null && (
                  <GraphView articles={articles} onSelectArticle={onOpenArticleFromGraph} />
                )}
                {activeView !== 'settings' && activeView !== 'chat' && activeView !== 'graph' && editingFilename === null && selectedFilename === '__new__' && (
                  <NewTabPage onNewNote={onNewArticle} onGoToFile={() => onViewChange('search')} onClose={() => closeTab('__new__')} />
                )}
                {activeView !== 'settings' && activeView !== 'chat' && activeView !== 'graph' && selectedFilename !== '__new__' && (editingFilename === null || inlineEditActive) && (
                  <ArticleBrowser
                    selectedFilename={selectedFilename}
                    onHeadingsChange={onHeadingsChange}
                    onNavigate={selectWithHistory}
                    inlineEditActive={inlineEditActive}
                  />
                )}
                {editingFilename !== null && !inlineEditActive && <ArticleEditor />}
              </main>
            </div>
            {activeView !== 'settings' && activeView !== 'chat' && activeView !== 'graph' && readerLayoutChrome && !rightCollapsed && headings.length > 0 && (
              <div
                className={`lumina-resize-handle${isRightResizing ? ' is-dragging' : ''}`}
                onMouseDown={handleRightResizeStart}
              />
            )}
            {activeView === 'chat' && editingFilename === null && chatThinkingData && !rightCollapsed && (
              <div
                className={`lumina-resize-handle${isRightResizing ? ' is-dragging' : ''}`}
                onMouseDown={handleRightResizeStart}
              />
            )}
            {activeView !== 'settings' && activeView !== 'chat' && activeView !== 'graph' && readerLayoutChrome && (
              <TocPanel headings={headings} collapsed={rightCollapsed} width={rightWidth} />
            )}
            {activeView === 'chat' && editingFilename === null && chatThinkingData && !rightCollapsed && (
              <ThinkingSidebar
                content={chatThinkingData.content}
                trace={chatThinkingData.trace}
                durationMs={chatThinkingData.durationMs}
                isStreaming={chatThinkingData.isStreaming}
                onClose={() => closeThinkingRef.current?.()}
                width={rightWidth}
                onWikilinkClick={chatThinkingData.onWikilinkClick}
              />
            )}
          </div>
        </div>
      </div>
    );
  };

// ── AppShell ───────────────────────────────────────────────────

const AppShell: React.FC = () => {
  const [activeView, setActiveView] = useState<SidebarView>('files');
  const [editingFilename, setEditingFilename] = useState<string | null>(null);
  const [targetFolder, setTargetFolder] = useState<string | null>(null);
  const [firstRun, setFirstRun] = useState<boolean | null>(null); // null = loading
  const [generateOpen, setGenerateOpen] = useState(false);
  const [searchPopupOpen, setSearchPopupOpen] = useState(false);
  const [debugPanelOpen, setDebugPanelOpen] = useState(false);
  const [findBarOpen, setFindBarOpen] = useState(false);
  const [findInitialQuery, setFindInitialQuery] = useState<string | undefined>(undefined);

  // Refs mirroring the latest activeView / editingFilename so the global
  // keydown handler can read them without re-binding on every change.
  const activeViewRef = useRef<SidebarView>('files');
  const editingFilenameRef = useRef<string | null>(null);
  const [generatedContent, setGeneratedContent] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('dark');
  const [headings, setHeadings] = useState<TocHeading[]>([]);
  const [vaultName, setVaultName] = useState('vault');
  const [vaultPath, setVaultPath] = useState('');
  const [vaultReloadKey, setVaultReloadKey] = useState(0);

  // Article list state (shared with FilesView)
  const [articles, setArticles] = useState<ArticleMeta[]>([]);
  const [emptyWikiRawFolders, setEmptyWikiRawFolders] = useState<string[]>([]);
  const [selectedFilename, setSelectedFilename] = useState<string | null>(null);
  const [articlesLoading, setArticlesLoading] = useState(true);
  const [articlesError, setArticlesError] = useState<string | null>(null);
  const [bookmarks, setBookmarks] = useState<Set<string>>(() => new Set());
  const [showVaultInit, setShowVaultInit] = useState(false);

  const CLAUDE_CANDIDATES = ['.CLAUDE.md', 'CLAUDE.md', '.claude.md', 'claude.md'];
  const hasClaudeMd = articles.some((a) => CLAUDE_CANDIDATES.includes(a.filename));

  const onToggleBookmark = useCallback((filename: string) => {
    setBookmarks((prev) => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      const arr = [...next];
      const rollback = new Set(prev);
      void window.api.setBookmarks(arr).catch(() => {
        setBookmarks(rollback);
      });
      return next;
    });
  }, []);

  // Set document title on mount
  useEffect(() => {
    document.title = 'Lumina';
  }, []);

  // Load config on mount: check vault path and apply theme
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      try {
        const config = await window.api.getConfig();
        if (!cancelled) {
          setTheme(config.theme);
          applyTheme(resolveTheme(config.theme));
          setFirstRun(!config.vaultPath);
          if (config.vaultPath) {
            const segments = config.vaultPath.replace(/\\/g, '/').split('/').filter(Boolean);
            setVaultName(segments[segments.length - 1] ?? 'vault');
            setVaultPath(config.vaultPath);
          }
        }
      } catch {
        if (!cancelled) {
          applyTheme('dark');
          setFirstRun(true);
        }
      }
    };

    init();

    // Listen for system theme changes when using "system" preference
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handleSystemChange = async () => {
      try {
        const config = await window.api.getConfig();
        if (config.theme === 'system' && !cancelled) {
          applyTheme(resolveTheme('system'));
        }
      } catch {
        // ignore
      }
    };
    mq.addEventListener('change', handleSystemChange);

    return () => {
      cancelled = true;
      mq.removeEventListener('change', handleSystemChange);
    };
  }, []);

  // Keep refs in sync so the global keydown handler can read latest state.
  useEffect(() => { activeViewRef.current = activeView; }, [activeView]);
  useEffect(() => { editingFilenameRef.current = editingFilename; }, [editingFilename]);

  // Auto-close the in-page find bar when the user navigates away from the
  // currently-searched document (different file, switched to chat, etc.).
  useEffect(() => {
    if (findBarOpen) setFindBarOpen(false);
    // Intentionally only depend on the navigation surface, not findBarOpen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, editingFilename, selectedFilename, vaultReloadKey]);

  // ── Cmd+Shift+F → open search popup ──────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // ⌘⇧F — global vault search popup. Must come before ⌘F so the
      // shift-modifier variant doesn't fall through to in-page find.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchPopupOpen(o => !o);
        return;
      }
      // ⌘F — open the in-page find bar for the currently visible document.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        // Only intercept when there's actually a document to search; otherwise
        // let the browser default (e.g. the chat view) take over.
        const isDocumentView =
          (activeViewRef.current !== "chat" &&
            activeViewRef.current !== "settings") ||
          editingFilenameRef.current !== null;
        if (!isDocumentView) return;
        e.preventDefault();
        // Seed from current text selection (if any) on first open, like
        // Chrome / VSCode do.
        const sel = window.getSelection?.()?.toString().trim() ?? "";
        setFindInitialQuery(sel.length > 0 && sel.length < 200 ? sel : undefined);
        setFindBarOpen(true);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setActiveView("settings");
        setEditingFilename(null);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        setSearchPopupOpen(true);
      }
      // ⌘⇧D — toggle the bottom debug log panel.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setDebugPanelOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Fetch articles on mount + on vault switch + listen for vault changes
  useEffect(() => {
    if (firstRun === null || firstRun) return;

    let cancelled = false;
    /** Coalesce rapid file-watcher events so the sidebar tree does not flash "Loading…". */
    let vaultRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    const VAULT_REFRESH_DEBOUNCE_MS = 280;

    const fetchArticles = async (showLoading: boolean) => {
      if (showLoading) {
        setArticlesLoading(true);
        setArticlesError(null);
      }
      try {
        const [list, emptyDirs] = await Promise.all([
          window.api.listArticles(),
          window.api.listEmptyWikiRawFolders(),
        ]);
        if (!cancelled) {
          setArticles(list);
          setEmptyWikiRawFolders(emptyDirs);
          // Check if vault has claude.md — if not, prompt initialization
          const claudeCandidates = ['.CLAUDE.md', 'CLAUDE.md', '.claude.md', 'claude.md'];
          const hasClaudeFile = list.some((a) =>
            claudeCandidates.includes(a.filename),
          );
          if (!hasClaudeFile) setShowVaultInit(true);
        }
      } catch (err) {
        if (!cancelled) {
          setArticlesError(err instanceof Error ? err.message : 'Failed to load articles');
        }
      } finally {
        if (!cancelled) setArticlesLoading(false);
      }
    };

    const fetchBookmarks = async () => {
      try {
        let list = await window.api.getBookmarks();
        if (list.length === 0) {
          try {
            const raw = localStorage.getItem('lumina-bookmarks');
            if (raw) {
              const parsed = JSON.parse(raw) as unknown;
              if (
                Array.isArray(parsed) &&
                parsed.every((x): x is string => typeof x === 'string')
              ) {
                list = parsed;
                await window.api.setBookmarks(list);
                localStorage.removeItem('lumina-bookmarks');
              }
            }
          } catch {
            // ignore migration errors
          }
        }
        if (!cancelled) setBookmarks(new Set(list));
      } catch {
        if (!cancelled) setBookmarks(new Set());
      }
    };

    void fetchArticles(true);
    void fetchBookmarks();

    const scheduleVaultRefresh = () => {
      if (cancelled) return;
      if (vaultRefreshTimer !== null) clearTimeout(vaultRefreshTimer);
      vaultRefreshTimer = setTimeout(() => {
        vaultRefreshTimer = null;
        if (!cancelled) {
          void fetchArticles(false);
          void fetchBookmarks();
        }
      }, VAULT_REFRESH_DEBOUNCE_MS);
    };

    window.api.onVaultChange(() => {
      scheduleVaultRefresh();
    });

    return () => {
      cancelled = true;
      if (vaultRefreshTimer !== null) clearTimeout(vaultRefreshTimer);
      window.api.removeVaultChangeListener();
    };
  }, [firstRun, vaultReloadKey]);

  // Listen for vault-switched events from the main process
  useEffect(() => {
    window.api.onVaultSwitched((newVaultPath: string) => {
      const segments = newVaultPath.replace(/\\/g, '/').split('/').filter(Boolean);
      const name = segments[segments.length - 1] ?? 'vault';
      setVaultPath(newVaultPath);
      setVaultName(name);
      setSelectedFilename(null);
      setEditingFilename(null);
      setFirstRun(false);
      setVaultReloadKey((k) => k + 1);
    });
    return () => {
      window.api.removeVaultSwitchedListener();
    };
  }, []);

  const navigate = useCallback((v: string) => {
    // Handle legacy NavView values for backward compatibility
    if (v === 'browse') {
      setActiveView('files');
      setEditingFilename(null);
      return;
    }
    if (v === 'edit') {
      // 'edit' is no longer a sidebar view; ignore (use editArticle/createNewArticle instead)
      return;
    }
    // Search opens the floating popup instead of a sidebar panel
    if (v === 'search') {
      setSearchPopupOpen(true);
      return;
    }

    const next = v as SidebarView;
    const topEntry = () => navStackRef.current[navIndexRef.current];

    // Leaving the knowledge graph via the sidebar (not the history buttons):
    // drop the synthetic graph marker so the stack matches "Back into graph" semantics.
    if (activeView === 'graph' && next !== 'graph' && topEntry() === '__view:graph') {
      navStackRef.current.pop();
      navIndexRef.current = Math.max(-1, navStackRef.current.length - 1);
      syncNavButtons();
    } else if (next === 'graph' && activeView !== 'graph') {
      // Entering graph: record so toolbar Back returns to files/bookmarks/etc.
      navStackRef.current = navStackRef.current.slice(0, navIndexRef.current + 1);
      navStackRef.current.push('__view:graph');
      navIndexRef.current = navStackRef.current.length - 1;
      syncNavButtons();
    }

    setActiveView(next);
    // Clear editing state when switching views via navigate
    setEditingFilename(null);
  }, [activeView]);

  const editArticle = useCallback((filename: string) => {
    setEditingFilename(filename);
  }, []);

  const createNewArticle = useCallback((folder?: string) => {
    setEditingFilename(null);
    setGeneratedContent(null);
    setTargetFolder(folder ?? 'wiki');
    // Set editingFilename to empty string to signal "new article" mode
    // (null means "not editing", so we use a sentinel)
    setEditingFilename('');
  }, []);

  const createNewFolder = useCallback(async (relativePath: string) => {
    try {
      await window.api.createFolder(relativePath);
      const [list, emptyDirs] = await Promise.all([
        window.api.listArticles(),
        window.api.listEmptyWikiRawFolders(),
      ]);
      setArticles(list);
      setEmptyWikiRawFolders(emptyDirs);
      setArticlesError(null);
    } catch (err) {
      console.error(err);
      window.alert(err instanceof Error ? err.message : "Could not create folder");
    }
  }, []);

  const refreshFileTree = useCallback(async () => {
    try {
      const [list, emptyDirs] = await Promise.all([
        window.api.listArticles(),
        window.api.listEmptyWikiRawFolders(),
      ]);
      setArticles(list);
      setEmptyWikiRawFolders(emptyDirs);
      setArticlesError(null);
    } catch (err) {
      setArticlesError(err instanceof Error ? err.message : "Failed to refresh file list");
    }
  }, []);

  const prevSidebarViewRef = useRef<SidebarView>(activeView);

  // When leaving settings/chat/search/etc. for Files or Graph, rescan the vault
  // so the sidebar tree and graph stay in sync with disk.
  useEffect(() => {
    if (firstRun === null || firstRun) return;

    const prev = prevSidebarViewRef.current;
    prevSidebarViewRef.current = activeView;

    const isFilesOrGraph = activeView === "files" || activeView === "graph";
    const wasFilesOrGraph = prev === "files" || prev === "graph";
    if (!isFilesOrGraph || wasFilesOrGraph) return;

    void refreshFileTree();
  }, [activeView, firstRun, refreshFileTree]);

  const handleSelectArticle = useCallback((filename: string) => {
    setSelectedFilename(filename || null);
    setEditingFilename(null);
  }, []);

  // ── Navigation history ────────────────────────────────────────
  // Stack entries are either vault-relative filenames or '__view:<viewName>' markers.
  const navStackRef = React.useRef<string[]>([]);
  const navIndexRef = React.useRef(-1);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  const syncNavButtons = () => {
    setCanGoBack(navIndexRef.current > 0);
    setCanGoForward(navIndexRef.current < navStackRef.current.length - 1);
  };

  const selectArticleWithHistory = useCallback((filename: string) => {
    navStackRef.current = navStackRef.current.slice(0, navIndexRef.current + 1);
    navStackRef.current.push(filename);
    navIndexRef.current = navStackRef.current.length - 1;
    syncNavButtons();
    handleSelectArticle(filename);
  }, [handleSelectArticle]);

  /** From graph node / file tree while graph is main: do not use `navigate('files')` — that pops `__view:graph`. */
  const openArticleFromGraph = useCallback(
    (filename: string) => {
      selectArticleWithHistory(filename);
      setActiveView("files");
      setEditingFilename(null);
    },
    [selectArticleWithHistory],
  );

  const handleHistoryBack = useCallback(() => {
    if (navIndexRef.current <= 0) return;
    navIndexRef.current--;
    syncNavButtons();
    const entry = navStackRef.current[navIndexRef.current];
    if (entry.startsWith('__view:')) {
      setActiveView(entry.slice(7) as SidebarView);
    } else {
      handleSelectArticle(entry);
      setActiveView('files');
    }
  }, [handleSelectArticle]);

  const handleHistoryForward = useCallback(() => {
    if (navIndexRef.current >= navStackRef.current.length - 1) return;
    navIndexRef.current++;
    syncNavButtons();
    const entry = navStackRef.current[navIndexRef.current];
    if (entry.startsWith('__view:')) {
      setActiveView(entry.slice(7) as SidebarView);
    } else {
      handleSelectArticle(entry);
      setActiveView('files');
    }
  }, [handleSelectArticle]);

  const viewArticle = useCallback((filename: string) => {
    // If navigating from chat (or any non-files view), record the source view so
    // the back button can return there.
    if (activeView !== 'files') {
      navStackRef.current = navStackRef.current.slice(0, navIndexRef.current + 1);
      navStackRef.current.push(`__view:${activeView}`);
      navIndexRef.current = navStackRef.current.length - 1;
    }
    selectArticleWithHistory(filename);
    setEditingFilename(null);
    setActiveView('files');
  }, [activeView, selectArticleWithHistory]);

  const handleAcceptGenerated = useCallback((content: string) => {
    setGenerateOpen(false);
    setEditingFilename('');
    setGeneratedContent(content);
  }, []);

  const clearGeneratedContent = useCallback(() => {
    setGeneratedContent(null);
  }, []);

  const [prefilledTitle, setPrefilledTitle] = useState<string | null>(null);
  const clearPrefilledTitle = useCallback(() => setPrefilledTitle(null), []);

  /**
   * Create an empty CLAUDE.md in the vault root and immediately open it for
   * editing. The bundled CLAUDE.md template is intentionally NOT exposed to
   * the user — it's a runtime system prompt fallback only. The file the user
   * owns starts empty so they can write whatever conventions they want; the
   * bundled template fills in behind the scenes for chat sessions until the
   * user puts content in their own CLAUDE.md.
   */
  const handleCreateEmptyClaudeMd = useCallback(async () => {
    try {
      await window.api.writeRawFile('CLAUDE.md', '');
    } catch (err) {
      console.error('Failed to create empty CLAUDE.md:', err);
      return;
    }
    const [list, emptyDirs] = await Promise.all([
      window.api.listArticles(),
      window.api.listEmptyWikiRawFolders(),
    ]);
    setArticles(list);
    setEmptyWikiRawFolders(emptyDirs);
    const claudeFile = list.find((a) => a.filename.toLowerCase() === 'claude.md');
    if (claudeFile) {
      setSelectedFilename(claudeFile.filename);
      setEditingFilename(claudeFile.filename);
    }
  }, []);

  const handleVaultInit = useCallback(async () => {
    // Empty CLAUDE.md by design — the bundled template fills in as the
    // system prompt at runtime. Once the user writes anything in this file,
    // it overrides the bundled template (see chat-service.loadSystemPrompt).
    await window.api.writeRawFile('CLAUDE.md', '');
    await window.api.createFolder('raw');
    await window.api.createFolder('wiki');
    const [list, emptyDirs] = await Promise.all([
      window.api.listArticles(),
      window.api.listEmptyWikiRawFolders(),
    ]);
    setArticles(list);
    setEmptyWikiRawFolders(emptyDirs);
    setShowVaultInit(false);
    const claudeFile = list.find((a) => a.filename.toLowerCase() === 'claude.md');
    if (claudeFile) {
      setSelectedFilename(claudeFile.filename);
      setEditingFilename(claudeFile.filename);
    }
  }, []);

  const handleToggleTheme = useCallback(async () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
    try {
      await window.api.saveConfig({ theme: next });
    } catch {
      // ignore persistence failure
    }
  }, [theme]);

  const navCtx: NavigationContext = {
    view: activeView,
    navigate,
    editingFilename: editingFilename === '' ? null : editingFilename,
    editArticle,
    createNewArticle,
    targetFolder,
    generatedContent,
    clearGeneratedContent,
    viewArticle,
    refreshFileTree,
    prefilledTitle,
    clearPrefilledTitle,
  };

  // Still loading config
  if (firstRun === null) {
    return null;
  }

  // First-run: show welcome screen
  if (firstRun) {
    return <WelcomeScreen onVaultSelected={() => setFirstRun(false)} />;
  }

  return (
    <NetworkStatusProvider>
      <NavContext.Provider value={navCtx}>
        <TooltipProvider>
          <SidebarProvider defaultOpen={true} className="h-full w-full">
            <SidebarLayout
              activeView={activeView}
              onViewChange={navigate}
              editingFilename={editingFilename}
              articles={articles}
              selectedFilename={selectedFilename}
              articlesLoading={articlesLoading}
              articlesError={articlesError}
              onSelectArticle={handleSelectArticle}
              selectWithHistory={selectArticleWithHistory}
              onOpenArticleFromGraph={openArticleFromGraph}
              canGoBack={canGoBack}
              canGoForward={canGoForward}
              onHistoryBack={handleHistoryBack}
              onHistoryForward={handleHistoryForward}
              onNewArticle={createNewArticle}
              onNewFolder={createNewFolder}
              onRefreshFileTree={refreshFileTree}
              emptyWikiRawFolders={emptyWikiRawFolders}
              currentTheme={theme}
              onToggleTheme={handleToggleTheme}
              headings={headings}
              onHeadingsChange={setHeadings}
              vaultName={vaultName}
              vaultPath={vaultPath}
              onVaultSwitched={(newPath, newName) => {
                setVaultPath(newPath);
                setVaultName(newName);
                setSelectedFilename(null);
                setEditingFilename(null);
                setVaultReloadKey((k) => k + 1);
              }}
              bookmarks={bookmarks}
              onToggleBookmark={onToggleBookmark}
              hasClaudeMd={hasClaudeMd}
              vaultReloadKey={vaultReloadKey}
              onCreateEmptyClaudeMd={handleCreateEmptyClaudeMd}
            />
          </SidebarProvider>
        </TooltipProvider>

        {/* Generate Article Dialog */}
        <GenerateArticleDialog
          open={generateOpen}
          onClose={() => setGenerateOpen(false)}
          onAccept={handleAcceptGenerated}
        />

        {/* Search Popup (Alfred-style) */}
        <SearchPopup
          open={searchPopupOpen}
          onClose={() => setSearchPopupOpen(false)}
          onSelectArticle={viewArticle}
        />

        {/* Vault Init Dialog */}
        <VaultInitDialog
          open={showVaultInit}
          onConfirm={handleVaultInit}
          onCancel={() => { setShowVaultInit(false); setActiveView('files'); }}
        />

        {/* Debug log overlay (⌘⇧D) */}
        <DebugLogPanel
          open={debugPanelOpen}
          onClose={() => setDebugPanelOpen(false)}
        />

        {/* In-page Find bar (⌘F) — operates on whichever document view is
            currently registered as the active find backend. */}
        <FindBar
          open={findBarOpen}
          initialQuery={findInitialQuery}
          onClose={() => setFindBarOpen(false)}
        />
      </NavContext.Provider>
    </NetworkStatusProvider>
  );
};

export default AppShell;

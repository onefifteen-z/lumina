import React, { useState, useEffect, useCallback, useMemo, createContext, useContext } from 'react';
import type { WikiAPI, ArticleMeta } from '../../shared/types';
import { getConfigFiles } from '../lib/file-classification';
import ArticleBrowser from './ArticleBrowser';
import ArticleEditor from './ArticleEditor';
import SettingsPanel from './SettingsPanel';
import ChatView from './ChatView';
import { NetworkStatusProvider, useNetworkStatus } from '../hooks/useNetworkStatus';
import GenerateArticleDialog from './GenerateArticleDialog';
import { IconRail, type SidebarView } from './IconRail';
import { FilesView } from './FilesView';
import { SearchView } from './SearchView';
import { SearchPopup } from './SearchPopup';
import { BookmarksView } from './BookmarksView';
import { TocPanel, type TocHeading } from './TocPanel';
import { ContentToolbar } from './ContentToolbar';
import { GraphView } from './GraphView';
import { VaultSwitcher } from './VaultSwitcher';
import { VaultInitDialog } from './VaultInitDialog';
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, X, FileText, Plus } from 'lucide-react';
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
  createNewArticle: () => void;
  /** Pre-populated content from LLM generation (when opening editor after generate) */
  generatedContent: string | null;
  /** Clear the generated content after it's been consumed */
  clearGeneratedContent: () => void;
  /** Switch to the files view and select the given article for viewing */
  viewArticle: (filename: string) => void;
}

const NavContext = createContext<NavigationContext>({
  view: 'files',
  navigate: () => { },
  editingFilename: null,
  editArticle: () => { },
  createNewArticle: () => { },
  generatedContent: null,
  clearGeneratedContent: () => { },
  viewArticle: () => { },
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

// ── WelcomeScreen ──────────────────────────────────────────────

const WelcomeScreen: React.FC<{ onVaultSelected: () => void }> = ({ onVaultSelected }) => {
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSelectVault = async () => {
    setSelecting(true);
    setError(null);
    try {
      const selectedPath = await window.api.selectVaultFolder();
      if (!selectedPath) {
        setSelecting(false);
        return;
      }
      await window.api.saveConfig({ vaultPath: selectedPath });
      await window.api.listArticles();
      onVaultSelected();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set up vault folder.');
      setSelecting(false);
    }
  };

  return (
    <div className="welcome-screen">
      <div className="welcome-screen__card">
        <div className="welcome-screen__icon" aria-hidden="true">📚</div>
        <h1 className="welcome-screen__title">Welcome to Lumina</h1>
        <p className="welcome-screen__description">
          Your local, AI-powered personal wiki. To get started, select or create a folder to store your wiki articles.
        </p>
        <button
          className="welcome-screen__btn"
          onClick={handleSelectVault}
          disabled={selecting}
        >
          {selecting ? 'Setting up…' : 'Select Vault Folder'}
        </button>
        {error && <p className="welcome-screen__error" role="alert">{error}</p>}
      </div>
    </div>
  );
};

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
  onNewArticle: () => void;
  onNewFolder: (folderPath: string) => void;
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
}> = ({
  activeView,
  onViewChange,
  editingFilename,
  articles,
  selectedFilename,
  articlesLoading,
  articlesError,
  onSelectArticle,
  onNewArticle,
  onNewFolder,
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
}) => {
    const { open, setOpen } = useSidebar();
    const { editArticle, navigate, viewArticle } = useNavigation();

    // Derive config files from articles for the ConfigMenu
    const configFiles = useMemo(() => getConfigFiles(articles), [articles]);

    const [rightCollapsed, setRightCollapsed] = useState(false);
    const [leftWidth, setLeftWidth] = useState(240);
    const [rightWidth, setRightWidth] = useState(260);
    const [isLeftResizing, setIsLeftResizing] = useState(false);
    const [isRightResizing, setIsRightResizing] = useState(false);

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

    // ── Navigation history ────────────────────────────────────
    const navStackRef = React.useRef<string[]>([]);
    const navIndexRef = React.useRef(-1);
    const [canGoBack, setCanGoBack] = useState(false);
    const [canGoForward, setCanGoForward] = useState(false);

    const syncNavButtons = () => {
      setCanGoBack(navIndexRef.current > 0);
      setCanGoForward(navIndexRef.current < navStackRef.current.length - 1);
    };

    /** Wraps onSelectArticle to push an entry onto the history stack. */
    const selectArticleWithHistory = useCallback((filename: string) => {
      navStackRef.current = navStackRef.current.slice(0, navIndexRef.current + 1);
      navStackRef.current.push(filename);
      navIndexRef.current = navStackRef.current.length - 1;
      syncNavButtons();
      onSelectArticle(filename);
    }, [onSelectArticle]);

    const handleHistoryBack = useCallback(() => {
      if (navIndexRef.current <= 0) return;
      navIndexRef.current--;
      syncNavButtons();
      onSelectArticle(navStackRef.current[navIndexRef.current]);
    }, [onSelectArticle]);

    const handleHistoryForward = useCallback(() => {
      if (navIndexRef.current >= navStackRef.current.length - 1) return;
      navIndexRef.current++;
      syncNavButtons();
      onSelectArticle(navStackRef.current[navIndexRef.current]);
    }, [onSelectArticle]);

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
          {activeView !== 'settings' && activeView !== 'chat' && activeView !== 'graph' && editingFilename === null && tabs.length > 0 && (
            <div
              style={{
                position: "absolute",
                left: open ? `${44 + leftWidth}px` : "110px",
                right: `${(activeView !== 'settings' && activeView !== 'chat' && activeView !== 'graph' && !rightCollapsed && headings.length > 0) ? rightWidth + 53 : 48}px`,
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
          {activeView !== 'settings' && activeView !== 'chat' && activeView !== 'graph' && editingFilename === null && headings.length > 0 && (
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
          />

          {/* Sidebar Panel */}
          {showSidebarPanel && (
            <>
              <Sidebar panelWidth={leftWidth}>
                <SidebarContent>
                  {(activeView === 'files' || activeView === 'graph') && (
                    <FilesView
                      articles={articles}
                      selectedFilename={selectedFilename}
                      loading={articlesLoading}
                      error={articlesError}
                      onSelectArticle={(f) => { selectArticleWithHistory(f); if (activeView === 'graph') onViewChange('files'); }}
                      onNewArticle={onNewArticle}
                      onNewFolder={onNewFolder}
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
                        selectArticleWithHistory(filename);
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
                const showToolbar = (toolbarFilename !== null || isNewArticle)
                  && activeView !== 'settings' && activeView !== 'chat' && activeView !== 'graph';
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
                    onBack={handleHistoryBack}
                    onForward={handleHistoryForward}
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
                {activeView === 'chat' && editingFilename === null && <ChatView />}
                {activeView === 'graph' && editingFilename === null && (
                  <GraphView articles={articles} onSelectArticle={(f) => { selectArticleWithHistory(f); onViewChange('files'); }} />
                )}
                {activeView !== 'settings' && activeView !== 'chat' && activeView !== 'graph' && editingFilename === null && selectedFilename === '__new__' && (
                  <NewTabPage onNewNote={onNewArticle} onGoToFile={() => onViewChange('search')} onClose={() => closeTab('__new__')} />
                )}
                {activeView !== 'settings' && activeView !== 'chat' && activeView !== 'graph' && editingFilename === null && selectedFilename !== '__new__' && (
                  <ArticleBrowser
                    selectedFilename={selectedFilename}
                    onHeadingsChange={onHeadingsChange}
                    onNavigate={selectArticleWithHistory}
                  />
                )}
                {editingFilename !== null && <ArticleEditor />}
              </main>
            </div>
            {activeView !== 'settings' && activeView !== 'chat' && activeView !== 'graph' && editingFilename === null && !rightCollapsed && headings.length > 0 && (
              <div
                className={`lumina-resize-handle${isRightResizing ? ' is-dragging' : ''}`}
                onMouseDown={handleRightResizeStart}
              />
            )}
            {activeView !== 'settings' && activeView !== 'chat' && activeView !== 'graph' && editingFilename === null && (
              <TocPanel headings={headings} collapsed={rightCollapsed} width={rightWidth} />
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
  const [firstRun, setFirstRun] = useState<boolean | null>(null); // null = loading
  const [generateOpen, setGenerateOpen] = useState(false);
  const [searchPopupOpen, setSearchPopupOpen] = useState(false);
  const [generatedContent, setGeneratedContent] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('dark');
  const [headings, setHeadings] = useState<TocHeading[]>([]);
  const [vaultName, setVaultName] = useState('vault');
  const [vaultPath, setVaultPath] = useState('');
  const [vaultReloadKey, setVaultReloadKey] = useState(0);

  // Article list state (shared with FilesView)
  const [articles, setArticles] = useState<ArticleMeta[]>([]);
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

  // ── Cmd+Shift+F → open search popup ──────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchPopupOpen(o => !o);
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
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Fetch articles on mount + on vault switch + listen for vault changes
  useEffect(() => {
    if (firstRun === null || firstRun) return;

    let cancelled = false;

    const fetchArticles = async () => {
      try {
        setArticlesLoading(true);
        setArticlesError(null);
        const list = await window.api.listArticles();
        if (!cancelled) {
          setArticles(list);
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

    fetchArticles();
    fetchBookmarks();

    window.api.onVaultChange(() => {
      if (!cancelled) {
        void fetchArticles();
        void fetchBookmarks();
      }
    });

    return () => {
      cancelled = true;
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
    setActiveView(v as SidebarView);
    // Clear editing state when switching views via navigate
    setEditingFilename(null);
  }, []);

  const editArticle = useCallback((filename: string) => {
    setEditingFilename(filename);
  }, []);

  const createNewArticle = useCallback(() => {
    setEditingFilename(null);
    setGeneratedContent(null);
    // Set editingFilename to empty string to signal "new article" mode
    // (null means "not editing", so we use a sentinel)
    setEditingFilename('');
  }, []);

  const createNewFolder = useCallback(async (folderName: string) => {
    try {
      await window.api.createFolder(folderName);
    } catch { /* folder may already exist */ }
  }, []);

  const handleSelectArticle = useCallback((filename: string) => {
    setSelectedFilename(filename || null);
    setEditingFilename(null);
  }, []);

  const viewArticle = useCallback((filename: string) => {
    setSelectedFilename(filename);
    setEditingFilename(null);
    setActiveView('files');
  }, []);

  const handleAcceptGenerated = useCallback((content: string) => {
    setGenerateOpen(false);
    setEditingFilename('');
    setGeneratedContent(content);
  }, []);

  const clearGeneratedContent = useCallback(() => {
    setGeneratedContent(null);
  }, []);

  const handleVaultInit = useCallback(async () => {
    const defaultContent = '# System Prompt\n\nYou are a helpful assistant for this vault.\n';
    await window.api.saveArticle({
      frontmatter: { title: 'claude', tags: [], created: new Date().toISOString(), modified: new Date().toISOString() },
      content: defaultContent,
      rawContent: '',
    });
    await window.api.createFolder('raw');
    await window.api.createFolder('wiki');
    const list = await window.api.listArticles();
    setArticles(list);
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
    generatedContent,
    clearGeneratedContent,
    viewArticle,
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
              onNewArticle={createNewArticle}
              onNewFolder={createNewFolder}
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
      </NavContext.Provider>
    </NetworkStatusProvider>
  );
};

export default AppShell;

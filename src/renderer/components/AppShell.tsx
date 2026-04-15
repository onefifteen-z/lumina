import React, { useState, useEffect, useCallback, createContext, useContext } from 'react';
import type { WikiAPI, ArticleMeta } from '../../shared/types';
import ArticleBrowser from './ArticleBrowser';
import ArticleEditor from './ArticleEditor';
import SettingsPanel from './SettingsPanel';
import { NetworkStatusProvider, useNetworkStatus } from '../hooks/useNetworkStatus';
import GenerateArticleDialog from './GenerateArticleDialog';
import { IconRail, type SidebarView } from './IconRail';
import { FilesView } from './FilesView';
import { SearchView } from './SearchView';
import { BookmarksView } from './BookmarksView';
import { TooltipProvider } from './ui/tooltip';
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
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
  /** Title of the article being edited (when in editor mode) */
  editingTitle: string | null;
  /** Navigate to the editor for a specific article */
  editArticle: (title: string) => void;
  /** Create a new article — opens blank editor */
  createNewArticle: () => void;
  /** Pre-populated content from LLM generation (when opening editor after generate) */
  generatedContent: string | null;
  /** Clear the generated content after it's been consumed */
  clearGeneratedContent: () => void;
}

const NavContext = createContext<NavigationContext>({
  view: 'files',
  navigate: () => { },
  editingTitle: null,
  editArticle: () => { },
  createNewArticle: () => { },
  generatedContent: null,
  clearGeneratedContent: () => { },
});

export const useNavigation = () => useContext(NavContext);

// ── Theme helpers ──────────────────────────────────────────────

function resolveTheme(theme: 'light' | 'dark' | 'system'): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.setAttribute('data-theme', theme);
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

// ── SidebarLayout (inner component that uses useSidebar) ───────

const SidebarLayout: React.FC<{
  activeView: SidebarView;
  onViewChange: (view: string) => void;
  editingTitle: string | null;
  articles: ArticleMeta[];
  selectedTitle: string | null;
  articlesLoading: boolean;
  articlesError: string | null;
  onSelectArticle: (title: string) => void;
  onNewArticle: () => void;
  onGenerateArticle: () => void;
}> = ({
  activeView,
  onViewChange,
  editingTitle,
  articles,
  selectedTitle,
  articlesLoading,
  articlesError,
  onSelectArticle,
  onNewArticle,
  onGenerateArticle,
}) => {
    const { open, setOpen } = useSidebar();

    const handleViewChange = useCallback(
      (view: SidebarView) => {
        if (view === activeView) {
          // Clicking the active icon toggles sidebar open/closed
          setOpen(!open);
        } else {
          // Switching to a different view
          onViewChange(view);
          // Settings doesn't use the sidebar panel, so collapse it
          if (view === 'settings') {
            setOpen(false);
          } else if (!open) {
            // Open sidebar if switching to a panel view while collapsed
            setOpen(true);
          }
        }
      },
      [activeView, open, setOpen, onViewChange]
    );

    // Determine if sidebar panel should show content (not for settings)
    const showSidebarPanel = activeView !== 'settings';

    return (
      <div className="flex h-full w-full">
        {/* Icon Rail — always visible */}
        <IconRail
          activeView={activeView}
          onViewChange={handleViewChange}
          isSidebarOpen={open}
        />

        {/* Sidebar Panel */}
        {showSidebarPanel && (
          <Sidebar>
            <SidebarHeader>
              <span className="text-sm font-semibold text-text-primary tracking-wide">
                Lumina
              </span>
            </SidebarHeader>
            <SidebarContent>
              {activeView === 'files' && (
                <FilesView
                  articles={articles}
                  selectedTitle={selectedTitle}
                  loading={articlesLoading}
                  error={articlesError}
                  onSelectArticle={onSelectArticle}
                  onNewArticle={onNewArticle}
                  onGenerateArticle={onGenerateArticle}
                />
              )}
              {activeView === 'search' && (
                <SearchView onSelectArticle={onSelectArticle} />
              )}
              {activeView === 'bookmarks' && <BookmarksView />}
            </SidebarContent>
          </Sidebar>
        )}

        {/* Main Content Area */}
        <main className="flex-1 overflow-auto bg-main-bg">
          <OfflineBanner />
          {activeView === 'settings' && editingTitle === null && <SettingsPanel />}
          {activeView !== 'settings' && editingTitle === null && <ArticleBrowser selectedTitle={selectedTitle} />}
          {editingTitle !== null && <ArticleEditor />}
        </main>
      </div>
    );
  };

// ── AppShell ───────────────────────────────────────────────────

const AppShell: React.FC = () => {
  const [activeView, setActiveView] = useState<SidebarView>('files');
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [firstRun, setFirstRun] = useState<boolean | null>(null); // null = loading
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generatedContent, setGeneratedContent] = useState<string | null>(null);

  // Article list state (shared with FilesView)
  const [articles, setArticles] = useState<ArticleMeta[]>([]);
  const [selectedTitle, setSelectedTitle] = useState<string | null>(null);
  const [articlesLoading, setArticlesLoading] = useState(true);
  const [articlesError, setArticlesError] = useState<string | null>(null);

  // Load config on mount: check vault path and apply theme
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      try {
        const config = await window.api.getConfig();
        if (!cancelled) {
          applyTheme(resolveTheme(config.theme));
          setFirstRun(!config.vaultPath);
        }
      } catch {
        if (!cancelled) {
          applyTheme('light');
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

  // Fetch articles on mount + listen for vault changes
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
        }
      } catch (err) {
        if (!cancelled) {
          setArticlesError(err instanceof Error ? err.message : 'Failed to load articles');
        }
      } finally {
        if (!cancelled) setArticlesLoading(false);
      }
    };

    fetchArticles();

    window.api.onVaultChange(() => {
      if (!cancelled) fetchArticles();
    });

    return () => {
      cancelled = true;
      window.api.removeVaultChangeListener();
    };
  }, [firstRun]);

  const navigate = useCallback((v: string) => {
    // Handle legacy NavView values for backward compatibility
    if (v === 'browse') {
      setActiveView('files');
      setEditingTitle(null);
      return;
    }
    if (v === 'edit') {
      // 'edit' is no longer a sidebar view; ignore (use editArticle/createNewArticle instead)
      return;
    }
    setActiveView(v as SidebarView);
    // Clear editing state when switching views via navigate
    setEditingTitle(null);
  }, []);

  const editArticle = useCallback((title: string) => {
    setEditingTitle(title);
  }, []);

  const createNewArticle = useCallback(() => {
    setEditingTitle(null);
    setGeneratedContent(null);
    // Set editingTitle to empty string to signal "new article" mode
    // (null means "not editing", so we use a sentinel)
    setEditingTitle('');
  }, []);

  const handleSelectArticle = useCallback((title: string) => {
    setSelectedTitle(title);
    setEditingTitle(null);
  }, []);

  const handleAcceptGenerated = useCallback((content: string) => {
    setGenerateOpen(false);
    setEditingTitle('');
    setGeneratedContent(content);
  }, []);

  const clearGeneratedContent = useCallback(() => {
    setGeneratedContent(null);
  }, []);

  const navCtx: NavigationContext = {
    view: activeView,
    navigate,
    editingTitle: editingTitle === '' ? null : editingTitle,
    editArticle,
    createNewArticle,
    generatedContent,
    clearGeneratedContent,
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
          <SidebarProvider defaultOpen={true}>
            <SidebarLayout
              activeView={activeView}
              onViewChange={navigate}
              editingTitle={editingTitle}
              articles={articles}
              selectedTitle={selectedTitle}
              articlesLoading={articlesLoading}
              articlesError={articlesError}
              onSelectArticle={handleSelectArticle}
              onNewArticle={createNewArticle}
              onGenerateArticle={() => setGenerateOpen(true)}
            />
          </SidebarProvider>
        </TooltipProvider>

        {/* Generate Article Dialog */}
        <GenerateArticleDialog
          open={generateOpen}
          onClose={() => setGenerateOpen(false)}
          onAccept={handleAcceptGenerated}
        />
      </NavContext.Provider>
    </NetworkStatusProvider>
  );
};

export default AppShell;

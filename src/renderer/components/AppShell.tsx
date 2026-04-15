import React, { useState, useEffect, useCallback, createContext, useContext } from 'react';
import type { WikiAPI } from '../../shared/types';
import ArticleBrowser from './ArticleBrowser';
import ArticleEditor from './ArticleEditor';

// ── Declare window.api for TypeScript ──────────────────────────

declare global {
  interface Window {
    api: WikiAPI;
  }
}

// ── Navigation types ───────────────────────────────────────────

export type NavView = 'browse' | 'search' | 'settings' | 'edit';

export interface NavigationContext {
  view: NavView;
  navigate: (view: NavView) => void;
  /** Title of the article being edited (when view === 'edit') */
  editingTitle: string | null;
  /** Navigate to the editor for a specific article */
  editArticle: (title: string) => void;
}

const NavContext = createContext<NavigationContext>({
  view: 'browse',
  navigate: () => { },
  editingTitle: null,
  editArticle: () => { },
});

export const useNavigation = () => useContext(NavContext);

// ── Placeholder components ─────────────────────────────────────

const SearchPanel: React.FC = () => (
  <div className="placeholder-panel">
    <h2>Search</h2>
    <p>Search panel will be implemented here.</p>
  </div>
);

const SettingsPanel: React.FC = () => (
  <div className="placeholder-panel">
    <h2>Settings</h2>
    <p>Settings panel will be implemented here.</p>
  </div>
);



// ── Sidebar nav items ──────────────────────────────────────────

const NAV_ITEMS: { view: NavView; label: string; icon: string }[] = [
  { view: 'browse', label: 'Articles', icon: '📄' },
  { view: 'search', label: 'Search', icon: '🔍' },
  { view: 'settings', label: 'Settings', icon: '⚙️' },
];

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
        // User cancelled the dialog
        setSelecting(false);
        return;
      }
      await window.api.saveConfig({ vaultPath: selectedPath });
      // Trigger initial vault scan and index build
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
        <h1 className="welcome-screen__title">Welcome to LLM Wiki</h1>
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

// ── AppShell ───────────────────────────────────────────────────

const AppShell: React.FC = () => {
  const [view, setView] = useState<NavView>('browse');
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [firstRun, setFirstRun] = useState<boolean | null>(null); // null = loading

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

  const navigate = useCallback((v: NavView) => {
    setView(v);
    if (v !== 'edit') setEditingTitle(null);
  }, []);

  const editArticle = useCallback((title: string) => {
    setEditingTitle(title);
    setView('edit');
  }, []);

  const navCtx: NavigationContext = { view, navigate, editingTitle, editArticle };

  // Still loading config
  if (firstRun === null) {
    return null;
  }

  // First-run: show welcome screen
  if (firstRun) {
    return <WelcomeScreen onVaultSelected={() => setFirstRun(false)} />;
  }

  return (
    <NavContext.Provider value={navCtx}>
      <div className="app-shell">
        {/* Sidebar */}
        <aside className="app-sidebar">
          <div className="app-sidebar__header">LLM Wiki</div>
          <nav className="app-sidebar__nav">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.view}
                className={`app-sidebar__item${view === item.view ? ' app-sidebar__item--active' : ''}`}
                onClick={() => navigate(item.view)}
                aria-current={view === item.view ? 'page' : undefined}
              >
                <span aria-hidden="true">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </nav>
        </aside>

        {/* Main content */}
        <main className="app-main">
          {view === 'browse' && <ArticleBrowser />}
          {view === 'search' && <SearchPanel />}
          {view === 'settings' && <SettingsPanel />}
          {view === 'edit' && <ArticleEditor />}
        </main>
      </div>
    </NavContext.Provider>
  );
};

export default AppShell;

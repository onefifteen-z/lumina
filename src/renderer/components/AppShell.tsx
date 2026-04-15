import React, { useState, useEffect, useCallback, createContext, useContext } from 'react';
import type { WikiAPI } from '../../shared/types';

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

const ArticleBrowser: React.FC = () => (
  <div className="placeholder-panel">
    <h2>Articles</h2>
    <p>Article browser will be implemented here.</p>
  </div>
);

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

const ArticleEditor: React.FC = () => {
  const { editingTitle } = useNavigation();
  return (
    <div className="placeholder-panel">
      <h2>Editor</h2>
      <p>Editing: {editingTitle ?? 'New article'}</p>
    </div>
  );
};

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

// ── AppShell ───────────────────────────────────────────────────

const AppShell: React.FC = () => {
  const [view, setView] = useState<NavView>('browse');
  const [editingTitle, setEditingTitle] = useState<string | null>(null);

  // Load theme from config on mount
  useEffect(() => {
    let cancelled = false;

    const loadTheme = async () => {
      try {
        const config = await window.api.getConfig();
        if (!cancelled) {
          applyTheme(resolveTheme(config.theme));
        }
      } catch {
        // Fallback to light if config unavailable
        if (!cancelled) applyTheme('light');
      }
    };

    loadTheme();

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

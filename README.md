# Lumina

LLM Wiki — a local-first Electron desktop app providing an AI-powered personal wiki with Obsidian-compatible Markdown storage.

## Project Structure

- `src/shared/` — Shared types and Markdown parser utilities
- `src/main/` — Electron main process (services, IPC handlers)
  - `src/main/services/filesystem-service.ts` — Vault filesystem operations (scan, read, write, delete, watch)
  - `src/main/services/search-index-service.ts` — Full-text search and tag-based filtering via FlexSearch
  - `src/main/services/llm-service.ts` — LLM provider integration (streaming generation, summarize, expand, refine)
  - `src/main/services/config-service.ts` — App configuration persistence (electron-store) and secure API key storage (safeStorage)
- `src/renderer/` — React-based renderer UI
  - `src/renderer/components/AppShell.tsx` — Main layout shell with sidebar navigation, theme support, and navigation context
- `src/main/ipc-handlers.ts` — IPC handler registration wiring services to renderer API
- `src/preload/` — Typed preload script exposing WikiAPI via contextBridge

## Getting Started

```bash
git clone <repository-url>
cd prj-lumina
npm install
npm run dev
```

## Implementation Progress

- [x] Core data models and project scaffolding
- [x] Markdown parser (frontmatter, wikilinks, embeds, tags, title/filename conversion)
- [x] Main process services (FileSystemService, SearchIndexService, LLMService, ConfigService)
- [x] IPC bridge and preload script
- [-] React UI (browsing, editing, search, settings)
  - [x] AppShell layout with sidebar navigation and theme support
  - [x] ArticleBrowser with article list, remark rendering, metadata header, and backlinks
  - [x] Remark plugins for wikilinks, embeds, and inline tags
  - [x] Wikilink navigation, link resolution, and tag filtering
  - [x] Browsing and navigation checkpoint passed (86 tests passing)
  - [x] ArticleEditor with CodeMirror 6 (markdown editing, save with Ctrl/Cmd+S, title input, frontmatter serialization)
  - [x] CodeMirror extensions for Obsidian syntax highlighting (wikilinks, embeds, tags, frontmatter)
  - [x] Wikilink autocomplete (triggers on `[[`, fetches article titles, inserts with closing `]]`)
  - [x] Unsaved changes handling (dirty tracking, navigation prompt, before-quit dialog)
  - [x] New article creation flow (sidebar button, duplicate title check, title validation)
  - [x] SearchPanel with debounced full-text search, highlighted match snippets, and tag-based search (`#` prefix)
  - [x] SettingsPanel (LLM endpoint/API key/model config, vault folder selector, theme picker, connection testing, secure API key storage)
- [x] LLM integration UI
  - [x] Generate Article dialog (AI-powered article generation with streaming preview, accept/cancel flow)
  - [x] LLMAssistPanel (floating panel for summarize/expand/refine on selected text with diff view)
  - [x] LLM availability handling (periodic polling, disabled controls when unavailable, classified error messages)
- [x] First-run experience and offline handling
  - [x] First-run vault selection (welcome screen with folder picker)
  - [x] Offline mode handling (network status context, offline banner, LLM availability tracking)
- [x] Application lifecycle and error handling
  - [x] Electron app lifecycle (fatal error dialogs, error logging to file, corrupted file fallback, graceful quit with unsaved changes)
  - [x] File watcher integration (vault change events via IPC, external delete/modify notifications in editor and browser)
- [x] Final integration checkpoint — all tests passing, TypeScript compilation clean across all targets

## Testing

91 tests passing across 5 test suites: markdown parser, filesystem service, search index service, remark plugins, and network status handling. TypeScript compiles cleanly for main, preload, and renderer targets.

```bash
npm test
```

## Bugfix: Select Vault Folder (Preload Path)

Fixing a duplicate `"preload"` directory segment in the BrowserWindow preload path that prevents `window.api` from being defined. See `.kiro/specs/select-vault-folder-fix/` for the full spec.

- [x] Bug condition exploration test — confirmed duplicate segment via property-based tests
- [x] Preservation property tests — baseline confirmed (3 properties pass on unfixed code)
- [x] Fix implementation — duplicate preload segment removed, all property tests pass
- [x] Final checkpoint — 96 tests passing, 0 failures

## Lumina Sidebar UI Redesign

Transforming the app into "Lumina" with an Obsidian-inspired two-part navigation: a narrow Icon Rail for view switching and an expandable/collapsible Sidebar Panel. Uses Tailwind CSS v4, shadcn/ui vendored components, and Lucide React icons. See `.kiro/specs/lumina-sidebar-ui/` for the full spec.

- [x] Install dependencies (tailwindcss, @tailwindcss/vite, lucide-react, shadcn/ui deps)
- [x] Configure Vite plugin and Tailwind CSS v4 entry point with custom color tokens
- [x] Create cn() utility function (clsx + tailwind-merge)
- [x] Vendor shadcn/ui Button component
- [x] Vendor shadcn/ui Tooltip component
- [x] Vendor shadcn/ui Sidebar component (expand/collapse with 200ms transition)
- [x] IconRail component with Lucide icons, tooltips, keyboard navigation
- [x] FilesView component (sorted article list, new/generate buttons)
- [x] SearchView component (debounced search, tag search, results display)
- [x] BookmarksView placeholder component
- [x] Refactor AppShell with SidebarProvider, IconRail, and new navigation system
- [x] Refactor ArticleBrowser to viewer-only component (article list extracted to FilesView)
- [x] Rebrand all UI references from "LLM Wiki" to "Lumina"
- [x] Apply Obsidian-inspired dark theme as default (dark class, contrast-compliant colors)
- [x] Keyboard accessibility (focus rings, Tab navigation, Enter/Space activation)

## License

MIT

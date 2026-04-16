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
- [x] Final integration checkpoint — 108 tests passing, TypeScript clean, zero diagnostics

## LLM Chat Feature

Adding a full-featured LLM chat page to Lumina with multi-turn conversation support, streaming responses, and Markdown rendering. See `.kiro/specs/llm-chat/` for the full spec.

- [x] ChatMessage and ChatSession shared type interfaces
- [x] WikiAPI chat method signatures (startChatSession, sendChatMessage, stopChatGeneration, etc.)
- [x] Property-based tests for ChatMessage/ChatSession JSON round-trip
- [x] LLMService.generateChat async generator with SSE streaming and AbortSignal
- [x] ChatService (startSession, sendMessage, stopGeneration, system prompt loading)
- [x] Property-based tests for ChatService (Properties 1–4)
- [x] Unit tests for ChatService edge cases
- [x] Chat IPC handlers (startChatSession, sendChatMessage, stopChatGeneration, getChatSession)
- [x] ChatService initialization in main process
- [x] Preload bridge chat API methods
- [x] IconRail chat icon (MessageSquare, after bookmarks)
- [x] AppShell routing for ChatView (sidebar collapse, TocPanel hidden)
- [x] IconRail chat icon unit tests (position, active state, keyboard nav)
- [x] MessageList component (bubble layout, timestamps, auto-scroll)
- [x] ChatInput component (auto-expand, Enter/Shift+Enter, stop button, offline state)
- [x] CodeBlock component (syntax highlighting, copy-to-clipboard)
- [x] ChatView main component (title bar, welcome placeholder, Markdown rendering, error display, Ctrl/Cmd+N, offline banner)
- [x] Property-based test for timestamp formatting (Property 5)
- [x] Unit tests for ChatView (welcome placeholder, error messages, display logic)
- [x] TypeScript compilation clean across all targets
- [x] Full test suite passing — 183 tests across 14 suites

## Lumina Amber Theme Migration

Migrating the color palette from purple (#7c3aed family) to amber (#D4731A family) across the entire app. Replaces CSS custom properties, Tailwind utility classes, and hardcoded hex values in all components. See `.kiro/specs/2026041704-lumina-amber-theme/` for the full spec.

- [x] Define amber palette CSS custom properties and update @theme block
- [x] Migrate CSS class accent references in styles.css
- [x] Migrate component Tailwind class references (12 components)
- [x] Replace hardcoded purple hex values in GraphView.tsx
- [x] Verify zero remaining purple references — build passes, all searches clean

## File Viewer Tabs

Restructuring the FilesView sidebar to classify vault files into Wiki and Raw categories with a tab bar, exclude config files from the file tree, and provide a Config Menu for accessing config files separately. See `.kiro/specs/2026041702-file-viewer-tabs/` for the full spec.

- [x] File classification utility module (`file-classification.ts` — classifyFile, isConfigFile, filterArticlesForTab, getConfigFiles)
- [x] TabBar inline component in FilesView (Wiki/Raw tabs with counts, keyboard nav, ARIA roles)
- [x] Tab filtering wired into file tree rendering pipeline
- [x] Per-tab folder expansion state isolation
- [x] Per-tab selection tracking for highlight restoration
- [x] Checkpoint — 223 tests passing, tabs, filtering, and state isolation verified
- [x] ConfigMenu dropdown component
- [x] Config Menu trigger in IconRail
- [x] Config Menu wired in AppShell/SidebarLayout
- [x] Tab count reactivity verified
- [x] Final checkpoint — 223 tests passing across 15 suites, zero regressions

## Fox Thinking Animation

Adding an animated geometric fox SVG loading indicator to the chat interface, replacing the plain-text "…" placeholder shown while waiting for the LLM to begin streaming. See `.kiro/specs/2026041703-fox-thinking-animation/` for the full spec.

- [x] CSS keyframe animations (breathing, ear wiggle, eye blink, eye shine, facet shimmer, glow pulse, dot bounce, label fade, reduced-motion support)
- [x] FoxThinkingIndicator SVG fox head geometry component
- [x] Glow ring, thinking dots, and thinking label (large/small variants)

## License

MIT

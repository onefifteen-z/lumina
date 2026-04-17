# Lumina

A local-first Electron desktop app providing an AI-powered personal wiki with Obsidian-compatible Markdown storage. Features a modern Obsidian-inspired UI with amber theme, graph view, LLM chat, and full offline support.

## Getting Started

```bash
git clone <repository-url>
cd prj-lumina
npm install
npm run dev
```

## Project Structure

- `src/shared/` — Shared types and Markdown parser utilities
- `src/main/` — Electron main process (services, IPC handlers)
  - `src/main/services/filesystem-service.ts` — Vault filesystem operations (scan, read, write, delete, watch, folder creation)
  - `src/main/services/search-index-service.ts` — Full-text search and tag-based filtering via FlexSearch
  - `src/main/services/llm-service.ts` — LLM provider integration (streaming generation, summarize, expand, refine, chat)
  - `src/main/services/chat-service.ts` — Multi-turn chat session management with system prompt loading
  - `src/main/services/config-service.ts` — App configuration persistence (electron-store) and secure API key storage (safeStorage)
- `src/renderer/` — React-based renderer UI
  - `src/renderer/components/AppShell.tsx` — Main layout shell with sidebar, navigation context, theme support, and resizable panels
  - `src/renderer/components/IconRail.tsx` — Narrow icon rail for view switching (files, search, bookmarks, chat, graph, settings)
  - `src/renderer/components/FilesView.tsx` — File tree with Wiki/Raw tabs, toolbar (new MD, new folder, sort, expand/collapse)
  - `src/renderer/components/SearchView.tsx` — Sidebar search with debounced full-text and tag-based search
  - `src/renderer/components/BookmarksView.tsx` — Bookmarked articles view
  - `src/renderer/components/GraphView.tsx` — Interactive wikilink graph visualization (D3 force-directed)
  - `src/renderer/components/ChatView.tsx` — LLM chat page with streaming Markdown rendering
  - `src/renderer/components/chat/` — Chat sub-components (MessageList, ChatInput, CodeBlock, FoxThinkingIndicator)
  - `src/renderer/components/ArticleBrowser.tsx` — Article viewer with remark rendering, metadata header, and backlinks
  - `src/renderer/components/ArticleEditor.tsx` — CodeMirror 6 editor with Obsidian syntax highlighting and wikilink autocomplete
  - `src/renderer/components/SettingsPanel.tsx` — LLM config, vault folder selector, theme picker, connection testing
  - `src/renderer/components/ContentToolbar.tsx` — Article action toolbar (edit, bookmark, delete)
  - `src/renderer/components/VaultSwitcher.tsx` — Multi-vault switching with history
  - `src/renderer/components/SearchPopup.tsx` — Global search popup (Cmd/Ctrl+K)
  - `src/renderer/components/ConfigMenu.tsx` — Config file access dropdown
  - `src/renderer/components/TocPanel.tsx` — Table of contents right panel
  - `src/renderer/components/ui/` — Vendored shadcn/ui components (Button, Tooltip, Sidebar)
- `src/main/ipc-handlers.ts` — IPC handler registration wiring services to renderer API
- `src/preload/` — Typed preload script exposing WikiAPI via contextBridge

## Features

### Core Wiki
- Obsidian-compatible Markdown storage with frontmatter, wikilinks, embeds, and tags
- Full-text search and tag-based filtering via FlexSearch
- Wikilink navigation, backlink resolution, and interactive graph view
- CodeMirror 6 editor with Obsidian syntax highlighting and `[[` autocomplete
- Unsaved changes handling with navigation prompts and before-quit dialogs

### Sidebar & Navigation
- Obsidian-inspired two-part navigation: narrow Icon Rail + collapsible Sidebar Panel
- File tree with Wiki/Raw tab classification and config file exclusion
- Toolbar with new MD, new folder, sort (alpha/modified), expand level, collapse all
- Bookmarks, search, chat, graph, and settings views
- Vault switcher with history and multi-vault support

### LLM Integration
- AI-powered article generation with streaming preview
- LLM assist panel for summarize/expand/refine on selected text with diff view
- Multi-turn chat with streaming responses, Markdown rendering, and code syntax highlighting
- Fox thinking animation while waiting for LLM responses
- Action bar on assistant messages (copy, regenerate, thumbs up/down)
- Configurable LLM endpoint, API key (secure storage), and model selection

### UI & Theme
- Amber color palette (#D4731A family) with Obsidian-inspired dark theme
- Tailwind CSS v4 with custom color tokens
- Resizable sidebar and right panel (TocPanel)
- Light/dark mode support
- Keyboard accessibility throughout (focus rings, Tab navigation, Enter/Space activation)

### Application Lifecycle
- First-run vault selection with welcome screen
- Offline mode handling with network status context and offline banner
- File watcher integration for external change notifications
- Fatal error dialogs, error logging to file, corrupted file fallback

## Testing

242 tests across 16 suites covering: markdown parser, filesystem service, search index service, remark plugins, network status, icon rail, file classification, chat components, and fox thinking indicator.

```bash
npm test
```

## Tech Stack

- Electron (main + renderer + preload)
- React 18 with TypeScript
- Tailwind CSS v4 + shadcn/ui (vendored)
- CodeMirror 6 (editor)
- D3.js (graph visualization)
- FlexSearch (full-text search)
- Lucide React (icons)
- Vitest + fast-check (testing)

## License

MIT

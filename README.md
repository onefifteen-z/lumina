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
- [ ] LLM integration UI
- [x] First-run experience and offline handling
  - [x] First-run vault selection (welcome screen with folder picker)
  - [x] Offline mode handling (network status context, offline banner, LLM availability tracking)

## Testing

All 91 tests passing across markdown parser, filesystem service, search index service, remark plugins, and network status handling.

```bash
npm test
```

## License

MIT

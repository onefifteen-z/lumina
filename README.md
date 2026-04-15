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
- `src/preload/` — Preload script for IPC bridge

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
- [ ] IPC bridge and preload script
- [ ] React UI (browsing, editing, search, settings)
- [ ] LLM integration UI
- [ ] First-run experience and offline handling

## Testing

All 66 tests passing across markdown parser, filesystem service, and search index service.

```bash
npm test
```

## License

MIT

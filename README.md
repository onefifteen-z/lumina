# Lumina

LLM Wiki — a local-first Electron desktop app providing an AI-powered personal wiki with Obsidian-compatible Markdown storage.

## Project Structure

- `src/shared/` — Shared types and Markdown parser utilities
- `src/main/` — Electron main process (services, IPC handlers)
  - `src/main/services/filesystem-service.ts` — Vault filesystem operations (scan, read, write, delete, watch)
- `src/renderer/` — React-based renderer UI
- `src/preload/` — Preload script for IPC bridge

## Getting Started

```bash
git clone <repository-url>
cd prj-lumina
npm install
npm run dev
```

## Testing

```bash
npm test
```

## License

MIT

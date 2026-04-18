<div align="center">

<img src="assets/icon.png" alt="Lumina" width="120" />

# Lumina

**A local-first, AI-powered personal wiki for your desktop**

*Own your knowledge. Think with AI. Never leave your machine.*

[![Electron](https://img.shields.io/badge/Electron-36.x-47848F?logo=electron&logoColor=white)](https://electronjs.org)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://typescriptlang.org)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-v4-06B6D4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-D4731A)](LICENSE)

</div>

---

Lumina is a desktop wiki that stores everything as plain Markdown files on your disk — fully compatible with Obsidian vaults — and layers AI assistance on top. Generate articles, chat with your notes, summarize or expand content, all through any LLM endpoint you control.

## ✨ Highlights

| | |
|---|---|
| **Obsidian-compatible vault** | Markdown + frontmatter, `[[wikilinks]]`, `![[embeds]]`, and tags — open your existing vault directly |
| **LLM chat & assist** | Multi-turn chat with streaming, plus inline summarize / expand / refine on any selection |
| **Instant full-text search** | FlexSearch-powered search with tag filtering, accessible via `⌘K` popup |
| **Interactive graph** | D3 force-directed wikilink graph to explore connections visually |
| **Multi-vault** | Switch between vaults instantly; each vault remembers its own settings |
| **PDF & HTML viewer** | Browse PDFs and styled HTML files directly inside the app |
| **Light & dark mode** | Amber-accented Obsidian-inspired theme with system preference support |
| **100% local** | No cloud sync, no telemetry — your notes never leave your machine |

## 🚀 Getting Started

```bash
git clone <repository-url>
cd prj-lumina
npm install
npm run dev
```

On first launch, select a folder as your vault. Lumina will watch it for changes and keep the file tree in sync.

To configure LLM features, open **Settings** and enter your endpoint URL, API key, and model name. Supports any OpenAI-compatible API including LiteLLM proxies, Gemini, and Claude.

## 🏗 Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron |
| UI | React 18 + TypeScript + Tailwind CSS v4 |
| Editor | CodeMirror 6 with Obsidian syntax theme |
| Graph | D3.js force-directed layout |
| Search | FlexSearch |
| Icons | Lucide React |
| Components | shadcn/ui (vendored) |
| Testing | Vitest + fast-check (242 tests) |

## 📂 Project Layout

```
src/
├── main/                   Electron main process
│   └── services/           FileSystem · Search · LLM · Chat · Config
├── renderer/               React UI
│   └── components/         AppShell · FilesView · ArticleBrowser · ChatView · …
├── preload/                contextBridge API surface (WikiAPI)
└── shared/                 Types + Markdown parser
assets/                     App icon (SVG + PNG)
```

## 🧪 Testing

```bash
npm test
```

242 tests across 16 suites — Markdown parser, filesystem service, search index, remark plugins, network status, file classification, chat components, and more.

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

## 📄 License

MIT

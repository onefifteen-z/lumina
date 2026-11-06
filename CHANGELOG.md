# Changelog

All notable changes to Lumina are documented here. The app shows this on first launch after each update.

## 0.8.8 — 2026-09-27

- Optional QMD semantic search for Chat `search_wiki`, for better recall on conceptual queries
- Search and semantic (QMD) indexes now refresh automatically when vault Markdown files change
- Right-click "Ingest" (and batch ingest) now starts the ingest immediately instead of briefly flashing an empty "new chat" screen
- MCP server: other agents (Cursor, Claude Code, …) can search and read your wiki and answer with their own model — over local HTTP while Lumina runs, or a stdio command that works without the app. Optional, off-by-default write and "ingest with Lumina" tools

## 0.8.7 — 2025-06-26

- "What's new" changelog popup on first launch after each update
- Batch ingest for uningested raw files in a folder, processed sequentially in chat
- Chat icon always available in the rail, even before CLAUDE.md exists

## 0.8.6 — 2025-06-26

- Deferred CLAUDE.md / INGEST.md creation — draft in the editor and save when ready
- Per-vault wiki language setting with persisted file-tree expansion state
- Provider-aware chat prompt caching for lower latency on repeat turns
- Improved `search_wiki` recall and faster ingest workflow
- Ingest status badges on raw files in the file tree

## 0.8.5 — 2025-06-20

- OpenAI File Upload ingest via Files API and Responses API for office documents
- Automatic markitdown fallback when OpenAI file upload fails
- Vault initialization via `.lumina-vault` marker instead of requiring CLAUDE.md / INGEST.md
- File-upload ingest, folder-aware article saves, and persisted panel widths
- Thinking sidebar sync fixes and batch wikilink resolution

## 0.8.4 — 2025-06-12

- Refined graph rendering with clickable source navigation
- Enhanced graph view interactions, filters, and in-page find
- First-install flow hardening with user-consent popup for Python venv setup

## 0.8.3 — 2025-06-05

- Project renamed from llm-wiki to **Lumina**
- Wiki graph view, file tree navigation, and CSP updates
- Folder refresh, empty-folder drop targets, and view-switch refresh
- Inline frontmatter editing and markdown syntax improvements

## 0.8.1 — 2025-05-28

- User guide page and welcome screen with i18n support
- PDF vision ingest settings improvements
- Live markdown preview with article editor and extensions

## 0.8.0 — 2025-05-20

- Document ingestion pipeline with templates and shell tracing
- Find-in-page and chat session renaming
- Debug logging panel and improved dev workflow
- Phoenix observability integration (optional, off by default)
- Frontmatter state management in the live editor

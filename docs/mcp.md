# Lumina MCP Server

Lets external agents such as Cursor, Claude Code and Claude Desktop query (and optionally write to) Lumina's `wiki/` over MCP, generating answers with **the caller's own model**.

## Two ways to connect

| Transport | Available when | Capabilities |
|-----------|----------------|--------------|
| **HTTP** (in the app) | Lumina is running and Settings → MCP server is enabled | All tools; shares the app's warm index (FlexSearch + QMD); `ingest_with_lumina` is only offered here |
| **stdio CLI** | Any time (the app does not need to be running) | Retrieval + optional writes; QMD reuses the index and embedding model the app already built/downloaded, read-only (it never downloads models or generates embeddings) |

### HTTP setup

Settings → **MCP server** → turn it on → Save. A bearer token is generated the first time it is enabled. Copy the HTTP snippet from the panel into `~/.cursor/mcp.json` (or another client's MCP config):

```json
{
  "mcpServers": {
    "lumina": {
      "url": "http://127.0.0.1:8765/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

If the client refuses to store a static `Authorization` header (e.g. it only accepts OAuth / `${USER_JWT}`), put the token in the URL so only a server URL is needed (the panel has a "token in URL" snippet):

```json
{ "mcpServers": { "lumina": { "url": "http://127.0.0.1:8765/mcp?token=<token>" } } }
```

### stdio setup

The CLI runs on the app's bundled Electron runtime in Node mode, so no separate Node install is needed:

```json
{
  "mcpServers": {
    "lumina": {
      "command": "/Applications/Lumina.app/Contents/MacOS/Lumina",
      "args": [
        "/Applications/Lumina.app/Contents/Resources/app.asar/dist/main/mcp/cli.js",
        "--vault", "/path/to/vault"
      ],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

CLI options:

- `--vault <path>`: the default vault (used when a tool call omits `vault`). Precedence: `--vault` > the `LUMINA_VAULT` environment variable > the vault last opened in the app. Optional when the app's vault list is non-empty.
- `--allow-write`: register the write tools (or turn on "Allow writing wiki pages" in the app; the CLI reads the same setting).
- `--user-data <dir>`: the app's userData directory (default `~/Library/Application Support/Lumina`), used to read QMD settings and the embedding model.

Development: `npm run build:main && npm run mcp -- --vault <path>` (`npm run` prints a header to stdout, so in client configs run `electron dist/main/mcp/cli.js` directly).

## Multiple vaults

Accessible vaults = the app's vault list (the vault switcher history); the CLI also includes an explicitly passed `--vault`. Any path outside that list is rejected.

- `list_vaults()` returns `[{name, path, default, initialized}]`.
- Every tool and both prompts accept an optional `vault`: a name (case-insensitive) or a full path. When omitted, the default vault is used (HTTP: the vault currently open in the app; CLI: `--vault`). Vaults with the same name must be addressed by path.
- Over HTTP, the open vault uses the app's warm index; other vaults load their own index on demand (at most 3 at once, released LRU). QMD reuses that vault's existing index and does not generate embeddings at that point.
- The write switches apply to all vaults. `ingest_with_lumina` also accepts `vault`; Lumina ingests for all vaults share one serial queue.

## Tools

| Tool | Default | Description |
|------|---------|-------------|
| `list_vaults()` | ✅ | Accessible vaults and the default vault |
| `search_wiki(query, limit?)` | ✅ | Hybrid search (BM25 + vectors) when QMD is ready, otherwise FlexSearch |
| `get_article(filename)` | ✅ | Read a page under `wiki/` (frontmatter + body); the `wiki/` prefix may be omitted |
| `list_articles(prefix?, tag?, limit?)` | ✅ | Filter by folder prefix / tag, most recently modified first |
| `get_backlinks(title)` | ✅ | Pages that `[[link]]` to the title |
| `ingest_source(path, mode?)` | ✅ | Extract a `raw/` source file (same implementation as the app; read-only) |
| `get_vault_instructions(task?, path?, question?)` | ✅ | The vault's `CLAUDE.md` (plus `INGEST.md` for `task=ingest`) mapped to the MCP tools — the same text as the matching prompt. For clients / skills without prompt support to read before writing |
| `lumina_status()` | ✅ | Vault, page count, search engine, QMD state, enabled capabilities |
| `write_wiki_page(path, content, overwrite?)` | Requires Allow write | Writes only `wiki/**.md`; existing pages need `overwrite: true` |
| `append_wiki_log(operation, title, details?)` | Requires Allow write | Appends `## [YYYY-MM-DD] op \| title` to `wiki/log.md` |
| `ingest_with_lumina(path, note?)` | Requires Allow ingest (HTTP only) | Lumina's own LLM performs the whole ingest; serialized, sends progress notifications, returns the reply and changed files |

## Prompts (the caller's model writes the answer)

MCP has no generally supported way for a server to "borrow" the caller's model (few clients support sampling), so Lumina provides prompt templates that the caller's model follows, calling the tools above:

- `answer_from_wiki(question)`: search → read → answer with `wiki/...` citations; says so when the wiki does not cover the question.
- `ingest(path)`: maps the vault's `CLAUDE.md` + `INGEST.md` onto the MCP tools (`write_wiki_page` instead of shell heredocs, etc.) so the caller's model can perform the ingest. Requires writes to be enabled.

In Cursor you can ask the agent to "answer … using lumina's answer_from_wiki", or pick the prompt in clients that support prompts.

Clients without prompt support can call the `get_vault_instructions` tool instead (`task: "ingest"` by default, or `"answer"`), which returns the same text. For example, in a third-party skill:

```markdown
1. Call lumina's `get_vault_instructions` with `{ task: "ingest", path: "<raw/ file>", vault: "<vault>" }`.
2. Follow the returned CLAUDE.md / INGEST.md exactly: `ingest_source` → `search_wiki` / `get_article` → `write_wiki_page` → update `wiki/index.md` → `append_wiki_log`.
3. Pass the same `vault` to every call.
```

## Security boundaries

- Never exposes `shell`, the API key, or chat history.
- HTTP binds to `127.0.0.1` only and requires a bearer token or `?token=` parameter (constant-time comparison), and validates Host / Origin against DNS rebinding and cross-site browser requests.
- The write and Lumina-ingest switches are off by default and take effect immediately (no restart). Regenerate invalidates the old token immediately.
- `write_wiki_page` rejects absolute paths, `..`, hidden directories, non-`.md` files and `raw/`, and checks the realpath so symlinks cannot escape `wiki/`.
- `ingest_with_lumina` only accepts existing files under `raw/` and a note of at most 500 characters; it runs serialized in a separate session (the in-app chat is unaffected) with a 20-minute timeout.

## Code layout

| File | Purpose |
|------|---------|
| `src/mcp/server-factory.ts` | Registers tools / prompts (transport-agnostic) |
| `src/mcp/vault-registry.ts` | `vault` argument resolution, on-demand loading and LRU cache |
| `src/mcp/backend.ts` | `LuminaBackend`: vault reads, search, prompt text |
| `src/mcp/wiki-write.ts` | Restricted writes and log format |
| `src/mcp/cli.ts` | stdio entry point (does not load electron) |
| `src/core/vault-runtime.ts` / `headless-config.ts` | Electron-free vault services and config parsing for the CLI |
| `src/main/services/mcp-http-service.ts` | 127.0.0.1 HTTP + auth |
| `src/main/services/mcp-app-server.ts` | In-app lifecycle and settings sync |
| `src/main/services/lumina-ingest-runner.ts` | `ingest_with_lumina` runner |

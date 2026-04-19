<div align="center">

# Contributing to Lumina

Thanks for taking the time to improve Lumina! This document explains how to
get a dev environment running, what we expect in a pull request, and how the
codebase is laid out so you can find your way around quickly.

</div>

---

## Code of Conduct

Be kind. Assume good intent. We follow the spirit of the
[Contributor Covenant](https://www.contributor-covenant.org/) — harassment,
discrimination, or personal attacks are not tolerated in issues, PRs, or
any other project space.

## Branching

- The default branch is **`main`**. Open PRs against `main`.
- Branch naming: `feat/<short-slug>`, `fix/<short-slug>`, `chore/<short-slug>`.
- Keep PRs focused — one logical change per PR makes review fast.

## Quick Start

```bash
git clone <repository-url>
cd prj-lumina
npm install
npm run dev          # renderer (Vite) + main + preload + Electron in watch mode
```

Useful scripts:

| Command | What it does |
|---|---|
| `npm run dev` | Full dev loop: Vite HMR + `tsc --watch` for main & preload + `electronmon` auto-restart on `dist/main/**` and `dist/preload/**` changes |
| `npm test` | Run the Vitest suite once |
| `npm test -- --watch` | TDD loop |
| `npx tsc --noEmit` | Type-check the whole project (CI gate) |
| `npm run build` | Build renderer, main, and preload bundles |
| `npm run build:mac` | Produce a `.dmg` via `electron-builder` |

> Saving any file under `src/main/**` or `src/preload/**` is enough — the
> watcher recompiles into `dist/**` and `electronmon` restarts the Electron
> process automatically. Renderer changes hot-reload through Vite. You should
> not need to run `build:renderer` / `build:main` manually during development.

## Project Layout

```
src/
├── main/                   Electron main process
│   ├── ipc-handlers.ts     All wiki:* IPC channel registrations
│   └── services/           FileSystem · Search · LLM · Chat · Config · ChatHistory
├── renderer/               React UI (runs in BrowserWindow)
│   ├── components/         AppShell · FilesView · ArticleBrowser · ChatView · …
│   ├── components/chat/    ThinkingChip · FoxThinkingIndicator · MessageList · …
│   ├── extensions/         CodeMirror extensions (wikilink autocomplete, …)
│   ├── hooks/              useNetworkStatus, etc.
│   └── lib/                Pure helpers (file-classification, utils)
├── preload/                contextBridge API surface (WikiAPI)
└── shared/                 Types + Markdown parser shared by main & renderer
assets/                     App icon (SVG + PNG) + loading mock
```

### Process boundaries

- **Renderer** code never imports from `src/main/**` directly. All privileged
  operations go through `window.api.*`, which is defined in
  [`src/preload/preload.ts`](src/preload/preload.ts).
- **Main** code never imports from `src/renderer/**`. Cross-cutting types live
  in [`src/shared/types.ts`](src/shared/types.ts).
- When you add a new capability:
  1. Add a method to `WikiAPI` in `src/shared/types.ts`.
  2. Implement it in the relevant service under `src/main/services/`.
  3. Register an `ipcMain.handle("wiki:…")` channel in
     `src/main/ipc-handlers.ts`.
  4. Wire it through `src/preload/preload.ts`.
  5. Call it from the renderer via `window.api.<method>()`.

## Coding Conventions

- **Language**: TypeScript everywhere. No `any` unless you justify it in a
  comment. Prefer `unknown` + narrowing.
- **React**: function components with hooks. Keep components small; lift
  state up; memoize expensive trees with `useMemo` / `React.memo`.
- **Styling**: Tailwind v4 utility classes. Reuse existing tokens
  (`bg-primary-bg`, `text-text-secondary`, `border-border`, …) instead of
  hard-coded colors. New tokens go through `src/renderer/styles.css` /
  the Tailwind config.
- **Filesystem & paths**: vault-relative paths use POSIX separators (`/`).
  Always validate paths against escape (`..`) and reserved directories
  (`.lumina`, `.lumina-vault`) — see `FileSystemService.resolveUnderVault`
  for the canonical pattern.
- **Comments**: only when they explain *why*. Don't narrate code.
- **Imports**: prefer named imports; avoid default exports for utilities.
- **Errors**: surface user-facing errors via `window.alert` or inline UI;
  log developer-facing details via `console.error`.

## Testing

We use **Vitest** (with **fast-check** for property tests). The current suite
is **248 tests across 16 files**, and we expect it to stay green on every PR.

```bash
npm test                                   # whole suite
npm test -- --run path/to/file.test.ts     # one file
npm test -- --watch                        # TDD loop
```

Guidelines:

- **Unit-test pure logic** (parsers, classifiers, helpers) directly.
- **Service tests** spin up a temp directory under `os.tmpdir()` — see
  [`filesystem-service.test.ts`](src/main/services/filesystem-service.test.ts).
- **Component logic** is tested without a DOM by calling the component as a
  function and walking the returned React element tree — see
  [`FoxThinkingIndicator.test.ts`](src/renderer/components/chat/FoxThinkingIndicator.test.ts).
- New filesystem mutations **must** include happy-path + path-traversal
  rejection tests.
- New IPC channels **must** include a smoke test in the relevant service test
  file (we don't test through Electron itself).

## Pull Request Checklist

Before opening a PR:

- [ ] `npx tsc --noEmit` passes.
- [ ] `npm test` is green.
- [ ] New behavior has tests (or a clear note explaining why it can't).
- [ ] No stray `console.log` / debugger statements.
- [ ] Renderer ⇄ main boundary respected (no cross-imports).
- [ ] Tailwind tokens used for theme colors (no raw hex unless intentional).
- [ ] User-visible changes mentioned in the PR description with a screenshot
      or short clip when UI is involved.

PR titles follow conventional-commit style where practical, e.g.:

- `feat(files): drag and drop to reorganize folders`
- `fix(chat): preserve fox icon on Thinking chip when minimized`
- `refactor(ipc): extract refreshArticlesIndex helper`

## Reporting Bugs

Open an issue with:

1. OS + version, Electron/Node version (from `npm run dev` startup logs).
2. Vault size order of magnitude (rough file count).
3. Reproduction steps and observed vs. expected behavior.
4. Console / terminal logs (renderer DevTools + main process stdout).

## Suggesting Features

We're a local-first app — every new feature is weighed against:

- **Privacy**: nothing should phone home or leak vault contents.
- **Vault portability**: data stays as plain Markdown / standard files.
- **Performance**: cold-load and search must stay snappy on large vaults.

If your idea fits those three, please open an issue describing the use case
before sending a large PR.

## Maintainers

| Name | GitHub | Role |
|---|---|---|
| Yunjie Zhang | — | Original author & maintainer |

If you're a regular contributor and would like to be listed here, mention it
in your PR.

## License

By contributing, you agree that your contributions will be licensed under
the [MIT License](LICENSE) that covers the project.

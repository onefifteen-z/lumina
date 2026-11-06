import * as path from "path";
import * as fs from "fs/promises";

/**
 * Candidate on-disk paths for a bundled template file, first hit wins.
 * No `electron` import: the stdio MCP CLI loads this under ELECTRON_RUN_AS_NODE.
 *
 * - Packaged: `process.resourcesPath/templates/` — the `extraResources`
 *   mapping copies `assets/templates → templates`.
 * - Dev: main compiles to `dist/main/main/services/`, so four levels up is the
 *   repo root (or `app.asar` when packaged, whose sibling is `templates/`).
 * - cwd-relative for unusual run contexts (e.g. tests).
 */
function templateCandidates(basename: string): string[] {
  const candidates: string[] = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "templates", basename));
  }
  const fourUp = path.resolve(__dirname, "..", "..", "..", "..");
  candidates.push(path.join(fourUp, "assets", "templates", basename));
  candidates.push(path.join(path.dirname(fourUp), "templates", basename));
  candidates.push(path.join(process.cwd(), "assets", "templates", basename));
  return candidates;
}

/** Read a bundled template by basename. Returns null if missing/unreadable. */
export async function readTemplate(basename: string): Promise<string | null> {
  const candidates = templateCandidates(basename);

  for (const p of candidates) {
    try {
      return await fs.readFile(p, "utf-8");
    } catch {
      // try next
    }
  }
  return null;
}

/** Convenience: read the bundled CLAUDE.md system-prompt template. */
export function readClaudeMdTemplate(): Promise<string | null> {
  return readTemplate("CLAUDE.md");
}

/**
 * Convenience: read the bundled INGEST.md template.
 *
 * Used when the vault has no non-empty INGEST.md. The resolved ingest
 * protocol is concatenated onto the CLAUDE.md system prompt.
 */
export function readIngestMdTemplate(): Promise<string | null> {
  return readTemplate("INGEST.md");
}

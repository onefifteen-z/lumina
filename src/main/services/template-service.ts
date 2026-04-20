import { app } from "electron";
import * as path from "path";
import * as fs from "fs/promises";

/**
 * Resolve the on-disk path for a bundled template file.
 *
 * Dev: read from `assets/templates/` next to the project root (cwd-based,
 *      since electron's main process runs with cwd = project root in dev).
 * Prod: read from `process.resourcesPath/templates/` — which matches the
 *       `extraResources` mapping in package.json that copies
 *       `assets/templates → templates`.
 */
function resolveTemplatePath(basename: string): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "templates", basename);
  }
  // In dev, walk up from compiled main file to repo root. main.ts compiles to
  // `dist/main/main/main.js`, so going up 3 levels lands on the repo root in
  // both `npm run dev` (electronmon) and direct `electron .` invocations.
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  return path.join(repoRoot, "assets", "templates", basename);
}

/** Read a bundled template by basename. Returns null if missing/unreadable. */
export async function readTemplate(basename: string): Promise<string | null> {
  const candidates = [resolveTemplatePath(basename)];
  // Belt-and-suspenders: also try cwd-relative for unusual run contexts (e.g.
  // tests that don't go through electron). First hit wins.
  candidates.push(path.join(process.cwd(), "assets", "templates", basename));

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
 * INGEST.md is the protocol the model follows when CLAUDE.md tells it to
 * ingest a source. We always concatenate it onto the CLAUDE.md system
 * prompt so the model has both the wiki workflow ("what to do") and the
 * extraction protocol ("how to get content out") in one place.
 */
export function readIngestMdTemplate(): Promise<string | null> {
  return readTemplate("INGEST.md");
}

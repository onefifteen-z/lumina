import * as fs from "fs/promises";
import * as path from "path";

export const WIKI_DIR = "wiki";
export const WIKI_LOG_FILE = `${WIKI_DIR}/log.md`;
/** Upper bound for a single page written through MCP. */
export const MAX_WIKI_PAGE_CHARS = 500_000;

export class WikiPathError extends Error {}

/**
 * Normalise a caller-supplied path to a vault-relative `wiki/**.md` path.
 * Accepts `wiki/foo.md` or `foo.md` (assumed under wiki/). Rejects anything
 * that escapes wiki/ or is not markdown.
 */
export function normalizeWikiPagePath(input: string): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new WikiPathError("path is required");
  }
  const slashed = input.trim().replace(/\\/g, "/");
  if (slashed.startsWith("/") || /^[a-zA-Z]:/.test(slashed)) {
    throw new WikiPathError("path must be relative to the vault (e.g. wiki/topics/foo.md)");
  }
  const segments = slashed.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new WikiPathError("path must not contain '..'");
  }
  if (segments.some((s) => s.startsWith("."))) {
    throw new WikiPathError("hidden files and folders are not writable");
  }
  if (segments[0] === "raw") throw new WikiPathError("raw/ is read-only");
  if (segments[0] !== WIKI_DIR) segments.unshift(WIKI_DIR);
  if (segments.length < 2) throw new WikiPathError("path must name a file under wiki/");
  const rel = segments.join("/");
  if (!rel.toLowerCase().endsWith(".md")) {
    throw new WikiPathError("only markdown (.md) pages can be written");
  }
  return rel;
}

async function assertInsideWiki(vaultRoot: string, absPath: string): Promise<void> {
  const wikiRoot = path.join(vaultRoot, WIKI_DIR);
  // Resolve symlinks on the nearest existing ancestor so a linked folder can't escape wiki/.
  let probe = path.dirname(absPath);
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      const realWiki = await fs.realpath(wikiRoot).catch(() => wikiRoot);
      if (real !== realWiki && !real.startsWith(realWiki + path.sep)) {
        throw new WikiPathError("path resolves outside wiki/");
      }
      return;
    } catch (err) {
      if (err instanceof WikiPathError) throw err;
      const parent = path.dirname(probe);
      if (parent === probe) return;
      probe = parent;
    }
  }
}

export type WriteWikiPageResult = { path: string; created: boolean; bytes: number };

export async function writeWikiPage(
  vaultRoot: string,
  inputPath: string,
  content: string,
  overwrite = false,
): Promise<WriteWikiPageResult> {
  const rel = normalizeWikiPagePath(inputPath);
  if (typeof content !== "string") throw new WikiPathError("content must be a string");
  if (content.length > MAX_WIKI_PAGE_CHARS) {
    throw new WikiPathError(`content exceeds ${MAX_WIKI_PAGE_CHARS} characters`);
  }
  const abs = path.join(vaultRoot, rel);
  await assertInsideWiki(vaultRoot, abs);
  let exists = true;
  try {
    await fs.access(abs);
  } catch {
    exists = false;
  }
  if (exists && !overwrite) {
    throw new WikiPathError(`${rel} already exists; pass overwrite: true to replace it`);
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const body = content.endsWith("\n") ? content : `${content}\n`;
  await fs.writeFile(abs, body, "utf-8");
  return { path: rel, created: !exists, bytes: Buffer.byteLength(body) };
}

export type WikiLogEntry = {
  /** e.g. ingest, query, lint. */
  operation?: string;
  title: string;
  details?: string;
};

export function formatWikiLogEntry(entry: WikiLogEntry, now = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  const op = (entry.operation ?? "ingest").trim().replace(/[\r\n|]+/g, " ") || "ingest";
  const title = entry.title.trim().replace(/[\r\n]+/g, " ");
  if (!title) throw new WikiPathError("title is required");
  const details = entry.details?.trim();
  return `## [${date}] ${op} | ${title}\n${details ? `\n${details}\n` : ""}`;
}

export async function appendWikiLog(
  vaultRoot: string,
  entry: WikiLogEntry,
  now = new Date(),
): Promise<{ path: string }> {
  const abs = path.join(vaultRoot, WIKI_LOG_FILE);
  await assertInsideWiki(vaultRoot, abs);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  let prefix = "";
  try {
    const existing = await fs.readFile(abs, "utf-8");
    if (existing.length > 0) prefix = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  } catch {
    prefix = "# Log\n\n";
  }
  await fs.appendFile(abs, prefix + formatWikiLogEntry(entry, now), "utf-8");
  return { path: WIKI_LOG_FILE };
}

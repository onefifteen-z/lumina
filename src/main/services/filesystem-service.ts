import * as fs from "fs/promises";
import * as path from "path";
import { watch, type FSWatcher } from "fs";
import type {
  ArticleMeta,
  ArticleFile,
  BookmarksFile,
  VaultChangeEvent,
} from "../../shared/types";
import {
  parseArticleFile,
  serializeArticleFile,
  extractWikilinks,
  extractTags,
  titleToFilename as sharedTitleToFilename,
  filenameToTitle as sharedFilenameToTitle,
} from "../../shared/markdown-parser";

const BOOKMARKS_RELATIVE = path.join(".lumina", "bookmarks.json");

/**
 * Pull raw-source references out of an article's frontmatter. Accepts:
 *   - `source: "raw/foo.pdf"` (singular string)
 *   - `sources: "raw/foo.pdf"` (single string under plural key)
 *   - `sources: ["raw/a.pdf", "raw/b.pdf"]` (array of strings)
 *
 * Non-string entries (objects, numbers, …) are silently dropped — they're
 * already shown as JSON by the property panel, and surfacing them as
 * bogus ingest matches would be worse than ignoring them.
 *
 * Exported only for unit tests.
 */
export function extractFrontmatterSources(
  frontmatter: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  const pushIfString = (v: unknown): void => {
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  };
  // Plural wins when both are present; singular is a legacy convenience.
  const plural = frontmatter.sources;
  const singular = frontmatter.source;
  if (Array.isArray(plural)) {
    for (const item of plural) pushIfString(item);
  } else if (typeof plural === "string") {
    pushIfString(plural);
  }
  if (Array.isArray(singular)) {
    for (const item of singular) pushIfString(item);
  } else if (typeof singular === "string") {
    pushIfString(singular);
  }
  return out;
}

export class FileSystemService {
  private vaultPath: string;
  private watcher: FSWatcher | null = null;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
  }

  /**
   * Recursively find all files in the vault, parse .md files fully,
   * and return lightweight ArticleMeta[] for indexing/listing.
   * Non-markdown files get minimal metadata (title = basename, empty fields).
   */
  async scanVault(): Promise<ArticleMeta[]> {
    const allFiles = await this.findAllFiles(this.vaultPath);
    const results: ArticleMeta[] = [];

    for (const filePath of allFiles) {
      try {
        const filename = path.relative(this.vaultPath, filePath).replace(/\\/g, "/");

        if (filePath.toLowerCase().endsWith(".md")) {
          const raw = await fs.readFile(filePath, "utf-8");
          const article = parseArticleFile(raw);
          const wikilinks = extractWikilinks(article.content).map(
            (w) => w.target,
          );
          const tags = extractTags(article);
          const normalisedBody = article.content.replace(/\s+/g, " ").trim();
          const excerpt = normalisedBody.slice(0, 200);
          // Larger slice fed only to the search index so queries can match
          // terms that live past the 200-char preview. Capped to keep memory
          // bounded across a large (many-page) vault.
          const searchBody = normalisedBody.slice(0, 2000);
          // Pull raw-source references from frontmatter. We accept both
          // singular `source` (single string) and plural `sources` (array
          // or string) so authors using either convention get the same
          // "ingested" badge. Non-string entries are dropped silently —
          // they're already shown as JSON by the property panel, and
          // surfacing them as bogus ingest matches would be worse.
          const sources = extractFrontmatterSources(article.frontmatter);

          results.push({
            title: article.frontmatter.title || sharedFilenameToTitle(filename),
            filename,
            tags,
            created: article.frontmatter.created,
            modified: article.frontmatter.modified,
            wikilinks,
            excerpt,
            searchBody,
            ...(sources.length > 0 ? { sources } : {}),
          });
        } else {
          // Non-markdown: minimal metadata, title is the basename with extension
          results.push({
            title: path.basename(filename),
            filename,
            tags: [],
            created: "",
            modified: "",
            wikilinks: [],
            excerpt: "",
          });
        }
      } catch (err) {
        console.warn(`Skipping file ${filePath}:`, err);
      }
    }

    return results;
  }

  /**
   * Read a single article by filename (relative to vault root).
   */
  async readArticle(filename: string): Promise<ArticleFile> {
    const filePath = path.join(this.vaultPath, filename);
    const raw = await fs.readFile(filePath, "utf-8");
    return parseArticleFile(raw);
  }

  /**
   * Read raw file content without parsing. Used as fallback for corrupted files.
   */
  async readRawFile(filename: string): Promise<string> {
    const filePath = path.join(this.vaultPath, filename);
    return fs.readFile(filePath, "utf-8");
  }

  /**
   * Write a literal file to disk inside the vault — bypassing frontmatter
   * serialization. Used for files that aren't articles (e.g. an empty
   * CLAUDE.md slot the user is about to fill in).
   */
  async writeRawFile(filename: string, content: string): Promise<void> {
    const filePath = path.join(this.vaultPath, filename);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
  }

  /** Absolute path to the vault root (used to scope shell commands). */
  getVaultPath(): string {
    return this.vaultPath;
  }

  /**
   * Write an article to disk. Updates the `modified` timestamp before saving.
   * @param targetFolder Optional vault-relative folder (e.g. "wiki/notes") to place the file in.
   */
  async writeArticle(article: ArticleFile, targetFolder?: string): Promise<void> {
    article.frontmatter.modified = new Date().toISOString();
    const serialized = serializeArticleFile(article);
    const basename = sharedTitleToFilename(article.frontmatter.title) + ".md";
    const filename = targetFolder ? `${targetFolder}/${basename}` : basename;
    const filePath = path.join(this.vaultPath, filename);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, serialized, "utf-8");
  }

  /**
   * Delete an article file from the vault.
   */
  async deleteArticle(filename: string): Promise<void> {
    const filePath = path.join(this.vaultPath, filename);
    await fs.unlink(filePath);
  }

  /**
   * Check whether a file exists in the vault.
   */
  async fileExists(filename: string): Promise<boolean> {
    const filePath = path.join(this.vaultPath, filename);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  titleToFilename(title: string): string {
    return sharedTitleToFilename(title);
  }

  filenameToTitle(filename: string): string {
    return sharedFilenameToTitle(filename);
  }

  private bookmarksAbsolutePath(): string {
    return path.join(this.vaultPath, BOOKMARKS_RELATIVE);
  }

  /**
   * Read bookmarked article filenames from `.lumina/bookmarks.json`.
   * Returns [] if missing, unreadable, or invalid.
   */
  async getBookmarks(): Promise<string[]> {
    const abs = this.bookmarksAbsolutePath();
    try {
      const raw = await fs.readFile(abs, "utf-8");
      const data = JSON.parse(raw) as unknown;
      if (
        data &&
        typeof data === "object" &&
        Array.isArray((data as BookmarksFile).filenames)
      ) {
        return (data as BookmarksFile).filenames.filter(
          (f): f is string => typeof f === "string",
        );
      }
      console.warn("Invalid bookmarks.json shape; expected { filenames: string[] }");
      return [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      console.warn("Failed to read bookmarks.json:", err);
      return [];
    }
  }

  /**
   * Atomically replace vault bookmarks JSON.
   */
  async setBookmarks(filenames: string[]): Promise<void> {
    const abs = this.bookmarksAbsolutePath();
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const payload: BookmarksFile = {
      version: 1,
      filenames: [...filenames],
    };
    await fs.writeFile(abs, JSON.stringify(payload, null, 2), "utf-8");
  }

  /**
   * Watch the vault folder for external file changes and emit VaultChangeEvents.
   */
  watchVault(callback: (event: VaultChangeEvent) => void): void {
    if (this.watcher) {
      this.watcher.close();
    }

    this.watcher = watch(
      this.vaultPath,
      { recursive: true },
      (eventType, rawFilename) => {
        if (
          !rawFilename ||
          rawFilename === ".lumina-vault" ||
          rawFilename.endsWith("/.lumina-vault")
        )
          return;
        // allow all file types through

        const filename = rawFilename.replace(/\\/g, "/");

        if (eventType === "rename") {
          // "rename" fires for both add and delete — check if file exists
          const filePath = path.join(this.vaultPath, filename);
          fs.access(filePath)
            .then(() => callback({ type: "add", filename }))
            .catch(() => callback({ type: "unlink", filename }));
        } else if (eventType === "change") {
          callback({ type: "change", filename });
        }
      },
    );
  }

  /**
   * Stop watching the vault.
   */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /** Create a folder inside the vault. */
  async createFolder(relativePath: string): Promise<void> {
    const abs = path.join(this.vaultPath, relativePath);
    await fs.mkdir(abs, { recursive: true });
  }

  /**
   * True if the vault has been initialized, signalled by the presence of the
   * `.lumina-vault` marker file at the vault root. The marker is written only
   * after `raw/`+`wiki/` are scaffolded (see the vault-init flow), so it is an
   * explicit "initialization complete" flag rather than a content heuristic.
   * Used to decide whether to show the vault-init prompt. We no longer key off
   * a CLAUDE.md file because CLAUDE.md is not created during initialization.
   */
  async isVaultInitialized(): Promise<boolean> {
    try {
      const st = await fs.stat(path.join(this.vaultPath, ".lumina-vault"));
      return st.isFile();
    } catch {
      return false;
    }
  }

  /**
   * Wiki / Raw folder paths that exist on disk but have no vault files
   * anywhere under them (so they would not appear in the file tree from
   * `scanVault` alone). Used to show empty folders after "New folder".
   */
  async listEmptyWikiRawFolders(): Promise<string[]> {
    const relPaths = await this.findAllRelativeFilePaths();
    return this.collectEmptyWikiRawFolderPaths(relPaths);
  }

  private async findAllRelativeFilePaths(): Promise<string[]> {
    const absPaths = await this.findAllFiles(this.vaultPath);
    return absPaths.map((p) => path.relative(this.vaultPath, p).replace(/\\/g, "/"));
  }

  /** True if any indexed file path lies strictly under `dirRel` (POSIX). */
  private hasDescendantFile(dirRel: string, fileRelPaths: readonly string[]): boolean {
    const norm = dirRel.replace(/\\/g, "/").replace(/\/+$/, "");
    const prefix = `${norm}/`;
    return fileRelPaths.some((f) => f.startsWith(prefix));
  }

  private async collectEmptyWikiRawFolderPaths(fileRelPaths: readonly string[]): Promise<string[]> {
    const roots = ["wiki", "raw"];
    const acc: string[] = [];
    for (const root of roots) {
      await this.walkCollectEmptyDirs(root, fileRelPaths, acc);
    }
    return acc;
  }

  private async walkCollectEmptyDirs(
    rel: string,
    fileRelPaths: readonly string[],
    acc: string[],
  ): Promise<void> {
    const abs = path.join(this.vaultPath, rel);
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".")) continue;
      const child = `${rel}/${e.name}`.replace(/\\/g, "/");
      await this.walkCollectEmptyDirs(child, fileRelPaths, acc);
      if (!this.hasDescendantFile(child, fileRelPaths)) {
        acc.push(child);
      }
    }
  }

  /**
   * Move a file or folder to another folder inside the vault (basename preserved).
   * Paths are vault-relative POSIX (`wiki/Note.md`, `wiki/notes`).
   */
  async moveVaultEntry(fromRelative: string, toDirRelative: string): Promise<void> {
    const fromNorm = fromRelative.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!fromNorm) throw new Error("Invalid source path");
    if (fromNorm.split("/").some((s) => s === "..")) {
      throw new Error("Invalid source path");
    }

    const toDirNorm = toDirRelative
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
    if (toDirNorm.split("/").some((s) => s === "..")) {
      throw new Error("Invalid target folder");
    }

    if (this.pathTouchesReserved(fromNorm) || this.pathTouchesReserved(toDirNorm)) {
      throw new Error("Cannot move items into or from reserved paths");
    }

    const fromAbs = this.resolveUnderVault(fromNorm);
    const toDirAbs =
      toDirNorm === ""
        ? path.resolve(this.vaultPath)
        : this.resolveUnderVault(toDirNorm);

    const base = path.basename(fromNorm);
    const destAbs = path.join(toDirAbs, base);

    if (path.resolve(fromAbs) === path.resolve(destAbs)) return;

    const fromResolved = path.resolve(fromAbs);
    const destResolved = path.resolve(destAbs);
    if (destResolved.startsWith(fromResolved + path.sep)) {
      throw new Error("Cannot move a folder into itself");
    }

    await fs.mkdir(toDirAbs, { recursive: true });

    try {
      await fs.access(destAbs);
      throw new Error("A file or folder with that name already exists here");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    try {
      await fs.rename(fromAbs, destAbs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EXDEV") {
        await fs.cp(fromAbs, destAbs, { recursive: true });
        await fs.rm(fromAbs, { recursive: true, force: true });
      } else {
        throw err;
      }
    }
  }

  /**
   * Copy files or folders from absolute OS paths into a vault folder.
   * Sources already inside the vault are moved instead.
   */
  async importExternalEntries(
    absolutePaths: string[],
    toDirRelative: string,
  ): Promise<void> {
    const toDirNorm = toDirRelative
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
    if (!toDirNorm) throw new Error("Choose a folder inside the vault");
    if (toDirNorm.split("/").some((s) => s === "..")) {
      throw new Error("Invalid target folder");
    }
    if (this.pathTouchesReserved(toDirNorm)) {
      throw new Error("Cannot import into reserved paths");
    }

    const toDirAbs = this.resolveUnderVault(toDirNorm);
    await fs.mkdir(toDirAbs, { recursive: true });
    const vaultRoot = path.resolve(this.vaultPath);

    for (const rawSrc of absolutePaths) {
      const srcAbs = path.resolve(rawSrc);
      if (srcAbs === vaultRoot) continue;

      if (srcAbs.startsWith(vaultRoot + path.sep)) {
        const inner = path.relative(vaultRoot, srcAbs).replace(/\\/g, "/");
        if (!inner || inner.startsWith("..")) continue;
        if (this.pathTouchesReserved(inner)) continue;
        await this.moveVaultEntry(inner, toDirNorm);
        continue;
      }

      const base = path.basename(srcAbs);
      const destAbs = await this.uniqueDestPath(toDirAbs, base);
      const st = await fs.stat(srcAbs);
      if (st.isDirectory()) {
        await fs.cp(srcAbs, destAbs, { recursive: true, errorOnExist: true });
      } else if (st.isFile()) {
        await fs.copyFile(srcAbs, destAbs);
      }
    }
  }

  private pathTouchesReserved(rel: string): boolean {
    return rel.split("/").some(
      (s) => s === ".lumina" || s === ".lumina-vault",
    );
  }

  private resolveUnderVault(rel: string): string {
    const norm = rel.replace(/\\/g, "/").replace(/^\/+/, "");
    if (norm.split("/").some((s) => s === "..")) {
      throw new Error("Invalid path");
    }
    const abs = path.resolve(path.join(this.vaultPath, norm));
    const root = path.resolve(this.vaultPath);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error("Path escapes vault");
    }
    return abs;
  }

  private async uniqueDestPath(destDir: string, base: string): Promise<string> {
    const ext = path.extname(base);
    const stem = path.basename(base, ext);
    let candidate = path.join(destDir, base);
    let i = 1;
    for (;;) {
      try {
        await fs.access(candidate);
        candidate = path.join(destDir, `${stem} (${i})${ext}`);
        i++;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return candidate;
        throw err;
      }
    }
  }

  /**
   * Recursively find all files under a directory (any extension).
   * Skips the .lumina-vault marker file only.
   */
  private async findAllFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === ".lumina-vault") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = await this.findAllFiles(fullPath);
        results.push(...nested);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }

    return results;
  }
}

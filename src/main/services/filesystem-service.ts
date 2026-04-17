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
          const excerpt = article.content
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 200);

          results.push({
            title: article.frontmatter.title || sharedFilenameToTitle(filename),
            filename,
            tags,
            created: article.frontmatter.created,
            modified: article.frontmatter.modified,
            wikilinks,
            excerpt,
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
   * Write an article to disk. Updates the `modified` timestamp before saving.
   */
  async writeArticle(article: ArticleFile): Promise<void> {
    article.frontmatter.modified = new Date().toISOString();
    const serialized = serializeArticleFile(article);
    const filename = sharedTitleToFilename(article.frontmatter.title) + ".md";
    const filePath = path.join(this.vaultPath, filename);
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

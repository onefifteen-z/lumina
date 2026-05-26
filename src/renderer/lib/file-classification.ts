import type { ArticleMeta } from "../../shared/types";

export type FileCategory = "wiki" | "raw";

/**
 * Classify a vault-relative filename as Wiki or Raw based on top-level folder.
 *
 * Wiki: file lives under a "wiki/" top-level folder (case-insensitive).
 * Raw:  file lives under a "RAW/" top-level folder (case-insensitive).
 *
 * Anything not under "wiki/" is treated as Raw — this matches how the
 * sidebar buckets files and keeps the highlight on the same tab the user
 * is looking at when an out-of-band navigation (wikilink, search, graph)
 * targets a file that doesn't live under wiki/.
 */
export function classifyFilename(filename: string): FileCategory {
  const topFolder = filename.split("/")[0]?.toLowerCase() ?? "";
  return topFolder === "wiki" ? "wiki" : "raw";
}

/** Convenience wrapper for callers that already have an ArticleMeta. */
export function classifyFile(meta: ArticleMeta): FileCategory {
  return classifyFilename(meta.filename);
}

/**
 * Check if a filename represents a config file.
 * Returns true if the basename starts with '.' or any directory segment starts with '.'.
 */
export function isConfigFile(filename: string): boolean {
  const segments = filename.split("/");
  return segments.some((segment) => segment.startsWith("."));
}

/**
 * Filter articles for a given tab, excluding config files, then filtering by folder.
 *
 * Wiki tab: files under the "wiki/" top-level folder.
 * Raw tab:  files under the "RAW/" top-level folder.
 */
export function filterArticlesForTab(
  articles: ArticleMeta[],
  tab: FileCategory,
): ArticleMeta[] {
  const folderName = tab === "wiki" ? "wiki" : "raw";
  return articles.filter(
    (article) =>
      !isConfigFile(article.filename) &&
      article.filename.split("/")[0].toLowerCase() === folderName,
  );
}

/**
 * Extract only CLAUDE.md from the article list for the config menu.
 */
export function getConfigFiles(articles: ArticleMeta[]): ArticleMeta[] {
  return articles.filter((article) => {
    const basename = article.filename.split("/").pop() ?? article.filename;
    return basename.toUpperCase() === "CLAUDE.MD";
  });
}

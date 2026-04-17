import type { ArticleMeta } from "../../shared/types";

export type FileCategory = "wiki" | "raw";

/**
 * Classify an ArticleMeta as Wiki or Raw based on top-level folder.
 *
 * Wiki: file lives under a "wiki/" top-level folder (case-insensitive).
 * Raw:  file lives under a "RAW/" top-level folder (case-insensitive).
 */
export function classifyFile(meta: ArticleMeta): FileCategory {
  const topFolder = meta.filename.split("/")[0].toLowerCase();
  return topFolder === "wiki" ? "wiki" : "raw";
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

import type { ArticleMeta } from "../../shared/types";

export type FileCategory = "wiki" | "raw";

/**
 * Classify an ArticleMeta as Wiki or Raw based on frontmatter richness.
 *
 * Wiki: non-empty title AND at least one of:
 *   - non-empty tags array
 *   - non-empty wikilinks array
 *   - both created and modified are non-empty strings
 */
export function classifyFile(meta: ArticleMeta): FileCategory {
  const hasTitle = meta.title.length > 0;
  if (!hasTitle) return "raw";

  const hasTags = meta.tags.length > 0;
  const hasWikilinks = meta.wikilinks.length > 0;
  const hasTimestamps = meta.created.length > 0 && meta.modified.length > 0;

  if (hasTags || hasWikilinks || hasTimestamps) {
    return "wiki";
  }

  return "raw";
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
 * Filter articles for a given tab, excluding config files, then filtering by classification.
 */
export function filterArticlesForTab(
  articles: ArticleMeta[],
  tab: FileCategory,
): ArticleMeta[] {
  return articles.filter(
    (article) =>
      !isConfigFile(article.filename) && classifyFile(article) === tab,
  );
}

/**
 * Extract config files from the article list.
 */
export function getConfigFiles(articles: ArticleMeta[]): ArticleMeta[] {
  return articles.filter((article) => isConfigFile(article.filename));
}

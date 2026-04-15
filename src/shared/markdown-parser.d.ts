import type { FrontmatterData, ArticleFile, WikilinkRef, EmbedRef } from "./types";
/**
 * Parse YAML frontmatter from a raw Markdown string.
 * Returns the extracted data and the body content after the frontmatter block.
 */
export declare function parseFrontmatter(raw: string): {
    data: FrontmatterData;
    content: string;
};
/**
 * Serialize frontmatter data and body content into a valid Markdown string
 * with a YAML frontmatter block.
 */
export declare function serializeFrontmatter(data: FrontmatterData, content: string): string;
/**
 * Parse a full article file (frontmatter + body) into an ArticleFile.
 * Stores rawContent for round-trip fidelity.
 */
export declare function parseArticleFile(raw: string): ArticleFile;
/**
 * Serialize an ArticleFile back to a Markdown string with YAML frontmatter.
 * Uses gray-matter's stringify for consistent output.
 */
export declare function serializeArticleFile(article: ArticleFile): string;
/**
 * Extract all wikilinks ([[Target]] and [[Target|Alias]]) from Markdown content.
 * Skips links inside code blocks.
 */
export declare function extractWikilinks(content: string): WikilinkRef[];
/**
 * Extract all embeds (![[Target]]) from Markdown content.
 * Skips embeds inside code blocks.
 */
export declare function extractEmbeds(content: string): EmbedRef[];
/**
 * Extract all tags from an ArticleFile.
 * Collects from both frontmatter `tags` array and inline `#tag` in the body.
 * Skips tags inside code blocks. Returns deduplicated array.
 */
export declare function extractTags(article: ArticleFile): string[];
/**
 * Convert an article title to a filesystem-safe filename (without extension).
 *
 * - Replaces spaces with hyphens
 * - Strips characters that are not alphanumeric, hyphens, underscores, or dots
 * - Handles unicode by keeping unicode letters/digits
 * - Collapses consecutive hyphens
 * - Truncates to MAX_FILENAME_LENGTH
 * - Handles Windows reserved names by appending an underscore
 * - Deterministic: same input always produces same output
 */
export declare function titleToFilename(title: string): string;
/**
 * Convert a filename back to a human-readable title.
 * Strips the `.md` extension and replaces hyphens with spaces.
 */
export declare function filenameToTitle(filename: string): string;

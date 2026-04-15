import matter from "gray-matter";
import type {
  FrontmatterData,
  ArticleFile,
  WikilinkRef,
  EmbedRef,
} from "./types";

// ─── Frontmatter Parsing & Serialization (Task 2.1) ────────────────────────

/**
 * Parse YAML frontmatter from a raw Markdown string.
 * Returns the extracted data and the body content after the frontmatter block.
 */
export function parseFrontmatter(raw: string): {
  data: FrontmatterData;
  content: string;
} {
  const parsed = matter(raw);
  const data = parsed.data as FrontmatterData;

  // Ensure required fields have sensible defaults
  if (!data.title) data.title = "";
  if (!Array.isArray(data.tags)) data.tags = [];
  if (!data.created) data.created = "";
  if (!data.modified) data.modified = "";

  return { data, content: parsed.content };
}

/**
 * Serialize frontmatter data and body content into a valid Markdown string
 * with a YAML frontmatter block.
 */
export function serializeFrontmatter(
  data: FrontmatterData,
  content: string,
): string {
  return matter.stringify(content, data);
}

/**
 * Parse a full article file (frontmatter + body) into an ArticleFile.
 * Stores rawContent for round-trip fidelity.
 */
export function parseArticleFile(raw: string): ArticleFile {
  const { data, content } = parseFrontmatter(raw);
  return {
    frontmatter: data,
    content,
    rawContent: raw,
  };
}

/**
 * Serialize an ArticleFile back to a Markdown string with YAML frontmatter.
 * Uses gray-matter's stringify for consistent output.
 */
export function serializeArticleFile(article: ArticleFile): string {
  return serializeFrontmatter(article.frontmatter, article.content);
}

// ─── Wikilink, Embed, and Tag Extraction (Task 2.4) ─────────────────────────

/**
 * Build a set of ranges that should be skipped (fenced code blocks and inline code).
 */
function getCodeRanges(content: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];

  // Fenced code blocks: ``` ... ```
  const fencedRegex = /^(`{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = fencedRegex.exec(content)) !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }

  // Inline code: `...` (but not inside fenced blocks — we'll check overlap later)
  const inlineRegex = /`[^`\n]+`/g;
  while ((m = inlineRegex.exec(content)) !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }

  return ranges;
}

function isInsideCode(
  pos: number,
  ranges: Array<{ start: number; end: number }>,
): boolean {
  return ranges.some((r) => pos >= r.start && pos < r.end);
}

/**
 * Extract all wikilinks ([[Target]] and [[Target|Alias]]) from Markdown content.
 * Skips links inside code blocks.
 */
export function extractWikilinks(content: string): WikilinkRef[] {
  const codeRanges = getCodeRanges(content);
  const results: WikilinkRef[] = [];

  // Match [[...]] but NOT ![[...]] (embeds)
  const regex = /(?<!!)\[\[([^\]]+?)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    if (isInsideCode(m.index, codeRanges)) continue;

    const inner = m[1];
    if (!inner.trim()) continue; // skip empty brackets

    const pipeIndex = inner.indexOf("|");
    const ref: WikilinkRef = {
      target: pipeIndex >= 0 ? inner.slice(0, pipeIndex).trim() : inner.trim(),
      position: { start: m.index, end: m.index + m[0].length },
    };
    if (pipeIndex >= 0) {
      ref.alias = inner.slice(pipeIndex + 1).trim();
    }
    if (ref.target) {
      results.push(ref);
    }
  }

  return results;
}

/**
 * Extract all embeds (![[Target]]) from Markdown content.
 * Skips embeds inside code blocks.
 */
export function extractEmbeds(content: string): EmbedRef[] {
  const codeRanges = getCodeRanges(content);
  const results: EmbedRef[] = [];

  const regex = /!\[\[([^\]]+?)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    if (isInsideCode(m.index, codeRanges)) continue;

    const target = m[1].trim();
    if (!target) continue; // skip empty

    results.push({
      target,
      position: { start: m.index, end: m.index + m[0].length },
    });
  }

  return results;
}

/**
 * Extract all tags from an ArticleFile.
 * Collects from both frontmatter `tags` array and inline `#tag` in the body.
 * Skips tags inside code blocks. Returns deduplicated array.
 */
export function extractTags(article: ArticleFile): string[] {
  const tagSet = new Set<string>();

  // Frontmatter tags
  if (Array.isArray(article.frontmatter.tags)) {
    for (const tag of article.frontmatter.tags) {
      if (typeof tag === "string" && tag.trim()) {
        tagSet.add(tag.trim());
      }
    }
  }

  // Inline tags from body — #tag (word chars and hyphens)
  const codeRanges = getCodeRanges(article.content);
  const tagRegex = /(?:^|(?<=\s))#([a-zA-Z][\w-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(article.content)) !== null) {
    if (isInsideCode(m.index, codeRanges)) continue;
    tagSet.add(m[1]);
  }

  return Array.from(tagSet);
}

// ─── Title ↔ Filename Conversion (Task 2.6) ──────────────────────────────────

const MAX_FILENAME_LENGTH = 200;

/** Windows reserved filenames (case-insensitive). */
const WINDOWS_RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

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
export function titleToFilename(title: string): string {
  let name = title
    // Replace whitespace with hyphens
    .replace(/\s+/g, "-")
    // Keep only word characters (unicode-aware), hyphens, underscores, dots
    .replace(/[^\p{L}\p{N}_.-]/gu, "")
    // Collapse consecutive hyphens
    .replace(/-{2,}/g, "-")
    // Remove leading/trailing hyphens and dots
    .replace(/^[-.]+ |[-.]+ $/g, "")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "");

  // Truncate to max length
  if (name.length > MAX_FILENAME_LENGTH) {
    name = name.slice(0, MAX_FILENAME_LENGTH);
    // Don't end on a partial hyphen sequence
    name = name.replace(/[-.]+$/, "");
  }

  // Handle empty result
  if (!name) {
    name = "untitled";
  }

  // Handle Windows reserved names
  if (WINDOWS_RESERVED.has(name.toLowerCase())) {
    name = name + "_";
  }

  return name;
}

/**
 * Convert a filename back to a human-readable title.
 * Strips the `.md` extension and replaces hyphens with spaces.
 */
export function filenameToTitle(filename: string): string {
  let name = filename;

  // Strip .md extension
  if (name.toLowerCase().endsWith(".md")) {
    name = name.slice(0, -3);
  }

  // Replace hyphens with spaces
  name = name.replace(/-/g, " ");

  return name;
}

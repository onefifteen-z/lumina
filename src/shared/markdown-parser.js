"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseFrontmatter = parseFrontmatter;
exports.serializeFrontmatter = serializeFrontmatter;
exports.parseArticleFile = parseArticleFile;
exports.serializeArticleFile = serializeArticleFile;
exports.extractWikilinks = extractWikilinks;
exports.extractEmbeds = extractEmbeds;
exports.extractTags = extractTags;
exports.titleToFilename = titleToFilename;
exports.filenameToTitle = filenameToTitle;
const gray_matter_1 = __importDefault(require("gray-matter"));
// ─── Frontmatter Parsing & Serialization (Task 2.1) ────────────────────────
/**
 * Parse YAML frontmatter from a raw Markdown string.
 * Returns the extracted data and the body content after the frontmatter block.
 */
function parseFrontmatter(raw) {
    const parsed = (0, gray_matter_1.default)(raw);
    const data = parsed.data;
    // Ensure required fields have sensible defaults
    if (!data.title)
        data.title = "";
    if (!Array.isArray(data.tags))
        data.tags = [];
    if (!data.created)
        data.created = "";
    if (!data.modified)
        data.modified = "";
    return { data, content: parsed.content };
}
/**
 * Serialize frontmatter data and body content into a valid Markdown string
 * with a YAML frontmatter block.
 */
function serializeFrontmatter(data, content) {
    return gray_matter_1.default.stringify(content, data);
}
/**
 * Parse a full article file (frontmatter + body) into an ArticleFile.
 * Stores rawContent for round-trip fidelity.
 */
function parseArticleFile(raw) {
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
function serializeArticleFile(article) {
    return serializeFrontmatter(article.frontmatter, article.content);
}
// ─── Wikilink, Embed, and Tag Extraction (Task 2.4) ─────────────────────────
/**
 * Build a set of ranges that should be skipped (fenced code blocks and inline code).
 */
function getCodeRanges(content) {
    const ranges = [];
    // Fenced code blocks: ``` ... ```
    const fencedRegex = /^(`{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm;
    let m;
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
function isInsideCode(pos, ranges) {
    return ranges.some((r) => pos >= r.start && pos < r.end);
}
/**
 * Extract all wikilinks ([[Target]] and [[Target|Alias]]) from Markdown content.
 * Skips links inside code blocks.
 */
function extractWikilinks(content) {
    const codeRanges = getCodeRanges(content);
    const results = [];
    // Match [[...]] but NOT ![[...]] (embeds)
    const regex = /(?<!!)\[\[([^\]]+?)\]\]/g;
    let m;
    while ((m = regex.exec(content)) !== null) {
        if (isInsideCode(m.index, codeRanges))
            continue;
        const inner = m[1];
        if (!inner.trim())
            continue; // skip empty brackets
        const pipeIndex = inner.indexOf("|");
        const ref = {
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
function extractEmbeds(content) {
    const codeRanges = getCodeRanges(content);
    const results = [];
    const regex = /!\[\[([^\]]+?)\]\]/g;
    let m;
    while ((m = regex.exec(content)) !== null) {
        if (isInsideCode(m.index, codeRanges))
            continue;
        const target = m[1].trim();
        if (!target)
            continue; // skip empty
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
function extractTags(article) {
    const tagSet = new Set();
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
    let m;
    while ((m = tagRegex.exec(article.content)) !== null) {
        if (isInsideCode(m.index, codeRanges))
            continue;
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
function titleToFilename(title) {
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
function filenameToTitle(filename) {
    let name = filename;
    // Strip .md extension
    if (name.toLowerCase().endsWith(".md")) {
        name = name.slice(0, -3);
    }
    // Replace hyphens with spaces
    name = name.replace(/-/g, " ");
    return name;
}
//# sourceMappingURL=markdown-parser.js.map
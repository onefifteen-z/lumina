import {
  ViewPlugin,
  Decoration,
  DecorationSet,
  EditorView,
  ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

// Decoration marks for each syntax type
const wikilinkMark = Decoration.mark({ class: "cm-wikilink" });
const embedMark = Decoration.mark({ class: "cm-embed" });
const tagMark = Decoration.mark({ class: "cm-wiki-tag" });
const frontmatterMark = Decoration.mark({ class: "cm-frontmatter" });

// Regex patterns
const WIKILINK_RE = /\[\[[^\]]+\]\]/g;
const EMBED_RE = /!\[\[[^\]]+\]\]/g;
const TAG_RE = /(?<=^|[\s,;(])#[a-zA-Z][\w-]*/g;

/**
 * Build decorations by scanning the full document text for Obsidian syntax patterns.
 */
function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  const text = doc.toString();

  // Collect all decoration ranges, then sort by start position
  // (RangeSetBuilder requires sorted insertion)
  const ranges: { from: number; to: number; decoration: Decoration }[] = [];

  // --- YAML Frontmatter ---
  if (text.startsWith("---")) {
    const closingIdx = text.indexOf("\n---", 3);
    if (closingIdx !== -1) {
      // Include the closing --- line
      const end = closingIdx + 4; // '\n---' is 4 chars
      ranges.push({
        from: 0,
        to: Math.min(end, text.length),
        decoration: frontmatterMark,
      });
    }
  }

  // --- Embeds (must be checked before wikilinks since ![[...]] contains [[...]] ) ---
  const embedPositions = new Set<string>();
  for (const match of text.matchAll(EMBED_RE)) {
    const from = match.index!;
    const to = from + match[0].length;
    ranges.push({ from, to, decoration: embedMark });
    // Track embed positions so we can skip overlapping wikilinks
    embedPositions.add(`${from + 1}-${to}`); // The [[ part starts at from+1
  }

  // --- Wikilinks ---
  for (const match of text.matchAll(WIKILINK_RE)) {
    const from = match.index!;
    const to = from + match[0].length;
    // Skip if this [[ is part of an embed ![[
    const key = `${from}-${to}`;
    if (embedPositions.has(key)) continue;
    ranges.push({ from, to, decoration: wikilinkMark });
  }

  // --- Inline Tags ---
  for (const match of text.matchAll(TAG_RE)) {
    const from = match.index!;
    const to = from + match[0].length;
    ranges.push({ from, to, decoration: tagMark });
  }

  // Sort by start position (required by RangeSetBuilder)
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);

  for (const { from, to, decoration } of ranges) {
    builder.add(from, to, decoration);
  }

  return builder.finish();
}

/**
 * ViewPlugin that applies Obsidian syntax decorations.
 * Rebuilds decorations on every document or viewport change.
 */
const obsidianSyntaxPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

/**
 * Returns an array of CodeMirror 6 extensions that highlight Obsidian-specific syntax:
 * - `[[Target]]` and `[[Target|Alias]]` wikilinks
 * - `![[Target]]` embeds
 * - `#tag` inline tags
 * - YAML frontmatter blocks
 */
export function obsidianSyntaxExtensions() {
  return [obsidianSyntaxPlugin];
}

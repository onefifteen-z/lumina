import {
  ensureSyntaxTree,
  syntaxTree,
  syntaxTreeAvailable,
} from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import { StateField } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  findPipeTableBlockRangesInDoc,
  markdownTableBlockToHtmlTableElement,
} from "./markdown-live-preview-table";

/** Inline + theme: syntax highlighting sets color on nested spans, so we must win with !important. */
const HIDDEN = Decoration.mark({
  attributes: {
    class: "cm-lp-mark-hidden",
    style:
      "color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important;",
  },
});

const HIDE_NODE_NAMES = new Set([
  "HeaderMark",
  "QuoteMark",
  "EmphasisMark",
  "CodeMark",
  "LinkMark",
]);

function hasNonEmptySelection(state: EditorState): boolean {
  return state.selection.ranges.some((r) => !r.empty);
}

function emphasisRangeAt(tree: ReturnType<typeof syntaxTree>, pos: number) {
  let n = tree.resolveInner(pos, -1);
  while (n) {
    if (n.type.name === "Emphasis" || n.type.name === "StrongEmphasis")
      return { from: n.from, to: n.to };
    n = n.parent;
  }
  return null;
}

function linkRangeAt(tree: ReturnType<typeof syntaxTree>, pos: number) {
  let n = tree.resolveInner(pos, -1);
  while (n) {
    if (n.type.name === "Link" || n.type.name === "Image")
      return { from: n.from, to: n.to };
    n = n.parent;
  }
  return null;
}

function inlineCodeRangeAt(tree: ReturnType<typeof syntaxTree>, pos: number) {
  let n = tree.resolveInner(pos, -1);
  while (n) {
    if (n.type.name === "InlineCode") return { from: n.from, to: n.to };
    n = n.parent;
  }
  return null;
}

function cursorOnSameLine(doc: EditorState["doc"], a: number, b: number): boolean {
  return doc.lineAt(a).number === doc.lineAt(b).number;
}

/** Wikilink opens inside a table block that is shown as preview (caret not in that table). */
function wikilinkInTablePreviewMode(
  tree: ReturnType<typeof syntaxTree>,
  openPos: number,
  head: number,
): boolean {
  let n = tree.resolveInner(openPos, 1);
  while (n) {
    if (n.type.name === "Table") {
      const editing = head >= n.from && head <= n.to;
      return !editing;
    }
    n = n.parent;
  }
  return false;
}

/** Inline replace: ViewPlugin facets may not use block widgets; list marks stay on one line. */
class BulletListMarkWidget extends WidgetType {
  constructor(readonly markFrom: number, readonly markTo: number) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof BulletListMarkWidget &&
      other.markFrom === this.markFrom &&
      other.markTo === this.markTo
    );
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-lp-list-bullet-widget";
    span.textContent = "•";
    span.setAttribute("aria-hidden", "true");
    return span;
  }
}

class TablePreviewWidget extends WidgetType {
  constructor(
    readonly tableFrom: number,
    readonly tableTo: number,
    readonly source: string,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof TablePreviewWidget &&
      other.tableFrom === this.tableFrom &&
      other.tableTo === this.tableTo &&
      other.source === this.source
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement("div");
    root.className = "cm-lp-table-preview";
    const table = markdownTableBlockToHtmlTableElement(this.source);
    if (table) {
      root.appendChild(table);
    } else {
      const pre = document.createElement("pre");
      pre.className = "cm-lp-table-preview__fallback";
      pre.textContent = this.source;
      root.appendChild(pre);
    }
    root.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.focus();
      const pos = Math.min(this.tableFrom + 1, view.state.doc.length);
      view.dispatch({
        selection: { anchor: pos, head: pos },
        scrollIntoView: true,
      });
    });
    return root;
  }
}

function rangesOverlap(
  a: { from: number; to: number },
  b: { from: number; to: number },
): boolean {
  return a.from < b.to && a.to > b.from;
}

function mergeTableBlockRanges(
  ast: { from: number; to: number }[],
  scanned: { from: number; to: number }[],
): { from: number; to: number }[] {
  const out = ast.length ? ast.slice() : [];
  for (const s of scanned) {
    if (!out.some((a) => rangesOverlap(a, s))) out.push(s);
  }
  out.sort((a, b) => a.from - b.from || a.to - b.to);
  return out;
}

/**
 * Block table preview must live in a StateField-backed `DecorationSet`, not a
 * ViewPlugin function facet — CM forbids block/replace decorations that span
 * line breaks on dynamic (per-view) decoration providers.
 */
function buildTableDecorationSet(state: EditorState): DecorationSet {
  if (hasNonEmptySelection(state)) return Decoration.none;

  const doc = state.doc;
  const parseUpto = doc.length;
  if (!syntaxTreeAvailable(state, parseUpto)) {
    ensureSyntaxTree(state, parseUpto, 200);
  }

  const tree = syntaxTree(state);
  const head = state.selection.main.head;

  const astBlocks: { from: number; to: number }[] = [];
  tree.iterate({
    from: 0,
    to: doc.length,
    enter: (ref) => {
      if (ref.type.name === "Table") {
        astBlocks.push({ from: ref.from, to: ref.to });
        return false;
      }
    },
  });

  const tableBlocks = mergeTableBlockRanges(astBlocks, findPipeTableBlockRangesInDoc(doc));

  const pieces: { from: number; to: number; value: Decoration }[] = [];
  for (const block of tableBlocks) {
    if (head >= block.from && head <= block.to) continue;
    const slice = doc.sliceString(block.from, block.to);
    pieces.push({
      from: block.from,
      to: block.to,
      value: Decoration.replace({
        block: true,
        widget: new TablePreviewWidget(block.from, block.to, slice),
      }),
    });
  }

  return pieces.length ? Decoration.set(pieces, true) : Decoration.none;
}

const tablePreviewDecoField = StateField.define<DecorationSet>({
  create: buildTableDecorationSet,
  update: (_deco, tr) => buildTableDecorationSet(tr.state),
  provide: (f) => EditorView.decorations.from(f),
});

function buildMarkDecorations(view: EditorView): DecorationSet {
  const state = view.state;
  if (hasNonEmptySelection(state)) return Decoration.none;

  const doc = state.doc;
  const parseUpto = Math.min(doc.length, view.viewport.to + 4000);
  if (!syntaxTreeAvailable(state, parseUpto)) {
    ensureSyntaxTree(state, parseUpto, 120);
  }

  const tree = syntaxTree(state);
  const head = state.selection.main.head;
  const emphHere = emphasisRangeAt(tree, head);
  const linkHere = linkRangeAt(tree, head);
  const codeHere = inlineCodeRangeAt(tree, head);

  const ranges: { from: number; to: number }[] = [];
  const seen = new Set<string>();

  const push = (from: number, to: number) => {
    if (from >= to) return;
    const k = `${from}:${to}`;
    if (seen.has(k)) return;
    seen.add(k);
    ranges.push({ from, to });
  };

  const inlinePieces: { from: number; to: number; value: Decoration }[] = [];

  tree.iterate({
    from: view.viewport.from,
    to: view.viewport.to,
    enter: (ref) => {
      const { from, to } = ref;
      const name = ref.type.name;

      if (name === "FencedCode" || name === "CodeBlock") return false;
      if (name === "Table") return false;

      if (name === "ListMark") {
        if (cursorOnSameLine(doc, head, from)) return;
        const slice = doc.sliceString(from, to);
        const t = slice.trim();
        if (/^[-*+]$/.test(t)) {
          inlinePieces.push({
            from,
            to,
            value: Decoration.replace({
              widget: new BulletListMarkWidget(from, to),
            }),
          });
        } else {
          push(from, to);
        }
        return;
      }

      if (!HIDE_NODE_NAMES.has(name)) return;

      if (name === "HeaderMark") {
        if (cursorOnSameLine(doc, head, from)) return;
        push(from, to);
        return;
      }

      if (name === "QuoteMark") {
        if (cursorOnSameLine(doc, head, from)) return;
        push(from, to);
        return;
      }

      if (name === "EmphasisMark") {
        if (emphHere && head >= emphHere.from && head <= emphHere.to) return;
        push(from, to);
        return;
      }

      if (name === "CodeMark") {
        if (codeHere && head >= codeHere.from && head <= codeHere.to) return;
        const line = doc.lineAt(from).text;
        if (/^\s*`{3,}/.test(line) || /`{3,}\s*$/.test(line)) return;
        push(from, to);
        return;
      }

      if (name === "LinkMark") {
        if (linkHere && head >= linkHere.from && head <= linkHere.to) return;
        push(from, to);
        return;
      }
    },
  });

  const text = doc.toString();
  const WIKI = /(?<!!)\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = WIKI.exec(text)) !== null) {
    const open = m.index;
    const close = m.index + m[0].length;
    if (head > open && head < close) continue;
    if (wikilinkInTablePreviewMode(tree, open, head)) continue;
    push(open, open + 2);
    push(close - 2, close);
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  inlinePieces.sort((a, b) => a.from - b.from || a.to - b.to);

  const pieces: { from: number; to: number; value: Decoration }[] = [];
  for (const { from, to } of ranges) {
    pieces.push({ from, to, value: HIDDEN });
  }
  pieces.push(...inlinePieces);

  pieces.sort((a, b) => a.from - b.from || a.to - b.to);
  return pieces.length ? Decoration.set(pieces, true) : Decoration.none;
}

const livePreviewTheme = EditorView.baseTheme({
  ".cm-lp-mark-hidden": {
    textShadow: "none",
    fontSize: "inherit",
  },
  ".cm-lp-mark-hidden, .cm-lp-mark-hidden *": {
    color: "transparent !important",
    textShadow: "none !important",
    // Highlighting uses this on Safari / some themes
    WebkitTextFillColor: "transparent !important",
  },
  ".cm-lp-list-bullet-widget": {
    display: "inline-block",
    minWidth: "0.55em",
    marginRight: "0.3em",
    color: "var(--color-text-secondary)",
    userSelect: "none",
    textAlign: "center",
  },
  ".cm-lp-table-preview": {
    cursor: "pointer",
    marginBottom: "0.6em",
  },
  ".cm-lp-table-preview table": {
    width: "100%",
    borderCollapse: "collapse",
  },
  ".cm-lp-table-preview th, .cm-lp-table-preview td": {
    padding: "6px 10px",
    border: "1px solid var(--color-border)",
    textAlign: "left",
  },
  ".cm-lp-table-preview th": {
    backgroundColor: "var(--color-bg-secondary)",
    fontWeight: "600",
  },
  ".cm-lp-table-preview__fallback": {
    margin: "0",
    fontSize: "0.85em",
    whiteSpace: "pre-wrap",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },
});

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildMarkDecorations(view);
    }
    update(update: ViewUpdate) {
      // Also rebuild when the language service finishes a background parse
      // (tree fills in without doc/selection/viewport changes).
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.transactions.length > 0
      ) {
        this.decorations = buildMarkDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/**
 * Obsidian-style live preview: hide lightweight syntax markers (ATX hashes,
 * ordered list markers, emphasis markers, link brackets, inline code
 * backticks, …) when the caret is not editing that span. Bullet list markers
 * are replaced with a visible bullet while the line is not active. Non-empty
 * selection shows raw markdown everywhere. GFM pipe tables render as HTML
 * (via a StateField decoration set) while the caret is outside the table;
 * click the preview or move the caret into the block to edit the source.
 */
export function markdownLivePreview(): Extension {
  return [livePreviewTheme, tablePreviewDecoField, livePreviewPlugin];
}

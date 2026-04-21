import type { Extension } from "@codemirror/state";
import {
  defaultHighlightStyle,
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";

const headingNoUnderline = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "bold", textDecoration: "none" },
  { tag: tags.heading1, fontWeight: "bold", textDecoration: "none" },
  { tag: tags.heading2, fontWeight: "bold", textDecoration: "none" },
  { tag: tags.heading3, fontWeight: "bold", textDecoration: "none" },
  { tag: tags.heading4, fontWeight: "bold", textDecoration: "none" },
  { tag: tags.heading5, fontWeight: "bold", textDecoration: "none" },
  { tag: tags.heading6, fontWeight: "bold", textDecoration: "none" },
]);

/**
 * CodeMirror's default fallback highlighter is skipped whenever any non-fallback
 * highlighter exists, so we re-register the default style and layer a small
 * override that removes `tags.heading*` underline (the default uses anonymous
 * theme classes; `.tok-heading*` CSS alone does not win the cascade).
 */
export const luminaMarkdownSyntaxHighlightExtensions: Extension[] = [
  syntaxHighlighting(defaultHighlightStyle),
  syntaxHighlighting(headingNoUnderline),
];

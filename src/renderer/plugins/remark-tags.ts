import { visit } from "unist-util-visit";

/**
 * Remark plugin that transforms inline #tag syntax in MDAST text nodes
 * into clickable span elements.
 *
 * #tag → <span class="inline-tag" data-tag="tag">#tag</span>
 *
 * Rules:
 * - Tags must start with a letter and contain word chars/hyphens: #[a-zA-Z][\w-]*
 * - Don't match inside code blocks
 * - Don't match heading markers (# followed by space)
 */
export default function remarkTags() {
  return (tree: any) => {
    visit(tree, "text", (node: any, index: number | undefined, parent: any) => {
      if (index === undefined || !parent) return;

      // Skip text inside code/codeBlock nodes
      if (parent.type === "code" || parent.type === "inlineCode") return;

      // Skip heading nodes — their text children shouldn't be treated as tags
      if (parent.type === "heading") return;

      const value: string = node.value;
      // Match #tag preceded by start-of-string or whitespace
      const regex = /(^|(?<=\s))#([a-zA-Z][\w-]*)/g;
      let match: RegExpExecArray | null;
      const nodes: any[] = [];
      let lastIndex = 0;

      while ((match = regex.exec(value)) !== null) {
        const prefix = match[1]; // whitespace before #
        const tag = match[2];
        const matchStart = match.index;

        // Add preceding text (including the whitespace prefix)
        if (matchStart + prefix.length > lastIndex) {
          nodes.push({
            type: "text",
            value: value.slice(lastIndex, matchStart + prefix.length),
          });
        }

        nodes.push({
          type: "html",
          value: `<span class="inline-tag" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</span>`,
        });

        lastIndex = match.index + match[0].length;
      }

      if (nodes.length === 0) return;

      // Add trailing text
      if (lastIndex < value.length) {
        nodes.push({ type: "text", value: value.slice(lastIndex) });
      }

      parent.children.splice(index, 1, ...nodes);
    });
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

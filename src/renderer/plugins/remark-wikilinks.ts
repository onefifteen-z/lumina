import { visit } from "unist-util-visit";

/**
 * Remark plugin that transforms [[Target]] and [[Target|Alias]] wikilink syntax
 * in MDAST text nodes into HTML anchor elements.
 *
 * - [[Target]]       → <a class="wikilink" data-target="Target">Target</a>
 * - [[Target|Alias]] → <a class="wikilink" data-target="Target">Alias</a>
 */
export default function remarkWikilinks() {
  return (tree: any) => {
    visit(tree, "text", (node: any, index: number | undefined, parent: any) => {
      if (index === undefined || !parent) return;

      // Skip text inside code/codeBlock nodes
      if (parent.type === "code" || parent.type === "inlineCode") return;

      const value: string = node.value;
      // Match [[...]] but NOT ![[...]]
      const regex = /(?<!!)\[\[([^\]]+?)\]\]/g;
      let match: RegExpExecArray | null;
      const nodes: any[] = [];
      let lastIndex = 0;

      while ((match = regex.exec(value)) !== null) {
        const inner = match[1];
        if (!inner.trim()) continue;

        // Add preceding text
        if (match.index > lastIndex) {
          nodes.push({
            type: "text",
            value: value.slice(lastIndex, match.index),
          });
        }

        const pipeIndex = inner.indexOf("|");
        const target =
          pipeIndex >= 0 ? inner.slice(0, pipeIndex).trim() : inner.trim();
        const display =
          pipeIndex >= 0 ? inner.slice(pipeIndex + 1).trim() : inner.trim();

        if (target) {
          nodes.push({
            type: "html",
            value: `<a class="wikilink" data-target="${escapeHtml(target)}">${escapeHtml(display)}</a>`,
          });
        } else {
          // Empty target, keep original text
          nodes.push({ type: "text", value: match[0] });
        }

        lastIndex = match.index + match[0].length;
      }

      if (nodes.length === 0) return;

      // Add trailing text
      if (lastIndex < value.length) {
        nodes.push({ type: "text", value: value.slice(lastIndex) });
      }

      // Replace the original node with the new nodes
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

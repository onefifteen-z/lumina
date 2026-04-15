import { visit } from "unist-util-visit";

/**
 * Remark plugin that transforms ![[Target]] embed syntax in MDAST text nodes
 * into placeholder HTML div elements.
 *
 * ![[Target]] → <div class="embed" data-target="Target"><p>Embedded: Target</p></div>
 */
export default function remarkEmbeds() {
  return (tree: any) => {
    visit(tree, "text", (node: any, index: number | undefined, parent: any) => {
      if (index === undefined || !parent) return;

      // Skip text inside code/codeBlock nodes
      if (parent.type === "code" || parent.type === "inlineCode") return;

      const value: string = node.value;
      const regex = /!\[\[([^\]]+?)\]\]/g;
      let match: RegExpExecArray | null;
      const nodes: any[] = [];
      let lastIndex = 0;

      while ((match = regex.exec(value)) !== null) {
        const target = match[1].trim();
        if (!target) continue;

        // Add preceding text
        if (match.index > lastIndex) {
          nodes.push({
            type: "text",
            value: value.slice(lastIndex, match.index),
          });
        }

        nodes.push({
          type: "html",
          value: `<div class="embed" data-target="${escapeHtml(target)}"><p>Embedded: ${escapeHtml(target)}</p></div>`,
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

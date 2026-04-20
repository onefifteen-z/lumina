import { describe, it, expect } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkHtml from "remark-html";
import remarkWikilinks from "../plugins/remark-wikilinks";
import remarkEmbeds from "../plugins/remark-embeds";
import remarkTags from "../plugins/remark-tags";
import { normalizeLiveMarkdownForVault } from "./live-editor-markdown";

/** Same remark stack as ArticleBrowser preview (minus heading IDs). */
function readerPipeline(markdown: string): string {
  return String(
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkWikilinks)
      .use(remarkEmbeds)
      .use(remarkTags)
      .use(remarkHtml, { sanitize: false })
      .processSync(markdown),
  );
}

describe("normalizeLiveMarkdownForVault", () => {
  it("normalizes CRLF to LF", () => {
    expect(normalizeLiveMarkdownForVault("a\r\nb")).toBe("a\nb");
  });
});

describe("live editor markdown vs reader pipeline", () => {
  it("keeps wikilinks, embeds, and tags stable through normalize + remark", () => {
    const md =
      "See [[My Note|alias]] and ![[Embed]] plus #tag.\n\n| a |\n| - |\n| 1 |\n";
    const normalized = normalizeLiveMarkdownForVault(md);
    const html = readerPipeline(normalized);
    expect(html).toContain('class="wikilink"');
    expect(html).toContain('data-target="My Note"');
    expect(html).toContain('class="embed"');
    expect(html).toContain('data-target="Embed"');
    expect(html).toContain('class="inline-tag"');
    expect(html).toContain("<table");
  });
});

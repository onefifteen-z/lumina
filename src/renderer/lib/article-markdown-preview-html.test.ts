import { describe, it, expect } from "vitest";
import { markdownArticleBodyToHtml } from "./article-markdown-preview-html";

describe("markdownArticleBodyToHtml", () => {
  it("renders wikilinks like the reader pipeline", () => {
    const html = markdownArticleBodyToHtml("See [[Note]] here.");
    expect(html).toContain('class="wikilink"');
    expect(html).toContain('data-target="Note"');
  });
});

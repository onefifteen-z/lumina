import { describe, it, expect } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkHtml from "remark-html";
import remarkWikilinks from "./remark-wikilinks";
import remarkEmbeds from "./remark-embeds";
import remarkTags from "./remark-tags";

function render(markdown: string): string {
  return String(
    unified()
      .use(remarkParse)
      .use(remarkWikilinks)
      .use(remarkEmbeds)
      .use(remarkTags)
      .use(remarkHtml, { sanitize: false })
      .processSync(markdown),
  );
}

describe("remarkWikilinks", () => {
  it("renders [[Target]] as a wikilink anchor", () => {
    const html = render("See [[My Article]] for details.");
    expect(html).toContain(
      '<a class="wikilink" data-target="My Article">My Article</a>',
    );
  });

  it("renders [[Target|Alias]] with alias text", () => {
    const html = render("Check [[My Article|this link]] out.");
    expect(html).toContain(
      '<a class="wikilink" data-target="My Article">this link</a>',
    );
  });

  it("renders multiple wikilinks in one paragraph", () => {
    const html = render("Link to [[A]] and [[B|bee]].");
    expect(html).toContain('data-target="A">A</a>');
    expect(html).toContain('data-target="B">bee</a>');
  });

  it("does not match embeds (![[Target]])", () => {
    const html = render("Embed: ![[Embedded]]");
    expect(html).not.toContain('class="wikilink"');
  });

  it("does not match wikilinks inside inline code", () => {
    const html = render("Use `[[NotALink]]` in code.");
    expect(html).not.toContain('class="wikilink"');
    expect(html).toContain("<code>[[NotALink]]</code>");
  });

  it("does not match wikilinks inside fenced code blocks", () => {
    const html = render("```\n[[NotALink]]\n```");
    expect(html).not.toContain('class="wikilink"');
  });

  it("handles special characters in target", () => {
    const html = render("See [[Art & Craft]] for details.");
    expect(html).toContain('data-target="Art &amp; Craft"');
    expect(html).toContain(">Art &amp; Craft</a>");
  });
});

describe("remarkEmbeds", () => {
  it("renders ![[Target]] as an embed placeholder", () => {
    const html = render("Content: ![[My Note]]");
    expect(html).toContain('<div class="embed" data-target="My Note">');
    expect(html).toContain("<p>Embedded: My Note</p>");
  });

  it("renders multiple embeds", () => {
    const html = render("![[A]] and ![[B]]");
    expect(html).toContain('data-target="A"');
    expect(html).toContain('data-target="B"');
  });

  it("does not match regular wikilinks", () => {
    const html = render("Link: [[NotEmbed]]");
    expect(html).not.toContain('class="embed"');
  });

  it("does not match inside inline code", () => {
    const html = render("Use `![[NotEmbed]]` in code.");
    expect(html).not.toContain('class="embed"');
  });

  it("handles special characters in target", () => {
    const html = render("![[Art & Craft]]");
    expect(html).toContain('data-target="Art &amp; Craft"');
    expect(html).toContain("Embedded: Art &amp; Craft");
  });
});

describe("remarkTags", () => {
  it("renders #tag as an inline-tag span", () => {
    const html = render("This is #science content.");
    expect(html).toContain(
      '<span class="inline-tag" data-tag="science">#science</span>',
    );
  });

  it("renders tags with hyphens", () => {
    const html = render("Topic: #machine-learning is cool.");
    expect(html).toContain('data-tag="machine-learning"');
  });

  it("does not match heading markers", () => {
    const html = render("# Heading");
    expect(html).not.toContain('class="inline-tag"');
    expect(html).toContain("<h1>Heading</h1>");
  });

  it("does not match # followed by a number", () => {
    const html = render("Issue #123 is open.");
    expect(html).not.toContain('class="inline-tag"');
  });

  it("does not match inside inline code", () => {
    const html = render("Use `#notag` in code.");
    expect(html).not.toContain('class="inline-tag"');
  });

  it("renders multiple tags", () => {
    const html = render("Tags: #alpha #beta");
    expect(html).toContain('data-tag="alpha"');
    expect(html).toContain('data-tag="beta"');
  });

  it("matches tag at start of text", () => {
    const html = render("#first tag at start.");
    expect(html).toContain('data-tag="first"');
  });
});

describe("full pipeline integration", () => {
  it("handles wikilinks, embeds, and tags in the same document", () => {
    const md = `See [[Article A]] for more.

![[Embedded Note]]

This is #tagged content with [[Link|alias]].`;
    const html = render(md);
    expect(html).toContain('data-target="Article A">Article A</a>');
    expect(html).toContain('class="embed" data-target="Embedded Note"');
    expect(html).toContain('data-tag="tagged"');
    expect(html).toContain('data-target="Link">alias</a>');
  });
});

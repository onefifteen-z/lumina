import { describe, it, expect } from "vitest";
import {
  parseFrontmatter,
  serializeFrontmatter,
  parseArticleFile,
  serializeArticleFile,
  extractWikilinks,
  extractEmbeds,
  extractTags,
  titleToFilename,
  filenameToTitle,
} from "./markdown-parser";

// ─── Task 2.1: Frontmatter Parsing & Serialization ─────────────────────────

describe("parseFrontmatter", () => {
  it("extracts YAML frontmatter and body content", () => {
    const raw = `---
title: "Test Article"
tags:
  - science
created: "2024-01-15T10:30:00Z"
modified: "2024-01-16T14:22:00Z"
---

# Hello World

Body content here.
`;
    const { data, content } = parseFrontmatter(raw);
    expect(data.title).toBe("Test Article");
    expect(data.tags).toEqual(["science"]);
    expect(data.created).toBe("2024-01-15T10:30:00Z");
    expect(data.modified).toBe("2024-01-16T14:22:00Z");
    expect(content).toContain("# Hello World");
    expect(content).toContain("Body content here.");
  });

  it("provides defaults for missing fields", () => {
    const raw = `---
custom: value
---
Body`;
    const { data } = parseFrontmatter(raw);
    expect(data.title).toBe("");
    expect(data.tags).toEqual([]);
    expect(data.created).toBe("");
    expect(data.modified).toBe("");
  });

  it("coerces YAML date scalars on created/modified to ISO strings", () => {
    const raw = `---
title: Dated
tags: []
created: 2024-06-10
modified: 2024-06-11
---
x`;
    const { data } = parseFrontmatter(raw);
    expect(typeof data.created).toBe("string");
    expect(typeof data.modified).toBe("string");
    expect(data.created).toMatch(/^2024-06-10/);
    expect(data.modified).toMatch(/^2024-06-11/);
  });
});

describe("serializeFrontmatter", () => {
  it("produces valid Markdown with YAML frontmatter", () => {
    const data = {
      title: "My Article",
      tags: ["a", "b"],
      created: "2024-01-01T00:00:00Z",
      modified: "2024-01-02T00:00:00Z",
    };
    const result = serializeFrontmatter(data, "\n# Content\n");
    expect(result).toContain("---");
    expect(result).toContain("title: My Article");
    expect(result).toContain("# Content");
  });
});

describe("parseArticleFile / serializeArticleFile", () => {
  it("round-trips a complete article", () => {
    const raw = `---
title: Round Trip
tags:
  - test
created: '2024-01-01T00:00:00Z'
modified: '2024-01-02T00:00:00Z'
---
# Round Trip

Some content with a [[Wikilink]] and ![[Embed]] and #tag.
`;
    const article = parseArticleFile(raw);
    expect(article.frontmatter.title).toBe("Round Trip");
    expect(article.rawContent).toBe(raw);
    expect(article.content).toContain("[[Wikilink]]");

    // Serialized output should re-parse to the same data
    const serialized = serializeArticleFile(article);
    const reparsed = parseArticleFile(serialized);
    expect(reparsed.frontmatter.title).toBe(article.frontmatter.title);
    expect(reparsed.frontmatter.tags).toEqual(article.frontmatter.tags);
    expect(reparsed.content.trim()).toBe(article.content.trim());
  });

  it("preserves rawContent on parse", () => {
    const raw =
      "---\ntitle: Test\ntags: []\ncreated: ''\nmodified: ''\n---\nBody";
    const article = parseArticleFile(raw);
    expect(article.rawContent).toBe(raw);
  });
});

// ─── Task 2.4: Wikilink, Embed, and Tag Extraction ─────────────────────────

describe("extractWikilinks", () => {
  it("extracts simple wikilinks", () => {
    const content = "See [[Article One]] and [[Article Two]].";
    const links = extractWikilinks(content);
    expect(links).toHaveLength(2);
    expect(links[0].target).toBe("Article One");
    expect(links[1].target).toBe("Article Two");
  });

  it("extracts aliased wikilinks", () => {
    const content = "Check [[Target|Display Text]] here.";
    const links = extractWikilinks(content);
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("Target");
    expect(links[0].alias).toBe("Display Text");
  });

  it("provides correct position offsets", () => {
    const content = "Hello [[World]] end";
    const links = extractWikilinks(content);
    expect(links[0].position.start).toBe(6);
    expect(links[0].position.end).toBe(15);
    expect(content.slice(links[0].position.start, links[0].position.end)).toBe(
      "[[World]]",
    );
  });

  it("skips wikilinks inside fenced code blocks", () => {
    const content = "Before\n```\n[[InCode]]\n```\nAfter [[Real]]";
    const links = extractWikilinks(content);
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("Real");
  });

  it("skips wikilinks inside inline code", () => {
    const content = "Use `[[NotALink]]` but [[RealLink]] works.";
    const links = extractWikilinks(content);
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("RealLink");
  });

  it("does not match embeds", () => {
    const content = "![[Embed]] and [[Link]]";
    const links = extractWikilinks(content);
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("Link");
  });

  it("skips empty brackets", () => {
    const content = "[[]] and [[ ]] and [[Valid]]";
    const links = extractWikilinks(content);
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("Valid");
  });
});

describe("extractEmbeds", () => {
  it("extracts embeds", () => {
    const content = "See ![[Embedded Article]] here.";
    const embeds = extractEmbeds(content);
    expect(embeds).toHaveLength(1);
    expect(embeds[0].target).toBe("Embedded Article");
  });

  it("provides correct position offsets", () => {
    const content = "X ![[Target]] Y";
    const embeds = extractEmbeds(content);
    expect(embeds[0].position.start).toBe(2);
    expect(embeds[0].position.end).toBe(13);
  });

  it("skips embeds inside code blocks", () => {
    const content = "```\n![[InCode]]\n```\n![[Real]]";
    const embeds = extractEmbeds(content);
    expect(embeds).toHaveLength(1);
    expect(embeds[0].target).toBe("Real");
  });
});

describe("extractTags", () => {
  it("collects tags from frontmatter", () => {
    const article = {
      frontmatter: {
        title: "Test",
        tags: ["science", "physics"],
        created: "",
        modified: "",
      },
      content: "No inline tags here.",
      rawContent: "",
    };
    const tags = extractTags(article);
    expect(tags).toContain("science");
    expect(tags).toContain("physics");
  });

  it("collects inline tags from body", () => {
    const article = {
      frontmatter: { title: "Test", tags: [], created: "", modified: "" },
      content: "Some text #coding and #design here.",
      rawContent: "",
    };
    const tags = extractTags(article);
    expect(tags).toContain("coding");
    expect(tags).toContain("design");
  });

  it("deduplicates tags from frontmatter and body", () => {
    const article = {
      frontmatter: {
        title: "Test",
        tags: ["coding"],
        created: "",
        modified: "",
      },
      content: "Also #coding inline.",
      rawContent: "",
    };
    const tags = extractTags(article);
    expect(tags.filter((t) => t === "coding")).toHaveLength(1);
  });

  it("skips tags inside code blocks", () => {
    const article = {
      frontmatter: { title: "Test", tags: [], created: "", modified: "" },
      content: "```\n#notag\n```\n#realtag here",
      rawContent: "",
    };
    const tags = extractTags(article);
    expect(tags).toContain("realtag");
    expect(tags).not.toContain("notag");
  });
});

// ─── Task 2.6: Title ↔ Filename Conversion ──────────────────────────────────

describe("titleToFilename", () => {
  it("replaces spaces with hyphens", () => {
    expect(titleToFilename("Hello World")).toBe("Hello-World");
  });

  it("strips unsafe characters", () => {
    expect(titleToFilename("Hello: World!")).toBe("Hello-World");
  });

  it("handles unicode characters", () => {
    const result = titleToFilename("日本語タイトル");
    expect(result).toBe("日本語タイトル");
  });

  it("collapses consecutive hyphens", () => {
    expect(titleToFilename("A  --  B")).toBe("A-B");
  });

  it("truncates long names", () => {
    const longTitle = "A".repeat(300);
    const result = titleToFilename(longTitle);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it("handles Windows reserved names", () => {
    expect(titleToFilename("CON")).toBe("CON_");
    expect(titleToFilename("nul")).toBe("nul_");
    expect(titleToFilename("COM1")).toBe("COM1_");
    expect(titleToFilename("LPT9")).toBe("LPT9_");
  });

  it("returns 'untitled' for empty/whitespace-only input", () => {
    expect(titleToFilename("")).toBe("untitled");
    expect(titleToFilename("   ")).toBe("untitled");
  });

  it("is deterministic", () => {
    const title = "Some Complex Title! @#$%";
    expect(titleToFilename(title)).toBe(titleToFilename(title));
  });

  it("produces only safe characters", () => {
    const result = titleToFilename('A/B\\C<D>E:F"G|H?I*J');
    // Should only contain unicode letters, digits, hyphens, underscores, dots
    expect(result).toMatch(/^[\p{L}\p{N}_.-]+$/u);
  });
});

describe("filenameToTitle", () => {
  it("strips .md extension", () => {
    expect(filenameToTitle("hello-world.md")).toBe("hello world");
  });

  it("replaces hyphens with spaces", () => {
    expect(filenameToTitle("my-article")).toBe("my article");
  });

  it("handles filenames without extension", () => {
    expect(filenameToTitle("no-extension")).toBe("no extension");
  });

  it("handles case-insensitive .MD extension", () => {
    expect(filenameToTitle("test.MD")).toBe("test");
  });
});

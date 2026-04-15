"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const markdown_parser_1 = require("./markdown-parser");
// ─── Task 2.1: Frontmatter Parsing & Serialization ─────────────────────────
(0, vitest_1.describe)("parseFrontmatter", () => {
    (0, vitest_1.it)("extracts YAML frontmatter and body content", () => {
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
        const { data, content } = (0, markdown_parser_1.parseFrontmatter)(raw);
        (0, vitest_1.expect)(data.title).toBe("Test Article");
        (0, vitest_1.expect)(data.tags).toEqual(["science"]);
        (0, vitest_1.expect)(data.created).toBe("2024-01-15T10:30:00Z");
        (0, vitest_1.expect)(data.modified).toBe("2024-01-16T14:22:00Z");
        (0, vitest_1.expect)(content).toContain("# Hello World");
        (0, vitest_1.expect)(content).toContain("Body content here.");
    });
    (0, vitest_1.it)("provides defaults for missing fields", () => {
        const raw = `---
custom: value
---
Body`;
        const { data } = (0, markdown_parser_1.parseFrontmatter)(raw);
        (0, vitest_1.expect)(data.title).toBe("");
        (0, vitest_1.expect)(data.tags).toEqual([]);
        (0, vitest_1.expect)(data.created).toBe("");
        (0, vitest_1.expect)(data.modified).toBe("");
    });
});
(0, vitest_1.describe)("serializeFrontmatter", () => {
    (0, vitest_1.it)("produces valid Markdown with YAML frontmatter", () => {
        const data = {
            title: "My Article",
            tags: ["a", "b"],
            created: "2024-01-01T00:00:00Z",
            modified: "2024-01-02T00:00:00Z",
        };
        const result = (0, markdown_parser_1.serializeFrontmatter)(data, "\n# Content\n");
        (0, vitest_1.expect)(result).toContain("---");
        (0, vitest_1.expect)(result).toContain("title: My Article");
        (0, vitest_1.expect)(result).toContain("# Content");
    });
});
(0, vitest_1.describe)("parseArticleFile / serializeArticleFile", () => {
    (0, vitest_1.it)("round-trips a complete article", () => {
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
        const article = (0, markdown_parser_1.parseArticleFile)(raw);
        (0, vitest_1.expect)(article.frontmatter.title).toBe("Round Trip");
        (0, vitest_1.expect)(article.rawContent).toBe(raw);
        (0, vitest_1.expect)(article.content).toContain("[[Wikilink]]");
        // Serialized output should re-parse to the same data
        const serialized = (0, markdown_parser_1.serializeArticleFile)(article);
        const reparsed = (0, markdown_parser_1.parseArticleFile)(serialized);
        (0, vitest_1.expect)(reparsed.frontmatter.title).toBe(article.frontmatter.title);
        (0, vitest_1.expect)(reparsed.frontmatter.tags).toEqual(article.frontmatter.tags);
        (0, vitest_1.expect)(reparsed.content.trim()).toBe(article.content.trim());
    });
    (0, vitest_1.it)("preserves rawContent on parse", () => {
        const raw = "---\ntitle: Test\ntags: []\ncreated: ''\nmodified: ''\n---\nBody";
        const article = (0, markdown_parser_1.parseArticleFile)(raw);
        (0, vitest_1.expect)(article.rawContent).toBe(raw);
    });
});
// ─── Task 2.4: Wikilink, Embed, and Tag Extraction ─────────────────────────
(0, vitest_1.describe)("extractWikilinks", () => {
    (0, vitest_1.it)("extracts simple wikilinks", () => {
        const content = "See [[Article One]] and [[Article Two]].";
        const links = (0, markdown_parser_1.extractWikilinks)(content);
        (0, vitest_1.expect)(links).toHaveLength(2);
        (0, vitest_1.expect)(links[0].target).toBe("Article One");
        (0, vitest_1.expect)(links[1].target).toBe("Article Two");
    });
    (0, vitest_1.it)("extracts aliased wikilinks", () => {
        const content = "Check [[Target|Display Text]] here.";
        const links = (0, markdown_parser_1.extractWikilinks)(content);
        (0, vitest_1.expect)(links).toHaveLength(1);
        (0, vitest_1.expect)(links[0].target).toBe("Target");
        (0, vitest_1.expect)(links[0].alias).toBe("Display Text");
    });
    (0, vitest_1.it)("provides correct position offsets", () => {
        const content = "Hello [[World]] end";
        const links = (0, markdown_parser_1.extractWikilinks)(content);
        (0, vitest_1.expect)(links[0].position.start).toBe(6);
        (0, vitest_1.expect)(links[0].position.end).toBe(15);
        (0, vitest_1.expect)(content.slice(links[0].position.start, links[0].position.end)).toBe("[[World]]");
    });
    (0, vitest_1.it)("skips wikilinks inside fenced code blocks", () => {
        const content = "Before\n```\n[[InCode]]\n```\nAfter [[Real]]";
        const links = (0, markdown_parser_1.extractWikilinks)(content);
        (0, vitest_1.expect)(links).toHaveLength(1);
        (0, vitest_1.expect)(links[0].target).toBe("Real");
    });
    (0, vitest_1.it)("skips wikilinks inside inline code", () => {
        const content = "Use `[[NotALink]]` but [[RealLink]] works.";
        const links = (0, markdown_parser_1.extractWikilinks)(content);
        (0, vitest_1.expect)(links).toHaveLength(1);
        (0, vitest_1.expect)(links[0].target).toBe("RealLink");
    });
    (0, vitest_1.it)("does not match embeds", () => {
        const content = "![[Embed]] and [[Link]]";
        const links = (0, markdown_parser_1.extractWikilinks)(content);
        (0, vitest_1.expect)(links).toHaveLength(1);
        (0, vitest_1.expect)(links[0].target).toBe("Link");
    });
    (0, vitest_1.it)("skips empty brackets", () => {
        const content = "[[]] and [[ ]] and [[Valid]]";
        const links = (0, markdown_parser_1.extractWikilinks)(content);
        (0, vitest_1.expect)(links).toHaveLength(1);
        (0, vitest_1.expect)(links[0].target).toBe("Valid");
    });
});
(0, vitest_1.describe)("extractEmbeds", () => {
    (0, vitest_1.it)("extracts embeds", () => {
        const content = "See ![[Embedded Article]] here.";
        const embeds = (0, markdown_parser_1.extractEmbeds)(content);
        (0, vitest_1.expect)(embeds).toHaveLength(1);
        (0, vitest_1.expect)(embeds[0].target).toBe("Embedded Article");
    });
    (0, vitest_1.it)("provides correct position offsets", () => {
        const content = "X ![[Target]] Y";
        const embeds = (0, markdown_parser_1.extractEmbeds)(content);
        (0, vitest_1.expect)(embeds[0].position.start).toBe(2);
        (0, vitest_1.expect)(embeds[0].position.end).toBe(13);
    });
    (0, vitest_1.it)("skips embeds inside code blocks", () => {
        const content = "```\n![[InCode]]\n```\n![[Real]]";
        const embeds = (0, markdown_parser_1.extractEmbeds)(content);
        (0, vitest_1.expect)(embeds).toHaveLength(1);
        (0, vitest_1.expect)(embeds[0].target).toBe("Real");
    });
});
(0, vitest_1.describe)("extractTags", () => {
    (0, vitest_1.it)("collects tags from frontmatter", () => {
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
        const tags = (0, markdown_parser_1.extractTags)(article);
        (0, vitest_1.expect)(tags).toContain("science");
        (0, vitest_1.expect)(tags).toContain("physics");
    });
    (0, vitest_1.it)("collects inline tags from body", () => {
        const article = {
            frontmatter: { title: "Test", tags: [], created: "", modified: "" },
            content: "Some text #coding and #design here.",
            rawContent: "",
        };
        const tags = (0, markdown_parser_1.extractTags)(article);
        (0, vitest_1.expect)(tags).toContain("coding");
        (0, vitest_1.expect)(tags).toContain("design");
    });
    (0, vitest_1.it)("deduplicates tags from frontmatter and body", () => {
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
        const tags = (0, markdown_parser_1.extractTags)(article);
        (0, vitest_1.expect)(tags.filter((t) => t === "coding")).toHaveLength(1);
    });
    (0, vitest_1.it)("skips tags inside code blocks", () => {
        const article = {
            frontmatter: { title: "Test", tags: [], created: "", modified: "" },
            content: "```\n#notag\n```\n#realtag here",
            rawContent: "",
        };
        const tags = (0, markdown_parser_1.extractTags)(article);
        (0, vitest_1.expect)(tags).toContain("realtag");
        (0, vitest_1.expect)(tags).not.toContain("notag");
    });
});
// ─── Task 2.6: Title ↔ Filename Conversion ──────────────────────────────────
(0, vitest_1.describe)("titleToFilename", () => {
    (0, vitest_1.it)("replaces spaces with hyphens", () => {
        (0, vitest_1.expect)((0, markdown_parser_1.titleToFilename)("Hello World")).toBe("Hello-World");
    });
    (0, vitest_1.it)("strips unsafe characters", () => {
        (0, vitest_1.expect)((0, markdown_parser_1.titleToFilename)("Hello: World!")).toBe("Hello-World");
    });
    (0, vitest_1.it)("handles unicode characters", () => {
        const result = (0, markdown_parser_1.titleToFilename)("日本語タイトル");
        (0, vitest_1.expect)(result).toBe("日本語タイトル");
    });
    (0, vitest_1.it)("collapses consecutive hyphens", () => {
        (0, vitest_1.expect)((0, markdown_parser_1.titleToFilename)("A  --  B")).toBe("A-B");
    });
    (0, vitest_1.it)("truncates long names", () => {
        const longTitle = "A".repeat(300);
        const result = (0, markdown_parser_1.titleToFilename)(longTitle);
        (0, vitest_1.expect)(result.length).toBeLessThanOrEqual(200);
    });
    (0, vitest_1.it)("handles Windows reserved names", () => {
        (0, vitest_1.expect)((0, markdown_parser_1.titleToFilename)("CON")).toBe("CON_");
        (0, vitest_1.expect)((0, markdown_parser_1.titleToFilename)("nul")).toBe("nul_");
        (0, vitest_1.expect)((0, markdown_parser_1.titleToFilename)("COM1")).toBe("COM1_");
        (0, vitest_1.expect)((0, markdown_parser_1.titleToFilename)("LPT9")).toBe("LPT9_");
    });
    (0, vitest_1.it)("returns 'untitled' for empty/whitespace-only input", () => {
        (0, vitest_1.expect)((0, markdown_parser_1.titleToFilename)("")).toBe("untitled");
        (0, vitest_1.expect)((0, markdown_parser_1.titleToFilename)("   ")).toBe("untitled");
    });
    (0, vitest_1.it)("is deterministic", () => {
        const title = "Some Complex Title! @#$%";
        (0, vitest_1.expect)((0, markdown_parser_1.titleToFilename)(title)).toBe((0, markdown_parser_1.titleToFilename)(title));
    });
    (0, vitest_1.it)("produces only safe characters", () => {
        const result = (0, markdown_parser_1.titleToFilename)('A/B\\C<D>E:F"G|H?I*J');
        // Should only contain unicode letters, digits, hyphens, underscores, dots
        (0, vitest_1.expect)(result).toMatch(/^[\p{L}\p{N}_.-]+$/u);
    });
});
(0, vitest_1.describe)("filenameToTitle", () => {
    (0, vitest_1.it)("strips .md extension", () => {
        (0, vitest_1.expect)((0, markdown_parser_1.filenameToTitle)("hello-world.md")).toBe("hello world");
    });
    (0, vitest_1.it)("replaces hyphens with spaces", () => {
        (0, vitest_1.expect)((0, markdown_parser_1.filenameToTitle)("my-article")).toBe("my article");
    });
    (0, vitest_1.it)("handles filenames without extension", () => {
        (0, vitest_1.expect)((0, markdown_parser_1.filenameToTitle)("no-extension")).toBe("no extension");
    });
    (0, vitest_1.it)("handles case-insensitive .MD extension", () => {
        (0, vitest_1.expect)((0, markdown_parser_1.filenameToTitle)("test.MD")).toBe("test");
    });
});
//# sourceMappingURL=markdown-parser.test.js.map
import { describe, it, expect, beforeEach } from "vitest";
import { SearchIndexService } from "./search-index-service";
import type { ArticleMeta } from "../../shared/types";

function makeArticle(overrides: Partial<ArticleMeta> = {}): ArticleMeta {
  return {
    title: "Test Article",
    filename: "test-article.md",
    tags: ["test"],
    created: "2024-01-01T00:00:00Z",
    modified: "2024-01-01T00:00:00Z",
    wikilinks: [],
    excerpt: "This is a test article with some content.",
    ...overrides,
  };
}

let service: SearchIndexService;

beforeEach(() => {
  service = new SearchIndexService();
});

// ─── buildIndex ─────────────────────────────────────────────────────────────

describe("buildIndex", () => {
  it("indexes all provided articles", async () => {
    const articles = [
      makeArticle({ title: "Alpha", filename: "alpha.md" }),
      makeArticle({ title: "Beta", filename: "beta.md" }),
    ];
    await service.buildIndex(articles);

    const results = await service.search("Alpha");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Alpha");
  });

  it("clears previous index on rebuild", async () => {
    await service.buildIndex([
      makeArticle({ title: "Old", filename: "old.md" }),
    ]);
    await service.buildIndex([
      makeArticle({ title: "New", filename: "new.md" }),
    ]);

    const oldResults = await service.search("Old");
    expect(oldResults).toHaveLength(0);

    const newResults = await service.search("New");
    expect(newResults).toHaveLength(1);
  });
});

// ─── addDocument / removeDocument ───────────────────────────────────────────

describe("addDocument", () => {
  it("makes article searchable after adding", async () => {
    service.addDocument(
      makeArticle({ title: "Dynamic", filename: "dynamic.md" }),
    );
    const results = await service.search("Dynamic");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Dynamic");
  });

  it("replaces existing article with same title", async () => {
    service.addDocument(
      makeArticle({
        title: "Dup",
        filename: "dup.md",
        excerpt: "original content",
      }),
    );
    service.addDocument(
      makeArticle({
        title: "Dup",
        filename: "dup.md",
        excerpt: "updated content",
      }),
    );

    const results = await service.search("Dup");
    expect(results).toHaveLength(1);
    expect(results[0].excerpt).toBe("updated content");
  });
});

describe("removeDocument", () => {
  it("removes article from search results", async () => {
    service.addDocument(makeArticle({ title: "Gone", filename: "gone.md" }));
    service.removeDocument("Gone");

    const results = await service.search("Gone");
    expect(results).toHaveLength(0);
  });

  it("does nothing for non-existent title", () => {
    // Should not throw
    expect(() => service.removeDocument("Nonexistent")).not.toThrow();
  });
});

// ─── search ─────────────────────────────────────────────────────────────────

describe("search", () => {
  it("returns empty array for empty query", async () => {
    service.addDocument(makeArticle());
    const results = await service.search("");
    expect(results).toEqual([]);
  });

  it("matches against title", async () => {
    service.addDocument(
      makeArticle({ title: "Quantum Physics", filename: "quantum.md" }),
    );
    const results = await service.search("Quantum");
    expect(results).toHaveLength(1);
    expect(results[0].matches.some((m) => m.field === "title")).toBe(true);
  });

  it("matches against content/excerpt", async () => {
    service.addDocument(
      makeArticle({
        title: "Cooking",
        filename: "cooking.md",
        excerpt: "A recipe for delicious chocolate cake with frosting.",
      }),
    );
    const results = await service.search("chocolate");
    expect(results).toHaveLength(1);
    expect(results[0].matches.some((m) => m.field === "content")).toBe(true);
  });

  it("matches against tags", async () => {
    service.addDocument(
      makeArticle({
        title: "Gardening",
        filename: "gardening.md",
        tags: ["plants", "outdoor"],
      }),
    );
    const results = await service.search("outdoor");
    expect(results).toHaveLength(1);
    expect(results[0].matches.some((m) => m.field === "tags")).toBe(true);
  });

  it("returns results sorted by score (title matches rank higher)", async () => {
    service.addDocument(
      makeArticle({
        title: "Electron Guide",
        filename: "electron-guide.md",
        excerpt: "A guide about building apps.",
        tags: ["dev"],
      }),
    );
    service.addDocument(
      makeArticle({
        title: "Building Apps",
        filename: "building.md",
        excerpt: "Learn about Electron framework for desktop apps.",
        tags: ["electron"],
      }),
    );

    const results = await service.search("Electron");
    expect(results.length).toBeGreaterThanOrEqual(1);
    // The article with "Electron" in the title should score higher
    if (results.length >= 2) {
      expect(results[0].title).toBe("Electron Guide");
    }
  });

  it("highlights matching terms in snippets", async () => {
    service.addDocument(
      makeArticle({
        title: "Rust Language",
        filename: "rust.md",
        excerpt: "Rust is a systems programming language.",
      }),
    );
    const results = await service.search("Rust");
    expect(results).toHaveLength(1);
    const titleMatch = results[0].matches.find((m) => m.field === "title");
    expect(titleMatch?.snippet).toContain("<mark>");
  });

  it("returns no results for unmatched query", async () => {
    service.addDocument(makeArticle({ title: "Hello", filename: "hello.md" }));
    const results = await service.search("zzzznonexistent");
    expect(results).toHaveLength(0);
  });

  it("matches a multi-keyword query when only some tokens hit (OR semantics)", async () => {
    service.addDocument(
      makeArticle({
        title: "Operating Model to Scale Generative AI",
        filename: "operating-model.md",
        excerpt:
          "Centrally led, BU-executed operating model with a GenAI CoE and upskilling tiers.",
        tags: ["mckinsey", "operating-model"],
      }),
    );
    // A long natural-language query: under FlexSearch's default AND
    // semantics this would return nothing because not every token is
    // present. The tolerant search must still surface the page.
    const results = await service.search(
      "operating model generative ai business unit enablement upskilling roadmap",
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toBe("Operating Model to Scale Generative AI");
  });

  it("matches terms living in searchBody beyond the 200-char excerpt", async () => {
    const deepTerm = "finops";
    const filler = "lorem ipsum ".repeat(40); // > 200 chars of preamble
    service.addDocument(
      makeArticle({
        title: "Platform Maturity",
        filename: "platform.md",
        excerpt: filler.slice(0, 200),
        searchBody: `${filler} ${deepTerm} framework for generative ai`,
      }),
    );
    const results = await service.search(deepTerm);
    expect(results).toHaveLength(1);
    expect(results[0].matches.some((m) => m.field === "content")).toBe(true);
  });
});

// ─── searchByTag ────────────────────────────────────────────────────────────

describe("searchByTag", () => {
  it("finds articles with matching frontmatter tag", async () => {
    await service.buildIndex([
      makeArticle({
        title: "A",
        filename: "a.md",
        tags: ["science", "physics"],
      }),
      makeArticle({ title: "B", filename: "b.md", tags: ["history"] }),
    ]);

    const results = service.searchByTag("science");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("A");
  });

  it("finds articles with inline tag in excerpt", async () => {
    await service.buildIndex([
      makeArticle({
        title: "Inline",
        filename: "inline.md",
        tags: [],
        excerpt: "Some text with #coding inline tag.",
      }),
    ]);

    const results = service.searchByTag("coding");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Inline");
  });

  it("handles # prefix in query", async () => {
    await service.buildIndex([
      makeArticle({ title: "Tagged", filename: "tagged.md", tags: ["wiki"] }),
    ]);

    const results = service.searchByTag("#wiki");
    expect(results).toHaveLength(1);
  });

  it("is case-insensitive", async () => {
    await service.buildIndex([
      makeArticle({ title: "Case", filename: "case.md", tags: ["JavaScript"] }),
    ]);

    const results = service.searchByTag("javascript");
    expect(results).toHaveLength(1);
  });

  it("returns empty array when no articles match tag", async () => {
    await service.buildIndex([
      makeArticle({ title: "X", filename: "x.md", tags: ["alpha"] }),
    ]);

    const results = service.searchByTag("nonexistent");
    expect(results).toHaveLength(0);
  });

  it("does not return articles without the tag", async () => {
    await service.buildIndex([
      makeArticle({ title: "Has", filename: "has.md", tags: ["target"] }),
      makeArticle({ title: "Not", filename: "not.md", tags: ["other"] }),
    ]);

    const results = service.searchByTag("target");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Has");
  });
});

import { describe, it, expect } from "vitest";
import type { ArticleMeta } from "../../shared/types";
import { filterArticlesForTab } from "../lib/file-classification";
import { sortNodes } from "./FilesView";

/**
 * Unit tests for FilesView TabBar logic.
 * Tests tab data, filtering integration, and keyboard navigation math
 * without requiring a DOM or React rendering environment.
 */

// ── Tab configuration (mirrors component) ──────────────────────

const tabs: { key: "wiki" | "raw"; label: string }[] = [
  { key: "wiki", label: "Wiki" },
  { key: "raw", label: "Raw" },
];

// Keyboard navigation logic (mirrors TabBar handleKeyDown)
function getNextTabIndex(
  currentKey: "wiki" | "raw",
  direction: "left" | "right",
): number {
  const currentIndex = tabs.findIndex((t) => t.key === currentKey);
  if (direction === "right") {
    return (currentIndex + 1) % tabs.length;
  }
  return (currentIndex - 1 + tabs.length) % tabs.length;
}

// ── Test fixtures ──────────────────────────────────────────────

function makeArticle(overrides: Partial<ArticleMeta> = {}): ArticleMeta {
  return {
    title: "Test Article",
    filename: "test.md",
    tags: [],
    created: "",
    modified: "",
    wikilinks: [],
    excerpt: "",
    ...overrides,
  };
}

const wikiArticle = makeArticle({
  title: "Wiki Page",
  filename: "wiki/wiki-page.md",
  tags: ["note"],
  created: "2024-01-01",
  modified: "2024-01-02",
});

const rawArticle = makeArticle({
  title: "",
  filename: "raw/raw-file.md",
  tags: [],
});

const configArticle = makeArticle({
  title: "Config",
  filename: ".CLAUDE.md",
  tags: ["config"],
});

const mixedArticles = [wikiArticle, rawArticle, configArticle];

// ── Tests ──────────────────────────────────────────────────────

describe("TabBar configuration", () => {
  it("has exactly two tabs: wiki and raw", () => {
    expect(tabs).toHaveLength(2);
    expect(tabs[0].key).toBe("wiki");
    expect(tabs[1].key).toBe("raw");
  });

  it("labels tabs as Wiki and Raw", () => {
    expect(tabs[0].label).toBe("Wiki");
    expect(tabs[1].label).toBe("Raw");
  });

  it("defaults active tab to wiki (first tab)", () => {
    const defaultTab = tabs[0].key;
    expect(defaultTab).toBe("wiki");
  });
});

describe("TabBar keyboard navigation", () => {
  it("ArrowRight from wiki moves to raw", () => {
    const nextIndex = getNextTabIndex("wiki", "right");
    expect(tabs[nextIndex].key).toBe("raw");
  });

  it("ArrowRight from raw wraps to wiki", () => {
    const nextIndex = getNextTabIndex("raw", "right");
    expect(tabs[nextIndex].key).toBe("wiki");
  });

  it("ArrowLeft from raw moves to wiki", () => {
    const nextIndex = getNextTabIndex("raw", "left");
    expect(tabs[nextIndex].key).toBe("wiki");
  });

  it("ArrowLeft from wiki wraps to raw", () => {
    const nextIndex = getNextTabIndex("wiki", "left");
    expect(tabs[nextIndex].key).toBe("raw");
  });
});

describe("Tab filtering integration", () => {
  it("wiki tab shows only wiki-classified articles", () => {
    const result = filterArticlesForTab(mixedArticles, "wiki");
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe("wiki/wiki-page.md");
  });

  it("raw tab shows only raw-classified articles", () => {
    const result = filterArticlesForTab(mixedArticles, "raw");
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe("raw/raw-file.md");
  });

  it("config files are excluded from both tabs", () => {
    const wikiResult = filterArticlesForTab(mixedArticles, "wiki");
    const rawResult = filterArticlesForTab(mixedArticles, "raw");
    const allFilenames = [...wikiResult, ...rawResult].map((a) => a.filename);
    expect(allFilenames).not.toContain(".CLAUDE.md");
  });

  it("counts reflect filtered article counts", () => {
    const wikiCount = filterArticlesForTab(mixedArticles, "wiki").length;
    const rawCount = filterArticlesForTab(mixedArticles, "raw").length;
    expect(wikiCount).toBe(1);
    expect(rawCount).toBe(1);
  });

  it("empty article list produces zero counts for both tabs", () => {
    expect(filterArticlesForTab([], "wiki")).toHaveLength(0);
    expect(filterArticlesForTab([], "raw")).toHaveLength(0);
  });
});

function articleMeta(overrides: Partial<ArticleMeta> & { filename: string }): ArticleMeta {
  return {
    title: overrides.title ?? "t",
    filename: overrides.filename,
    tags: overrides.tags ?? [],
    created: overrides.created ?? "",
    modified: overrides.modified ?? "",
    wikilinks: overrides.wikilinks ?? [],
    excerpt: overrides.excerpt ?? "",
  };
}

describe("sortNodes", () => {
  it("alpha mode keeps folders above files and sorts files by basename", () => {
    const nodes = [
      { type: "folder" as const, name: "projects", path: "wiki/projects", children: [] },
      { type: "file" as const, name: "apple", article: articleMeta({ filename: "wiki/apple.md" }) },
    ];
    const sorted = sortNodes(nodes, "alpha");
    expect(sorted[0]?.type).toBe("folder");
    expect(sorted[1]?.type).toBe("file");
  });

  it("alpha mode still reorders sibling folders when there are no files", () => {
    const nodes = [
      { type: "folder" as const, name: "zebra", path: "wiki/zebra", children: [] },
      { type: "folder" as const, name: "alpha", path: "wiki/alpha", children: [] },
    ];
    const sorted = sortNodes(nodes, "alpha");
    expect(sorted.map((n) => (n.type === "folder" ? n.name : ""))).toEqual(["alpha", "zebra"]);
  });

  it("modified mode keeps folders before files", () => {
    const nodes = [
      {
        type: "file" as const,
        name: "new",
        article: articleMeta({ filename: "wiki/new.md", modified: "2099-01-01T00:00:00Z" }),
      },
      { type: "folder" as const, name: "old", path: "wiki/old", children: [] },
    ];
    const sorted = sortNodes(nodes, "modified");
    expect(sorted[0]?.type).toBe("folder");
    expect(sorted[1]?.type).toBe("file");
  });

  it("alpha mode uses numeric order in basenames", () => {
    const nodes = [
      { type: "file" as const, name: "a10", article: articleMeta({ filename: "wiki/n10.md" }) },
      { type: "file" as const, name: "a2", article: articleMeta({ filename: "wiki/n2.md" }) },
    ];
    const sorted = sortNodes(nodes, "alpha");
    expect(sorted[0]?.type).toBe("file");
    expect(sorted[0]?.type === "file" && sorted[0].article.filename).toBe("wiki/n2.md");
    expect(sorted[1]?.type).toBe("file");
    expect(sorted[1]?.type === "file" && sorted[1].article.filename).toBe("wiki/n10.md");
  });
});

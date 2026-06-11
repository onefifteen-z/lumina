import { describe, it, expect, beforeEach } from "vitest";
import type { ArticleMeta } from "../../shared/types";
import { classifyFilename, filterArticlesForTab } from "../lib/file-classification";
import {
  ancestorFolderPaths,
  expandedStorageKey,
  loadExpandedFromStorage,
  rawFileIconKind,
  saveExpandedToStorage,
  sortNodes,
} from "./FilesView";

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

describe("ancestorFolderPaths", () => {
  it("returns parent chain for a deeply-nested file", () => {
    expect(ancestorFolderPaths("wiki/notes/2025/a.md")).toEqual([
      "wiki",
      "wiki/notes",
      "wiki/notes/2025",
    ]);
  });

  it("returns single root for a top-level file", () => {
    expect(ancestorFolderPaths("wiki/a.md")).toEqual(["wiki"]);
  });

  it("returns empty array for a bare filename (no folders to expand)", () => {
    expect(ancestorFolderPaths("a.md")).toEqual([]);
  });

  it("skips empty path segments produced by stray slashes", () => {
    expect(ancestorFolderPaths("wiki//notes/a.md")).toEqual(["wiki", "wiki/notes"]);
  });
});

describe("classifyFilename — cross-tab highlight routing", () => {
  it("routes wiki/ files to the wiki tab", () => {
    expect(classifyFilename("wiki/foo.md")).toBe("wiki");
  });

  it("routes raw/ files to the raw tab", () => {
    expect(classifyFilename("raw/notes/foo.pdf")).toBe("raw");
  });

  it("treats top-level (non-wiki) files as raw so they don't get lost", () => {
    // Anything outside of wiki/ falls into the Raw bucket; the highlight
    // sync logic relies on this to pick a non-empty tab.
    expect(classifyFilename("CLAUDE.md")).toBe("raw");
  });

  it("is case-insensitive on the top-level folder", () => {
    expect(classifyFilename("WIKI/foo.md")).toBe("wiki");
    expect(classifyFilename("Raw/foo.pdf")).toBe("raw");
  });
});

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

describe("expanded folder persistence helpers", () => {
  beforeEach(() => {
    const map = new Map<string, string>();
    (globalThis as unknown as { window: { localStorage: Storage } }).window = {
      localStorage: {
        getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
        setItem: (k: string, v: string) => {
          map.set(k, v);
        },
        removeItem: (k: string) => {
          map.delete(k);
        },
        clear: () => map.clear(),
        key: (i: number) => [...map.keys()][i] ?? null,
        get length() {
          return map.size;
        },
      } as Storage,
    };
  });

  it("saves and restores expanded paths for the same vault/tab key", () => {
    const vaultPath = "/tmp/vault-a";
    const tab = "raw" as const;
    saveExpandedToStorage(vaultPath, tab, new Set(["raw", "raw/images"]));
    expect(loadExpandedFromStorage(vaultPath, tab)).toEqual(
      new Set(["raw", "raw/images"]),
    );
  });

  it("uses distinct keys per vault and tab", () => {
    const k1 = expandedStorageKey("/tmp/a", "wiki");
    const k2 = expandedStorageKey("/tmp/a", "raw");
    const k3 = expandedStorageKey("/tmp/b", "wiki");
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k2).not.toBe(k3);
  });
});

describe("raw file icon mapping", () => {
  it("maps pdf to pdf icon kind", () => {
    expect(rawFileIconKind("raw/report.PDF")).toBe("pdf");
  });

  it("maps markdown to markdown icon kind", () => {
    expect(rawFileIconKind("raw/notes.md")).toBe("markdown");
    expect(rawFileIconKind("raw/notes.markdown")).toBe("markdown");
  });

  it("maps image extensions to image icon kind", () => {
    expect(rawFileIconKind("raw/pic.png")).toBe("image");
    expect(rawFileIconKind("raw/photo.JPEG")).toBe("image");
  });
});

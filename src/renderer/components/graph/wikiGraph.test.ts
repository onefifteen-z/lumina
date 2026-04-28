import { describe, expect, it } from "vitest";
import type { ArticleMeta } from "../../../shared/types";
import {
  DEFAULT_WIKI_GRAPH_FILTER_ENABLED,
  WIKI_GRAPH_ENTITY_TAG_OPTIONS,
  buildWikiGraph,
  buildWikiGraphTooltipMap,
  discoverWikiGraphFilterBuckets,
  excerptPreviewLines,
  filterArticlesForWikiGraph,
  formatArticleDateForGraph,
  wikiGraphFilterDiscoveryKey,
} from "./wikiGraph";

function meta(filename: string, overrides: Partial<ArticleMeta> = {}): ArticleMeta {
  return {
    title: "T",
    filename,
    tags: [],
    created: "",
    modified: "",
    wikilinks: [],
    excerpt: "",
    ...overrides,
  };
}

describe("discoverWikiGraphFilterBuckets", () => {
  it("collects first path segment and wiki-root md stems", () => {
    const articles = [
      meta("wiki/concepts/a.md"),
      meta("wiki/topics/b.md"),
      meta("wiki/index.md"),
      meta("wiki/log.md"),
      meta("wiki/sources/x.md"),
      meta("raw/nope.md"),
      meta("wiki/.hidden/x.md"),
    ];
    const b = discoverWikiGraphFilterBuckets(articles);
    expect(b.folderIds).toEqual(["concepts", "sources", "topics"]);
    expect(b.rootFileIds).toEqual(["index", "log"]);
  });

  it("wikiGraphFilterDiscoveryKey is stable for same ids", () => {
    const a = discoverWikiGraphFilterBuckets([meta("wiki/a/x.md"), meta("wiki/b.md")]);
    const b = discoverWikiGraphFilterBuckets([meta("wiki/a/y.md"), meta("wiki/b.md")]);
    expect(wikiGraphFilterDiscoveryKey(a)).toBe(wikiGraphFilterDiscoveryKey(b));
  });
});

describe("filterArticlesForWikiGraph", () => {
  it("keeps only enabled folders and root stems", () => {
    const articles = [
      meta("wiki/concepts/a.md"),
      meta("wiki/sources/b.md"),
      meta("wiki/index.md"),
    ];
    const enabled = new Set(["concepts", "index"]);
    const out = filterArticlesForWikiGraph(articles, enabled);
    expect(out.map((a) => a.filename).sort()).toEqual(["wiki/concepts/a.md", "wiki/index.md"]);
  });

  it("filters entities by enabled tag selections", () => {
    const articles = [
      meta("wiki/entities/acme.md", { tags: ["org"] }),
      meta("wiki/entities/alice.md", { tags: ["person"] }),
      meta("wiki/entities/misc.md", { tags: [] }),
      meta("wiki/concepts/c1.md"),
    ];
    const enabledFolders = new Set(["entities", "concepts"]);
    const out = filterArticlesForWikiGraph(articles, enabledFolders, new Set<typeof WIKI_GRAPH_ENTITY_TAG_OPTIONS[number]>(["org"]));
    expect(out.map((a) => a.filename).sort()).toEqual([
      "wiki/concepts/c1.md",
      "wiki/entities/acme.md",
      "wiki/entities/misc.md",
    ]);
  });
});

describe("DEFAULT_WIKI_GRAPH_FILTER_ENABLED", () => {
  it("includes concepts, entities, topics, analytics, and analyses", () => {
    expect(DEFAULT_WIKI_GRAPH_FILTER_ENABLED.has("concepts")).toBe(true);
    expect(DEFAULT_WIKI_GRAPH_FILTER_ENABLED.has("entities")).toBe(true);
    expect(DEFAULT_WIKI_GRAPH_FILTER_ENABLED.has("topics")).toBe(true);
    expect(DEFAULT_WIKI_GRAPH_FILTER_ENABLED.has("analytics")).toBe(true);
    expect(DEFAULT_WIKI_GRAPH_FILTER_ENABLED.has("analyses")).toBe(true);
  });
});

describe("WIKI_GRAPH_ENTITY_TAG_OPTIONS", () => {
  it("includes org and person tags", () => {
    expect(WIKI_GRAPH_ENTITY_TAG_OPTIONS).toEqual(["org", "person"]);
  });
});

describe("excerptPreviewLines", () => {
  it("takes first lines when newlines exist", () => {
    expect(excerptPreviewLines("a\nb\nc\nd", 3)).toBe("a\nb\nc");
  });
});

describe("formatArticleDateForGraph", () => {
  it("returns em dash for empty / null", () => {
    expect(formatArticleDateForGraph("")).toBe("—");
    expect(formatArticleDateForGraph("  ")).toBe("—");
    expect(formatArticleDateForGraph(null)).toBe("—");
    expect(formatArticleDateForGraph(undefined)).toBe("—");
  });

  it("accepts Date objects (YAML date deserialization)", () => {
    const d = new Date("2024-03-20T15:00:00.000Z");
    const out = formatArticleDateForGraph(d);
    expect(out).not.toBe("—");
    expect(out).toMatch(/2024/);
  });
});

describe("buildWikiGraphTooltipMap", () => {
  it("counts distinct in/out wiki links", () => {
    const articles = [
      meta("wiki/a.md", {
        title: "A",
        wikilinks: ["B", "B"],
        excerpt: "line1\nline2",
        tags: ["t1"],
        created: "2024-01-15T12:00:00.000Z",
      }),
      meta("wiki/b.md", { title: "B", wikilinks: ["A"], excerpt: "", tags: [], created: "" }),
    ];
    const m = buildWikiGraphTooltipMap(articles);
    const ta = m.get("wiki/a.md")!;
    const tb = m.get("wiki/b.md")!;
    expect(ta.outCount).toBe(1);
    expect(ta.inCount).toBe(1);
    expect(tb.outCount).toBe(1);
    expect(tb.inCount).toBe(1);
    expect(ta.excerpt).toContain("line1");
  });

  it("handles created as Date without throwing", () => {
    const articles = [
      meta("wiki/dated.md", {
        title: "D",
        created: new Date("2024-05-01T00:00:00.000Z") as unknown as string,
      }),
    ];
    const m = buildWikiGraphTooltipMap(articles);
    const t = m.get("wiki/dated.md")!;
    expect(t.createdLabel).toMatch(/2024/);
    expect(t.fullTitle).toBe("D");
  });
});

describe("buildWikiGraph", () => {
  it("annotates entity nodes with org/person tags", () => {
    const g = buildWikiGraph([
      meta("wiki/entities/acme.md", { tags: ["org"] }),
      meta("wiki/entities/alice.md", { tags: ["person"] }),
      meta("wiki/entities/misc.md", { tags: [] }),
      meta("wiki/concepts/c1.md", { tags: ["org"] }),
    ]);
    const tagById = new Map(g.nodes.map((n) => [n.id, n.entityTag]));
    expect(tagById.get("wiki/entities/acme.md")).toBe("org");
    expect(tagById.get("wiki/entities/alice.md")).toBe("person");
    expect(tagById.get("wiki/entities/misc.md")).toBeNull();
    expect(tagById.get("wiki/concepts/c1.md")).toBeNull();
  });
});

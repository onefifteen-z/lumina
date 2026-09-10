import { describe, it, expect, vi } from "vitest";
import { SearchIndexService } from "./search-index-service";
import { WikiSearchRouter } from "./wiki-search-router";
import type { QmdSearchService } from "./qmd-search-service";

function mockFlexIndex(
  results: Array<{ title: string; filename: string; excerpt: string; score: number }>,
): SearchIndexService {
  const svc = new SearchIndexService();
  vi.spyOn(svc, "search").mockResolvedValue(
    results.map((r) => ({
      ...r,
      matches: [],
    })),
  );
  return svc;
}

function mockQmd(
  hits: Array<{ title: string; filename: string; excerpt: string }>,
  ready = true,
): QmdSearchService {
  return {
    isReady: () => ready,
    search: vi.fn().mockResolvedValue(hits),
  } as unknown as QmdSearchService;
}

describe("WikiSearchRouter", () => {
  it("uses QMD when enabled and ready", async () => {
    const flex = mockFlexIndex([
      { title: "Flex", filename: "flex.md", excerpt: "flex hit", score: 1 },
    ]);
    const qmd = mockQmd([
      { title: "QMD", filename: "qmd.md", excerpt: "semantic hit" },
    ]);
    const router = new WikiSearchRouter(flex, qmd, () => true);
    const results = await router.search("deployment process");
    expect(results).toEqual([
      { title: "QMD", filename: "qmd.md", excerpt: "semantic hit" },
    ]);
    expect(qmd.search).toHaveBeenCalledWith("deployment process");
  });

  it("falls back to FlexSearch when QMD returns no hits", async () => {
    const flex = mockFlexIndex([
      { title: "Flex", filename: "flex.md", excerpt: "flex hit", score: 2 },
    ]);
    const qmd = mockQmd([]);
    const router = new WikiSearchRouter(flex, qmd, () => true);
    const results = await router.search("keyword");
    expect(results).toEqual([
      { title: "Flex", filename: "flex.md", excerpt: "flex hit" },
    ]);
  });

  it("falls back to FlexSearch when QMD is disabled", async () => {
    const flex = mockFlexIndex([
      { title: "Flex", filename: "flex.md", excerpt: "flex hit", score: 2 },
    ]);
    const qmd = mockQmd([
      { title: "QMD", filename: "qmd.md", excerpt: "semantic hit" },
    ]);
    const router = new WikiSearchRouter(flex, qmd, () => false);
    const results = await router.search("keyword");
    expect(results).toEqual([
      { title: "Flex", filename: "flex.md", excerpt: "flex hit" },
    ]);
    expect(qmd.search).not.toHaveBeenCalled();
  });

  it("falls back to FlexSearch when QMD is not ready", async () => {
    const flex = mockFlexIndex([
      { title: "Flex", filename: "flex.md", excerpt: "flex hit", score: 2 },
    ]);
    const qmd = mockQmd(
      [{ title: "QMD", filename: "qmd.md", excerpt: "semantic hit" }],
      false,
    );
    const router = new WikiSearchRouter(flex, qmd, () => true);
    const results = await router.search("keyword");
    expect(results).toEqual([
      { title: "Flex", filename: "flex.md", excerpt: "flex hit" },
    ]);
  });
});

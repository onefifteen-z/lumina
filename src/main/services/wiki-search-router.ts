import type { SearchIndexService } from "./search-index-service";
import type { QmdSearchService, WikiSearchHit } from "./qmd-search-service";

/**
 * Routes Chat `search_wiki` through QMD when enabled and ready, with
 * FlexSearch fallback. UI IPC search always uses FlexSearch directly.
 */
export class WikiSearchRouter {
  constructor(
    private readonly flexSearch: SearchIndexService,
    private qmd: QmdSearchService | null,
    private readonly isQmdEnabled: () => boolean,
  ) {}

  setQmdService(qmd: QmdSearchService | null): void {
    this.qmd = qmd;
  }

  async search(query: string): Promise<WikiSearchHit[]> {
    if (this.isQmdEnabled() && this.qmd?.isReady()) {
      try {
        const results = await this.qmd.search(query);
        if (results.length > 0) return results;
      } catch (err) {
        console.warn("QMD search failed, falling back to FlexSearch:", err);
      }
    }
    const flexResults = await this.flexSearch.search(query);
    return flexResults.map((r) => ({
      title: r.title,
      filename: r.filename,
      excerpt: r.excerpt,
    }));
  }
}

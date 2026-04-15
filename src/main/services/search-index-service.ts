import type {
  ArticleMeta,
  SearchResult,
  SearchMatch,
} from "../../shared/types";

// FlexSearch v0.7.x has limited ESM/TS support — use require
// eslint-disable-next-line @typescript-eslint/no-var-requires
const FlexSearch = require("flexsearch");

/**
 * Wraps FlexSearch to provide full-text search and tag-based filtering
 * across all wiki articles.
 */
export class SearchIndexService {
  private titleIndex: InstanceType<typeof FlexSearch.Index>;
  private contentIndex: InstanceType<typeof FlexSearch.Index>;
  private tagsIndex: InstanceType<typeof FlexSearch.Index>;

  /** Map from numeric ID to ArticleMeta for lookup after search */
  private articles: Map<number, ArticleMeta> = new Map();
  /** Map from article title to numeric ID for removal */
  private titleToId: Map<string, number> = new Map();
  private nextId = 0;

  constructor() {
    const indexOptions = { tokenize: "forward", resolution: 9 };
    this.titleIndex = new FlexSearch.Index(indexOptions);
    this.contentIndex = new FlexSearch.Index(indexOptions);
    this.tagsIndex = new FlexSearch.Index(indexOptions);
  }

  /**
   * Build the search index from a full set of articles.
   * Clears any existing index data first.
   */
  async buildIndex(articles: ArticleMeta[]): Promise<void> {
    // Reset state
    this.articles.clear();
    this.titleToId.clear();
    this.nextId = 0;

    this.titleIndex = new FlexSearch.Index({
      tokenize: "forward",
      resolution: 9,
    });
    this.contentIndex = new FlexSearch.Index({
      tokenize: "forward",
      resolution: 9,
    });
    this.tagsIndex = new FlexSearch.Index({
      tokenize: "forward",
      resolution: 9,
    });

    for (const article of articles) {
      this.addDocument(article);
    }
  }

  /**
   * Add a single article to the index (incremental update).
   */
  addDocument(article: ArticleMeta): void {
    // If already indexed, remove first
    if (this.titleToId.has(article.title)) {
      this.removeDocument(article.title);
    }

    const id = this.nextId++;
    this.articles.set(id, article);
    this.titleToId.set(article.title, id);

    this.titleIndex.add(id, article.title);
    this.contentIndex.add(id, article.excerpt);
    this.tagsIndex.add(id, article.tags.join(" "));
  }

  /**
   * Remove an article from the index by title.
   */
  removeDocument(title: string): void {
    const id = this.titleToId.get(title);
    if (id === undefined) return;

    this.titleIndex.remove(id);
    this.contentIndex.remove(id);
    this.tagsIndex.remove(id);
    this.articles.delete(id);
    this.titleToId.delete(title);
  }

  /**
   * Full-text search across title, content, and tags.
   * Returns SearchResult[] with score and match snippets.
   */
  async search(query: string): Promise<SearchResult[]> {
    if (!query.trim()) return [];

    const titleHits: number[] = this.titleIndex.search(query, { limit: 100 });
    const contentHits: number[] = this.contentIndex.search(query, {
      limit: 100,
    });
    const tagsHits: number[] = this.tagsIndex.search(query, { limit: 100 });

    // Merge results with scoring: title matches score highest
    const scoreMap = new Map<
      number,
      { score: number; matches: SearchMatch[] }
    >();

    for (const id of titleHits) {
      const article = this.articles.get(id);
      if (!article) continue;
      const entry = scoreMap.get(id) || { score: 0, matches: [] };
      entry.score += 3;
      entry.matches.push({
        field: "title",
        snippet: this.highlightMatch(article.title, query),
      });
      scoreMap.set(id, entry);
    }

    for (const id of contentHits) {
      const article = this.articles.get(id);
      if (!article) continue;
      const entry = scoreMap.get(id) || { score: 0, matches: [] };
      entry.score += 2;
      entry.matches.push({
        field: "content",
        snippet: this.buildSnippet(article.excerpt, query),
      });
      scoreMap.set(id, entry);
    }

    for (const id of tagsHits) {
      const article = this.articles.get(id);
      if (!article) continue;
      const entry = scoreMap.get(id) || { score: 0, matches: [] };
      entry.score += 1;
      entry.matches.push({
        field: "tags",
        snippet: this.highlightMatch(article.tags.join(", "), query),
      });
      scoreMap.set(id, entry);
    }

    const results: SearchResult[] = [];
    for (const [id, { score, matches }] of scoreMap) {
      const article = this.articles.get(id);
      if (!article) continue;
      results.push({
        title: article.title,
        filename: article.filename,
        excerpt: article.excerpt,
        matches,
        score,
      });
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Filter articles by tag. Checks both frontmatter tags and inline tag
   * occurrences in the excerpt/content.
   */
  searchByTag(tag: string): ArticleMeta[] {
    const normalizedTag = tag.replace(/^#/, "").toLowerCase();
    const results: ArticleMeta[] = [];

    for (const article of this.articles.values()) {
      const hasFrontmatterTag = article.tags.some(
        (t) => t.toLowerCase() === normalizedTag,
      );
      const hasInlineTag = article.excerpt
        .toLowerCase()
        .includes(`#${normalizedTag}`);

      if (hasFrontmatterTag || hasInlineTag) {
        results.push(article);
      }
    }

    return results;
  }

  /**
   * Build a snippet showing context around the matching term,
   * with the match wrapped in <mark> tags.
   */
  private buildSnippet(text: string, query: string): string {
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const idx = lowerText.indexOf(lowerQuery);

    if (idx === -1) {
      // FlexSearch tokenizer may match partial — return start of text
      return text.slice(0, 100) + (text.length > 100 ? "..." : "");
    }

    const contextChars = 40;
    const start = Math.max(0, idx - contextChars);
    const end = Math.min(text.length, idx + query.length + contextChars);

    let snippet = "";
    if (start > 0) snippet += "...";
    const raw = text.slice(start, end);
    snippet += this.highlightMatch(raw, query);
    if (end < text.length) snippet += "...";

    return snippet;
  }

  /**
   * Wrap occurrences of query in <mark> tags (case-insensitive).
   */
  private highlightMatch(text: string, query: string): string {
    if (!query) return text;
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(${escaped})`, "gi");
    return text.replace(regex, "<mark>$1</mark>");
  }
}

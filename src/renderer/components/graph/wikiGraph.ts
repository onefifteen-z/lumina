import type { ArticleMeta } from "../../../shared/types";

/** Gray-matter / YAML may deserialize dates and other scalars to non-strings. */
function metaString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return String(value);
}

/**
 * Default-on folder ids for the graph filter. Matches user preference
 * (concepts, analytics, entities, topics) plus `analyses` for CLAUDE.md
 * vaults that use wiki/analyses/ instead of a folder named analytics.
 */
export const DEFAULT_WIKI_GRAPH_FILTER_ENABLED = new Set([
  "concepts",
  "analytics",
  "entities",
  "topics",
  "analyses",
]);

export const WIKI_GRAPH_ENTITY_TAG_OPTIONS = ["org", "person"] as const;
export type WikiGraphEntityTag = (typeof WIKI_GRAPH_ENTITY_TAG_OPTIONS)[number];

export interface WikiGraphFilterBuckets {
  /** First path segment under wiki/, lowercased (e.g. concepts, sources). */
  folderIds: string[];
  /** Basename of markdown files directly under wiki/, lowercased (e.g. index, log). */
  rootFileIds: string[];
}

function isWikiPathExcluded(filename: string): boolean {
  return !filename.startsWith("wiki/") || filename.split("/").some((s) => s.startsWith("."));
}

/** Discover folder names and wiki-root .md stems present in the vault. */
export function discoverWikiGraphFilterBuckets(articles: ArticleMeta[]): WikiGraphFilterBuckets {
  const folders = new Set<string>();
  const roots = new Set<string>();
  for (const a of articles) {
    const f = a.filename;
    if (isWikiPathExcluded(f)) continue;
    const rest = f.slice("wiki/".length);
    if (!/\.md$/i.test(rest)) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) {
      roots.add(rest.replace(/\.md$/i, "").toLowerCase());
    } else {
      folders.add(rest.slice(0, slash).toLowerCase());
    }
  }
  return {
    folderIds: [...folders].sort(),
    rootFileIds: [...roots].sort(),
  };
}

/** Stable key when the set of filter ids changes (new folder or root file category). */
export function wikiGraphFilterDiscoveryKey(buckets: WikiGraphFilterBuckets): string {
  return `${buckets.folderIds.join("/")}\n${buckets.rootFileIds.join("/")}`;
}

function articleEntityTagForGraph(article: ArticleMeta): WikiGraphEntityTag | null {
  if (!article.filename.toLowerCase().startsWith("wiki/entities/")) return null;
  const tags = Array.isArray(article.tags) ? article.tags : [];
  const norm = new Set(tags.map((t) => String(t).trim().toLowerCase()));
  for (const tag of WIKI_GRAPH_ENTITY_TAG_OPTIONS) {
    if (norm.has(tag)) return tag;
  }
  return null;
}

/** Keep only wiki articles whose folder or root stem is in `enabledIds`. */
export function filterArticlesForWikiGraph(
  articles: ArticleMeta[],
  enabledIds: Set<string>,
  enabledEntityTags: Set<WikiGraphEntityTag> = new Set(WIKI_GRAPH_ENTITY_TAG_OPTIONS),
): ArticleMeta[] {
  return articles.filter((a) => {
    const f = a.filename;
    if (isWikiPathExcluded(f)) return false;
    const rest = f.slice("wiki/".length);
    if (!/\.md$/i.test(rest)) return false;
    const slash = rest.indexOf("/");
    if (slash === -1) {
      const stem = rest.replace(/\.md$/i, "").toLowerCase();
      return enabledIds.has(stem);
    }
    const folder = rest.slice(0, slash).toLowerCase();
    if (!enabledIds.has(folder)) return false;
    const entityTag = articleEntityTagForGraph(a);
    if (entityTag && !enabledEntityTags.has(entityTag)) return false;
    return true;
  });
}

/** Show only the leaf name — strip folder prefix if title is path-derived. */
export function displayTitle(article: ArticleMeta): string {
  const t = metaString(article.title);
  if (t.includes("/")) {
    const basename = article.filename.split("/").pop() ?? article.filename;
    return basename.replace(/\.md$/i, "");
  }
  return t;
}

export interface WikiGraphNode {
  id: string;
  title: string;
  filename: string;
  linkCount: number;
  /**
   * Specific entity sub-type for filter UI (`org` / `person`). Drives the
   * "show only orgs / only people" toggles and stays narrow on purpose —
   * adding a generic `entity` value here would force every "entity tag"
   * checkbox elsewhere to grow a third option.
   */
  entityTag: WikiGraphEntityTag | null;
  /**
   * Whether the article lives under `wiki/entities/`. Used purely for
   * coloring: every entity (org, person, or otherwise) should render with
   * the unified entity blue so untagged entity pages aren't visually
   * orphaned among concepts/topics. Independent of `entityTag` so that a
   * future fourth filter category doesn't have to retrofit the colour
   * branch.
   */
  isEntity: boolean;
}

export interface WikiGraphLink {
  source: string;
  target: string;
}

export interface WikiGraphData {
  nodes: WikiGraphNode[];
  links: WikiGraphLink[];
}

/** Rich hover payload for graph nodes (same wiki scope as `buildWikiGraph`). */
export interface WikiGraphNodeTooltip {
  filename: string;
  fullTitle: string;
  excerpt: string;
  tags: string[];
  createdLabel: string;
  inCount: number;
  outCount: number;
}

/** First up to `maxLines` logical lines from excerpt (newline-split; long single line is truncated). */
export function excerptPreviewLines(excerpt: string, maxLines: number): string {
  const raw = excerpt.trim();
  if (!raw) return "";
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length >= 2) {
    return lines.slice(0, maxLines).join("\n");
  }
  const one = lines[0] ?? raw;
  const approxCharsPerLine = 72;
  const maxChars = approxCharsPerLine * maxLines;
  if (one.length <= maxChars) return one;
  return `${one.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function formatArticleDateForGraph(iso: unknown): string {
  // `String(...)` guards against any non-string return if callers bypass normalization.
  const raw = String(metaString(iso)).trim();
  if (!raw) return "—";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw.length >= 10 ? raw.slice(0, 10) : raw;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Per-file tooltip fields + directed wiki link counts (distinct targets / distinct sources).
 * Uses the same title resolution rules as the graph edges.
 */
export function buildWikiGraphTooltipMap(articles: ArticleMeta[]): Map<string, WikiGraphNodeTooltip> {
  const wikiArticles = articles.filter((a) => !isWikiPathExcluded(a.filename));

  const titleMap = new Map<string, string>();
  for (const a of wikiArticles) {
    const titleNorm = metaString(a.title);
    titleMap.set(titleNorm.toLowerCase(), a.filename);
    const stem = a.filename.split("/").pop()?.replace(/\.md$/i, "") ?? "";
    if (stem) titleMap.set(stem.toLowerCase(), a.filename);
    if (titleNorm.includes("/")) {
      const baseStem = titleNorm.split("/").pop()?.trim() ?? "";
      if (baseStem) titleMap.set(baseStem.toLowerCase(), a.filename);
    }
  }

  const inboundSources = new Map<string, Set<string>>();
  const outboundTargets = new Map<string, Set<string>>();

  for (const a of wikiArticles) {
    const outSet = new Set<string>();
    for (const target of a.wikilinks) {
      const tf = titleMap.get(target.toLowerCase());
      if (!tf || tf === a.filename) continue;
      outSet.add(tf);
      if (!inboundSources.has(tf)) inboundSources.set(tf, new Set());
      inboundSources.get(tf)!.add(a.filename);
    }
    outboundTargets.set(a.filename, outSet);
  }

  const map = new Map<string, WikiGraphNodeTooltip>();
  for (const a of wikiArticles) {
    const outs = outboundTargets.get(a.filename)?.size ?? 0;
    const ins = inboundSources.get(a.filename)?.size ?? 0;
    map.set(a.filename, {
      filename: a.filename,
      fullTitle: metaString(a.title).trim() || a.filename,
      // Keep enough lines so headings/tables survive markdown preview in graph popup.
      excerpt: excerptPreviewLines(metaString(a.excerpt), 8),
      tags: Array.isArray(a.tags) ? a.tags.map((t) => (typeof t === "string" ? t : String(t))) : [],
      createdLabel: formatArticleDateForGraph(a.created),
      inCount: ins,
      outCount: outs,
    });
  }
  return map;
}

/** Build nodes and resolved wikilinks for wiki/ articles only. */
export function buildWikiGraph(articles: ArticleMeta[]): WikiGraphData {
  const wikiArticles = articles.filter((a) => !isWikiPathExcluded(a.filename));

  const titleMap = new Map<string, string>();
  for (const a of wikiArticles) {
    const titleNorm = metaString(a.title);
    titleMap.set(titleNorm.toLowerCase(), a.filename);
    const stem = a.filename.split("/").pop()?.replace(/\.md$/i, "") ?? "";
    if (stem) titleMap.set(stem.toLowerCase(), a.filename);
    if (titleNorm.includes("/")) {
      const baseStem = titleNorm.split("/").pop()?.trim() ?? "";
      if (baseStem) titleMap.set(baseStem.toLowerCase(), a.filename);
    }
  }

  const nodes: WikiGraphNode[] = wikiArticles.map((a) => ({
    id: a.filename,
    title: displayTitle(a),
    filename: a.filename,
    linkCount: 0,
    entityTag: articleEntityTagForGraph(a),
    isEntity: a.filename.toLowerCase().startsWith("wiki/entities/"),
  }));

  const links: WikiGraphLink[] = [];
  const seen = new Set<string>();
  for (const a of wikiArticles) {
    for (const target of a.wikilinks) {
      const targetFilename = titleMap.get(target.toLowerCase());
      if (!targetFilename || targetFilename === a.filename) continue;
      const key = [a.filename, targetFilename].sort().join("→");
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: a.filename, target: targetFilename });
    }
  }

  const countMap = new Map<string, number>();
  for (const l of links) {
    countMap.set(l.source, (countMap.get(l.source) ?? 0) + 1);
    countMap.set(l.target, (countMap.get(l.target) ?? 0) + 1);
  }
  for (const n of nodes) n.linkCount = countMap.get(n.id) ?? 0;

  return { nodes, links };
}

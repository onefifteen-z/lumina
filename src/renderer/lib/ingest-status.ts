import type { ArticleMeta } from "../../shared/types";

/**
 * Normalise a `sources` frontmatter entry to a vault-relative-ish key.
 *
 * `sources` can be written in several styles by humans and the model:
 *   - `raw/foo.pdf`          ← canonical
 *   - `./raw/foo.pdf`        ← relative-style
 *   - `/raw/foo.pdf`         ← absolute-style
 *   - `` `raw/foo.pdf` ``    ← code-fenced for emphasis
 *   - `[[raw/foo.pdf]]`      ← wikilink-like
 *   - `[[raw/foo.pdf|Foo]]`  ← wikilink with display alias
 *   - `foo.pdf`              ← just the basename (matched by basename later)
 *
 * This helper strips formatting noise so the resulting string can be
 * compared against `article.filename` values directly. Empty input
 * (or input that strips to empty) returns `""`.
 *
 * Pure function. Exported for reuse by `ArticleBrowser` (which used to
 * carry its own private copy) and by the ingest-status set computation.
 */
export function normalizeSourceRef(value: string): string {
  let ref = value.trim();
  if (!ref) return "";
  if (ref.startsWith("`") && ref.endsWith("`") && ref.length > 1) {
    ref = ref.slice(1, -1).trim();
  }
  if (ref.startsWith("[[") && ref.endsWith("]]")) {
    ref = ref.slice(2, -2).trim();
  }
  const pipe = ref.indexOf("|");
  if (pipe >= 0) ref = ref.slice(0, pipe).trim();
  if (ref.startsWith("./")) ref = ref.slice(2);
  if (ref.startsWith("/")) ref = ref.slice(1);
  // Unicode-normalize so an NFD-encoded disk filename (typical of macOS
  // HFS+ / older AirDrop / iCloud transfer paths) matches an NFC-encoded
  // frontmatter reference written by the chat agent. Without this, e.g.
  // `沖プラ定例` in NFD (フ + ゜) and the same string in NFC (プ as a
  // single codepoint) compare unequal even though they render identically.
  return ref.normalize("NFC");
}

/** Lowercase, NFC-normalized basename (last `/`-delimited segment) of a path. Returns "" for empty. */
function basenameLower(p: string): string {
  if (!p) return "";
  const i = p.lastIndexOf("/");
  return (i === -1 ? p : p.slice(i + 1)).toLowerCase().normalize("NFC");
}

/**
 * Reduce a file basename to a comparable stem so a raw file can be matched
 * against the wiki/sources/ page that summarises it even when the dates are
 * formatted differently.
 *
 * Example pairings the wiki/CLAUDE.md ingest workflow produces in practice:
 *
 *   raw/meeting_memo/20260422_書類作成業務ヒアリング.md   ↔
 *   wiki/sources/2026-04-22-書類作成業務ヒアリング.md
 *
 *   raw/2024-q4/summary.pdf                              ↔
 *   wiki/sources/summary.md
 *
 * The transform:
 *   1. Take the last `/`-segment.
 *   2. Drop the extension.
 *   3. Strip a leading date pattern (`YYYYMMDD`, `YYYY-MM-DD`, `YYYY_MM_DD`,
 *      `YYYY/MM/DD`) plus any trailing separator.
 *   4. Strip leftover leading separators (`-_./`).
 *   5. Lowercase + trim.
 *
 * Returns `""` for inputs that strip to empty or are shorter than 2 chars
 * after normalisation (a single-letter stem like "a" would match an
 * implausibly large set of files; better to skip the heuristic than to
 * flag random false positives).
 */
export function ingestStem(filename: string): string {
  if (!filename) return "";
  const base = filename.split("/").pop() ?? filename;
  // NFC-normalize before any string ops. Disk filenames on macOS may be
  // NFD (decomposed) while filenames written by the chat agent are NFC.
  // Without this, two filenames that render identically (e.g. `プ` as the
  // single codepoint U+30D7 vs `フ` U+30D5 + U+309A) hash to different
  // stems and the badge silently goes missing.
  let stem = base.normalize("NFC").replace(/\.[^./]+$/, "").toLowerCase();
  stem = stem.replace(/^\d{4}[-_/]?\d{2}[-_/]?\d{2}[-_./]?/, "");
  stem = stem.replace(/^[-_./]+/, "").trim();
  return stem.length < 2 ? "" : stem;
}

/**
 * Compute the set of raw filenames (vault-relative paths, e.g.
 * `raw/2025-10-21-foo.pdf`) that have been ingested into the wiki.
 *
 * A raw file counts as ingested when ANY of the following hold:
 *
 *   (A) Some wiki page declares it in its `sources` frontmatter field.
 *       This is the canonical signal — explicit and unambiguous.
 *       Matching is fuzzy on the reference: full vault-relative path,
 *       basename, wikilink, `./` / `/` prefixed, or backticked all work.
 *
 *   (B) Some `wiki/sources/<slug>.md` page exists whose slug-stem
 *       (basename minus extension and minus a leading `YYYYMMDD`-style
 *       date) equals the raw file's stem. This is the convention-based
 *       signal — CLAUDE.md's ingest workflow says "create a summary
 *       page in wiki/sources/ named after the source file", and the
 *       model often does that without echoing the raw path back into
 *       `sources:` frontmatter. Without this fallback those files
 *       would silently lose the badge despite being fully ingested.
 *
 * Returns a set of full vault-relative raw filenames. Stable, pure, and
 * safe to memoise against `articles` identity.
 */
export function computeIngestedRawFiles(articles: ArticleMeta[]): Set<string> {
  // ── Step 1 (signal A): gather explicit `sources:` references.
  const refKeys = new Set<string>();
  for (const article of articles) {
    if (!isWikiArticle(article)) continue;
    const sources = article.sources;
    if (!sources || sources.length === 0) continue;
    for (const raw of sources) {
      const normalised = normalizeSourceRef(raw);
      if (!normalised) continue;
      refKeys.add(normalised.toLowerCase());
      const base = basenameLower(normalised);
      if (base) refKeys.add(base);
    }
  }

  // ── Step 2 (signal B): index wiki/sources/ pages by ingestStem.
  // We only consider files directly under `wiki/sources/` to keep the
  // heuristic narrow — matching the schema in CLAUDE.md exactly. A
  // wiki/concepts/foo.md page that happens to share a stem with a raw
  // file is NOT enough to claim "ingested".
  const sourceStems = new Set<string>();
  for (const article of articles) {
    if (!article.filename.toLowerCase().startsWith("wiki/sources/")) continue;
    const stem = ingestStem(article.filename);
    if (stem) sourceStems.add(stem);
  }

  // ── Step 3: match raw files against either signal.
  const ingested = new Set<string>();
  if (refKeys.size === 0 && sourceStems.size === 0) return ingested;
  for (const article of articles) {
    if (!isRawArticle(article)) continue;
    // NFC-normalize the disk filename so it can compare equal to the
    // (NFC-normalized) refKeys harvested from frontmatter. `basenameLower`
    // already normalizes its return value.
    const filenameLower = article.filename.toLowerCase().normalize("NFC");
    const base = basenameLower(article.filename);
    if (refKeys.has(filenameLower) || (base && refKeys.has(base))) {
      ingested.add(article.filename);
      continue;
    }
    const stem = ingestStem(article.filename);
    if (stem && sourceStems.has(stem)) {
      ingested.add(article.filename);
    }
  }
  return ingested;
}

function topFolder(filename: string): string {
  return filename.split("/")[0]?.toLowerCase() ?? "";
}

function isWikiArticle(article: ArticleMeta): boolean {
  return topFolder(article.filename) === "wiki";
}

function isRawArticle(article: ArticleMeta): boolean {
  return topFolder(article.filename) === "raw";
}

function normalizeVaultPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/**
 * List vault-relative `raw/` files under `folderPath` (recursive) that are
 * not yet marked ingested by {@link computeIngestedRawFiles}.
 */
export function collectNonIngestedRawFilesInFolder(
  folderPath: string,
  articles: readonly ArticleMeta[],
  ingestedRawSet: ReadonlySet<string>,
): string[] {
  const folder = normalizeVaultPath(folderPath);
  const lower = folder.toLowerCase();
  if (lower !== "raw" && !lower.startsWith("raw/")) return [];

  const prefix = `${folder}/`;
  return articles
    .map((a) => normalizeVaultPath(a.filename))
    .filter((filename) => {
      if (topFolder(filename) !== "raw") return false;
      if (filename !== folder && !filename.startsWith(prefix)) return false;
      return !ingestedRawSet.has(filename);
    })
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
}

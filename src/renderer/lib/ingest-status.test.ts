import { describe, it, expect } from "vitest";
import type { ArticleMeta } from "../../shared/types";
import {
  normalizeSourceRef,
  computeIngestedRawFiles,
  ingestStem,
} from "./ingest-status";

/**
 * Pin the contract for the file-tree "Ingested" badge. The product
 * behaviour we lock in:
 *
 *   1. A raw/ file is shown as ingested iff some wiki/ page references
 *      it in its `sources` frontmatter field.
 *   2. The reference can be a canonical path (`raw/foo.pdf`), a basename
 *      (`foo.pdf`), a wikilink (`[[raw/foo.pdf]]`), an aliased wikilink
 *      (`[[raw/foo.pdf|Foo]]`), or code-fenced — all of which are
 *      common dialects the wiki maintainer and the model both produce.
 *   3. Case is normalised — `RAW/Foo.PDF` in the source ref still
 *      matches `raw/foo.pdf` on disk.
 *   4. Raw files that aren't referenced anywhere are absent from the
 *      set — never falsely flagged.
 *   5. Wiki pages without a `sources` field don't contribute false
 *      positives.
 */

function makeArticle(overrides: Partial<ArticleMeta> = {}): ArticleMeta {
  return {
    title: "T",
    filename: "wiki/t.md",
    tags: [],
    created: "",
    modified: "",
    wikilinks: [],
    excerpt: "",
    ...overrides,
  };
}

// ── normalizeSourceRef ────────────────────────────────────────────

describe("normalizeSourceRef", () => {
  it("returns canonical paths unchanged", () => {
    expect(normalizeSourceRef("raw/foo.pdf")).toBe("raw/foo.pdf");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeSourceRef("  raw/foo.pdf  ")).toBe("raw/foo.pdf");
  });

  it("strips backticks", () => {
    expect(normalizeSourceRef("`raw/foo.pdf`")).toBe("raw/foo.pdf");
  });

  it("strips wikilink brackets and ignores the display alias", () => {
    expect(normalizeSourceRef("[[raw/foo.pdf]]")).toBe("raw/foo.pdf");
    expect(normalizeSourceRef("[[raw/foo.pdf|Foo Doc]]")).toBe("raw/foo.pdf");
  });

  it("strips leading `./` and `/`", () => {
    expect(normalizeSourceRef("./raw/foo.pdf")).toBe("raw/foo.pdf");
    expect(normalizeSourceRef("/raw/foo.pdf")).toBe("raw/foo.pdf");
  });

  it("returns '' for empty / whitespace-only input", () => {
    expect(normalizeSourceRef("")).toBe("");
    expect(normalizeSourceRef("   ")).toBe("");
  });
});

// ── computeIngestedRawFiles ──────────────────────────────────────

describe("computeIngestedRawFiles", () => {
  it("returns an empty set when no wiki page declares sources", () => {
    const articles = [
      makeArticle({ filename: "raw/foo.pdf" }),
      makeArticle({ filename: "wiki/note.md" /* no sources */ }),
    ];
    expect(computeIngestedRawFiles(articles).size).toBe(0);
  });

  it("flags a raw file referenced by canonical vault-relative path", () => {
    const articles = [
      makeArticle({ filename: "raw/foo.pdf" }),
      makeArticle({
        filename: "wiki/sources/foo.md",
        sources: ["raw/foo.pdf"],
      }),
    ];
    const ingested = computeIngestedRawFiles(articles);
    expect(ingested.has("raw/foo.pdf")).toBe(true);
    expect(ingested.size).toBe(1);
  });

  it("flags a raw file referenced by basename only", () => {
    // The wiki maintainer often writes just `foo.pdf` — INGEST.md
    // examples and the model frequently follow suit. We must match.
    const articles = [
      makeArticle({ filename: "raw/foo.pdf" }),
      makeArticle({
        filename: "wiki/sources/foo.md",
        sources: ["foo.pdf"],
      }),
    ];
    expect(computeIngestedRawFiles(articles).has("raw/foo.pdf")).toBe(true);
  });

  it("accepts every formatting dialect (wikilink / aliased / ./ / / / backticks)", () => {
    const articles = [
      makeArticle({ filename: "raw/a.pdf" }),
      makeArticle({ filename: "raw/b.pdf" }),
      makeArticle({ filename: "raw/c.pdf" }),
      makeArticle({ filename: "raw/d.pdf" }),
      makeArticle({ filename: "raw/e.pdf" }),
      makeArticle({
        filename: "wiki/mix.md",
        sources: [
          "[[raw/a.pdf]]",
          "[[raw/b.pdf|B Doc]]",
          "./raw/c.pdf",
          "/raw/d.pdf",
          "`raw/e.pdf`",
        ],
      }),
    ];
    const ingested = computeIngestedRawFiles(articles);
    expect(ingested).toEqual(
      new Set(["raw/a.pdf", "raw/b.pdf", "raw/c.pdf", "raw/d.pdf", "raw/e.pdf"]),
    );
  });

  it("matches case-insensitively (RAW/Foo.PDF in source ref → raw/foo.pdf on disk)", () => {
    const articles = [
      makeArticle({ filename: "raw/foo.pdf" }),
      makeArticle({
        filename: "wiki/note.md",
        sources: ["RAW/Foo.PDF"],
      }),
    ];
    expect(computeIngestedRawFiles(articles).has("raw/foo.pdf")).toBe(true);
  });

  it("never flags a wiki/ file (badge is only for raw/)", () => {
    // Even if a wiki page weirdly references another wiki page in
    // `sources`, that target wiki page is not a raw file, so it
    // doesn't belong in the ingested set.
    const articles = [
      makeArticle({ filename: "wiki/intro.md" }),
      makeArticle({
        filename: "wiki/index.md",
        sources: ["wiki/intro.md"],
      }),
    ];
    expect(computeIngestedRawFiles(articles).size).toBe(0);
  });

  it("ignores sources from raw/ articles (they can't ingest themselves)", () => {
    // raw/ articles aren't supposed to declare sources, but if some
    // tooling sets one anyway it must NOT contribute to the badge.
    const articles = [
      makeArticle({ filename: "raw/a.pdf" }),
      makeArticle({
        filename: "raw/notes.md",
        sources: ["raw/a.pdf"],
      }),
    ];
    expect(computeIngestedRawFiles(articles).size).toBe(0);
  });

  it("returns each ingested raw file exactly once even when referenced by many wiki pages", () => {
    const articles = [
      makeArticle({ filename: "raw/foo.pdf" }),
      makeArticle({ filename: "wiki/a.md", sources: ["raw/foo.pdf"] }),
      makeArticle({ filename: "wiki/b.md", sources: ["foo.pdf"] }),
      makeArticle({ filename: "wiki/c.md", sources: ["[[raw/foo.pdf]]"] }),
    ];
    const ingested = computeIngestedRawFiles(articles);
    expect(ingested.size).toBe(1);
    expect(ingested.has("raw/foo.pdf")).toBe(true);
  });

  it("does not flag a raw file when only a similarly-named non-raw file is referenced", () => {
    // `foo.pdf` in sources should NOT match a wiki/foo.pdf attachment —
    // we only ever populate the set with raw/ paths.
    const articles = [
      makeArticle({ filename: "wiki/attachments/foo.pdf" }),
      makeArticle({ filename: "wiki/note.md", sources: ["foo.pdf"] }),
    ];
    expect(computeIngestedRawFiles(articles).size).toBe(0);
  });

  it("ignores empty / whitespace source entries", () => {
    const articles = [
      makeArticle({ filename: "raw/foo.pdf" }),
      makeArticle({
        filename: "wiki/note.md",
        sources: ["", "   ", "raw/foo.pdf"],
      }),
    ];
    expect(computeIngestedRawFiles(articles).has("raw/foo.pdf")).toBe(true);
  });

  it("handles articles with empty `sources` array (no false positives)", () => {
    const articles = [
      makeArticle({ filename: "raw/foo.pdf" }),
      makeArticle({ filename: "wiki/note.md", sources: [] }),
    ];
    expect(computeIngestedRawFiles(articles).size).toBe(0);
  });

  // ── Signal B: wiki/sources/ slug-stem fallback ────────────────

  /**
   * Real-world case reported by the user: the ingest produced a
   * wiki/sources/ summary page whose date prefix is hyphenated (the
   * model's slug style), while the original raw file uses an
   * unhyphenated YYYYMMDD prefix. The summary page does NOT echo the
   * raw path back into its `sources:` frontmatter, so signal A alone
   * misses it. Signal B (stem match) recovers it.
   */
  it("flags a raw file when a wiki/sources/ page shares its stem (Japanese filenames, mismatched date format)", () => {
    const articles = [
      makeArticle({
        filename: "raw/meeting_memo/20260422_書類作成業務ヒアリング.md",
      }),
      makeArticle({
        filename: "wiki/sources/2026-04-22-書類作成業務ヒアリング.md",
        // Crucially: NO `sources` frontmatter here. The stem match is
        // the only thing that can save this file's badge.
      }),
    ];
    const ingested = computeIngestedRawFiles(articles);
    expect(
      ingested.has("raw/meeting_memo/20260422_書類作成業務ヒアリング.md"),
    ).toBe(true);
  });

  it("flags a raw file when a wiki/sources/ page shares its plain stem (no dates)", () => {
    const articles = [
      makeArticle({ filename: "raw/foo.pdf" }),
      makeArticle({ filename: "wiki/sources/foo.md" }),
    ];
    expect(computeIngestedRawFiles(articles).has("raw/foo.pdf")).toBe(true);
  });

  it("stem match accepts ASCII date formats too (YYYY-MM-DD ↔ YYYYMMDD)", () => {
    const articles = [
      makeArticle({ filename: "raw/2024-01-15-meeting-notes.pdf" }),
      makeArticle({ filename: "wiki/sources/20240115_meeting-notes.md" }),
    ];
    expect(
      computeIngestedRawFiles(articles).has(
        "raw/2024-01-15-meeting-notes.pdf",
      ),
    ).toBe(true);
  });

  it("stem match is scoped to wiki/sources/ — a wiki/concepts/ page with a colliding stem is NOT enough", () => {
    // Keeps the heuristic conservative: CLAUDE.md's contract puts
    // source summaries specifically under wiki/sources/, so concept
    // / entity / topic pages mustn't grant the badge by accident.
    const articles = [
      makeArticle({ filename: "raw/foo.pdf" }),
      makeArticle({ filename: "wiki/concepts/foo.md" }),
    ];
    expect(computeIngestedRawFiles(articles).size).toBe(0);
  });

  it("stem match ignores tiny stems (≤1 char) so single-letter files don't false-positive", () => {
    const articles = [
      makeArticle({ filename: "raw/a.pdf" }),
      makeArticle({ filename: "wiki/sources/a.md" }),
    ];
    expect(computeIngestedRawFiles(articles).size).toBe(0);
  });

  it("explicit `sources:` reference still wins when both signals point at the same file (no dedup miss)", () => {
    const articles = [
      makeArticle({ filename: "raw/foo.pdf" }),
      makeArticle({
        filename: "wiki/sources/foo.md",
        sources: ["raw/foo.pdf"],
      }),
    ];
    const ingested = computeIngestedRawFiles(articles);
    expect(ingested.size).toBe(1);
    expect(ingested.has("raw/foo.pdf")).toBe(true);
  });

  /**
   * Real-world bug: a Japanese filename arrives on disk as NFD (typical
   * after a macOS HFS+ / older AirDrop / iCloud round-trip — `プ` becomes
   * `フ` U+30D5 + `゜` U+309A) while the wiki/sources/ summary written by
   * the chat agent stays NFC (`プ` U+30D7). The two render identically
   * but compare unequal, so signal B silently fails to flag the raw file
   * as ingested. Both `ingestStem` and the filename comparator must
   * NFC-normalize before hashing.
   */
  it("flags raw vs wiki when one filename is NFD and the other is NFC (Japanese)", () => {
    const rawNfd =
      "raw/meeting_memo/20260408_沖プラ定例.md".normalize("NFD");
    const wikiNfc =
      "wiki/sources/2026-04-08-沖プラ定例.md".normalize("NFC");
    // Sanity: confirm the test fixture really is mixed-form (otherwise
    // this assertion silently passes for the wrong reason).
    expect(rawNfd).not.toBe(rawNfd.normalize("NFC"));
    const articles = [
      makeArticle({ filename: rawNfd }),
      makeArticle({ filename: wikiNfc /* no sources frontmatter */ }),
    ];
    const ingested = computeIngestedRawFiles(articles);
    expect(ingested.has(rawNfd)).toBe(true);
  });

  it("flags raw via signal A when frontmatter `sources:` is NFC but disk filename is NFD", () => {
    const rawNfd = "raw/meeting_memo/20260408_沖プラ定例.md".normalize("NFD");
    const articles = [
      makeArticle({ filename: rawNfd }),
      makeArticle({
        filename: "wiki/note.md",
        // Author typed the path in NFC (what their editor / chat produces).
        sources: ["raw/meeting_memo/20260408_沖プラ定例.md".normalize("NFC")],
      }),
    ];
    const ingested = computeIngestedRawFiles(articles);
    expect(ingested.has(rawNfd)).toBe(true);
  });
});

// ── ingestStem ────────────────────────────────────────────────────

describe("ingestStem", () => {
  it("strips the file extension and lowercases", () => {
    expect(ingestStem("Foo.PDF")).toBe("foo");
    expect(ingestStem("raw/Foo.PDF")).toBe("foo");
  });

  it("strips a leading YYYYMMDD date prefix with separator", () => {
    expect(ingestStem("20260422_書類作成業務ヒアリング.md")).toBe(
      "書類作成業務ヒアリング",
    );
    expect(ingestStem("20260422-meeting.pdf")).toBe("meeting");
  });

  it("strips a leading YYYY-MM-DD / YYYY_MM_DD date prefix", () => {
    expect(ingestStem("2024-01-15-notes.pdf")).toBe("notes");
    expect(ingestStem("2024_01_15_notes.pdf")).toBe("notes");
  });

  it("returns the bare stem when no date prefix is present", () => {
    expect(ingestStem("summary.pdf")).toBe("summary");
  });

  it("returns '' for inputs that strip to <2 chars (avoids false positives)", () => {
    expect(ingestStem("a.md")).toBe("");
    expect(ingestStem("20240101_.md")).toBe("");
    expect(ingestStem("")).toBe("");
  });

  it("returns identical stems for NFC and NFD forms of the same filename", () => {
    const nfc = "20260408_沖プラ定例.md".normalize("NFC");
    const nfd = "20260408_沖プラ定例.md".normalize("NFD");
    // Sanity: the two inputs really do differ at the codepoint level.
    expect(nfc).not.toBe(nfd);
    expect(ingestStem(nfd)).toBe(ingestStem(nfc));
    expect(ingestStem(nfd)).toBe("沖プラ定例");
  });
});

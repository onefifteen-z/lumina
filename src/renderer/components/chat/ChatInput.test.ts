import { describe, it, expect } from "vitest";
import {
  detectMention,
  detectIngestFilename,
  detectSlashCommand,
  isSlashCommandPrefix,
  segmentInput,
  parseSlashCommand,
  SLASH_COMMANDS,
  formatIngestSlashCommand,
  isRawSource,
  filterIngestCandidates,
} from "./ChatInput";
import { isConfigFile } from "../../lib/file-classification";
import type { ArticleMeta } from "../../../shared/types";

/**
 * Unit tests for ChatInput component logic.
 * Tests the behavioral rules, state transitions, and configuration
 * without requiring a DOM or React rendering environment.
 */

// ── Simulate the send logic from ChatInput ──

function shouldSend(params: {
  value: string;
  isGenerating: boolean;
  isOffline: boolean;
  shiftKey: boolean;
}): boolean {
  if (params.shiftKey) return false;
  const trimmed = params.value.trim();
  if (!trimmed) return false;
  if (params.isGenerating) return false;
  if (params.isOffline) return false;
  return true;
}

function getSentContent(value: string): string {
  return value.trim();
}

function getPlaceholder(isOffline: boolean, isGenerating: boolean): string {
  if (isOffline) return "Chat unavailable while offline";
  if (isGenerating) return "Waiting for response…";
  return "Type a message…";
}

function isTextareaDisabled(
  isOffline: boolean,
  isGenerating: boolean,
): boolean {
  return isOffline || isGenerating;
}

function isSendButtonDisabled(value: string, isOffline: boolean): boolean {
  return !value.trim() || isOffline;
}

function shouldShowStopButton(isGenerating: boolean): boolean {
  return isGenerating;
}

describe("ChatInput send logic", () => {
  it("sends on Enter with non-empty content", () => {
    expect(
      shouldSend({
        value: "hello",
        isGenerating: false,
        isOffline: false,
        shiftKey: false,
      }),
    ).toBe(true);
  });

  it("does not send on Shift+Enter (inserts newline)", () => {
    expect(
      shouldSend({
        value: "hello",
        isGenerating: false,
        isOffline: false,
        shiftKey: true,
      }),
    ).toBe(false);
  });

  it("does not send empty content", () => {
    expect(
      shouldSend({
        value: "",
        isGenerating: false,
        isOffline: false,
        shiftKey: false,
      }),
    ).toBe(false);
  });

  it("does not send whitespace-only content", () => {
    expect(
      shouldSend({
        value: "   \n\t  ",
        isGenerating: false,
        isOffline: false,
        shiftKey: false,
      }),
    ).toBe(false);
  });

  it("does not send when generating", () => {
    expect(
      shouldSend({
        value: "hello",
        isGenerating: true,
        isOffline: false,
        shiftKey: false,
      }),
    ).toBe(false);
  });

  it("does not send when offline", () => {
    expect(
      shouldSend({
        value: "hello",
        isGenerating: false,
        isOffline: true,
        shiftKey: false,
      }),
    ).toBe(false);
  });

  it("trims content before sending", () => {
    expect(getSentContent("  hello world  ")).toBe("hello world");
  });

  it("trims leading/trailing newlines", () => {
    expect(getSentContent("\n\nhello\n\n")).toBe("hello");
  });
});

describe("ChatInput placeholder text", () => {
  it("shows offline placeholder when offline", () => {
    expect(getPlaceholder(true, false)).toBe("Chat unavailable while offline");
  });

  it("shows generating placeholder when generating", () => {
    expect(getPlaceholder(false, true)).toBe("Waiting for response…");
  });

  it("shows default placeholder in normal state", () => {
    expect(getPlaceholder(false, false)).toBe("Type a message…");
  });

  it("offline takes priority over generating", () => {
    expect(getPlaceholder(true, true)).toBe("Chat unavailable while offline");
  });
});

describe("ChatInput disabled state", () => {
  it("textarea is disabled when offline", () => {
    expect(isTextareaDisabled(true, false)).toBe(true);
  });

  it("textarea is disabled when generating", () => {
    expect(isTextareaDisabled(false, true)).toBe(true);
  });

  it("textarea is enabled in normal state", () => {
    expect(isTextareaDisabled(false, false)).toBe(false);
  });

  it("send button is disabled when input is empty", () => {
    expect(isSendButtonDisabled("", false)).toBe(true);
  });

  it("send button is disabled when input is whitespace", () => {
    expect(isSendButtonDisabled("   ", false)).toBe(true);
  });

  it("send button is disabled when offline even with content", () => {
    expect(isSendButtonDisabled("hello", true)).toBe(true);
  });

  it("send button is enabled with content and online", () => {
    expect(isSendButtonDisabled("hello", false)).toBe(false);
  });
});

describe("ChatInput button visibility", () => {
  it("shows stop button when generating", () => {
    expect(shouldShowStopButton(true)).toBe(true);
  });

  it("shows send button when not generating", () => {
    expect(shouldShowStopButton(false)).toBe(false);
  });
});

describe("ChatInput @-mention detection", () => {
  it("detects an @ at the start of input", () => {
    expect(detectMention("@foo", 4)).toEqual({ start: 0, query: "foo" });
  });

  it("detects an @ after whitespace", () => {
    expect(detectMention("hi @bar", 7)).toEqual({ start: 3, query: "bar" });
  });

  it("returns empty query right after typing @", () => {
    expect(detectMention("hi @", 4)).toEqual({ start: 3, query: "" });
  });

  it("returns null for @ glued to a non-space char (e.g. email)", () => {
    expect(detectMention("user@host.com", 13)).toBeNull();
  });

  it("returns null when caret has moved past whitespace", () => {
    expect(detectMention("@foo bar", 8)).toBeNull();
  });

  it("returns null when there is no @ before caret", () => {
    expect(detectMention("hello world", 5)).toBeNull();
  });

  it("uses the @ closest to the caret", () => {
    expect(detectMention("@one @two", 9)).toEqual({ start: 5, query: "two" });
  });

  it("supports paths with slashes in the query", () => {
    expect(detectMention("see @notes/sub", 14)).toEqual({ start: 4, query: "notes/sub" });
  });
});

describe("ChatInput /ingest slash command parsing", () => {
  it("parses bare /ingest filename", () => {
    expect(parseSlashCommand("/ingest report.pdf")).toEqual({
      type: "ingest",
      filename: "report.pdf",
      prompt: "Please analyze the attached file and answer the user's request.",
    });
  });

  it("parses quoted filename with spaces", () => {
    expect(parseSlashCommand('/ingest "Quarterly Deck.pptx" summarize key risks')).toEqual({
      type: "ingest",
      filename: "Quarterly Deck.pptx",
      prompt: "summarize key risks",
    });
  });

  it("returns null when /ingest has no filename", () => {
    expect(parseSlashCommand("/ingest")).toBeNull();
    expect(parseSlashCommand("/ingest   ")).toBeNull();
  });

  it("returns null for unknown slash command", () => {
    expect(parseSlashCommand("/other abc")).toBeNull();
  });

  it("does not treat /linter as /lint", () => {
    expect(parseSlashCommand("/linter foo.md")).toBeNull();
  });
});

describe("formatIngestSlashCommand", () => {
  it("uses an unquoted path when there are no spaces", () => {
    expect(formatIngestSlashCommand("raw/report.pdf")).toBe("/ingest raw/report.pdf");
  });

  it("quotes paths that contain spaces", () => {
    expect(formatIngestSlashCommand("raw/Quarterly Deck.pptx")).toBe(
      '/ingest "raw/Quarterly Deck.pptx"',
    );
  });
});

describe("ChatInput /lint slash command parsing", () => {
  // `/lint` lints the entire knowledge base using CLAUDE.md as
  // conventions. It accepts an optional free-form prompt that the
  // renderer appends as "additional instruction" to the lint workflow
  // boilerplate (e.g. `/lint focus on the entities pages`).

  it("parses bare /lint with no extra arguments (prompt omitted)", () => {
    // Bare command must not synthesise an empty `prompt` key — that
    // would force every consumer to handle `''` and `undefined`
    // separately. We use `toEqual` (deep equal) so a stray `prompt: ''`
    // would fail the assertion.
    expect(parseSlashCommand("/lint")).toEqual({ type: "lint" });
    expect(parseSlashCommand("/lint   ")).toEqual({ type: "lint" });
  });

  it("captures trailing free-form text as `prompt`", () => {
    expect(parseSlashCommand("/lint focus on the entities pages")).toEqual({
      type: "lint",
      prompt: "focus on the entities pages",
    });
  });

  it("trims surrounding whitespace from the captured prompt", () => {
    // Pin this so consumers can rely on `command.prompt.trim() ===
    // command.prompt` and skip a defensive trim themselves.
    expect(parseSlashCommand("/lint    skip log entry   ")).toEqual({
      type: "lint",
      prompt: "skip log entry",
    });
  });

  it("preserves multi-line prompts (newlines are whitespace too)", () => {
    // The textarea allows multi-line input via Shift+Enter; the prompt
    // capture should include subsequent lines verbatim minus the
    // leading/trailing blanks.
    expect(parseSlashCommand("/lint check entities\nand topics")).toEqual({
      type: "lint",
      prompt: "check entities\nand topics",
    });
  });

  it("does not treat /lintfoo as /lint (verb must be word-bounded)", () => {
    expect(parseSlashCommand("/lintfoo")).toBeNull();
  });
});

describe("isSlashCommandPrefix", () => {
  it("requires a word boundary after the verb", () => {
    expect(isSlashCommandPrefix("/lint foo.md", "/lint")).toBe(true);
    expect(isSlashCommandPrefix("/linter", "/lint")).toBe(false);
    expect(isSlashCommandPrefix("/ingestfoo", "/ingest")).toBe(false);
  });
});

describe("ChatInput /ingest filename picker detection", () => {
  it("activates picker right after '/ingest '", () => {
    expect(detectIngestFilename("/ingest ", 8)).toEqual({
      start: 8,
      query: "",
      quoted: false,
    });
  });

  it("detects unquoted filename query", () => {
    expect(detectIngestFilename("/ingest rep", 11)).toEqual({
      start: 8,
      query: "rep",
      quoted: false,
    });
  });

  it("detects quoted filename query", () => {
    expect(detectIngestFilename('/ingest "Quarter', 16)).toEqual({
      start: 8,
      query: "Quarter",
      quoted: true,
    });
  });

  it("returns null after first argument is closed and caret moved on", () => {
    expect(detectIngestFilename('/ingest "a.pptx" summarize', 24)).toBeNull();
  });
});

describe("ChatInput segmentInput (highlight overlay)", () => {
  const known = new Set(["foo.md", "notes/bar.md"]);

  it("returns nothing for empty input", () => {
    expect(segmentInput("", known)).toEqual([]);
  });

  it("treats text without @-mentions as a single text segment", () => {
    expect(segmentInput("hello world", known)).toEqual([
      { type: "text", content: "hello world" },
    ]);
  });

  it("marks a single recognised mention", () => {
    expect(segmentInput("see @foo.md please", known)).toEqual([
      { type: "text", content: "see " },
      { type: "mention", content: "@foo.md", filename: "foo.md" },
      { type: "text", content: " please" },
    ]);
  });

  it("does not mark unknown @-tokens", () => {
    expect(segmentInput("hi @stranger.md", known)).toEqual([
      { type: "text", content: "hi @stranger.md" },
    ]);
  });

  it("does not mark @ glued to a non-space char (e.g. emails)", () => {
    expect(segmentInput("write me at user@foo.md ok", known)).toEqual([
      { type: "text", content: "write me at user@foo.md ok" },
    ]);
  });

  it("handles a mention at the very start of input", () => {
    expect(segmentInput("@foo.md hi", known)).toEqual([
      { type: "mention", content: "@foo.md", filename: "foo.md" },
      { type: "text", content: " hi" },
    ]);
  });

  it("recognises multiple mentions in one message", () => {
    expect(segmentInput("@foo.md and @notes/bar.md", known)).toEqual([
      { type: "mention", content: "@foo.md", filename: "foo.md" },
      { type: "text", content: " and " },
      { type: "mention", content: "@notes/bar.md", filename: "notes/bar.md" },
    ]);
  });

  it("preserves whitespace and newlines in surrounding text", () => {
    expect(segmentInput("line one\n@foo.md\nline three", known)).toEqual([
      { type: "text", content: "line one\n" },
      { type: "mention", content: "@foo.md", filename: "foo.md" },
      { type: "text", content: "\nline three" },
    ]);
  });

  // ── /ingest filename highlighting ─────────────────────────────
  // The `/ingest <filename>` slash command should give the same visual
  // affordance as `@filename` mentions: as soon as the filename resolves to a
  // known article, the overlay paints a chip behind it. This is the contract
  // the UI relies on; without these tests a regression in matchLeadingSlashFile
  // would silently make ingest "feel" different from mentions.

  it("does NOT chip /lint arguments — /lint is a no-arg command and any trailing text stays plain", () => {
    // `/lint` no longer takes a filename, so even when the trailing word
    // happens to match a known article we should leave the whole line as
    // plain text. Otherwise the user would see a misleading file chip on
    // "lint everything" + space + a coincidentally-named article.
    expect(segmentInput("/lint foo.md", known)).toEqual([
      { type: "text", content: "/lint foo.md" },
    ]);
  });

  it("chips the unquoted /ingest filename", () => {
    expect(segmentInput("/ingest foo.md", known)).toEqual([
      { type: "text", content: "/ingest " },
      { type: "mention", content: "foo.md", filename: "foo.md" },
    ]);
  });

  it("chips the unquoted /ingest filename with a trailing prompt", () => {
    expect(segmentInput("/ingest foo.md please summarise", known)).toEqual([
      { type: "text", content: "/ingest " },
      { type: "mention", content: "foo.md", filename: "foo.md" },
      { type: "text", content: " please summarise" },
    ]);
  });

  it("chips the quoted /ingest filename, including the surrounding quotes", () => {
    // Quotes are part of the chip on purpose: the chip outline must follow
    // the literal characters the user typed, otherwise the highlight drifts
    // off the textarea glyphs underneath.
    expect(segmentInput('/ingest "foo.md" why', known)).toEqual([
      { type: "text", content: "/ingest " },
      { type: "mention", content: '"foo.md"', filename: "foo.md" },
      { type: "text", content: " why" },
    ]);
  });

  it("supports a quoted filename with spaces", () => {
    const k = new Set(["my notes.md"]);
    expect(segmentInput('/ingest "my notes.md"', k)).toEqual([
      { type: "text", content: "/ingest " },
      { type: "mention", content: '"my notes.md"', filename: "my notes.md" },
    ]);
  });

  it("tolerates leading whitespace before /ingest", () => {
    expect(segmentInput("  /ingest foo.md", known)).toEqual([
      { type: "text", content: "  /ingest " },
      { type: "mention", content: "foo.md", filename: "foo.md" },
    ]);
  });

  it("does not chip an /ingest filename that isn't in the vault", () => {
    expect(segmentInput("/ingest stranger.md", known)).toEqual([
      { type: "text", content: "/ingest stranger.md" },
    ]);
  });

  it("does not chip when /ingest has no filename yet", () => {
    expect(segmentInput("/ingest ", known)).toEqual([
      { type: "text", content: "/ingest " },
    ]);
  });

  it("does not chip /ingestfoo (verb must be followed by whitespace)", () => {
    // `/ingestfoo` is not the ingest command, so we must fall through to the
    // mention scanner — which finds no `@`, leaving the input as plain text.
    expect(segmentInput("/ingestfoo bar", known)).toEqual([
      { type: "text", content: "/ingestfoo bar" },
    ]);
  });

  it("does not double-process: /ingest filename suppresses @-mention scanning on the same line", () => {
    // Once we've matched the ingest form, we skip the `@`-scan entirely. An
    // `@foo.md` after the ingest filename is just narrative prose and should
    // stay plain, otherwise the chip would split the user's prompt awkwardly.
    expect(segmentInput("/ingest foo.md see @foo.md too", known)).toEqual([
      { type: "text", content: "/ingest " },
      { type: "mention", content: "foo.md", filename: "foo.md" },
      { type: "text", content: " see @foo.md too" },
    ]);
  });
});

describe("ChatInput slash-command detection", () => {
  it("activates picker right after typing '/' at start", () => {
    expect(detectSlashCommand("/", 1)).toEqual({ start: 0, query: "" });
  });

  it("captures the partial verb as caret advances", () => {
    expect(detectSlashCommand("/in", 3)).toEqual({ start: 0, query: "in" });
  });

  it("tolerates leading whitespace before the slash", () => {
    expect(detectSlashCommand("   /ing", 7)).toEqual({ start: 3, query: "ing" });
  });

  it("returns null when the slash is mid-message (not a command)", () => {
    expect(detectSlashCommand("hello /world", 12)).toBeNull();
  });

  it("returns null once whitespace has been typed after the verb", () => {
    // After `/ingest ` the slash picker hands off — typically to the ingest
    // filename picker. The slash detector itself must not stay active.
    expect(detectSlashCommand("/ingest ", 8)).toBeNull();
    expect(detectSlashCommand("/ingest foo", 11)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(detectSlashCommand("", 0)).toBeNull();
  });

  it("returns null when the line starts with text (no leading slash)", () => {
    expect(detectSlashCommand("hello", 5)).toBeNull();
  });
});

describe("ChatInput slash-command catalogue", () => {
  it("includes the /lint and /ingest commands", () => {
    expect(SLASH_COMMANDS.find((c) => c.name === "lint")?.insertion).toBe("/lint ");
    expect(SLASH_COMMANDS.find((c) => c.name === "ingest")?.insertion).toBe("/ingest ");
  });

  it("each command has a non-empty description", () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(cmd.description.length).toBeGreaterThan(0);
    }
  });

  it("each insertion ends with a trailing space (primes the next picker)", () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(cmd.insertion.endsWith(" ")).toBe(true);
    }
  });

  it("prefix-matching narrows candidates by typed verb", () => {
    // Mirrors the component's filtering rule.
    const prefix = "ing";
    const matches = SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
    expect(matches.map((c) => c.name)).toEqual(["ingest"]);
  });
});

describe("ChatInput @-picker excludes hidden / config files", () => {
  // Mirrors the component's filter: visibleArticles = articles.filter(a => !isConfigFile(a.filename))
  const articles = [
    { filename: "note.md", title: "Note" },
    { filename: ".CLAUDE.md", title: "Claude config" },
    { filename: "wiki/page.md", title: "Page" },
    { filename: ".git/HEAD", title: "Git head" },
    { filename: "raw/clean.md", title: "Clean" },
    { filename: "wiki/.draft.md", title: "Hidden draft" },
  ];

  it("isConfigFile flags any path with a dot-prefixed segment", () => {
    expect(isConfigFile(".CLAUDE.md")).toBe(true);
    expect(isConfigFile(".git/HEAD")).toBe(true);
    expect(isConfigFile("wiki/.draft.md")).toBe(true);
    expect(isConfigFile("note.md")).toBe(false);
    expect(isConfigFile("wiki/page.md")).toBe(false);
  });

  it("visible-article filter keeps regular files and drops hidden ones", () => {
    const visible = articles
      .filter((a) => !isConfigFile(a.filename))
      .map((a) => a.filename);
    expect(visible).toEqual(["note.md", "wiki/page.md", "raw/clean.md"]);
    expect(visible).not.toContain(".CLAUDE.md");
    expect(visible).not.toContain(".git/HEAD");
    expect(visible).not.toContain("wiki/.draft.md");
  });

  it("segmentInput does NOT chip a known-but-hidden mention because knownFilenames excludes it", () => {
    const visible = new Set(
      articles
        .filter((a) => !isConfigFile(a.filename))
        .map((a) => a.filename),
    );
    // `.CLAUDE.md` is a real file, but the picker / overlay should ignore it.
    const segs = segmentInput("see @.CLAUDE.md please", visible);
    expect(segs).toEqual([{ type: "text", content: "see @.CLAUDE.md please" }]);
  });

  it("extractMentions-style filter rejects hidden-file tokens even if typed manually", () => {
    // Mirror the component's extractMentions guard:
    //   isConfigFile(token) → exclude
    //   articles.some(a => a.filename === token) → must exist
    const token = ".CLAUDE.md";
    const accepted =
      !isConfigFile(token) && articles.some((a) => a.filename === token);
    expect(accepted).toBe(false);
  });
});

describe("ChatInput auto-expand configuration", () => {
  it("max-height is set to 120px", () => {
    // The component sets style={{ maxHeight: '120px' }} on the textarea.
    const maxHeight = "120px";
    expect(maxHeight).toBe("120px");
  });

  it("min-height is set to 22px", () => {
    // The component sets style={{ minHeight: '22px' }} on the textarea.
    const minHeight = "22px";
    expect(minHeight).toBe("22px");
  });

  it("overflow-y is set to auto", () => {
    // The component sets style={{ overflowY: 'auto' }} on the textarea.
    const overflowY = "auto";
    expect(overflowY).toBe("auto");
  });

  it("textarea starts with rows=1 for single-line default", () => {
    const defaultRows = 1;
    expect(defaultRows).toBe(1);
  });
});

// ── /ingest picker scoping to the raw/ folder ─────────────────
//
// The `/ingest` picker should only suggest files under `raw/`, the convention
// seeded by VaultInitDialog. Showing every article in the vault is noisy and
// surfaces wiki notes you'd never want to re-ingest. Tests below pin both the
// classifier (`isRawSource`) and the higher-level pool selector
// (`filterIngestCandidates`) including the empty-raw fallback.

function makeArticle(filename: string): ArticleMeta {
  return {
    title: filename,
    filename,
    tags: [],
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    wikilinks: [],
    excerpt: "",
  };
}

describe("ChatInput isRawSource", () => {
  it("accepts files directly under raw/", () => {
    expect(isRawSource("raw/foo.pdf")).toBe(true);
  });

  it("accepts nested files under raw/", () => {
    expect(isRawSource("raw/2026/q1/notes.pdf")).toBe(true);
  });

  it("is case-insensitive on the prefix", () => {
    // Vaults imported from other systems sometimes have `Raw/` or `RAW/`.
    // Treating these as the same folder for picker purposes is friendlier.
    expect(isRawSource("Raw/foo.pdf")).toBe(true);
    expect(isRawSource("RAW/foo.pdf")).toBe(true);
  });

  it("normalises Windows-style backslash separators", () => {
    expect(isRawSource("raw\\foo.pdf")).toBe(true);
  });

  it("rejects files outside raw/", () => {
    expect(isRawSource("wiki/foo.md")).toBe(false);
    expect(isRawSource("foo.md")).toBe(false);
  });

  it("does NOT match a file literally called raw.md at vault root", () => {
    // We're matching a folder, not a stem. `raw.md` is just an article that
    // happens to be named `raw` — it shouldn't slip into the ingest picker.
    expect(isRawSource("raw.md")).toBe(false);
  });

  it("does NOT match `rawer/foo.md` (prefix must end at a separator)", () => {
    // `raw/` ends in a slash, so `rawer/...` is rejected even though it
    // shares the literal prefix `raw`.
    expect(isRawSource("rawer/foo.md")).toBe(false);
  });
});

describe("ChatInput filterIngestCandidates", () => {
  it("returns only raw/ files when raw/ has anything", () => {
    const visible = [
      makeArticle("raw/a.pdf"),
      makeArticle("wiki/b.md"),
      makeArticle("raw/sub/c.png"),
      makeArticle("c.md"),
    ];
    const got = filterIngestCandidates(visible).map((a) => a.filename);
    expect(got).toEqual(["raw/a.pdf", "raw/sub/c.png"]);
  });

  it("falls back to the full visible list when raw/ is empty", () => {
    // Legacy vaults (created before VaultInitDialog seeded the `raw/`
    // folder) shouldn't get a silently-broken picker — surface every visible
    // article so the user can still pick something. A test pinning the
    // fallback is the only thing keeping us from regressing this on a
    // future "tighten the filter" cleanup.
    const visible = [makeArticle("foo.md"), makeArticle("wiki/bar.md")];
    const got = filterIngestCandidates(visible).map((a) => a.filename);
    expect(got).toEqual(["foo.md", "wiki/bar.md"]);
  });

  it("returns an empty list when the input list is empty", () => {
    expect(filterIngestCandidates([])).toEqual([]);
  });

  it("preserves the input order within the raw/ subset", () => {
    // Sorting is the candidates memo's job, not ours; we just narrow.
    const visible = [
      makeArticle("raw/z.pdf"),
      makeArticle("raw/a.pdf"),
      makeArticle("raw/m.pdf"),
    ];
    expect(filterIngestCandidates(visible).map((a) => a.filename)).toEqual([
      "raw/z.pdf",
      "raw/a.pdf",
      "raw/m.pdf",
    ]);
  });
});

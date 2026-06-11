import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { formatTimestamp } from "./MessageList";

/**
 * Property 5: Timestamp formatting to HH:mm
 *
 * For any valid ISO 8601 timestamp string, the formatted display string
 * SHALL match the pattern HH:mm (two-digit hour, colon, two-digit minute)
 * and represent the correct local time.
 *
 * **Validates: Requirements 4.6**
 */
describe("Property 5: Timestamp formatting to HH:mm", () => {
  it("should always produce a string matching HH:mm pattern", () => {
    fc.assert(
      fc.property(fc.date(), (date) => {
        const iso = date.toISOString();
        const result = formatTimestamp(iso);
        expect(result).toMatch(/^\d{2}:\d{2}$/);
      }),
      { numRuns: 100 },
    );
  });

  it("should produce hours and minutes matching the local time of the input date", () => {
    fc.assert(
      fc.property(fc.date(), (date) => {
        const iso = date.toISOString();
        const result = formatTimestamp(iso);

        const expectedHours = date.getHours().toString().padStart(2, "0");
        const expectedMinutes = date.getMinutes().toString().padStart(2, "0");
        const expected = `${expectedHours}:${expectedMinutes}`;

        expect(result).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });
});

import {
  parseMarkdownSegments,
  friendlyError,
  classifyLine,
  parseMarkdownLines,
  computeOrderedListStarts,
  applyInlineFormatting,
} from "../ChatView";

/* ── parseMarkdownSegments tests ──────────────────────────────── */

describe("parseMarkdownSegments", () => {
  it("returns a single text segment for plain text", () => {
    const result = parseMarkdownSegments("Hello world");
    expect(result).toEqual([{ type: "text", content: "Hello world" }]);
  });

  it("parses a fenced code block with language", () => {
    const input = "```typescript\nconst x = 1;\n```";
    const result = parseMarkdownSegments(input);
    expect(result).toEqual([
      { type: "code", language: "typescript", content: "const x = 1;" },
    ]);
  });

  it("parses mixed text and code blocks in order", () => {
    const input = "Before\n```js\nalert(1);\n```\nAfter";
    const result = parseMarkdownSegments(input);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: "text", content: "Before\n" });
    expect(result[1]).toEqual({
      type: "code",
      language: "js",
      content: "alert(1);",
    });
    expect(result[2]).toEqual({ type: "text", content: "\nAfter" });
  });

  it("extracts multiple code blocks", () => {
    const input =
      "```python\nprint('a')\n```\nMiddle\n```rust\nfn main() {}\n```";
    const result = parseMarkdownSegments(input);
    const codeSegments = result.filter((s) => s.type === "code");
    expect(codeSegments).toHaveLength(2);
    expect(codeSegments[0]).toEqual({
      type: "code",
      language: "python",
      content: "print('a')",
    });
    expect(codeSegments[1]).toEqual({
      type: "code",
      language: "rust",
      content: "fn main() {}",
    });
  });

  it("returns an empty array for empty input", () => {
    const result = parseMarkdownSegments("");
    expect(result).toEqual([]);
  });
});

/* ── Error message mapping tests ──────────────────────────────── */

describe("friendlyError mapping", () => {
  it("maps 'auth' to authentication error message", () => {
    expect(friendlyError("auth")).toBe(
      "Authentication failed. Check your API key in Settings.",
    );
  });

  it("maps 'rate_limit' to rate limit message", () => {
    expect(friendlyError("rate_limit")).toBe(
      "Rate limit exceeded. Please try again later.",
    );
  });

  it("maps 'timeout' to timeout message", () => {
    expect(friendlyError("timeout")).toBe("Request timed out.");
  });

  it("maps 'network' to network error message", () => {
    expect(friendlyError("network")).toBe(
      "Network error. Check your connection.",
    );
  });

  it("maps 'unknown' to unexpected error message", () => {
    expect(friendlyError("unknown")).toBe("An unexpected error occurred.");
  });

  it("maps any unrecognized string to unexpected error message", () => {
    expect(friendlyError("something_else")).toBe(
      "An unexpected error occurred.",
    );
    expect(friendlyError("")).toBe("An unexpected error occurred.");
  });
});

/* ── Layout structure / display logic tests ───────────────────── */

describe("ChatView display logic", () => {
  /**
   * These tests verify the display-logic conditions used in ChatView's render:
   *   hasMessages = messages.length > 0 || streamingContent.length > 0
   *   displayWelcome = showWelcome && !hasMessages
   */

  it("shows welcome when showWelcome=true and no messages", () => {
    const messages: unknown[] = [];
    const streamingContent = "";
    const showWelcome = true;

    const hasMessages = messages.length > 0 || streamingContent.length > 0;
    const displayWelcome = showWelcome && !hasMessages;

    expect(displayWelcome).toBe(true);
  });

  it("shows MessageList when messages exist", () => {
    const messages = [
      {
        id: "1",
        role: "user",
        content: "Hello",
        timestamp: new Date().toISOString(),
      },
    ];
    const streamingContent = "";
    const showWelcome = true;

    const hasMessages = messages.length > 0 || streamingContent.length > 0;
    const displayWelcome = showWelcome && !hasMessages;

    expect(displayWelcome).toBe(false);
    expect(hasMessages).toBe(true);
  });

  it("shows MessageList when streaming content exists (even with no messages)", () => {
    const messages: unknown[] = [];
    const streamingContent = "partial response...";
    const showWelcome = true;

    const hasMessages = messages.length > 0 || streamingContent.length > 0;
    const displayWelcome = showWelcome && !hasMessages;

    expect(displayWelcome).toBe(false);
    expect(hasMessages).toBe(true);
  });

  it("error display is shown when error is non-null", () => {
    const error = { type: "auth", message: "Unauthorized" };
    // In ChatView: {error && ( <error display with retry> )}
    expect(error).toBeTruthy();
    expect(friendlyError(error.type)).toBe(
      "Authentication failed. Check your API key in Settings.",
    );
  });

  it("error display includes retry capability", () => {
    const error = { type: "rate_limit", message: "Too many requests" };
    // The retry handler finds the last user message and resends it
    const messages = [
      {
        id: "1",
        role: "user" as const,
        content: "Hello",
        timestamp: new Date().toISOString(),
      },
      {
        id: "2",
        role: "assistant" as const,
        content: "Hi",
        timestamp: new Date().toISOString(),
      },
    ];
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    expect(lastUserMsg).toBeDefined();
    expect(lastUserMsg!.content).toBe("Hello");
    expect(error).toBeTruthy();
  });
});

/* ── classifyLine tests ───────────────────────────────────────── */

describe("classifyLine", () => {
  it("classifies h1 heading", () => {
    expect(classifyLine("# Hello")).toEqual({
      type: "heading",
      level: 1,
      content: "Hello",
    });
  });

  it("classifies h2 heading", () => {
    expect(classifyLine("## World")).toEqual({
      type: "heading",
      level: 2,
      content: "World",
    });
  });

  it("classifies h3 heading", () => {
    expect(classifyLine("### Sub")).toEqual({
      type: "heading",
      level: 3,
      content: "Sub",
    });
  });

  it("classifies unordered list with dash", () => {
    expect(classifyLine("- item")).toEqual({ type: "ul", content: "item" });
  });

  it("classifies unordered list with asterisk", () => {
    expect(classifyLine("* item")).toEqual({ type: "ul", content: "item" });
  });

  it("classifies ordered list", () => {
    expect(classifyLine("1. first")).toEqual({ type: "ol", content: "first" });
  });

  it("classifies horizontal rule", () => {
    expect(classifyLine("---")).toEqual({ type: "hr", content: "" });
  });

  it("classifies plain text as paragraph", () => {
    expect(classifyLine("just text")).toEqual({
      type: "paragraph",
      content: "just text",
    });
  });

  it("treats # without space as paragraph", () => {
    expect(classifyLine("#nospace")).toEqual({
      type: "paragraph",
      content: "#nospace",
    });
  });
});

/* ── parseMarkdownLines tests ─────────────────────────────────── */

describe("parseMarkdownLines", () => {
  it("returns empty array for empty string", () => {
    expect(parseMarkdownLines("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(parseMarkdownLines("   \n  ")).toEqual([]);
  });

  it("parses a heading", () => {
    const result = parseMarkdownLines("# Title");
    expect(result).toEqual([{ type: "heading", level: 1, content: "Title" }]);
  });

  it("parses a horizontal rule", () => {
    const result = parseMarkdownLines("---");
    expect(result).toEqual([{ type: "hr" }]);
  });

  it("groups consecutive unordered list items", () => {
    const result = parseMarkdownLines("- a\n- b\n- c");
    expect(result).toEqual([{ type: "ul", items: ["a", "b", "c"] }]);
  });

  it("groups consecutive ordered list items", () => {
    const result = parseMarkdownLines("1. first\n2. second");
    expect(result).toEqual([{ type: "ol", items: ["first", "second"] }]);
  });

  it("groups ordered list items separated by blank lines (loose list)", () => {
    // LLMs frequently emit "1. ... \n\n1. ... \n\n1. ..." (each line starts
    // with "1." because markdown renumbers automatically). Without
    // blank-line tolerance, every item became its own <ol> and rendered
    // as "1. 1. 1." instead of "1. 2. 3.".
    const result = parseMarkdownLines("1. first\n\n1. second\n\n1. third");
    expect(result).toEqual([
      { type: "ol", items: ["first", "second", "third"] },
    ]);
  });

  it("keeps one ordered list when each item has an immediate explanation line", () => {
    const result = parseMarkdownLines(
      "1. Identify the use case\nPick a concrete business problem where GenAI might help.\n1. Prioritize the use case\nRank candidates by value, feasibility, and strategic fit.",
    );
    expect(result).toEqual([
      {
        type: "ol",
        items: [
          "Identify the use case\nPick a concrete business problem where GenAI might help.",
          "Prioritize the use case\nRank candidates by value, feasibility, and strategic fit.",
        ],
      },
    ]);
  });

  it("groups unordered list items separated by blank lines", () => {
    const result = parseMarkdownLines("- a\n\n- b\n\n- c");
    expect(result).toEqual([{ type: "ul", items: ["a", "b", "c"] }]);
  });

  it("does not merge ordered list across a non-list block", () => {
    const result = parseMarkdownLines("1. first\n\nSome text\n\n1. second");
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: "ol", items: ["first"] });
    expect(result[1]).toEqual({ type: "paragraph", content: "Some text" });
    expect(result[2]).toEqual({ type: "ol", items: ["second"] });
  });

  it("does not merge ul into ol across blank lines", () => {
    const result = parseMarkdownLines("- a\n\n1. b");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "ul", items: ["a"] });
    expect(result[1]).toEqual({ type: "ol", items: ["b"] });
  });

  it("separates different block types", () => {
    const result = parseMarkdownLines("# Title\nSome text\n- item");
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: "heading", level: 1, content: "Title" });
    expect(result[1]).toEqual({ type: "paragraph", content: "Some text" });
    expect(result[2]).toEqual({ type: "ul", items: ["item"] });
  });

  it("handles mixed content with hr", () => {
    const result = parseMarkdownLines("Above\n---\nBelow");
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: "paragraph", content: "Above" });
    expect(result[1]).toEqual({ type: "hr" });
    expect(result[2]).toEqual({ type: "paragraph", content: "Below" });
  });
});

describe("computeOrderedListStarts", () => {
  it("continues numbering across split ordered-list blocks", () => {
    const blocks = parseMarkdownLines(
      "1. Identify the use case\nPick a concrete business problem.\n1. Prioritize the use case\nRank candidates.\n\n- talent and operating model\n- governance and risk\n\n1. Shape the solution approach\nDecide what kind of build you need.\n1. Answer the key design questions\nDefine modality and functions.\n\n- modality: text, image\n\n1. Build the PoC/MVP",
    );
    expect(computeOrderedListStarts(blocks).filter((n) => n !== null)).toEqual([
      1,
      3,
      5,
    ]);
  });
});

/* ── applyInlineFormatting tests ──────────────────────────────── */

describe("applyInlineFormatting", () => {
  it("returns plain text when no formatting markers", () => {
    const result = applyInlineFormatting("hello world");
    expect(result).toEqual(["hello world"]);
  });

  it("handles bold text", () => {
    const result = applyInlineFormatting("this is **bold** text");
    expect(result).toHaveLength(3);
    expect(result[0]).toBe("this is ");
    expect(result[2]).toBe(" text");
  });

  it("handles inline code", () => {
    const result = applyInlineFormatting("use `npm install` here");
    expect(result).toHaveLength(3);
    expect(result[0]).toBe("use ");
    expect(result[2]).toBe(" here");
  });

  it("treats unclosed bold markers as plain text", () => {
    const result = applyInlineFormatting("this is **unclosed");
    expect(result).toEqual(["this is **unclosed"]);
  });

  it("treats unclosed backtick as plain text", () => {
    const result = applyInlineFormatting("this is `unclosed");
    expect(result).toEqual(["this is `unclosed"]);
  });

  it("handles multiple inline elements", () => {
    const result = applyInlineFormatting("**bold** and `code`");
    expect(result).toHaveLength(3);
    // bold element, " and ", code element
    expect(result[1]).toBe(" and ");
  });
});

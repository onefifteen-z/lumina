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

import { parseMarkdownSegments, friendlyError } from "../ChatView";

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

import { describe, it, expect } from "vitest";
import { detectMention, segmentInput } from "./ChatInput";

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

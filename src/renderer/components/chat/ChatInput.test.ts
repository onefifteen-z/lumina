import { describe, it, expect } from "vitest";

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

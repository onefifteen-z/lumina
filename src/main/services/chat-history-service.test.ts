import { describe, it, expect } from "vitest";
import { normaliseRenameTitle } from "./chat-history-service";

/**
 * `normaliseRenameTitle` is the pure half of `ChatHistoryService.renameSession`
 * and is tested in isolation so we don't need to spin up a real SQLite DB
 * (which would require an electron-aware native build of better-sqlite3).
 */
describe("normaliseRenameTitle", () => {
  const noFallback = () => "";

  it("returns the trimmed title when it has content", () => {
    expect(normaliseRenameTitle("  Hello world  ", noFallback)).toBe("Hello world");
  });

  it("caps very long titles at 200 characters", () => {
    const long = "x".repeat(500);
    expect(normaliseRenameTitle(long, noFallback)).toBe("x".repeat(200));
  });

  it("falls back to derived title (truncated to 60 chars) when empty", () => {
    const fallback = () => "What is the capital of France?";
    expect(normaliseRenameTitle("", fallback)).toBe("What is the capital of France?");
  });

  it("collapses newlines in the derived fallback", () => {
    const fallback = () => "line one\nline two";
    expect(normaliseRenameTitle("   ", fallback)).toBe("line one line two");
  });

  it("truncates a long derived fallback to 60 chars", () => {
    const fallback = () => "y".repeat(120);
    expect(normaliseRenameTitle("", fallback)).toBe("y".repeat(60));
  });

  it("returns 'New chat' when both input and fallback are empty", () => {
    expect(normaliseRenameTitle("", noFallback)).toBe("New chat");
    expect(normaliseRenameTitle("   \n\t  ", noFallback)).toBe("New chat");
    expect(normaliseRenameTitle("", () => "   ")).toBe("New chat");
  });

  it("does not invoke the fallback when input is non-empty", () => {
    let called = 0;
    const fallback = () => {
      called++;
      return "should-not-appear";
    };
    expect(normaliseRenameTitle("My title", fallback)).toBe("My title");
    expect(called).toBe(0);
  });
});

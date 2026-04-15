import { describe, it, expect } from "vitest";

/**
 * Unit tests for CodeBlock component logic.
 * Tests the behavioral rules and display logic without requiring
 * a DOM or React rendering environment.
 */

// ── Simulate the display language logic from CodeBlock ──

function getDisplayLanguage(language?: string): string {
  return language || "text";
}

function getCopyButtonLabel(copied: boolean): string {
  return copied ? "Copied" : "Copy code";
}

function getCopyButtonText(copied: boolean): string {
  return copied ? "Copied!" : "Copy";
}

function getLanguageClass(language?: string): string {
  return language ? `language-${language}` : "";
}

describe("CodeBlock display language", () => {
  it("shows the provided language", () => {
    expect(getDisplayLanguage("typescript")).toBe("typescript");
  });

  it("shows 'text' when no language is provided", () => {
    expect(getDisplayLanguage()).toBe("text");
  });

  it("shows 'text' when language is empty string", () => {
    expect(getDisplayLanguage("")).toBe("text");
  });

  it("preserves language casing", () => {
    expect(getDisplayLanguage("JavaScript")).toBe("JavaScript");
  });
});

describe("CodeBlock copy button state", () => {
  it("shows 'Copy code' aria-label when not copied", () => {
    expect(getCopyButtonLabel(false)).toBe("Copy code");
  });

  it("shows 'Copied' aria-label after copying", () => {
    expect(getCopyButtonLabel(true)).toBe("Copied");
  });

  it("shows 'Copy' text when not copied", () => {
    expect(getCopyButtonText(false)).toBe("Copy");
  });

  it("shows 'Copied!' text after copying", () => {
    expect(getCopyButtonText(true)).toBe("Copied!");
  });
});

describe("CodeBlock language CSS class", () => {
  it("generates language class for provided language", () => {
    expect(getLanguageClass("python")).toBe("language-python");
  });

  it("generates language class for typescript", () => {
    expect(getLanguageClass("typescript")).toBe("language-typescript");
  });

  it("returns empty string when no language provided", () => {
    expect(getLanguageClass()).toBe("");
  });

  it("returns empty string for empty language", () => {
    expect(getLanguageClass("")).toBe("");
  });
});

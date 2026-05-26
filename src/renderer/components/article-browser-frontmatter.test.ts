import { describe, it, expect } from "vitest";
import { toRenderableString } from "./ArticleBrowser";

/**
 * Regression suite for the "Objects are not valid as a React child (found:
 * object with keys {更新})" crash that hit `ArticleBrowser` whenever a vault
 * doc had nested YAML maps inside an array frontmatter field (e.g.
 * `sources: [{更新: "..."}]`). The fix is a defensive coercion helper used
 * by the array-item and tag renderers; this file pins that contract so a
 * future "simplification" can't reintroduce the crash.
 */
describe("toRenderableString", () => {
  it("returns strings unchanged (the 99% case)", () => {
    expect(toRenderableString("hello")).toBe("hello");
    expect(toRenderableString("")).toBe("");
    expect(toRenderableString("raw/foo.pdf")).toBe("raw/foo.pdf");
  });

  it("stringifies numbers and booleans", () => {
    expect(toRenderableString(42)).toBe("42");
    expect(toRenderableString(0)).toBe("0");
    expect(toRenderableString(true)).toBe("true");
    expect(toRenderableString(false)).toBe("false");
  });

  it("emits an empty string for null / undefined (so the renderer can short-circuit)", () => {
    expect(toRenderableString(null)).toBe("");
    expect(toRenderableString(undefined)).toBe("");
  });

  it("formats Date instances as ISO strings (matches how the FM parser normalises dates)", () => {
    const d = new Date("2024-03-15T08:00:00.000Z");
    expect(toRenderableString(d)).toBe("2024-03-15T08:00:00.000Z");
  });

  it("JSON-stringifies nested objects so the user can see the malformed YAML", () => {
    // This is the exact shape that triggered the original crash —
    // `sources: [{更新: "2024-01-01"}]` parses to an array containing an
    // object, and the previous renderer fed `item` straight into JSX.
    const obj = { 更新: "2024-01-01" };
    const out = toRenderableString(obj);
    expect(out).toBe('{"更新":"2024-01-01"}');
    // Critically: it never throws and never returns the object itself.
    expect(typeof out).toBe("string");
  });

  it("JSON-stringifies nested arrays too", () => {
    expect(toRenderableString(["a", "b"])).toBe('["a","b"]');
  });

  it("never throws — even on values JSON.stringify would refuse (cycles / BigInt)", () => {
    // Cyclic refs make JSON.stringify throw; the helper must catch and
    // fall back to String(v). The fallback content isn't a contract we
    // care about — only that it's a string and the call doesn't bubble.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => toRenderableString(cyclic)).not.toThrow();
    expect(typeof toRenderableString(cyclic)).toBe("string");

    expect(() => toRenderableString(10n)).not.toThrow();
    expect(typeof toRenderableString(10n)).toBe("string");
  });
});

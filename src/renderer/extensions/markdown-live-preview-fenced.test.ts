import { describe, expect, it } from "vitest";
import { fencedCodeSliceToBodyAndLang } from "./markdown-live-preview";

describe("fencedCodeSliceToBodyAndLang", () => {
  it("strips fences and returns language", () => {
    const raw = ["```typescript", "const x = 1;", "```"].join("\n");
    expect(fencedCodeSliceToBodyAndLang(raw)).toEqual({
      lang: "typescript",
      body: "const x = 1;",
    });
  });

  it("supports tilde fences", () => {
    const raw = ["~~~", "# not heading", "~~~"].join("\n");
    expect(fencedCodeSliceToBodyAndLang(raw)).toEqual({
      lang: null,
      body: "# not heading",
    });
  });

  it("requires closing fence length >= opening (same char)", () => {
    const raw = ["````", "```", "body", "````"].join("\n");
    expect(fencedCodeSliceToBodyAndLang(raw)).toEqual({
      lang: null,
      body: ["```", "body"].join("\n"),
    });
  });
});

import { describe, expect, it } from "vitest";
import { extractHeadings } from "./TocPanel";

describe("extractHeadings", () => {
  it("ignores ATX-like lines inside fenced code blocks (backticks)", () => {
    const md = [
      "# Real",
      "",
      "```python",
      '# {"issue": "x"}',
      "```",
      "",
      "## Subtitle",
    ].join("\n");
    const h = extractHeadings(md);
    expect(h.map((x) => x.text)).toEqual(["Real", "Subtitle"]);
    expect(h.map((x) => x.level)).toEqual([1, 2]);
  });

  it("ignores ATX-like lines inside tilde-fenced blocks", () => {
    const md = [
      "# Intro",
      "",
      "~~~",
      "# not a heading",
      "~~~",
      "",
      "### Deep",
    ].join("\n");
    expect(extractHeadings(md).map((x) => x.text)).toEqual(["Intro", "Deep"]);
  });

  it("uses fence length so a shorter closing run stays inside the block", () => {
    const md = ["````", "# fake", "```", "````", "# Real"].join("\n");
    const h = extractHeadings(md);
    expect(h.map((x) => x.text)).toEqual(["Real"]);
  });

  it("still picks headings outside after a closed fence", () => {
    const md = ["```", "# skip", "```", "# Keep"].join("\n");
    expect(extractHeadings(md).map((x) => x.text)).toEqual(["Keep"]);
  });
});

import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  findPipeTableBlockRangesInDoc,
  parseMarkdownPipeTableBlock,
} from "./markdown-live-preview-table";

describe("parseMarkdownPipeTableBlock", () => {
  it("parses a GFM pipe table", () => {
    const src = `| Constraint | Rule | Rationale |
| --- | --- | --- |
| Min inventory | 20 days | Avoid stockout |
| Max price | $12/MMBtu | Budget |`;
    const parsed = parseMarkdownPipeTableBlock(src);
    expect(parsed).not.toBeNull();
    expect(parsed!.headers).toEqual(["Constraint", "Rule", "Rationale"]);
    expect(parsed!.rows).toHaveLength(2);
    expect(parsed!.rows[0][0]).toBe("Min inventory");
    expect(parsed!.rows[1][0]).toBe("Max price");
  });

  it("returns null without a delimiter row", () => {
    expect(parseMarkdownPipeTableBlock("| a | b |\n| x | y |")).toBeNull();
  });

  it("accepts single-dash delimiter rows like GitHub / lezer-markdown", () => {
    const parsed = parseMarkdownPipeTableBlock("| a | b |\n| - | - |\n| x | y |");
    expect(parsed).not.toBeNull();
    expect(parsed!.rows[0]).toEqual(["x", "y"]);
  });
});

describe("findPipeTableBlockRangesInDoc", () => {
  it("finds a pipe table as line ranges", () => {
    const doc = Text.of(["| a | b |", "| - | - |", "| x | y |", "", "after"]);
    const ranges = findPipeTableBlockRangesInDoc(doc);
    expect(ranges).toHaveLength(1);
    expect(doc.sliceString(ranges[0].from, ranges[0].to)).toBe("| a | b |\n| - | - |\n| x | y |");
  });
});

import { describe, expect, it } from "vitest";
import {
  bfsHopDistances,
  buildAdjacencyStringLinks,
  edgeHoverTier,
  getGraphHighlightPalette,
  graphEntityNodeColorOverride,
  multiplyRgbaAlpha,
  parseColorToRgba,
} from "./graphHighlightPalette";

describe("getGraphHighlightPalette", () => {
  it("uses stronger idle / far alpha on light than on dark for graph legibility", () => {
    const light = getGraphHighlightPalette(false);
    const dark = getGraphHighlightPalette(true);
    expect(light.idleAlphaMult).toBeGreaterThan(dark.idleAlphaMult);
    expect(light.farAlphaMult).toBeGreaterThan(dark.farAlphaMult);
    expect(light.edgeHover).toMatch(/217,\s*119,\s*6/);
    expect(light.neighborFillBlendStyle).toBe("lightenFromHover");
    expect(dark.neighborFillBlendStyle).toBe("darkenFromIdle");
  });
});

describe("parseColorToRgba / multiplyRgbaAlpha", () => {
  it("parses hex and scales alpha", () => {
    const c = parseColorToRgba("#646464");
    expect(c).toMatchObject({ r: 100, g: 100, b: 100, a: 1 });
    expect(multiplyRgbaAlpha("rgba(10,20,30,0.4)", 0.5)).toBe("rgba(10,20,30,0.2)");
  });
});

describe("graphEntityNodeColorOverride", () => {
  it("returns null for non-entity nodes (so the default palette applies)", () => {
    expect(graphEntityNodeColorOverride(false, true)).toBeNull();
    expect(graphEntityNodeColorOverride(false, false)).toBeNull();
  });

  it("returns the unified entity blue for any entity, regardless of subtype", () => {
    // The whole point of the boolean signature is that an org-tagged page,
    // a person-tagged page, and an untagged page in wiki/entities/ all
    // hit this branch with the same `true` and get the same swatch.
    const dark = graphEntityNodeColorOverride(true, true);
    const light = graphEntityNodeColorOverride(true, false);
    expect(dark).toEqual({ base: "#60A5FA", hover: "#93C5FD" });
    expect(light).toEqual({ base: "#2563EB", hover: "#1D4ED8" });
  });
});

describe("bfsHopDistances + edgeHoverTier", () => {
  it("assigns tiers 0,1,2 along a chain from hover", () => {
    const adj = buildAdjacencyStringLinks([
      { source: "a", target: "b" },
      { source: "b", target: "c" },
      { source: "c", target: "d" },
    ]);
    const dist = bfsHopDistances(adj, "a", 2);
    expect(dist.get("a")).toBe(0);
    expect(dist.get("b")).toBe(1);
    expect(dist.get("c")).toBe(2);
    expect(dist.has("d")).toBe(false);

    expect(edgeHoverTier({ source: "a", target: "b" }, dist, "a")).toBe(0);
    expect(edgeHoverTier({ source: "b", target: "c" }, dist, "a")).toBe(1);
    expect(edgeHoverTier({ source: "c", target: "d" }, dist, "a")).toBe(-1);
  });
});

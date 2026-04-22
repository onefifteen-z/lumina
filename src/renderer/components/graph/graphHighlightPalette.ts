/** Shared graph chrome for 2D canvas and 3D force-graph. */

/** Default when nothing is hovered (dark); light uses a higher value in the palette. */
export const GRAPH_NO_HOVER_ALPHA_MULT = 0.52;

/** Default fade for outside 2-hop while hovering (dark); light keeps more structure. */
export const GRAPH_HOVER_FAR_ALPHA_MULT = 0.22;

export interface GraphHighlightPalette {
  edge: string;
  edgeHover: string;
  node: string;
  nodeHover: string;
  nodeRing: string;
  nodeRingHover: string;
  label: string;
  labelHover: string;
  canvasBg: string;
  /** Multiply base rgba when nothing is hovered (nodes / edges / labels). */
  idleAlphaMult: number;
  /** Multiply base rgba for elements outside the 2-hop ball while hovering. */
  farAlphaMult: number;
  /** Edge hover tiers: alpha multipliers on `edgeHover` for hop 0 / 1 / 2. */
  edgeHoverTierAlpha: readonly [number, number, number];
  /**
   * Hop-1/2 styling: on dark canvas, blend idle gray toward `nodeHover`.
   * On light canvas, blend `nodeHover` toward `neighborSofterTarget` so neighbors淡开 while the focus stays saturated.
   */
  neighborFillBlendStyle: "darkenFromIdle" | "lightenFromHover";
  /** Mix target for `lightenFromHover` (typically white / near canvas). */
  neighborSofterTarget: string;
  /** Blend strength for hop 1 / hop 2 (meaning depends on `neighborFillBlendStyle`). */
  nodeFillBlend1: number;
  nodeFillBlend2: number;
  ringBlend1: number;
  ringBlend2: number;
  labelBlend1: number;
  labelBlend2: number;
}

export function getGraphHighlightPalette(isDark: boolean): GraphHighlightPalette {
  if (isDark) {
    return {
      edge: "rgba(255,255,255,0.18)",
      edgeHover: "rgba(212,115,26,0.7)",
      node: "#a0a0a0",
      nodeHover: "#D4731A",
      nodeRing: "#dcdcdc",
      nodeRingHover: "#EFA03C",
      label: "#d2d2d2",
      labelHover: "#EFA03C",
      canvasBg: "#202020",
      idleAlphaMult: GRAPH_NO_HOVER_ALPHA_MULT,
      farAlphaMult: GRAPH_HOVER_FAR_ALPHA_MULT,
      edgeHoverTierAlpha: [0.92, 0.55, 0.32],
      nodeFillBlend1: 0.5,
      nodeFillBlend2: 0.28,
      ringBlend1: 0.52,
      ringBlend2: 0.3,
      labelBlend1: 0.48,
      labelBlend2: 0.28,
      neighborFillBlendStyle: "darkenFromIdle",
      neighborSofterTarget: "#ffffff",
    };
  }
  // Light: slightly stronger base edges, warmer / higher-chroma hover, and less
  // aggressive fading so the 2-hop neighborhood still reads on white canvas.
  return {
    edge: "rgba(0,0,0,0.22)",
    edgeHover: "rgba(217,119,6,0.92)",
    node: "#4f4f4f",
    nodeHover: "#C2410C",
    nodeRing: "#737373",
    nodeRingHover: "#EA580C",
    label: "#262626",
    labelHover: "#C2410C",
    canvasBg: "#ffffff",
    idleAlphaMult: 0.6,
    farAlphaMult: 0.34,
    edgeHoverTierAlpha: [1, 0.72, 0.48],
    neighborFillBlendStyle: "lightenFromHover",
    neighborSofterTarget: "#ffffff",
    // Neighbors: pale tints of the theme (hop-2 paler than hop-1); focus stays `nodeHover`.
    nodeFillBlend1: 0.26,
    nodeFillBlend2: 0.5,
    ringBlend1: 0.32,
    ringBlend2: 0.54,
    labelBlend1: 0.24,
    labelBlend2: 0.46,
  };
}

/** Resolve link endpoint ids (strings) after force-graph may replace ids with node refs. */
export function linkEndpointIds(link: {
  source: string | number | { id?: string | number };
  target: string | number | { id?: string | number };
}): { a: string; b: string } {
  const a =
    typeof link.source === "object" && link.source != null && "id" in link.source
      ? String(link.source.id)
      : String(link.source);
  const b =
    typeof link.target === "object" && link.target != null && "id" in link.target
      ? String(link.target.id)
      : String(link.target);
  return { a, b };
}

/** True when this edge is incident to the hovered node (same rule as 2D canvas). */
export function linkTouchesHoveredNode(
  link: { source: unknown; target: unknown },
  hoveredId: string | null | undefined,
): boolean {
  if (!hoveredId) return false;
  const { a, b } = linkEndpointIds(link as { source: never; target: never });
  return a === hoveredId || b === hoveredId;
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseColorToRgba(input: string): Rgba {
  const m = input.trim().match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (m) {
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] !== undefined ? +m[4] : 1 };
  }
  const hex = input.trim();
  if (hex.startsWith("#") && (hex.length === 7 || hex.length === 4)) {
    const h = hex.slice(1);
    const expand = (s: string) => (s.length === 1 ? s + s : s);
    if (h.length === 3) {
      return {
        r: parseInt(expand(h[0]!), 16),
        g: parseInt(expand(h[1]!), 16),
        b: parseInt(expand(h[2]!), 16),
        a: 1,
      };
    }
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1,
    };
  }
  return { r: 128, g: 128, b: 128, a: 1 };
}

export function rgbaString(c: Rgba): string {
  return `rgba(${c.r},${c.g},${c.b},${c.a})`;
}

export function multiplyRgbaAlpha(input: string, alphaMult: number): string {
  const c = parseColorToRgba(input);
  return rgbaString({ ...c, a: Math.min(1, Math.max(0, c.a * alphaMult)) });
}

export function mixRgba(c0: Rgba, c1: Rgba, t: number): Rgba {
  const u = Math.min(1, Math.max(0, t));
  return {
    r: Math.round(c0.r * (1 - u) + c1.r * u),
    g: Math.round(c0.g * (1 - u) + c1.g * u),
    b: Math.round(c0.b * (1 - u) + c1.b * u),
    a: c0.a * (1 - u) + c1.a * u,
  };
}

export function mixCssColors(a: string, b: string, t: number): string {
  return rgbaString(mixRgba(parseColorToRgba(a), parseColorToRgba(b), t));
}

/** Undirected adjacency from links whose endpoints are string ids. */
export function buildAdjacencyStringLinks(links: Array<{ source: string; target: string }>): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  const add = (x: string, y: string) => {
    if (!m.has(x)) m.set(x, new Set());
    if (!m.has(y)) m.set(y, new Set());
    m.get(x)!.add(y);
    m.get(y)!.add(x);
  };
  for (const l of links) {
    add(l.source, l.target);
  }
  return m;
}

/** BFS hop distances from `startId` up to `maxDepth` (inclusive). Unreachable nodes omitted. */
export function bfsHopDistances(adj: Map<string, Set<string>>, startId: string, maxDepth: number): Map<string, number> {
  const dist = new Map<string, number>();
  const q: string[] = [startId];
  dist.set(startId, 0);
  for (let qi = 0; qi < q.length; qi++) {
    const u = q[qi]!;
    const d = dist.get(u)!;
    if (d >= maxDepth) continue;
    for (const v of adj.get(u) ?? []) {
      if (!dist.has(v)) {
        dist.set(v, d + 1);
        q.push(v);
      }
    }
  }
  return dist;
}

const INF = 1e9;

export function nodeDistanceOrInf(dist: Map<string, number> | null | undefined, nodeId: string): number {
  if (!dist) return INF;
  return dist.get(nodeId) ?? INF;
}

/** Edge propagation tier 0..2, or -1 if outside 2-hop ball or no hover. */
export function edgeHoverTier(
  link: { source: unknown; target: unknown },
  dist: Map<string, number> | null,
  hoveredId: string | null | undefined,
): -1 | 0 | 1 | 2 {
  if (!hoveredId || !dist) return -1;
  const { a, b } = linkEndpointIds(link as { source: never; target: never });
  const da = nodeDistanceOrInf(dist, a);
  const db = nodeDistanceOrInf(dist, b);
  if (da > 2 || db > 2) return -1;
  const t = Math.min(da, db);
  if (t === 0 || t === 1 || t === 2) return t;
  return -1;
}

export function graphEdgeStrokeColor(
  p: GraphHighlightPalette,
  dist: Map<string, number> | null,
  hoveredId: string | null,
  link: { source: unknown; target: unknown },
): string {
  if (!hoveredId) return multiplyRgbaAlpha(p.edge, p.idleAlphaMult);
  const tier = edgeHoverTier(link, dist, hoveredId);
  if (tier === -1) return multiplyRgbaAlpha(p.edge, p.farAlphaMult);
  const base = parseColorToRgba(p.edgeHover);
  const mult = p.edgeHoverTierAlpha[tier];
  return rgbaString({ ...base, a: Math.min(1, base.a * mult) });
}

export function graph2DEdgeLineWidth(hoveredId: string | null, tier: -1 | 0 | 1 | 2): number {
  if (!hoveredId) return GRAPH_2D_EDGE_WIDTH;
  if (tier === 0) return GRAPH_2D_EDGE_WIDTH_HOVER;
  if (tier === 1) return 1.22;
  if (tier === 2) return 1.06;
  return GRAPH_2D_EDGE_WIDTH;
}

export function graphNodeFillColor(
  p: GraphHighlightPalette,
  dist: Map<string, number> | null,
  hoveredId: string | null,
  nodeId: string,
): string {
  if (!hoveredId) return multiplyRgbaAlpha(p.node, p.idleAlphaMult);
  const d = nodeDistanceOrInf(dist, nodeId);
  if (d === 0) return p.nodeHover;
  if (p.neighborFillBlendStyle === "lightenFromHover") {
    if (d === 1) return mixCssColors(p.nodeHover, p.neighborSofterTarget, p.nodeFillBlend1);
    if (d === 2) return mixCssColors(p.nodeHover, p.neighborSofterTarget, p.nodeFillBlend2);
  } else {
    if (d === 1) return mixCssColors(p.node, p.nodeHover, p.nodeFillBlend1);
    if (d === 2) return mixCssColors(p.node, p.nodeHover, p.nodeFillBlend2);
  }
  return multiplyRgbaAlpha(p.node, p.farAlphaMult);
}

export function graphNodeRingColor(
  p: GraphHighlightPalette,
  dist: Map<string, number> | null,
  hoveredId: string | null,
  nodeId: string,
): string {
  if (!hoveredId) return multiplyRgbaAlpha(p.nodeRing, p.idleAlphaMult);
  const d = nodeDistanceOrInf(dist, nodeId);
  if (d === 0) return p.nodeRingHover;
  if (p.neighborFillBlendStyle === "lightenFromHover") {
    if (d === 1) return mixCssColors(p.nodeRingHover, p.neighborSofterTarget, p.ringBlend1);
    if (d === 2) return mixCssColors(p.nodeRingHover, p.neighborSofterTarget, p.ringBlend2);
  } else {
    if (d === 1) return mixCssColors(p.nodeRing, p.nodeRingHover, p.ringBlend1);
    if (d === 2) return mixCssColors(p.nodeRing, p.nodeRingHover, p.ringBlend2);
  }
  return multiplyRgbaAlpha(p.nodeRing, p.farAlphaMult);
}

export function graph2DNodeRingLineWidth(hoveredId: string | null, nodeId: string, dist: Map<string, number> | null): number {
  if (!hoveredId) return 0.5;
  const d = nodeDistanceOrInf(dist, nodeId);
  if (d === 0) return 2;
  if (d === 1) return 1.55;
  if (d === 2) return 1.15;
  return 0.45;
}

export function graphLabelColor(
  p: GraphHighlightPalette,
  dist: Map<string, number> | null,
  hoveredId: string | null,
  nodeId: string,
): string {
  if (!hoveredId) return multiplyRgbaAlpha(p.label, p.idleAlphaMult);
  const d = nodeDistanceOrInf(dist, nodeId);
  if (d === 0) return p.labelHover;
  if (p.neighborFillBlendStyle === "lightenFromHover") {
    if (d === 1) return mixCssColors(p.labelHover, p.neighborSofterTarget, p.labelBlend1);
    if (d === 2) return mixCssColors(p.labelHover, p.neighborSofterTarget, p.labelBlend2);
  } else {
    if (d === 1) return mixCssColors(p.label, p.labelHover, p.labelBlend1);
    if (d === 2) return mixCssColors(p.label, p.labelHover, p.labelBlend2);
  }
  return multiplyRgbaAlpha(p.label, p.farAlphaMult);
}

export function graph3DLinkWidth(hoveredId: string | null, tier: -1 | 0 | 1 | 2): number {
  if (!hoveredId) return GRAPH_3D_LINK_WIDTH;
  if (tier === 0) return GRAPH_3D_LINK_WIDTH_HOVER;
  if (tier === 1) return 0.52;
  if (tier === 2) return 0.44;
  return 0.32;
}

/** 2D canvas stroke widths (CSS pixels after transform). */
export const GRAPH_2D_EDGE_WIDTH = 1;
export const GRAPH_2D_EDGE_WIDTH_HOVER = 1.5;

/** 3D force-graph cylinder widths — same idle/hover ratio as 2D. */
export const GRAPH_3D_LINK_WIDTH = 0.4;
export const GRAPH_3D_LINK_WIDTH_HOVER = 0.6;

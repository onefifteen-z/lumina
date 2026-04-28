import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  Suspense,
  lazy,
} from "react";
import { Scan, LayoutGrid, Box, ListFilter } from "lucide-react";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceRadial,
  forceX,
  forceY,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import type { ArticleMeta } from "../../shared/types";
import {
  buildQueryRegex,
  registerFindBackend,
  type FindBackend,
  type FindOptions,
  type FindResult,
} from "../find/page-find-controller";
import {
  buildWikiGraph,
  buildWikiGraphTooltipMap,
  discoverWikiGraphFilterBuckets,
  filterArticlesForWikiGraph,
  wikiGraphFilterDiscoveryKey,
  DEFAULT_WIKI_GRAPH_FILTER_ENABLED,
  WIKI_GRAPH_ENTITY_TAG_OPTIONS,
  type WikiGraphEntityTag,
  type WikiGraphData,
  type WikiGraphNodeTooltip,
} from "./graph/wikiGraph";
import { GraphNodeTooltip } from "./graph/GraphNodeTooltip";
import {
  getGraphHighlightPalette,
  buildAdjacencyStringLinks,
  bfsHopDistances,
  graph2DEdgeLineWidth,
  graph2DNodeRingLineWidth,
  graphEdgeStrokeColor,
  graphLabelColor,
  graphNodeFillColorWithOverride,
  graphEntityNodeColorOverride,
  graphNodeRingColor,
  edgeHoverTier,
} from "./graph/graphHighlightPalette";

const GraphView3D = lazy(() => import("./graph/GraphView3D"));

function wikiGraphFilterRowLabel(id: string, kind: "folder" | "root"): string {
  if (kind === "root") return `${id}.md`;
  return id;
}

interface GraphNode extends SimulationNodeDatum {
  id: string;
  title: string;
  filename: string;
  linkCount: number;
  entityTag: WikiGraphEntityTag | null;
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
}

interface GraphViewProps {
  articles: ArticleMeta[];
  onSelectArticle: (filename: string) => void;
}

type GraphMode = "2d" | "3d";

const GRAPH_LOW_ZOOM_THRESHOLD_2D = 0.8;
const GRAPH_LOW_ZOOM_TOP_RATIO = 0.1;
const GRAPH_DEFAULT_RADIAL_STEP = 140;
const GRAPH_DEFAULT_RADIAL_STRENGTH = 0.26;
const GRAPH_DEFAULT_RADIAL_PRIORITY_STEMS = new Set(["index", "glossary", "overview"]);

function topLinkCountThreshold(nodes: Array<{ linkCount: number }>, topRatio: number): number {
  if (nodes.length === 0) return 0;
  const sorted = nodes.map((n) => n.linkCount).sort((a, b) => b - a);
  const topN = Math.max(1, Math.ceil(sorted.length * topRatio));
  return sorted[topN - 1] ?? 0;
}

function graphEndpointId(n: string | GraphNode): string {
  return typeof n === "string" ? n : n.id;
}

function graphFilenameStem(filename: string): string {
  const base = filename.split("/").pop() ?? filename;
  return base.replace(/\.md$/i, "").toLowerCase();
}

/**
 * Infer graph communities from link topology (label propagation), so clusters
 * are structural rather than directory-based.
 */
function computeGraphClusterMap(nodes: GraphNode[], links: GraphLink[]): Map<string, string> {
  const adj = new Map<string, Set<string>>();
  for (const n of nodes) adj.set(n.id, new Set());
  for (const l of links) {
    const a = graphEndpointId(l.source);
    const b = graphEndpointId(l.target);
    if (a === b) continue;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  }

  // Deterministic initialization and updates for stable layout behavior.
  const labels = new Map(nodes.map((n) => [n.id, n.id] as const));
  const ids = nodes.map((n) => n.id).sort();
  const maxIters = 24;
  for (let iter = 0; iter < maxIters; iter++) {
    let changed = 0;
    for (const id of ids) {
      const nbrs = adj.get(id);
      if (!nbrs || nbrs.size === 0) continue;
      const counts = new Map<string, number>();
      for (const nb of nbrs) {
        const lb = labels.get(nb);
        if (!lb) continue;
        counts.set(lb, (counts.get(lb) ?? 0) + 1);
      }
      if (counts.size === 0) continue;
      let bestLabel = labels.get(id)!;
      let bestScore = -1;
      for (const [lb, score] of counts) {
        if (score > bestScore || (score === bestScore && lb < bestLabel)) {
          bestLabel = lb;
          bestScore = score;
        }
      }
      if (labels.get(id) !== bestLabel) {
        labels.set(id, bestLabel);
        changed += 1;
      }
    }
    if (changed === 0) break;
  }
  return labels;
}

interface GraphView2DCanvasProps {
  graphData: WikiGraphData;
  tooltips: Map<string, WikiGraphNodeTooltip>;
  onSelectArticle: (filename: string) => void;
  onFitRequestRef?: React.MutableRefObject<(() => void) | null>;
  onActivateRequestRef?: React.MutableRefObject<((nodeId: string | null) => void) | null>;
}

function GraphView2DCanvas({
  graphData,
  tooltips,
  onSelectArticle,
  onFitRequestRef,
  onActivateRequestRef,
}: GraphView2DCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<GraphNode[]>([]);
  const linksRef = useRef<GraphLink[]>([]);
  const simRef = useRef<ReturnType<typeof forceSimulation<GraphNode>> | null>(null);
  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const dragRef = useRef<{ node: GraphNode; offsetX: number; offsetY: number } | null>(null);
  const panRef = useRef<{ startX: number; startY: number; tx: number; ty: number } | null>(null);
  const hoveredRef = useRef<GraphNode | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const pointerMovedRef = useRef(false);
  const flyRafRef = useRef<number | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const [hovered, setHovered] = useState<string | null>(null);
  const [tooltipClient, setTooltipClient] = useState<{ x: number; y: number } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeTooltipClient, setActiveTooltipClient] = useState<{ x: number; y: number } | null>(null);

  const fitAll = useCallback(() => {
    const nodes = nodesRef.current;
    if (nodes.length === 0) return;
    const { w, h } = sizeRef.current;
    if (w === 0 || h === 0) return;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      if (n.x == null || n.y == null) continue;
      minX = Math.min(minX, n.x);
      maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y);
      maxY = Math.max(maxY, n.y);
    }
    const pad = 60;
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;
    const scale = Math.min((w - pad * 2) / rangeX, (h - pad * 2) / rangeY, 2);
    transformRef.current = {
      x: -((minX + maxX) / 2) * scale,
      y: -((minY + maxY) / 2) * scale,
      k: scale,
    };
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { w, h } = sizeRef.current;
    const { x: tx, y: ty, k } = transformRef.current;
    const nodes = nodesRef.current;
    const links = linksRef.current;
    const hovId = activeIdRef.current ?? hoveredRef.current?.id ?? null;
    const lowZoomMinLinkCount = topLinkCountThreshold(nodes, GRAPH_LOW_ZOOM_TOP_RATIO);

    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    const p = getGraphHighlightPalette(isDark);

    const adj = buildAdjacencyStringLinks(
      links.map((l) => ({
        source: (l.source as GraphNode).id,
        target: (l.target as GraphNode).id,
      })),
    );
    const dist = hovId ? bfsHopDistances(adj, hovId, 2) : null;
    const isVisibleLabel = (n: GraphNode): boolean =>
      n.id === hovId ||
      GRAPH_DEFAULT_RADIAL_PRIORITY_STEMS.has(graphFilenameStem(n.filename)) ||
      k >= GRAPH_LOW_ZOOM_THRESHOLD_2D ||
      n.linkCount >= lowZoomMinLinkCount;

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2 + tx, h / 2 + ty);
    ctx.scale(k, k);

    for (const l of links) {
      const s = l.source as GraphNode;
      const t = l.target as GraphNode;
      if (s.x == null || s.y == null || t.x == null || t.y == null) continue;
      const tier = edgeHoverTier(l, dist, hovId);
      ctx.strokeStyle = graphEdgeStrokeColor(p, dist, hovId, l);
      ctx.lineWidth = graph2DEdgeLineWidth(hovId, tier);
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
    }

    for (const n of nodes) {
      if (n.x == null || n.y == null) continue;
      const r = 3 + Math.min(n.linkCount, 12) * 1.2;

      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = graphNodeFillColorWithOverride(
        p,
        dist,
        hovId,
        n.id,
        graphEntityNodeColorOverride(n.entityTag, isDark),
      );
      ctx.fill();

      ctx.strokeStyle = graphNodeRingColor(p, dist, hovId, n.id);
      ctx.lineWidth = graph2DNodeRingLineWidth(hovId, n.id, dist);
      ctx.stroke();
    }

    ctx.font = `${Math.max(9, 10 / k)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    for (const n of nodes) {
      if (n.x == null || n.y == null) continue;
      if (!isVisibleLabel(n)) continue;
      const r = 3 + Math.min(n.linkCount, 12) * 1.2;
      ctx.fillStyle = graphLabelColor(p, dist, hovId, n.id);
      ctx.fillText(n.title, n.x, n.y + r + 12);
    }

    ctx.restore();
  }, []);

  useEffect(() => {
    const nodes: GraphNode[] = graphData.nodes.map((n) => ({ ...n }));
    const links: GraphLink[] = graphData.links.map((l) => ({ source: l.source, target: l.target }));
    const clusterByNodeId = computeGraphClusterMap(nodes, links);
    const linkClusterClass = (l: GraphLink): "intra" | "inter" => {
      const sourceId = graphEndpointId(l.source);
      const targetId = graphEndpointId(l.target);
      const cs = clusterByNodeId.get(sourceId);
      const ct = clusterByNodeId.get(targetId);
      return cs && ct && cs === ct ? "intra" : "inter";
    };

    nodesRef.current = nodes;
    linksRef.current = links;
    const adjacency = buildAdjacencyStringLinks(
      links.map((l) => ({
        source: typeof l.source === "string" ? l.source : l.source.id,
        target: typeof l.target === "string" ? l.target : l.target.id,
      })),
    );
    const hubNode =
      nodes.find((n) => n.filename.toLowerCase() === "wiki/index.md") ??
      nodes.find((n) => graphFilenameStem(n.filename) === "index") ??
      nodes.reduce<GraphNode | null>(
        (best, n) => (best == null || n.linkCount > best.linkCount ? n : best),
        null,
      );
    const hubId = hubNode?.id ?? null;
    const hopDist = hubId ? bfsHopDistances(adjacency, hubId, 32) : new Map<string, number>();
    const maxHop = Math.max(0, ...hopDist.values());

    const sim = forceSimulation<GraphNode>(nodes)
      .alphaDecay(0.015)
      .velocityDecay(0.55)
      .force(
        "link",
        forceLink<GraphNode, GraphLink>(links)
          .id((d) => d.id)
          .distance((l) => (linkClusterClass(l) === "intra" ? 72 : 96))
          .strength((l) => (linkClusterClass(l) === "intra" ? 0.34 : 0.08)),
      )
      .force("charge", forceManyBody().strength(-320).distanceMax(720))
      .force("center", forceCenter(0, 0).strength(0.015))
      .force("x", forceX(0).strength((n) => (n as GraphNode).linkCount === 0 ? 0.12 : 0.01))
      .force("y", forceY(0).strength((n) => (n as GraphNode).linkCount === 0 ? 0.12 : 0.01))
      .force(
        "radial",
        forceRadial<GraphNode>(
          (n) => {
            if (hubId && n.id === hubId) return 0;
            if (GRAPH_DEFAULT_RADIAL_PRIORITY_STEMS.has(graphFilenameStem(n.filename))) {
              return GRAPH_DEFAULT_RADIAL_STEP;
            }
            const d = hopDist.get(n.id);
            if (d == null) return (maxHop + 1) * GRAPH_DEFAULT_RADIAL_STEP;
            return Math.max(1, d) * GRAPH_DEFAULT_RADIAL_STEP;
          },
          0,
          0,
        ).strength(GRAPH_DEFAULT_RADIAL_STRENGTH),
      )
      .force("collide", forceCollide(48));

    sim.stop();
    // Settle layout synchronously so the first paint is already stable + fit (no visible “flying” dots).
    if (nodes.length > 0) {
      const maxTicks = Math.min(5000, Math.max(400, nodes.length * 25));
      let ticks = 0;
      while (sim.alpha() > sim.alphaMin() && ticks < maxTicks) {
        sim.tick();
        ticks += 1;
      }
    }

    fitAll();
    draw();

    sim.on("tick", draw).on("end", () => {
      fitAll();
      draw();
    });

    simRef.current = sim;
    return () => {
      sim.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- draw/fitAll stable; graph identity tracks article-driven rebuilds
  }, [graphData, draw, fitAll]);

  useEffect(() => {
    activeIdRef.current = activeId;
    draw();
  }, [activeId, draw]);

  useEffect(() => {
    if (!activeId) return;
    if (!tooltips.has(activeId)) {
      setActiveId(null);
      setActiveTooltipClient(null);
    }
  }, [activeId, tooltips]);

  const activateNode = useCallback(
    (node: GraphNode, _tooltipClient?: { x: number; y: number } | null) => {
      if (flyRafRef.current != null) {
        cancelAnimationFrame(flyRafRef.current);
        flyRafRef.current = null;
      }
      setActiveId(node.id);
      const canvas = canvasRef.current;
      if (!canvas) {
        setActiveTooltipClient(null);
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const { w, h } = sizeRef.current;
      const centerClient = { x: rect.left + w / 2, y: rect.top + h / 2 };
      setActiveTooltipClient(centerClient);
      if (node.x == null || node.y == null) {
        draw();
        return;
      }
      const t0 = transformRef.current;
      const startX = t0.x;
      const startY = t0.y;
      const targetX = -node.x * t0.k;
      const targetY = -node.y * t0.k;
      const durationMs = 420;
      const ts0 = performance.now();
      const ease = (u: number) => 1 - (1 - u) * (1 - u);
      const maybeResetIfOutOfBounds = () => {
        const { w, h } = sizeRef.current;
        if (w <= 0 || h <= 0) return;
        let minSX = Infinity;
        let maxSX = -Infinity;
        let minSY = Infinity;
        let maxSY = -Infinity;
        const { x: tx, y: ty, k } = transformRef.current;
        for (const n of nodesRef.current) {
          if (n.x == null || n.y == null) continue;
          const sx = w / 2 + tx + n.x * k;
          const sy = h / 2 + ty + n.y * k;
          minSX = Math.min(minSX, sx);
          maxSX = Math.max(maxSX, sx);
          minSY = Math.min(minSY, sy);
          maxSY = Math.max(maxSY, sy);
        }
        const offscreenPad = 48;
        const fullyOutside =
          maxSX < -offscreenPad ||
          minSX > w + offscreenPad ||
          maxSY < -offscreenPad ||
          minSY > h + offscreenPad;
        if (fullyOutside) {
          fitAll();
          draw();
          const rect2 = canvas.getBoundingClientRect();
          setActiveTooltipClient({ x: rect2.left + w / 2, y: rect2.top + h / 2 });
        }
      };
      const step = (ts: number) => {
        const u = Math.min(1, (ts - ts0) / durationMs);
        const e = ease(u);
        transformRef.current.x = startX + (targetX - startX) * e;
        transformRef.current.y = startY + (targetY - startY) * e;
        setActiveTooltipClient(centerClient);
        draw();
        if (u < 1) flyRafRef.current = requestAnimationFrame(step);
        else {
          flyRafRef.current = null;
          maybeResetIfOutOfBounds();
        }
      };
      flyRafRef.current = requestAnimationFrame(step);
    },
    [draw, fitAll],
  );

  useEffect(
    () => () => {
      if (flyRafRef.current != null) cancelAnimationFrame(flyRafRef.current);
    },
    [],
  );

  useEffect(() => {
    const runFit = () => {
      fitAll();
      draw();
    };
    if (onFitRequestRef) onFitRequestRef.current = runFit;
    return () => {
      if (onFitRequestRef) onFitRequestRef.current = null;
    };
  }, [onFitRequestRef, fitAll, draw]);

  useEffect(() => {
    if (!onActivateRequestRef) return;
    onActivateRequestRef.current = (nodeId) => {
      if (!nodeId) {
        setActiveId(null);
        setActiveTooltipClient(null);
        return;
      }
      const n = nodesRef.current.find((x) => x.id === nodeId);
      if (!n) return;
      activateNode(n, null);
    };
    return () => {
      onActivateRequestRef.current = null;
    };
  }, [onActivateRequestRef, activateNode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.getContext("2d")?.scale(dpr, dpr);
      sizeRef.current = { w: width, h: height };
      fitAll();
      draw();
    });
    ro.observe(canvas.parentElement!);
    return () => ro.disconnect();
  }, [draw, fitAll]);

  const hitTest = useCallback((clientX: number, clientY: number): GraphNode | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const { w, h } = sizeRef.current;
    const { x: tx, y: ty, k } = transformRef.current;
    const mx = (clientX - rect.left - w / 2 - tx) / k;
    const my = (clientY - rect.top - h / 2 - ty) / k;
    for (const n of nodesRef.current) {
      if (n.x == null || n.y == null) continue;
      const r = 4 + Math.min(n.linkCount, 10) * 1.5 + 4;
      if ((mx - n.x) ** 2 + (my - n.y) ** 2 < r * r) return n;
    }
    return null;
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      pointerMovedRef.current = false;
      const node = hitTest(e.clientX, e.clientY);
      if (node && node.x != null && node.y != null) {
        const canvas = canvasRef.current!;
        const rect = canvas.getBoundingClientRect();
        const { w, h } = sizeRef.current;
        const { x: tx, y: ty, k } = transformRef.current;
        const mx = (e.clientX - rect.left - w / 2 - tx) / k;
        const my = (e.clientY - rect.top - h / 2 - ty) / k;
        dragRef.current = { node, offsetX: node.x - mx, offsetY: node.y - my };
        node.fx = node.x;
        node.fy = node.y;
        simRef.current?.alphaTarget(0.08).restart();
      } else {
        panRef.current = { startX: e.clientX, startY: e.clientY, tx: transformRef.current.x, ty: transformRef.current.y };
      }
    },
    [hitTest],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (dragRef.current) {
        pointerMovedRef.current = true;
        setTooltipClient(null);
        const canvas = canvasRef.current!;
        const rect = canvas.getBoundingClientRect();
        const { w, h } = sizeRef.current;
        const { x: tx, y: ty, k } = transformRef.current;
        const mx = (e.clientX - rect.left - w / 2 - tx) / k;
        const my = (e.clientY - rect.top - h / 2 - ty) / k;
        dragRef.current.node.fx = mx + dragRef.current.offsetX;
        dragRef.current.node.fy = my + dragRef.current.offsetY;
        return;
      }
      if (panRef.current) {
        pointerMovedRef.current = true;
        setTooltipClient(null);
        transformRef.current.x = panRef.current.tx + (e.clientX - panRef.current.startX);
        transformRef.current.y = panRef.current.ty + (e.clientY - panRef.current.startY);
        draw();
        return;
      }
      const node = hitTest(e.clientX, e.clientY);
      if (!activeIdRef.current) {
        if (node) setTooltipClient({ x: e.clientX, y: e.clientY });
        else setTooltipClient(null);
      }
      const prev = hoveredRef.current;
      if (node?.id !== prev?.id) {
        hoveredRef.current = node;
        setHovered(node?.id ?? null);
        draw();
      }
    },
    [hitTest, draw],
  );

  const handleMouseUp = useCallback(() => {
    if (dragRef.current) {
      dragRef.current.node.fx = null;
      dragRef.current.node.fy = null;
      dragRef.current = null;
      simRef.current?.alphaTarget(0);
    }
    panRef.current = null;
  }, []);

  const handleCanvasLeave = useCallback(() => {
    handleMouseUp();
    hoveredRef.current = null;
    setHovered(null);
    setTooltipClient(null);
    draw();
  }, [handleMouseUp, draw]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (panRef.current) return;
      const node = hitTest(e.clientX, e.clientY);
      if (pointerMovedRef.current) {
        pointerMovedRef.current = false;
        if (!node) {
          setActiveId(null);
          setActiveTooltipClient(null);
        }
        return;
      }
      if (!node) {
        setActiveId(null);
        setActiveTooltipClient(null);
        return;
      }
      activateNode(node, { x: e.clientX, y: e.clientY });
    },
    [hitTest, activateNode],
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const t = transformRef.current;
      t.k = Math.max(0.1, Math.min(5, t.k * delta));
      draw();
    },
    [draw],
  );

  const hoverTipData =
    !activeId && hovered && tooltipClient ? tooltips.get(hovered) : undefined;
  const activeTipData = activeId && activeTooltipClient ? tooltips.get(activeId) : undefined;

  return (
    <div className="relative w-full h-full">
      <canvas
        ref={canvasRef}
        className="w-full h-full block"
        style={{ cursor: hovered ? "pointer" : "grab" }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleCanvasLeave}
        onClick={handleClick}
        onWheel={handleWheel}
      />
      {hoverTipData && tooltipClient ? (
        <GraphNodeTooltip data={hoverTipData} clientX={tooltipClient.x} clientY={tooltipClient.y} />
      ) : null}
      {activeTipData && activeTooltipClient ? (
        <GraphNodeTooltip
          data={activeTipData}
          clientX={activeTooltipClient.x}
          clientY={activeTooltipClient.y}
          variant="active"
          onOpenFullPage={() => onSelectArticle(activeTipData.filename)}
        />
      ) : null}
    </div>
  );
}

export function GraphView({ articles, onSelectArticle }: GraphViewProps) {
  const filterBuckets = useMemo(() => discoverWikiGraphFilterBuckets(articles), [articles]);
  const filterDiscoveryKey = useMemo(() => wikiGraphFilterDiscoveryKey(filterBuckets), [filterBuckets]);

  const [enabledWikiFilters, setEnabledWikiFilters] = useState<Set<string>>(() => {
    const b = discoverWikiGraphFilterBuckets(articles);
    const next = new Set<string>();
    for (const id of [...b.folderIds, ...b.rootFileIds]) {
      if (DEFAULT_WIKI_GRAPH_FILTER_ENABLED.has(id)) next.add(id);
    }
    return next;
  });
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [enabledEntityTags, setEnabledEntityTags] = useState<Set<WikiGraphEntityTag>>(
    () => new Set(WIKI_GRAPH_ENTITY_TAG_OPTIONS),
  );
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const prevFilterDiscoveryKeyRef = useRef(filterDiscoveryKey);

  useLayoutEffect(() => {
    if (prevFilterDiscoveryKeyRef.current === filterDiscoveryKey) return;
    prevFilterDiscoveryKeyRef.current = filterDiscoveryKey;
    const all = new Set([...filterBuckets.folderIds, ...filterBuckets.rootFileIds]);
    const next = new Set<string>();
    for (const id of all) {
      if (DEFAULT_WIKI_GRAPH_FILTER_ENABLED.has(id)) next.add(id);
    }
    setEnabledWikiFilters(next);
  }, [filterDiscoveryKey, filterBuckets]);

  useEffect(() => {
    if (!filterMenuOpen) return;
    const close = (e: MouseEvent) => {
      if (filterMenuRef.current && !filterMenuRef.current.contains(e.target as Node)) {
        setFilterMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [filterMenuOpen]);

  const filteredArticles = useMemo(
    () => filterArticlesForWikiGraph(articles, enabledWikiFilters, enabledEntityTags),
    [articles, enabledWikiFilters, enabledEntityTags],
  );

  const graphData = useMemo(() => buildWikiGraph(filteredArticles), [filteredArticles]);
  const graphTooltips = useMemo(() => buildWikiGraphTooltipMap(filteredArticles), [filteredArticles]);

  const toggleWikiFilter = useCallback((id: string) => {
    setEnabledWikiFilters((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleEntityTag = useCallback((tag: WikiGraphEntityTag) => {
    setEnabledEntityTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }, []);

  const hasWikiFilterOptions =
    filterBuckets.folderIds.length > 0 || filterBuckets.rootFileIds.length > 0;

  const [mode, setMode] = useState<GraphMode>("2d");
  const fit2dRef = useRef<(() => void) | null>(null);
  const fit3dRef = useRef<(() => void) | null>(null);
  const activate2dRef = useRef<((nodeId: string | null) => void) | null>(null);
  const activate3dRef = useRef<((nodeId: string | null) => void) | null>(null);
  const modeRef = useRef<GraphMode>("2d");
  const graphDataRef = useRef(graphData);
  const graphTooltipsRef = useRef(graphTooltips);
  const findMatchesRef = useRef<string[]>([]);
  const findIndexRef = useRef(-1);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    graphDataRef.current = graphData;
  }, [graphData]);
  useEffect(() => {
    graphTooltipsRef.current = graphTooltips;
  }, [graphTooltips]);

  useEffect(() => {
    const activateNode = (nodeId: string | null) => {
      if (modeRef.current === "2d") activate2dRef.current?.(nodeId);
      else activate3dRef.current?.(nodeId);
    };

    const searchable = (nodeId: string): string => {
      const n = graphDataRef.current.nodes.find((x) => x.id === nodeId);
      if (!n) return "";
      const tip = graphTooltipsRef.current.get(nodeId);
      return [
        n.title,
        graphFilenameStem(n.filename),
        n.id,
        n.filename,
        tip?.fullTitle ?? "",
        tip?.excerpt ?? "",
        ...(tip?.tags ?? []),
      ].join("\n");
    };

    const applyMatchAt = (idx: number): FindResult => {
      const matches = findMatchesRef.current;
      if (matches.length === 0) {
        findIndexRef.current = -1;
        activateNode(null);
        return { total: 0, current: 0 };
      }
      const next = ((idx % matches.length) + matches.length) % matches.length;
      findIndexRef.current = next;
      activateNode(matches[next]!);
      return { total: matches.length, current: next + 1 };
    };

    const backend: FindBackend = {
      search(query: string, opts: FindOptions): FindResult {
        const rx = buildQueryRegex(query, opts);
        if (!rx) {
          findMatchesRef.current = [];
          return applyMatchAt(-1);
        }
        const matches: string[] = [];
        for (const n of graphDataRef.current.nodes) {
          rx.lastIndex = 0;
          if (rx.test(searchable(n.id))) matches.push(n.id);
        }
        findMatchesRef.current = matches;
        return applyMatchAt(0);
      },
      next(): FindResult {
        return applyMatchAt(findIndexRef.current + 1);
      },
      prev(): FindResult {
        return applyMatchAt(findIndexRef.current - 1);
      },
      clear(): void {
        findMatchesRef.current = [];
        findIndexRef.current = -1;
        activateNode(null);
      },
    };

    return registerFindBackend(backend);
  }, [graphData, graphTooltips, mode]);

  const [isDark, setIsDark] = useState(
    () => document.documentElement.getAttribute("data-theme") === "dark",
  );
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setIsDark(document.documentElement.getAttribute("data-theme") === "dark");
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  return (
    <div className="relative w-full h-full bg-main-bg overflow-hidden">
      <div ref={filterMenuRef} className="absolute top-3 right-3 z-20">
        <button
          type="button"
          title="Filter wiki scope"
          aria-expanded={filterMenuOpen}
          aria-haspopup="true"
          onClick={() => setFilterMenuOpen((o) => !o)}
          className={`w-8 h-8 flex items-center justify-center rounded-md border transition-colors ${
            filterMenuOpen
              ? "bg-surface-hover border-primary-border text-text-primary"
              : "bg-surface-hover border-border text-text-secondary hover:text-text-primary"
          }`}
        >
          <ListFilter size={15} aria-hidden />
        </button>
        {filterMenuOpen && (
          <div
            className="absolute right-0 mt-1 w-56 max-h-[min(70vh,22rem)] overflow-y-auto rounded-md border border-border bg-sidebar-bg shadow-lg py-2 px-1 text-sm"
            role="menu"
            aria-label="Wiki graph filters"
          >
            {!hasWikiFilterOptions ? (
              <div className="px-3 py-2 text-text-secondary text-xs">No wiki folders or root pages found.</div>
            ) : (
              <>
                {filterBuckets.folderIds.length > 0 && (
                  <div className="px-2 pb-1">
                    <div className="px-1 py-1 text-[11px] font-medium uppercase tracking-wide text-text-secondary">
                      Wiki folders
                    </div>
                    {filterBuckets.folderIds.map((id) => (
                      <label
                        key={id}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-surface-hover"
                      >
                        <input
                          type="checkbox"
                          className="rounded border-border"
                          checked={enabledWikiFilters.has(id)}
                          onChange={() => toggleWikiFilter(id)}
                        />
                        <span className="text-text-primary truncate">{wikiGraphFilterRowLabel(id, "folder")}</span>
                      </label>
                    ))}
                  </div>
                )}
                {filterBuckets.rootFileIds.length > 0 && (
                  <div className={`px-2 ${filterBuckets.folderIds.length > 0 ? "pt-2 border-t border-border" : ""}`}>
                    <div className="px-1 py-1 text-[11px] font-medium uppercase tracking-wide text-text-secondary">
                      Wiki root files
                    </div>
                    {filterBuckets.rootFileIds.map((id) => (
                      <label
                        key={id}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-surface-hover"
                      >
                        <input
                          type="checkbox"
                          className="rounded border-border"
                          checked={enabledWikiFilters.has(id)}
                          onChange={() => toggleWikiFilter(id)}
                        />
                        <span className="text-text-primary truncate">{wikiGraphFilterRowLabel(id, "root")}</span>
                      </label>
                    ))}
                  </div>
                )}
                <div
                  className={`px-2 ${
                    filterBuckets.rootFileIds.length > 0 || filterBuckets.folderIds.length > 0
                      ? "pt-2 border-t border-border"
                      : ""
                  }`}
                >
                  <div className="px-1 py-1 text-[11px] font-medium uppercase tracking-wide text-text-secondary">
                    Tag
                  </div>
                  {WIKI_GRAPH_ENTITY_TAG_OPTIONS.map((tag) => (
                    <label
                      key={tag}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-surface-hover"
                    >
                      <input
                        type="checkbox"
                        className="rounded border-border"
                        checked={enabledEntityTags.has(tag)}
                        onChange={() => toggleEntityTag(tag)}
                      />
                      <span className="text-text-primary truncate">{tag}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {mode === "2d" ? (
        <GraphView2DCanvas
          graphData={graphData}
          tooltips={graphTooltips}
          onSelectArticle={onSelectArticle}
          onFitRequestRef={fit2dRef}
          onActivateRequestRef={activate2dRef}
        />
      ) : (
        <Suspense
          fallback={
            <div className="w-full h-full flex items-center justify-center text-text-secondary text-sm">Loading 3D…</div>
          }
        >
          <GraphView3D
            graphData={graphData}
            tooltips={graphTooltips}
            onSelectArticle={onSelectArticle}
            isDark={isDark}
            onFitRequestRef={fit3dRef}
            onActivateRequestRef={activate3dRef}
          />
        </Suspense>
      )}

      <div className="absolute bottom-3 right-3 flex items-center gap-1.5">
        <div
          className="flex rounded-md border border-border overflow-hidden bg-sidebar-bg"
          role="group"
          aria-label="Graph layout"
        >
          <button
            type="button"
            title="2D graph"
            aria-pressed={mode === "2d"}
            onClick={() => setMode("2d")}
            className={`px-2 py-1.5 flex items-center justify-center transition-colors ${
              mode === "2d"
                ? "bg-surface-hover text-text-primary"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            <LayoutGrid size={15} aria-hidden />
          </button>
          <button
            type="button"
            title="3D graph"
            aria-pressed={mode === "3d"}
            onClick={() => setMode("3d")}
            className={`px-2 py-1.5 flex items-center justify-center transition-colors border-l border-border ${
              mode === "3d"
                ? "bg-surface-hover text-text-primary"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            <Box size={15} aria-hidden />
          </button>
        </div>
        <button
          type="button"
          title={mode === "2d" ? "Fit all nodes" : "Fit camera to graph"}
          onClick={() => {
            if (mode === "2d") fit2dRef.current?.();
            else fit3dRef.current?.();
          }}
          className="w-8 h-8 flex items-center justify-center rounded-md bg-surface-hover border border-border text-text-secondary hover:text-text-primary transition-colors"
        >
          <Scan size={15} />
        </button>
      </div>
    </div>
  );
}

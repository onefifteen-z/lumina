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
  forceX,
  forceY,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import type { ArticleMeta } from "../../shared/types";
import {
  buildWikiGraph,
  buildWikiGraphTooltipMap,
  discoverWikiGraphFilterBuckets,
  filterArticlesForWikiGraph,
  wikiGraphFilterDiscoveryKey,
  DEFAULT_WIKI_GRAPH_FILTER_ENABLED,
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
  graphNodeFillColor,
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

interface GraphView2DCanvasProps {
  graphData: WikiGraphData;
  tooltips: Map<string, WikiGraphNodeTooltip>;
  onSelectArticle: (filename: string) => void;
  onFitRequestRef?: React.MutableRefObject<(() => void) | null>;
}

function GraphView2DCanvas({ graphData, tooltips, onSelectArticle, onFitRequestRef }: GraphView2DCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<GraphNode[]>([]);
  const linksRef = useRef<GraphLink[]>([]);
  const simRef = useRef<ReturnType<typeof forceSimulation<GraphNode>> | null>(null);
  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const dragRef = useRef<{ node: GraphNode; offsetX: number; offsetY: number } | null>(null);
  const panRef = useRef<{ startX: number; startY: number; tx: number; ty: number } | null>(null);
  const hoveredRef = useRef<GraphNode | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const [hovered, setHovered] = useState<string | null>(null);
  const [tooltipClient, setTooltipClient] = useState<{ x: number; y: number } | null>(null);

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
    const hovId = hoveredRef.current?.id ?? null;

    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    const p = getGraphHighlightPalette(isDark);

    const adj = buildAdjacencyStringLinks(
      links.map((l) => ({
        source: (l.source as GraphNode).id,
        target: (l.target as GraphNode).id,
      })),
    );
    const dist = hovId ? bfsHopDistances(adj, hovId, 2) : null;

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
      ctx.fillStyle = graphNodeFillColor(p, dist, hovId, n.id);
      ctx.fill();

      ctx.strokeStyle = graphNodeRingColor(p, dist, hovId, n.id);
      ctx.lineWidth = graph2DNodeRingLineWidth(hovId, n.id, dist);
      ctx.stroke();
    }

    ctx.font = `${Math.max(9, 10 / k)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    for (const n of nodes) {
      if (n.x == null || n.y == null) continue;
      const r = 3 + Math.min(n.linkCount, 12) * 1.2;
      ctx.fillStyle = graphLabelColor(p, dist, hovId, n.id);
      ctx.fillText(n.title, n.x, n.y + r + 12);
    }

    ctx.restore();
  }, []);

  useEffect(() => {
    const nodes: GraphNode[] = graphData.nodes.map((n) => ({ ...n }));
    const links: GraphLink[] = graphData.links.map((l) => ({ source: l.source, target: l.target }));

    nodesRef.current = nodes;
    linksRef.current = links;

    const sim = forceSimulation<GraphNode>(nodes)
      .alphaDecay(0.015)
      .velocityDecay(0.55)
      .force("link", forceLink<GraphNode, GraphLink>(links).id((d) => d.id).distance(220).strength(0.3))
      .force("charge", forceManyBody().strength(-900).distanceMax(900))
      .force("center", forceCenter(0, 0).strength(0.015))
      .force("x", forceX(0).strength((n) => (n as GraphNode).linkCount === 0 ? 0.12 : 0.01))
      .force("y", forceY(0).strength((n) => (n as GraphNode).linkCount === 0 ? 0.12 : 0.01))
      .force("collide", forceCollide(65));

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
        setTooltipClient(null);
        transformRef.current.x = panRef.current.tx + (e.clientX - panRef.current.startX);
        transformRef.current.y = panRef.current.ty + (e.clientY - panRef.current.startY);
        draw();
        return;
      }
      const node = hitTest(e.clientX, e.clientY);
      if (node) setTooltipClient({ x: e.clientX, y: e.clientY });
      else setTooltipClient(null);
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
      if (node) onSelectArticle(node.filename);
    },
    [hitTest, onSelectArticle],
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

  const tipData = hovered && tooltipClient ? tooltips.get(hovered) : undefined;

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
      {tipData && tooltipClient ? (
        <GraphNodeTooltip data={tipData} clientX={tooltipClient.x} clientY={tooltipClient.y} />
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
    () => filterArticlesForWikiGraph(articles, enabledWikiFilters),
    [articles, enabledWikiFilters],
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

  const hasWikiFilterOptions =
    filterBuckets.folderIds.length > 0 || filterBuckets.rootFileIds.length > 0;

  const [mode, setMode] = useState<GraphMode>("2d");
  const fit2dRef = useRef<(() => void) | null>(null);
  const fit3dRef = useRef<(() => void) | null>(null);

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

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D from "react-force-graph-3d";
import type { ForceGraphMethods } from "react-force-graph-3d";
import type { WikiGraphData, WikiGraphNode, WikiGraphNodeTooltip } from "./wikiGraph";
import { GraphNodeTooltip } from "./GraphNodeTooltip";
import {
  getGraphHighlightPalette,
  buildAdjacencyStringLinks,
  bfsHopDistances,
  edgeHoverTier,
  graph3DLinkWidth,
  graphEdgeStrokeColor,
  graphEntityNodeColorOverride,
  graphNodeFillColorWithOverride,
} from "./graphHighlightPalette";

interface GraphView3DProps {
  graphData: WikiGraphData;
  tooltips: Map<string, WikiGraphNodeTooltip>;
  onSelectArticle: (filename: string) => void;
  isDark: boolean;
  onFitRequestRef?: React.MutableRefObject<(() => void) | null>;
  onActivateRequestRef?: React.MutableRefObject<((nodeId: string | null) => void) | null>;
}

interface OrbitLikeControls {
  target?: { x: number; y: number; z: number };
}

export default function GraphView3D({
  graphData,
  tooltips,
  onSelectArticle,
  isDark,
  onFitRequestRef,
  onActivateRequestRef,
}: GraphView3DProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const lastPtrRef = useRef({ x: 0, y: 0 });
  const focusRafRef = useRef<number | null>(null);
  const [dims, setDims] = useState({ w: 400, h: 300 });
  const fgRef = useRef<ForceGraphMethods<WikiGraphNode, { source: string; target: string }>>(undefined);

  const graphDataCloned = useMemo(
    () => ({
      nodes: graphData.nodes.map((n) => ({ ...n })),
      links: graphData.links.map((l) => ({ source: l.source, target: l.target })),
    }),
    [graphData],
  );

  const zoomFit = useCallback(() => {
    fgRef.current?.zoomToFit(400, 60);
  }, []);

  const focusNodeInView = useCallback((n: { x?: number; y?: number; z?: number }) => {
    const fg = fgRef.current;
    if (!fg || n.x == null || n.y == null || n.z == null) return;
    const camera = fg.camera() as { position?: { x: number; y: number; z: number } };
    const controls = fg.controls() as OrbitLikeControls;
    const cam = camera.position ?? { x: n.x + 260, y: n.y + 120, z: n.z + 220 };
    const tgt = controls?.target ?? { x: n.x, y: n.y, z: n.z };
    const vx = cam.x - tgt.x;
    const vy = cam.y - tgt.y;
    const vz = cam.z - tgt.z;
    const mag = Math.hypot(vx, vy, vz) || 360;
    const ux = vx / mag;
    const uy = vy / mag;
    const uz = vz / mag;
    const d = Math.max(260, Math.min(900, mag));
    fg.cameraPosition(
      { x: n.x + ux * d, y: n.y + uy * d, z: n.z + uz * d },
      { x: n.x, y: n.y, z: n.z },
      520,
    );
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (focusRafRef.current != null) cancelAnimationFrame(focusRafRef.current);
    const ts0 = performance.now();
    const tick = () => {
      if (!fgRef.current || n.x == null || n.y == null || n.z == null) return;
      const p = fgRef.current.graph2ScreenCoords(n.x, n.y, n.z);
      setActiveTipClient({ x: rect.left + p.x, y: rect.top + p.y });
      if (performance.now() - ts0 < 620) focusRafRef.current = requestAnimationFrame(tick);
      else {
        focusRafRef.current = null;
        const final = fgRef.current.graph2ScreenCoords(n.x, n.y, n.z);
        const margin = 24;
        const out =
          final.x < -margin ||
          final.x > rect.width + margin ||
          final.y < -margin ||
          final.y > rect.height + margin;
        if (out) {
          fgRef.current.zoomToFit(320, 60);
          setActiveTipClient({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
        }
      }
    };
    focusRafRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(
    () => () => {
      if (focusRafRef.current != null) cancelAnimationFrame(focusRafRef.current);
    },
    [],
  );

  useEffect(() => {
    if (onFitRequestRef) onFitRequestRef.current = zoomFit;
    return () => {
      if (onFitRequestRef) onFitRequestRef.current = null;
    };
  }, [onFitRequestRef, zoomFit]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setDims({ w: Math.max(80, width), h: Math.max(80, height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const palette = useMemo(() => getGraphHighlightPalette(isDark), [isDark]);

  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [tipClient, setTipClient] = useState<{ x: number; y: number } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeTipClient, setActiveTipClient] = useState<{ x: number; y: number } | null>(null);
  const focusedId = activeId ?? hoveredId;

  const stringLinks = useMemo(
    () => graphData.links.map((l) => ({ source: l.source, target: l.target })),
    [graphData],
  );

  const adj = useMemo(() => buildAdjacencyStringLinks(stringLinks), [stringLinks]);

  const hoverDist = useMemo(() => {
    if (!focusedId) return null;
    return bfsHopDistances(adj, String(focusedId), 2);
  }, [adj, focusedId]);

  const nodeColor = useCallback(
    (n: WikiGraphNode) =>
      graphNodeFillColorWithOverride(
        palette,
        hoverDist,
        focusedId,
        n.id,
        graphEntityNodeColorOverride(n.entityTag, isDark),
      ),
    [focusedId, hoverDist, isDark, palette],
  );

  const linkColorForLink = useCallback(
    (link: { source: unknown; target: unknown }) => graphEdgeStrokeColor(palette, hoverDist, focusedId, link),
    [focusedId, hoverDist, palette],
  );

  const linkWidthForLink = useCallback(
    (link: { source: unknown; target: unknown }) =>
      graph3DLinkWidth(focusedId, edgeHoverTier(link, hoverDist, focusedId)),
    [focusedId, hoverDist],
  );

  const handleNodeClick = useCallback(
    (node: WikiGraphNode) => {
      const n = node as WikiGraphNode & { x?: number; y?: number; z?: number };
      focusNodeInView(n);
      setActiveId(node.id);
      const rect = wrapRef.current?.getBoundingClientRect();
      if (rect) setActiveTipClient({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      else setActiveTipClient({ x: lastPtrRef.current.x, y: lastPtrRef.current.y });
    },
    [focusNodeInView],
  );

  useEffect(() => {
    if (!activeId) return;
    if (!tooltips.has(activeId)) {
      setActiveId(null);
      setActiveTipClient(null);
    }
  }, [activeId, tooltips]);

  useEffect(() => {
    if (!onActivateRequestRef) return;
    onActivateRequestRef.current = (nodeId) => {
      if (!nodeId) {
        setActiveId(null);
        setActiveTipClient(null);
        return;
      }
      const n = graphData.nodes.find((x) => x.id === nodeId) as
        | (WikiGraphNode & { x?: number; y?: number; z?: number })
        | undefined;
      if (!n) return;
      focusNodeInView(n);
      setActiveId(nodeId);
      const rect = wrapRef.current?.getBoundingClientRect();
      const fg = fgRef.current;
      if (!rect || !fg || n.x == null || n.y == null || n.z == null) {
        setActiveTipClient(rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null);
        return;
      }
      const p = fg.graph2ScreenCoords(n.x, n.y, n.z);
      setActiveTipClient({ x: rect.left + p.x, y: rect.top + p.y });
    };
    return () => {
      onActivateRequestRef.current = null;
    };
  }, [graphData, onActivateRequestRef, focusNodeInView]);

  const hoverTipPayload = !activeId && hoveredId && tipClient ? tooltips.get(hoveredId) : undefined;
  const activeTipPayload = activeId && activeTipClient ? tooltips.get(activeId) : undefined;

  return (
    <div
      ref={wrapRef}
      className="relative w-full h-full min-h-0"
      onPointerMove={(e) => {
        lastPtrRef.current = { x: e.clientX, y: e.clientY };
        if (!activeId && hoveredId) setTipClient({ x: e.clientX, y: e.clientY });
      }}
      onPointerLeave={() => {
        setHoveredId(null);
        setTipClient(null);
      }}
    >
      <ForceGraph3D<WikiGraphNode, { source: string; target: string }>
        ref={fgRef}
        width={dims.w}
        height={dims.h}
        backgroundColor={palette.canvasBg}
        graphData={graphDataCloned}
        nodeId="id"
        nodeLabel={() => ""}
        nodeVal={(n) => 1 + Math.max(0, n.linkCount) * 0.09}
        nodeColor={nodeColor}
        linkColor={linkColorForLink}
        linkOpacity={1}
        linkWidth={linkWidthForLink}
        showNavInfo={false}
        enableNavigationControls
        onNodeHover={(n) => {
          const id = n?.id ?? null;
          setHoveredId(id);
          if (!activeId && id) setTipClient({ x: lastPtrRef.current.x, y: lastPtrRef.current.y });
          else setTipClient(null);
        }}
        onNodeClick={handleNodeClick}
        onBackgroundClick={() => {
          setActiveId(null);
          setActiveTipClient(null);
        }}
        onEngineStop={zoomFit}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.35}
      />
      {hoverTipPayload && tipClient ? (
        <GraphNodeTooltip data={hoverTipPayload} clientX={tipClient.x} clientY={tipClient.y} />
      ) : null}
      {activeTipPayload && activeTipClient ? (
        <GraphNodeTooltip
          data={activeTipPayload}
          clientX={activeTipClient.x}
          clientY={activeTipClient.y}
          variant="active"
          onOpenFullPage={() => onSelectArticle(activeTipPayload.filename)}
        />
      ) : null}
    </div>
  );
}

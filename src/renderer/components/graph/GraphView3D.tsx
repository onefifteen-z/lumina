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
  graphNodeFillColor,
} from "./graphHighlightPalette";

interface GraphView3DProps {
  graphData: WikiGraphData;
  tooltips: Map<string, WikiGraphNodeTooltip>;
  onSelectArticle: (filename: string) => void;
  isDark: boolean;
  onFitRequestRef?: React.MutableRefObject<(() => void) | null>;
}

export default function GraphView3D({ graphData, tooltips, onSelectArticle, isDark, onFitRequestRef }: GraphView3DProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const lastPtrRef = useRef({ x: 0, y: 0 });
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

  const stringLinks = useMemo(
    () => graphData.links.map((l) => ({ source: l.source, target: l.target })),
    [graphData],
  );

  const adj = useMemo(() => buildAdjacencyStringLinks(stringLinks), [stringLinks]);

  const hoverDist = useMemo(() => {
    if (!hoveredId) return null;
    return bfsHopDistances(adj, String(hoveredId), 2);
  }, [adj, hoveredId]);

  const nodeColor = useCallback(
    (n: WikiGraphNode) => graphNodeFillColor(palette, hoverDist, hoveredId, n.id),
    [hoveredId, hoverDist, palette],
  );

  const linkColorForLink = useCallback(
    (link: { source: unknown; target: unknown }) => graphEdgeStrokeColor(palette, hoverDist, hoveredId, link),
    [hoveredId, hoverDist, palette],
  );

  const linkWidthForLink = useCallback(
    (link: { source: unknown; target: unknown }) =>
      graph3DLinkWidth(hoveredId, edgeHoverTier(link, hoverDist, hoveredId)),
    [hoveredId, hoverDist],
  );

  const handleNodeClick = useCallback(
    (node: WikiGraphNode) => {
      onSelectArticle(node.filename);
    },
    [onSelectArticle],
  );

  const tipPayload = hoveredId && tipClient ? tooltips.get(hoveredId) : undefined;

  return (
    <div
      ref={wrapRef}
      className="relative w-full h-full min-h-0"
      onPointerMove={(e) => {
        lastPtrRef.current = { x: e.clientX, y: e.clientY };
        if (hoveredId) setTipClient({ x: e.clientX, y: e.clientY });
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
        nodeVal={(n) => 1 + Math.min(n.linkCount, 12) * 0.35}
        nodeColor={nodeColor}
        linkColor={linkColorForLink}
        linkOpacity={1}
        linkWidth={linkWidthForLink}
        showNavInfo={false}
        enableNavigationControls
        onNodeHover={(n) => {
          const id = n?.id ?? null;
          setHoveredId(id);
          if (id) setTipClient({ x: lastPtrRef.current.x, y: lastPtrRef.current.y });
          else setTipClient(null);
        }}
        onNodeClick={handleNodeClick}
        onEngineStop={zoomFit}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.35}
      />
      {tipPayload && tipClient ? <GraphNodeTooltip data={tipPayload} clientX={tipClient.x} clientY={tipClient.y} /> : null}
    </div>
  );
}

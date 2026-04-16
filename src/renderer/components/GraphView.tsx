import React, { useEffect, useRef, useCallback, useState } from "react";
import { Scan } from "lucide-react";
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

/** Show only the leaf name — strip folder prefix if title is path-derived. */
function displayTitle(article: ArticleMeta): string {
  if (article.title.includes("/")) {
    const basename = article.filename.split("/").pop() ?? article.filename;
    return basename.replace(/\.md$/i, "");
  }
  return article.title;
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

export function GraphView({ articles, onSelectArticle }: GraphViewProps) {
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

  // Build graph data from articles
  useEffect(() => {
    // Only show articles under the wiki/ folder
    const wikiArticles = articles.filter((a) => a.filename.startsWith("wiki/"));

    // Build multiple lookup keys per article to maximise wikilink resolution:
    //   1. full title (exact)
    //   2. basename stem (for path-derived titles like "raw/MoM/file")
    //   3. filename stem
    const titleMap = new Map<string, string>(); // key -> filename
    for (const a of wikiArticles) {
      titleMap.set(a.title.toLowerCase(), a.filename);
      const stem = a.filename.split("/").pop()?.replace(/\.md$/i, "") ?? "";
      if (stem) titleMap.set(stem.toLowerCase(), a.filename);
      if (a.title.includes("/")) {
        const baseStem = a.title.split("/").pop()?.trim() ?? "";
        if (baseStem) titleMap.set(baseStem.toLowerCase(), a.filename);
      }
    }

    const nodes: GraphNode[] = wikiArticles.map((a) => ({
      id: a.filename,
      title: displayTitle(a),
      filename: a.filename,
      linkCount: 0,
    }));

    const links: GraphLink[] = [];
    const seen = new Set<string>();
    for (const a of wikiArticles) {
      for (const target of a.wikilinks) {
        const targetFilename = titleMap.get(target.toLowerCase());
        if (!targetFilename || targetFilename === a.filename) continue;
        const key = [a.filename, targetFilename].sort().join("→");
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ source: a.filename, target: targetFilename });
      }
    }

    // Update link counts based on actual resolved links
    const countMap = new Map<string, number>();
    for (const l of links) {
      const s = typeof l.source === "string" ? l.source : l.source.id;
      const t = typeof l.target === "string" ? l.target : l.target.id;
      countMap.set(s, (countMap.get(s) ?? 0) + 1);
      countMap.set(t, (countMap.get(t) ?? 0) + 1);
    }
    for (const n of nodes) n.linkCount = countMap.get(n.id) ?? 0;

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
      .force("collide", forceCollide(65))
      .on("tick", draw)
      .on("end", () => {
        fitAll();
        draw();
      });

    simRef.current = sim;
    return () => { sim.stop(); };
  }, [articles]); // eslint-disable-line react-hooks/exhaustive-deps

  const fitAll = useCallback(() => {
    const nodes = nodesRef.current;
    if (nodes.length === 0) return;
    const { w, h } = sizeRef.current;
    if (w === 0 || h === 0) return;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
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
    const hovId = hoveredRef.current?.id;

    // Detect theme
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    const edgeColor        = isDark ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.15)";
    const edgeHoverColor   = "rgba(139,92,246,0.7)";
    const nodeColor        = isDark ? "#a0a0a0" : "#646464";
    const nodeHoverColor   = "#a78bfa";
    const nodeBorderColor  = isDark ? "#dcdcdc" : "#505050";
    const labelColor       = isDark ? "#d2d2d2" : "#282828";

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2 + tx, h / 2 + ty);
    ctx.scale(k, k);

    // Draw edges
    for (const l of links) {
      const s = l.source as GraphNode;
      const t = l.target as GraphNode;
      if (s.x == null || s.y == null || t.x == null || t.y == null) continue;
      const highlight = hovId && (s.id === hovId || t.id === hovId);
      ctx.strokeStyle = highlight ? edgeHoverColor : edgeColor;
      ctx.lineWidth = highlight ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
    }

    // Draw nodes
    for (const n of nodes) {
      if (n.x == null || n.y == null) continue;
      const r = 3 + Math.min(n.linkCount, 12) * 1.2;
      const isHov = n.id === hovId;

      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = isHov ? nodeHoverColor : nodeColor;
      ctx.fill();

      // Border ring
      ctx.strokeStyle = isHov ? "#c4b5fd" : nodeBorderColor;
      ctx.lineWidth = isHov ? 2 : 0.5;
      ctx.stroke();
    }

    // Draw labels — always show title
    ctx.font = `${Math.max(9, 10 / k)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    for (const n of nodes) {
      if (n.x == null || n.y == null) continue;
      const r = 3 + Math.min(n.linkCount, 12) * 1.2;
      const isHov = n.id === hovId;
      ctx.fillStyle = isHov ? "#c4b5fd" : labelColor;
      ctx.fillText(n.title, n.x, n.y + r + 12);
    }

    ctx.restore();
  }, []);

  // Resize observer
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
      draw();
    });
    ro.observe(canvas.parentElement!);
    return () => ro.disconnect();
  }, [draw]);

  // Hit test helper
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
      const r = 4 + Math.min(n.linkCount, 10) * 1.5 + 4; // extra padding
      if ((mx - n.x) ** 2 + (my - n.y) ** 2 < r * r) return n;
    }
    return null;
  }, []);

  // Mouse handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
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
  }, [hitTest]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragRef.current) {
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
      transformRef.current.x = panRef.current.tx + (e.clientX - panRef.current.startX);
      transformRef.current.y = panRef.current.ty + (e.clientY - panRef.current.startY);
      draw();
      return;
    }
    const node = hitTest(e.clientX, e.clientY);
    const prev = hoveredRef.current;
    if (node?.id !== prev?.id) {
      hoveredRef.current = node;
      setHovered(node?.id ?? null);
      draw();
    }
  }, [hitTest, draw]);

  const handleMouseUp = useCallback(() => {
    if (dragRef.current) {
      dragRef.current.node.fx = null;
      dragRef.current.node.fy = null;
      dragRef.current = null;
      simRef.current?.alphaTarget(0);
    }
    panRef.current = null;
  }, []);

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (panRef.current) return; // was panning
    const node = hitTest(e.clientX, e.clientY);
    if (node) onSelectArticle(node.filename);
  }, [hitTest, onSelectArticle]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const t = transformRef.current;
    t.k = Math.max(0.1, Math.min(5, t.k * delta));
    draw();
  }, [draw]);

  return (
    <div className="relative w-full h-full bg-main-bg overflow-hidden">
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{ cursor: hovered ? "pointer" : "grab" }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleClick}
        onWheel={handleWheel}
      />
      {/* Fit-to-view button */}
      <button
        type="button"
        title="Fit all nodes"
        onClick={() => { fitAll(); draw(); }}
        className="absolute bottom-3 right-3 w-8 h-8 flex items-center justify-center rounded-md bg-surface-hover border border-border text-text-secondary hover:text-text-primary transition-colors"
      >
        <Scan size={15} />
      </button>
      {hovered && (
        <div className="absolute top-3 left-3 px-3 py-1.5 rounded-md border border-border text-xs text-text-primary pointer-events-none bg-sidebar-bg">
          {nodesRef.current.find((n) => n.id === hovered)?.title}
        </div>
      )}
    </div>
  );
}

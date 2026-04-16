import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";

export type TocHeading = {
  level: number;
  text: string;
  id: string;
};

// ── Heading extraction ─────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

export function extractHeadings(markdown: string): TocHeading[] {
  const headings: TocHeading[] = [];
  const idCounts: Record<string, number> = {};

  for (const line of markdown.split("\n")) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (!match) continue;
    const level = match[1].length;
    const text = match[2]
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      .trim();
    const baseId = slugify(text) || `heading-${headings.length}`;
    const count = idCounts[baseId] ?? 0;
    idCounts[baseId] = count + 1;
    headings.push({ level, text, id: count === 0 ? baseId : `${baseId}-${count}` });
  }
  return headings;
}

/** Inject sequential id attributes into h1-h6 opening tags. */
export function addHeadingIds(html: string, headings: TocHeading[]): string {
  let idx = 0;
  return html.replace(/<(h[1-6])([ >])/gi, (_match, tag, after) => {
    if (idx < headings.length) {
      return `<${tag} id="${headings[idx++].id}"${after}`;
    }
    return _match;
  });
}

// ── Tree model ─────────────────────────────────────────────────

type TocNode = {
  heading: TocHeading;
  children: TocNode[];
};

function buildTocTree(headings: TocHeading[]): TocNode[] {
  const root: TocNode[] = [];
  const stack: { node: TocNode; level: number }[] = [];

  for (const heading of headings) {
    const node: TocNode = { heading, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
      stack.pop();
    }
    if (stack.length === 0) {
      root.push(node);
    } else {
      stack[stack.length - 1].node.children.push(node);
    }
    stack.push({ node, level: heading.level });
  }

  return root;
}

// ── TocNodeRow ─────────────────────────────────────────────────

interface TocNodeRowProps {
  node: TocNode;
  depth: number;
  activeId: string;
  expandedIds: Set<string>;
  onToggle: (id: string) => void;
}

const TocNodeRow: React.FC<TocNodeRowProps> = ({
  node,
  depth,
  activeId,
  expandedIds,
  onToggle,
}) => {
  const indent = 6 + depth * 16;
  const hasChildren = node.children.length > 0;
  const isExpanded = expandedIds.has(node.heading.id);
  const isActive = node.heading.id === activeId;

  const handleClick = () => {
    if (hasChildren) onToggle(node.heading.id);
    const el = document.getElementById(node.heading.id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        style={{
          paddingLeft: `${indent}px`,
          paddingTop: "5px",
          paddingBottom: "5px",
          paddingRight: "12px",
          fontSize: "12.5px",
        }}
        className={cn(
          "flex items-center gap-1 w-full text-left truncate transition-colors cursor-pointer",
          "focus-visible:outline-none",
          isActive
            ? "text-primary font-medium"
            : "text-text-secondary hover:text-text-primary"
        )}
      >
        {hasChildren ? (
          <ChevronRight
            size={11}
            className={cn(
              "shrink-0 text-text-secondary transition-transform duration-150",
              isExpanded && "rotate-90"
            )}
          />
        ) : (
          <span style={{ width: "11px", display: "inline-block", flexShrink: 0 }} />
        )}
        <span className="truncate">{node.heading.text}</span>
      </button>

      {hasChildren && isExpanded && (
        <div className="relative">
          <div
            className="absolute top-0 bottom-0 w-px bg-border/50"
            style={{ left: `${indent + 5}px` }}
          />
          {node.children.map((child) => (
            <TocNodeRow
              key={child.heading.id}
              node={child}
              depth={depth + 1}
              activeId={activeId}
              expandedIds={expandedIds}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// ── TocPanel ───────────────────────────────────────────────────

interface TocPanelProps {
  headings: TocHeading[];
  collapsed?: boolean;
  width?: number;
}

function collectAllIds(nodes: TocNode[], acc: Set<string> = new Set()): Set<string> {
  for (const node of nodes) {
    if (node.children.length > 0) {
      acc.add(node.heading.id);
      collectAllIds(node.children, acc);
    }
  }
  return acc;
}

export function TocPanel({ headings, collapsed, width = 200 }: TocPanelProps) {
  const tree = React.useMemo(() => buildTocTree(headings), [headings]);

  // Start fully expanded
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(
    () => collectAllIds(tree)
  );

  // Re-expand when headings change (new article)
  const prevTreeRef = React.useRef(tree);
  if (prevTreeRef.current !== tree) {
    prevTreeRef.current = tree;
    setExpandedIds(collectAllIds(tree));
  }

  const [activeId, setActiveId] = React.useState<string>("");

  // Track active heading via IntersectionObserver
  React.useEffect(() => {
    if (headings.length === 0) { setActiveId(""); return; }

    const observers: IntersectionObserver[] = [];
    const visibleSet = new Set<string>();

    headings.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (!el) return;
      const obs = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) visibleSet.add(id);
          else visibleSet.delete(id);
          const first = headings.find((h) => visibleSet.has(h.id));
          if (first) setActiveId(first.id);
        },
        { rootMargin: "0px 0px -60% 0px", threshold: 0 }
      );
      obs.observe(el);
      observers.push(obs);
    });

    return () => observers.forEach((o) => o.disconnect());
  }, [headings]);

  const toggleNode = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (collapsed || tree.length === 0) return null;

  return (
    <aside
      className="h-full flex flex-col border-l border-border bg-sidebar-bg shrink-0 overflow-hidden"
      style={{ width: `${width}px` }}
    >
      <div className="flex-1 overflow-y-auto py-1">
        {tree.map((node) => (
          <TocNodeRow
            key={node.heading.id}
            node={node}
            depth={0}
            activeId={activeId}
            expandedIds={expandedIds}
            onToggle={toggleNode}
          />
        ))}
      </div>
    </aside>
  );
}

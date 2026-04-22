import React from "react";
import type { WikiGraphNodeTooltip } from "./wikiGraph";

const PANEL_W = 300;
const PANEL_H_EST = 220;
const OFFSET = 12;

export interface GraphNodeTooltipProps {
  data: WikiGraphNodeTooltip;
  /** Viewport coordinates (e.g. PointerEvent.clientX / clientY). */
  clientX: number;
  clientY: number;
}

export function GraphNodeTooltip({ data, clientX, clientY }: GraphNodeTooltipProps) {
  const vw = typeof window !== "undefined" ? window.innerWidth : 800;
  const vh = typeof window !== "undefined" ? window.innerHeight : 600;
  const left = Math.max(8, Math.min(clientX + OFFSET, vw - PANEL_W - 8));
  const top = Math.max(8, Math.min(clientY + OFFSET, vh - PANEL_H_EST - 8));

  return (
    <div
      className="pointer-events-none fixed z-[60] w-[min(22rem,calc(100vw-16px))] rounded-lg border border-border bg-sidebar-bg/95 backdrop-blur-sm px-3 py-2.5 shadow-lg text-left"
      style={{ left, top }}
      role="tooltip"
    >
      <div className="text-sm font-medium text-text-primary leading-snug break-words">{data.fullTitle}</div>
      {data.excerpt ? (
        <div className="mt-2 text-xs leading-relaxed text-text-secondary whitespace-pre-wrap line-clamp-4">
          {data.excerpt}
        </div>
      ) : null}
      <div className="mt-2 text-[11px] text-text-secondary">
        <span className="text-text-tertiary">Tags</span>{" "}
        {data.tags.length > 0 ? (
          <span className="text-text-primary">{data.tags.join(" · ")}</span>
        ) : (
          <span className="italic">—</span>
        )}
      </div>
      <div className="mt-1 text-[11px] text-text-secondary">
        <span className="text-text-tertiary">Created</span>{" "}
        <span className="text-text-primary">{data.createdLabel}</span>
      </div>
      <div className="mt-1.5 text-[11px] text-text-secondary tabular-nums">
        <span className="text-text-tertiary">Incoming</span> {data.inCount}
        <span className="mx-1.5 text-border">·</span>
        <span className="text-text-tertiary">Outgoing</span> {data.outCount}
      </div>
    </div>
  );
}

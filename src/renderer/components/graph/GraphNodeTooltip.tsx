import React from "react";
import type { WikiGraphNodeTooltip } from "./wikiGraph";
import { markdownArticleBodyToHtml } from "../../lib/article-markdown-preview-html";

const PANEL_W = 300;
const PANEL_H_EST = 220;
const OFFSET = 12;

export interface GraphNodeTooltipProps {
  data: WikiGraphNodeTooltip;
  /** Viewport coordinates (e.g. PointerEvent.clientX / clientY). */
  clientX: number;
  clientY: number;
  variant?: "hover" | "active";
  onOpenFullPage?: () => void;
}

export function GraphNodeTooltip({
  data,
  clientX,
  clientY,
  variant = "hover",
  onOpenFullPage,
}: GraphNodeTooltipProps) {
  const vw = typeof window !== "undefined" ? window.innerWidth : 800;
  const vh = typeof window !== "undefined" ? window.innerHeight : 600;
  const left = Math.max(8, Math.min(clientX + OFFSET, vw - PANEL_W - 8));
  const top = Math.max(8, Math.min(clientY + OFFSET, vh - PANEL_H_EST - 8));
  const isActive = variant === "active";
  const excerptHtml = React.useMemo(
    () => (data.excerpt ? markdownArticleBodyToHtml(data.excerpt) : ""),
    [data.excerpt],
  );
  const excerptClassName = isActive
    ? "mt-2 text-xs leading-relaxed text-text-secondary break-words max-h-56 overflow-y-auto pr-1"
    : "mt-2 text-xs leading-relaxed text-text-secondary break-words line-clamp-4";
  const markdownChromeClassName =
    "[&_p]:my-1 [&_h1]:mt-2 [&_h1]:mb-1 [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:text-xs [&_h3]:font-semibold [&_ul]:my-1 [&_ul]:pl-4 [&_ol]:my-1 [&_ol]:pl-4 [&_code]:rounded [&_code]:bg-surface-hover [&_code]:px-1 [&_table]:my-1 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-border [&_th]:bg-surface-hover [&_th]:px-1.5 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:border-border [&_td]:px-1.5 [&_td]:py-1";

  return (
    <div
      className={`fixed z-[60] w-[min(22rem,calc(100vw-16px))] rounded-lg border border-border bg-sidebar-bg/95 backdrop-blur-sm px-3 py-2.5 shadow-lg text-left ${
        isActive ? "pointer-events-auto" : "pointer-events-none"
      }`}
      style={{ left, top }}
      role={isActive ? "dialog" : "tooltip"}
    >
      <div className="text-sm font-medium text-text-primary leading-snug break-words">{data.fullTitle}</div>
      {data.excerpt ? (
        <div
          className={`${excerptClassName} ${markdownChromeClassName}`}
          dangerouslySetInnerHTML={{ __html: excerptHtml }}
        />
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
      {isActive ? (
        <div className="mt-2.5">
          <button
            type="button"
            onClick={onOpenFullPage}
            className="w-full rounded-md border border-primary-border bg-surface-hover px-2.5 py-1.5 text-xs font-medium text-text-primary hover:bg-primary/10 transition-colors"
          >
            Expand to full page
          </button>
        </div>
      ) : null}
    </div>
  );
}

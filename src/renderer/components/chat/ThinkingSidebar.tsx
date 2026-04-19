import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Copy, ChevronRight, ChevronDown } from 'lucide-react';
import { AssistantContent } from '../ChatView';
import type { TraceItem } from '../ChatView';
import { FoxThinkingIndicator, FoxChipIcon } from './FoxThinkingIndicator';

export interface ThinkingSidebarProps {
  content: string;
  trace?: TraceItem[];
  durationMs: number;
  isStreaming: boolean;
  /** Optional: lets parent close the panel via Escape; titlebar owns the toggle button. */
  onClose?: () => void;
  width: number;
  onWikilinkClick?: (target: string) => void;
}

function formatArgs(argsJson: string): string {
  try {
    const parsed = JSON.parse(argsJson);
    if (typeof parsed === 'object' && parsed !== null) {
      const keys = Object.keys(parsed);
      if (keys.length === 1 && typeof parsed[keys[0]] === 'string') {
        return parsed[keys[0]];
      }
    }
    return JSON.stringify(parsed);
  } catch {
    return argsJson;
  }
}

/** Claude-style mono shell prompt glyph: `>_` */
const ShellPromptGlyph: React.FC = () => (
  <span
    className="font-mono text-primary text-[13px] leading-none shrink-0"
    aria-hidden="true"
  >
    {'>_'}
  </span>
);

/** Document glyph for tool outputs, mirroring the screenshot's 📄 affordance. */
const OutputGlyph: React.FC = () => (
  <svg
    width={14}
    height={14}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="text-text-secondary shrink-0"
    aria-hidden="true"
  >
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <polyline points="14 3 14 9 20 9" />
  </svg>
);

const TraceEntry: React.FC<{ item: TraceItem; onWikilinkClick?: (target: string) => void }> = ({ item, onWikilinkClick }) => {
  const [expanded, setExpanded] = useState(false);

  if (item.kind === 'narration') {
    return (
      <div className="flex items-start gap-2 py-1.5 text-sm text-text-primary">
        <FoxChipIcon size={14} solid className="text-text-secondary shrink-0 mt-[2px]" />
        <div className="min-w-0 flex-1 break-words">
          <AssistantContent content={item.content} onWikilinkClick={onWikilinkClick} />
        </div>
      </div>
    );
  }

  if (item.kind === 'tool_call') {
    const argSummary = formatArgs(item.args);
    const isShell = item.name === 'shell';
    return (
      <div className="py-1.5 text-sm">
        <div className="flex items-center gap-2 mb-1">
          {isShell ? <ShellPromptGlyph /> : <FoxChipIcon size={14} solid className="text-text-secondary shrink-0" />}
          <span className="text-[11px] font-medium uppercase tracking-wider text-text-secondary">
            {isShell ? 'Shell' : item.name}
          </span>
        </div>
        <pre className="ml-6 text-[12.5px] font-mono leading-relaxed text-text-primary bg-[rgba(255,255,255,0.04)] border border-border/60 rounded-md px-2.5 py-1.5 whitespace-pre-wrap break-words">
          {argSummary}
        </pre>
      </div>
    );
  }

  // tool_result
  return (
    <div className="py-1.5 text-sm">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 text-text-secondary hover:text-text-primary cursor-pointer w-full text-left"
      >
        <OutputGlyph />
        {expanded ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
        <span className="text-[12.5px]">Output ({item.output.length.toLocaleString()} chars)</span>
      </button>
      {expanded && (
        <pre className="ml-6 mt-1.5 text-[12.5px] font-mono leading-relaxed text-text-secondary bg-[rgba(255,255,255,0.04)] border border-border/60 rounded-md px-2.5 py-1.5 whitespace-pre-wrap break-words max-h-96 overflow-y-auto">
          {item.output}
        </pre>
      )}
    </div>
  );
};

export const ThinkingSidebar: React.FC<ThinkingSidebarProps> = ({ content, trace, durationMs, isStreaming, onClose, width, onWikilinkClick }) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const prevKeyRef = useRef<string>('');
  const [copied, setCopied] = useState(false);

  // Auto-scroll while streaming
  useEffect(() => {
    if (isStreaming && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [content, trace, isStreaming]);

  // Scroll to top when content switches (different message)
  useEffect(() => {
    const key = `${content.length}:${trace?.length ?? 0}`;
    if (!isStreaming && prevKeyRef.current !== key) {
      bodyRef.current?.scrollTo(0, 0);
    }
    prevKeyRef.current = key;
  }, [content, trace, isStreaming]);

  useEffect(() => {
    if (!onClose) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleCopy = useCallback(async () => {
    try {
      const parts: string[] = [];
      if (content) parts.push(content);
      if (trace) {
        for (const item of trace) {
          if (item.kind === 'narration') parts.push(item.content);
          else if (item.kind === 'tool_call') parts.push(`[${item.name}] ${formatArgs(item.args)}`);
          else if (item.kind === 'tool_result') parts.push(`→ ${item.output}`);
        }
      }
      await navigator.clipboard.writeText(parts.join('\n\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  }, [content, trace]);

  const seconds = Math.round(durationMs / 1000);
  const hasThinking = content.length > 0;
  const hasTrace = (trace?.length ?? 0) > 0;

  useEffect(() => {
    try {
      window.api.notifyDebug?.("sidebar", "render", {
        hasThinking,
        contentLen: content.length,
        hasTrace,
        traceLen: trace?.length ?? 0,
        isStreaming,
      });
    } catch { /* ignore */ }
  }, [hasThinking, hasTrace, content.length, trace?.length, isStreaming]);

  return (
    <aside
      className="h-full flex flex-col border-l border-border bg-sidebar-bg shrink-0 overflow-hidden"
      style={{ width: `${width}px` }}
    >
      <div ref={bodyRef} className="flex-1 overflow-y-auto px-3 pt-3 pb-3 text-sm">
        {hasThinking && (
          <div className="mb-3">
            {hasTrace && (
              <div className="text-[10px] uppercase tracking-wider text-text-secondary mb-1.5">
                Thinking
              </div>
            )}
            <AssistantContent content={content} onWikilinkClick={onWikilinkClick} />
          </div>
        )}
        {hasTrace && (
          <div>
            {hasThinking && (
              <div className="text-[10px] uppercase tracking-wider text-text-secondary mb-1.5 mt-3 pt-3 border-t border-border">
                Actions
              </div>
            )}
            {trace!.map((item, i) => (
              <TraceEntry key={i} item={item} onWikilinkClick={onWikilinkClick} />
            ))}
          </div>
        )}
        {!hasThinking && !hasTrace && (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-text-secondary">
            {isStreaming ? (
              <>
                <FoxThinkingIndicator size="small" />
                <p className="text-xs">Working… reasoning hasn’t streamed yet.</p>
              </>
            ) : (
              <p className="text-xs">No thinking trace was returned for this response.</p>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between px-3 py-1.5 border-t border-border shrink-0">
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 px-2 py-1 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors cursor-pointer"
          aria-label={copied ? 'Copied' : 'Copy'}
        >
          <Copy size={12} />
          {copied ? 'Copied' : 'Copy'}
        </button>
        <span className="text-[11px] text-text-secondary tabular-nums">
          {isStreaming ? 'Working…' : `${seconds}s`}
        </span>
      </div>
    </aside>
  );
};

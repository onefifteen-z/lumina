import React, { useRef, useEffect, useState, useCallback } from 'react';
import { X, Copy, Terminal, FileText, ChevronRight, ChevronDown } from 'lucide-react';
import { AssistantContent } from '../ChatView';
import type { TraceItem } from '../ChatView';

export interface ThinkingSidebarProps {
  content: string;
  trace?: TraceItem[];
  durationMs: number;
  isStreaming: boolean;
  onClose: () => void;
  width: number;
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
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

const TraceEntry: React.FC<{ item: TraceItem }> = ({ item }) => {
  const [expanded, setExpanded] = useState(false);

  if (item.kind === 'narration') {
    return (
      <div className="flex gap-2 py-1.5 text-sm text-text-primary">
        <span className="text-text-secondary shrink-0 mt-0.5">💭</span>
        <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">
          <AssistantContent content={item.content} />
        </div>
      </div>
    );
  }

  if (item.kind === 'tool_call') {
    const argSummary = formatArgs(item.args);
    const { text: shown, truncated } = truncate(argSummary, 120);
    return (
      <div className="flex gap-2 py-1.5 text-sm">
        <Terminal size={14} className="text-primary shrink-0 mt-1" />
        <div className="min-w-0 flex-1">
          <div className="text-xs text-text-secondary uppercase tracking-wide mb-0.5">
            {item.name}
          </div>
          <code className="block text-xs font-mono text-text-primary bg-[rgba(255,255,255,0.04)] rounded px-2 py-1 whitespace-pre-wrap break-words">
            {expanded || !truncated ? argSummary : shown + '…'}
          </code>
          {truncated && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-[11px] text-text-secondary hover:text-text-primary mt-0.5 cursor-pointer"
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      </div>
    );
  }

  // tool_result
  const { text: shownOutput, truncated } = truncate(item.output, 400);
  return (
    <div className="flex gap-2 py-1.5 text-sm">
      <FileText size={14} className="text-text-secondary shrink-0 mt-1" />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary cursor-pointer mb-0.5"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>Output ({item.output.length.toLocaleString()} chars)</span>
        </button>
        {(expanded || !truncated) && (
          <pre className="text-xs font-mono text-text-secondary bg-[rgba(255,255,255,0.04)] rounded px-2 py-1 whitespace-pre-wrap break-words max-h-96 overflow-y-auto">
            {expanded ? item.output : shownOutput}
          </pre>
        )}
      </div>
    </div>
  );
};

export const ThinkingSidebar: React.FC<ThinkingSidebarProps> = ({ content, trace, durationMs, isStreaming, onClose, width }) => {
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

  return (
    <aside
      className="h-full flex flex-col border-l border-border bg-sidebar-bg shrink-0 overflow-hidden"
      style={{ width: `${width}px` }}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <div className="flex flex-col">
          <span className="text-xs font-semibold text-text-primary">
            {hasThinking && hasTrace ? 'Thinking & Actions' : hasThinking ? 'Thinking' : 'Actions'}
          </span>
          <span className="text-[11px] text-text-secondary">
            {isStreaming ? 'Working…' : `${seconds}s`}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex items-center justify-center w-6 h-6 rounded-md text-text-secondary hover:bg-surface-hover hover:text-text-primary transition-colors cursor-pointer"
          aria-label="Close panel"
        >
          <X size={14} />
        </button>
      </div>

      <div ref={bodyRef} className="flex-1 overflow-y-auto px-3 py-3 text-sm">
        {hasThinking && (
          <div className="mb-3">
            {hasTrace && (
              <div className="text-[10px] uppercase tracking-wider text-text-secondary mb-1.5">
                Thinking
              </div>
            )}
            <AssistantContent content={content} />
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
              <TraceEntry key={i} item={item} />
            ))}
          </div>
        )}
        {!hasThinking && !hasTrace && (
          <p className="text-text-secondary text-xs">Thinking…</p>
        )}
      </div>

      <div className="flex items-center px-3 py-1.5 border-t border-border shrink-0">
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 px-2 py-1 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors cursor-pointer"
          aria-label={copied ? 'Copied' : 'Copy'}
        >
          <Copy size={12} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </aside>
  );
};

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { SquarePen, RefreshCw, WifiOff, History, Trash2, FileText, Pencil } from 'lucide-react';
import type {
  ChatMessage,
  ChatSession,
  ChatHistoryEntry,
  ArticleMeta,
  ChatSendCommand,
  ChatContentBlock,
  ConfirmationRequest,
} from '../../shared/types';
import { MessageList } from './chat/MessageList';
import {
  ChatInput,
  DEFAULT_INGEST_PROMPT,
  formatIngestSlashCommand,
  parseSlashCommand,
} from './chat/ChatInput';
import { CodeBlock } from './chat/CodeBlock';
import { ConfirmationBanner } from './chat/ConfirmationBanner';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { useNavigation } from './AppShell';
import {
  readStoredPanelWidth,
  writeStoredPanelWidth,
  CHAT_HISTORY_WIDTH_KEY,
} from '../lib/panel-width';

/* ── Markdown-ish rendering ─────────────────────────────────── */

/**
 * Parse assistant content by splitting on fenced code blocks.
 * Returns an array of segments: either { type: 'text', content } or
 * { type: 'code', language, content }.
 */
export type Segment =
  | { type: 'text'; content: string }
  | { type: 'code'; language: string; content: string };

export function parseMarkdownSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  // Match ```lang\n...\n``` blocks
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    // Text before this code block
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }
    segments.push({
      type: 'code',
      language: match[1] || 'text',
      content: match[2].replace(/\n$/, ''), // trim trailing newline
    });
    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last code block
  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return segments;
}

/* ── Line-based markdown types & parser ──────────────────────── */

export type LineType = 'heading' | 'ul' | 'ol' | 'hr' | 'paragraph';

export interface ParsedLine {
  type: LineType;
  level?: number;       // heading level 1-6
  content: string;      // text content (stripped of markdown markers)
}

/**
 * Classify a single line of text into a markdown line type.
 * Returns a ParsedLine with the type and cleaned content.
 */
export function classifyLine(line: string): ParsedLine {
  const trimmed = line.trimStart();

  // Horizontal rule: line is only dashes (3+), optionally with spaces
  if (/^-{3,}\s*$/.test(trimmed) && trimmed.length >= 3) {
    return { type: 'hr', content: '' };
  }

  // Headings: # ## ### #### ##### ######
  const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
  if (headingMatch) {
    return { type: 'heading', level: headingMatch[1].length, content: headingMatch[2] };
  }

  // Unordered list: - or *
  const ulMatch = trimmed.match(/^[-*]\s+(.*)$/);
  if (ulMatch) {
    return { type: 'ul', content: ulMatch[1] };
  }

  // Ordered list: 1. 2. etc.
  const olMatch = trimmed.match(/^\d+\.\s+(.*)$/);
  if (olMatch) {
    return { type: 'ol', content: olMatch[1] };
  }

  return { type: 'paragraph', content: line };
}

/**
 * Parse a text segment into structured blocks by classifying each line
 * and grouping consecutive list items.
 */
export type MarkdownBlock =
  | { type: 'heading'; level: number; content: string }
  | { type: 'paragraph'; content: string }
  | { type: 'hr' }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'table'; headers: string[]; rows: string[][] };

export function parseMarkdownLines(text: string): MarkdownBlock[] {
  if (!text || !text.trim()) return [];

  const lines = text.split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  // Parse cells from a table row — handles lines with or without leading/trailing |
  const parseCells = (line: string) => {
    let t = line.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|')) t = t.slice(0, -1);
    return t.split('|').map((c) => c.trim());
  };
  // Separator row: only pipes, dashes, colons, spaces
  const isSepLine = (l: string) => /^[\s|:\-]+$/.test(l.trim()) && l.includes('-') && l.includes('|');
  // A line is table-like if it contains | and isn't purely a separator
  const isTableLike = (l: string) => l.includes('|');
  // Look ahead from startIdx to check a separator exists within 2 lines
  const hasSepNearby = (startIdx: number) => {
    for (let k = startIdx; k < Math.min(startIdx + 3, lines.length); k++) {
      if (isSepLine(lines[k])) return true;
    }
    return false;
  };

  while (i < lines.length) {
    // Table detection: line contains | AND a separator row is nearby
    if (isTableLike(lines[i]) && hasSepNearby(i)) {
      const tableLines: string[] = [];
      while (i < lines.length && isTableLike(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      const sepIdx = tableLines.findIndex(isSepLine);
      if (sepIdx >= 1) {
        const headers = parseCells(tableLines[sepIdx - 1]);
        const rows = tableLines.slice(sepIdx + 1).map(parseCells);
        blocks.push({ type: 'table', headers, rows });
        continue;
      } else if (sepIdx === 0) {
        const rows = tableLines.slice(1).map(parseCells);
        blocks.push({ type: 'table', headers: [], rows });
        continue;
      } else if (tableLines.length >= 2) {
        const headers = parseCells(tableLines[0]);
        const rows = tableLines.slice(1).map(parseCells);
        blocks.push({ type: 'table', headers, rows });
        continue;
      }
      for (const tl of tableLines) {
        const joined = tl.trim();
        if (joined) blocks.push({ type: 'paragraph', content: joined });
      }
      continue;
    }

    const parsed = classifyLine(lines[i]);

    if (parsed.type === 'hr') {
      blocks.push({ type: 'hr' });
      i++;
    } else if (parsed.type === 'heading') {
      blocks.push({ type: 'heading', level: parsed.level!, content: parsed.content });
      i++;
    } else if (parsed.type === 'ul' || parsed.type === 'ol') {
      // CommonMark "loose list": items can be separated by blank lines and
      // still belong to the same list. Without this, `1. a\n\n1. b\n\n1. c`
      // (which is the LLM's preferred output style — markdown auto-numbers
      // anyway, so it always emits "1.") becomes three separate <ol>s
      // each starting at 1, and the user sees "1. 1. 1." instead of
      // "1. 2. 3.". We accumulate while the next non-blank line stays the
      // same list type.
      const listType = parsed.type;
      const items: string[] = [parsed.content];
      i++;
      while (i < lines.length) {
        // Skip blank separators between items.
        let j = i;
        while (j < lines.length && lines[j].trim() === '') j++;
        if (j >= lines.length) break;
        const next = classifyLine(lines[j]);
        if (next.type === listType) {
          items.push(next.content);
          i = j + 1;
          continue;
        }

        // Compatibility path for LLM output style:
        //   1. Step title
        //   Explanation sentence
        //   1. Next step
        // Treat the paragraph line(s) as part of the previous ordered-list
        // item when another ordered-list item follows, so numbering remains
        // a single 1/2/3... sequence instead of resetting to 1 each time.
        if (listType === 'ol' && next.type === 'paragraph' && j === i) {
          const paraLines: string[] = [next.content];
          let k = j + 1;
          while (k < lines.length) {
            if (lines[k].trim() === '') break;
            const paraNext = classifyLine(lines[k]);
            if (paraNext.type !== 'paragraph') break;
            paraLines.push(paraNext.content);
            k++;
          }
          let t = k;
          while (t < lines.length && lines[t].trim() === '') t++;
          if (t >= lines.length || classifyLine(lines[t]).type === 'ol') {
            items[items.length - 1] += `\n${paraLines.join('\n')}`;
            i = t;
            continue;
          }
        }

        break;
      }
      blocks.push({ type: listType, items });
    } else {
      // Paragraph: collect consecutive paragraph lines
      const paraLines: string[] = [parsed.content];
      i++;
      while (i < lines.length) {
        if (isTableLike(lines[i]) && hasSepNearby(i)) break;
        const next = classifyLine(lines[i]);
        if (next.type !== 'paragraph') break;
        paraLines.push(next.content);
        i++;
      }
      const joined = paraLines.join('\n').trim();
      if (joined) {
        blocks.push({ type: 'paragraph', content: joined });
      }
    }
  }

  return blocks;
}

/**
 * Compute visual start numbers for ordered-list blocks so separate `<ol>`
 * segments in one assistant message can continue numbering (1..N) instead
 * of resetting to 1 after explanatory paragraphs or sub-bullets.
 */
export function computeOrderedListStarts(
  blocks: MarkdownBlock[],
): Array<number | null> {
  let nextStart = 1;
  return blocks.map((block) => {
    if (block.type !== 'ol') return null;
    const start = nextStart;
    nextStart += block.items.length;
    return start;
  });
}

/**
 * Apply inline formatting to a text string.
 * Handles **bold**, *italic*, and `inline code`. Unclosed markers are treated as plain text.
 * Returns an array of React nodes.
 */
export function applyInlineFormatting(text: string, onWikilinkClick?: (target: string) => void): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Order matters: [[wikilink]] and `code` come BEFORE bold/italic so that
  // wikilinks wrapped in *...* or **...** (e.g. "*Sources: [[a]], [[b]]*")
  // are still recognised. Bold/italic inner content is then recursively
  // re-processed so wikilinks inside them stay clickable.
  const inlineRegex = /(\[\[([^\]]+)\]\]|`([^`]+)`|\*\*([\s\S]+?)\*\*|\*([^*\n]+)\*|\[([ xX])\])/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = inlineRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    if (match[2] !== undefined) {
      // [[wikilink]]
      const target = match[2];
      nodes.push(
        <button
          key={key++}
          onClick={() => onWikilinkClick?.(target)}
          className="underline underline-offset-2 decoration-dotted text-primary hover:decoration-solid cursor-pointer focus:outline-none"
          title={`Open: ${target}`}
        >
          {target}
        </button>,
      );
    } else if (match[3] !== undefined) {
      nodes.push(
        <code
          key={key++}
          className="px-[5px] py-[2px] rounded-md bg-[rgba(255,255,255,0.08)] font-mono text-[0.85em] text-text-primary"
        >
          {match[3]}
        </code>,
      );
    } else if (match[4] !== undefined) {
      nodes.push(
        <strong key={key++} className="font-semibold">
          {applyInlineFormatting(match[4], onWikilinkClick)}
        </strong>,
      );
    } else if (match[5] !== undefined) {
      nodes.push(
        <em key={key++}>{applyInlineFormatting(match[5], onWikilinkClick)}</em>,
      );
    } else if (match[6] !== undefined) {
      const checked = match[6].toLowerCase() === 'x';
      nodes.push(
        <input key={key++} type="checkbox" checked={checked} readOnly className="mr-1.5 align-middle pointer-events-none" />,
      );
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

/** Render a text segment with line-by-line markdown parsing. */
const MarkdownText: React.FC<{ content: string; onWikilinkClick?: (target: string) => void }> = ({ content, onWikilinkClick }) => {
  const blocks = parseMarkdownLines(content);
  const olStarts = useMemo(() => computeOrderedListStarts(blocks), [blocks]);

  if (blocks.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'hr':
            return <hr key={i} className="border-border" />;
          case 'heading': {
            const level = Math.min(block.level, 6) as 1 | 2 | 3 | 4 | 5 | 6;
            const Tag = `h${level}` as keyof JSX.IntrinsicElements;
            const cls =
              level === 1
                ? 'text-[1.05rem] font-bold leading-snug text-text-primary mt-1'
                : level === 2
                  ? 'text-[0.95rem] font-semibold leading-snug text-text-primary mt-0.5'
                  : 'text-sm font-semibold leading-snug text-text-primary';
            return (
              <Tag key={i} className={cls}>
                {applyInlineFormatting(block.content, onWikilinkClick)}
              </Tag>
            );
          }
          case 'ul':
            return (
              <ul key={i} className="text-sm space-y-1 pl-5" style={{ listStyleType: 'disc' }}>
                {block.items.map((item, j) => (
                  <li key={j} className="break-words leading-relaxed pl-0.5">
                    {applyInlineFormatting(item, onWikilinkClick)}
                  </li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol
                key={i}
                start={olStarts[i] ?? 1}
                className="text-sm space-y-1 pl-5"
                style={{ listStyleType: 'decimal' }}
              >
                {block.items.map((item, j) => (
                  <li key={j} className="break-words leading-relaxed pl-0.5">
                    {applyInlineFormatting(item, onWikilinkClick)}
                  </li>
                ))}
              </ol>
            );
          case 'table':
            return (
              <div key={i} className="overflow-x-auto my-1">
                <table className="w-full text-sm border-collapse border border-border">
                  {block.headers.length > 0 && (
                    <thead>
                      <tr className="bg-[var(--surface-hover)]">
                        {block.headers.map((h, j) => (
                          <th key={j} className="border border-border px-4 py-3 text-left font-semibold text-text-primary">
                            {applyInlineFormatting(h, onWikilinkClick)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                  )}
                  <tbody>
                    {block.rows.map((row, ri) => (
                      <tr key={ri}>
                        {row.map((cell, ci) => (
                          <td key={ci} className="border border-border px-4 py-3 text-text-primary break-words">
                            {applyInlineFormatting(cell, onWikilinkClick)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'paragraph':
            return (
              <p key={i} className="text-sm leading-relaxed break-words">
                {applyInlineFormatting(block.content, onWikilinkClick)}
              </p>
            );
          default:
            return null;
        }
      })}
    </div>
  );
};

/** Render assistant message content with code blocks and text. */
export const AssistantContent: React.FC<{ content: string; onWikilinkClick?: (target: string) => void }> = ({ content, onWikilinkClick }) => {
  const segments = parseMarkdownSegments(content);

  return (
    <div className="flex flex-col gap-3">
      {segments.map((seg, i) =>
        seg.type === 'code' ? (
          <CodeBlock key={i} code={seg.content} language={seg.language} />
        ) : (
          <MarkdownText key={i} content={seg.content} onWikilinkClick={onWikilinkClick} />
        ),
      )}
    </div>
  );
};

/* ── Error helpers ──────────────────────────────────────────── */

const ERROR_MESSAGES: Record<string, string> = {
  auth: 'Authentication failed. Check your API key in Settings.',
  rate_limit: 'Rate limit exceeded. Please try again later.',
  timeout: 'Request timed out.',
  network: 'Network error. Check your connection.',
};

export function friendlyError(type: string): string {
  return ERROR_MESSAGES[type] ?? 'An unexpected error occurred.';
}

/* ── ChatView ───────────────────────────────────────────────── */

interface ChatError {
  type: string;
  message: string;
}

export type TraceItem =
  | { kind: 'narration'; content: string }
  | { kind: 'tool_call'; id: string; name: string; args: string }
  | { kind: 'tool_result'; id: string; output: string };

/* ── History grouping helpers (exported for tests) ─────────────────────── */

export type HistoryBucket = 'today' | 'yesterday' | 'last7' | 'last30' | 'older';

const BUCKET_LABELS: Record<HistoryBucket, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last7: 'Previous 7 days',
  last30: 'Previous 30 days',
  older: 'Older',
};

/** Bucket an ISO timestamp relative to `now` (defaults to wall clock). */
export function bucketForTimestamp(iso: string, now: Date = new Date()): HistoryBucket {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'older';
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const startOfLast7 = startOfToday - 7 * 86_400_000;
  const startOfLast30 = startOfToday - 30 * 86_400_000;
  if (t >= startOfToday) return 'today';
  if (t >= startOfYesterday) return 'yesterday';
  if (t >= startOfLast7) return 'last7';
  if (t >= startOfLast30) return 'last30';
  return 'older';
}

export interface HistoryGroup<T extends { updatedAt: string }> {
  bucket: HistoryBucket;
  label: string;
  entries: T[];
}

/**
 * Group history entries into recency buckets. Input is assumed to be already
 * sorted newest-first (which is what the backend returns); we preserve that
 * ordering within each bucket and emit buckets in fixed recency order.
 */
export function groupHistoryByRecency<T extends { updatedAt: string }>(
  entries: T[],
  now: Date = new Date(),
): HistoryGroup<T>[] {
  const order: HistoryBucket[] = ['today', 'yesterday', 'last7', 'last30', 'older'];
  const map = new Map<HistoryBucket, T[]>();
  for (const e of entries) {
    const b = bucketForTimestamp(e.updatedAt, now);
    const arr = map.get(b) ?? [];
    arr.push(e);
    map.set(b, arr);
  }
  return order
    .filter((b) => map.has(b) && (map.get(b)?.length ?? 0) > 0)
    .map((b) => ({ bucket: b, label: BUCKET_LABELS[b], entries: map.get(b)! }));
}

/** Compact "x min ago" / "Yesterday" / "Mar 15" style stamp for history rows. */
export function formatHistoryTimestamp(iso: string, now: Date = new Date()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diffSec = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (diffSec < 60) return 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24 && bucketForTimestamp(iso, now) === 'today') return `${diffHr}h ago`;
  const bucket = bucketForTimestamp(iso, now);
  if (bucket === 'yesterday') return 'Yesterday';
  const d = new Date(t);
  const sameYear = d.getFullYear() === now.getFullYear();
  return sameYear
    ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/* ── History row (inline rename) ──────────────────────────────────────── */

interface HistoryEntryRowProps {
  entry: ChatHistoryEntry;
  isActive: boolean;
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, newTitle: string) => Promise<void> | void;
}

const HistoryEntryRow: React.FC<HistoryEntryRowProps> = ({ entry, isActive, onLoad, onDelete, onRename }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.title || '');
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset draft whenever the upstream entry title changes (e.g. backend
  // normalised an empty rename to "New chat") so re-opening the editor shows
  // the canonical value rather than stale local state.
  useEffect(() => {
    if (!editing) setDraft(entry.title || '');
  }, [entry.title, editing]);

  // Auto-focus + select-all when entering edit mode.
  useEffect(() => {
    if (!editing) return;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [editing]);

  const startEdit = useCallback(() => {
    setDraft(entry.title || '');
    setEditing(true);
  }, [entry.title]);

  const commit = useCallback(() => {
    setEditing(false);
    const next = draft.trim();
    // Skip the IPC round-trip when nothing meaningful changed.
    if (next === (entry.title || '').trim()) return;
    void onRename(entry.id, next);
  }, [draft, entry.id, entry.title, onRename]);

  const cancel = useCallback(() => {
    setEditing(false);
    setDraft(entry.title || '');
  }, [entry.title]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    },
    [commit, cancel],
  );

  return (
    <div
      className={`group flex items-center gap-1 px-3 py-1.5 text-xs transition-colors ${
        isActive ? 'bg-primary-bg text-text-primary' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
      } ${editing ? '' : 'cursor-pointer'}`}
      onClick={() => { if (!editing) onLoad(entry.id); }}
      onDoubleClick={(e) => { e.stopPropagation(); if (!editing) startEdit(); }}
      title={editing ? undefined : `${entry.title || 'Untitled'} · ${new Date(entry.updatedAt).toLocaleString()} · double-click to rename`}
    >
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={commit}
            onClick={(e) => e.stopPropagation()}
            maxLength={200}
            className="w-full bg-surface-active text-text-primary text-xs px-1.5 py-0.5 rounded outline-none border border-primary/40 focus:border-primary"
            aria-label="Rename chat"
          />
        ) : (
          <div className="truncate">{entry.title || 'Untitled'}</div>
        )}
        <div className="text-[10px] text-text-secondary/70 tabular-nums mt-0.5">
          {formatHistoryTimestamp(entry.updatedAt)}
        </div>
      </div>
      {!editing && (
        <>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); startEdit(); }}
            className="shrink-0 opacity-0 group-hover:opacity-100 text-text-secondary hover:text-primary transition-opacity cursor-pointer"
            aria-label="Rename"
            title="Rename"
          >
            <Pencil size={12} />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete(entry.id); }}
            className="shrink-0 opacity-0 group-hover:opacity-100 text-text-secondary hover:text-red-400 transition-opacity cursor-pointer"
            aria-label="Delete"
            title="Delete"
          >
            <Trash2 size={12} />
          </button>
        </>
      )}
    </div>
  );
};

export interface ThinkingEntry {
  content: string;
  trace: TraceItem[];
  durationMs: number;
  isStreaming: boolean;
  /** Optional: handler so the right-rail sidebar can open notes when wikilinks are clicked. */
  onWikilinkClick?: (target: string) => void;
}

export interface ChatViewProps {
  onThinkingChange?: (data: ThinkingEntry | null) => void;
  /** Ref that ChatView populates with a function to close the thinking sidebar */
  closeThinkingRef?: React.MutableRefObject<(() => void) | null>;
  /** Incremented by AppShell whenever the active vault changes */
  vaultKey?: number;
  /**
   * Whether this view is currently visible to the user. ChatView stays mounted
   * even when the user navigates away (so streaming generation isn't
   * interrupted), but global keyboard shortcuts that semantically belong to
   * "the chat surface" (e.g. ⌘N for new session) must only fire when the
   * user is actually looking at it. Defaults to true.
   */
  visible?: boolean;
}

const ChatView: React.FC<ChatViewProps> = ({ onThinkingChange, closeThinkingRef, vaultKey, visible = true }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [error, setError] = useState<ChatError | null>(null);
  const [showWelcome, setShowWelcome] = useState(true);
  const [warning, setWarning] = useState<string | null>(null);
  const [historyList, setHistoryList] = useState<ChatHistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [historyWidth, setHistoryWidth] = useState(() => readStoredPanelWidth(CHAT_HISTORY_WIDTH_KEY, 224, 180, 400));
  const [isHistoryResizing, setIsHistoryResizing] = useState(false);

  // Persist the chat history sidebar width across view changes (this
  // component unmounts whenever the user leaves chat) and app restarts.
  useEffect(() => { writeStoredPanelWidth(CHAT_HISTORY_WIDTH_KEY, historyWidth); }, [historyWidth]);
  const [articleIndex, setArticleIndex] = useState<Map<string, ArticleMeta>>(new Map());
  // Outstanding confirmation prompts from the main process (venv install,
  // model-issued `request_user_confirmation`, future destructive actions).
  // We keep a queue rather than a single request so back-to-back prompts
  // can't quietly clobber each other; in practice the queue is almost
  // always 0 or 1 deep since tool calls are sequential.
  const [confirmationQueue, setConfirmationQueue] = useState<ConfirmationRequest[]>([]);

  const { isOffline } = useNetworkStatus();
  const { viewArticle, pendingIngestRequest, clearPendingIngestRequest, advanceIngestQueue, clearIngestQueue } = useNavigation();
  const sessionRef = useRef<ChatSession | null>(null);
  const streamBuf = useRef('');

  // ── Thinking state ──────────────────────────────────────────
  const [thinkingMap, setThinkingMap] = useState<Record<string, ThinkingEntry>>({});
  const [activeThinkingMsgId, setActiveThinkingMsgId] = useState<string | null>(null);
  const thinkingBuf = useRef('');
  const thinkingStart = useRef<number>(0);
  const traceBuf = useRef<TraceItem[]>([]);
  // Tracks whether the user has explicitly closed the streaming thinking panel.
  // We auto-open when a streaming entry first appears, but won't reopen after a manual close.
  const userClosedStreamingRef = useRef(false);

  // ── Stream update batching via rAF ──────────────────────────
  // Token-level setState during SSE causes React to re-render the
  // entire markdown tree per token; on slow models that produces
  // visible "stutter then big drop" behavior. We coalesce updates
  // into one frame so the UI keeps up regardless of token rate.
  const rafHandle = useRef<number | null>(null);
  const pendingTextUpdate = useRef(false);
  const pendingThinkingUpdate = useRef(false);
  // Tracks whether the very first text/thinking chunk of the current
  // generation has been committed yet. The first chunk flushes synchronously
  // so users get immediate feedback (no blank ~1 frame delay), and only
  // subsequent chunks are coalesced via rAF.
  const firstTextFlushed = useRef(false);
  const firstThinkingFlushed = useRef(false);

  const advanceIngestQueueRef = useRef(advanceIngestQueue);
  const clearIngestQueueRef = useRef(clearIngestQueue);
  useEffect(() => { advanceIngestQueueRef.current = advanceIngestQueue; }, [advanceIngestQueue]);
  useEffect(() => { clearIngestQueueRef.current = clearIngestQueue; }, [clearIngestQueue]);

  const flushNow = useCallback(() => {
    if (rafHandle.current !== null) {
      cancelAnimationFrame(rafHandle.current);
      rafHandle.current = null;
    }
    if (pendingTextUpdate.current) {
      pendingTextUpdate.current = false;
      setStreamingContent(streamBuf.current);
    }
    if (pendingThinkingUpdate.current) {
      pendingThinkingUpdate.current = false;
      const snapshot: ThinkingEntry = {
        content: thinkingBuf.current,
        trace: traceBuf.current.slice(),
        durationMs: Date.now() - thinkingStart.current,
        isStreaming: true,
      };
      setThinkingMap((prev) => ({ ...prev, __streaming__: snapshot }));
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    if (rafHandle.current !== null) return;
    rafHandle.current = requestAnimationFrame(() => {
      rafHandle.current = null;
      if (pendingTextUpdate.current) {
        pendingTextUpdate.current = false;
        setStreamingContent(streamBuf.current);
      }
      if (pendingThinkingUpdate.current) {
        pendingThinkingUpdate.current = false;
        const snapshot: ThinkingEntry = {
          content: thinkingBuf.current,
          trace: traceBuf.current.slice(),
          durationMs: Date.now() - thinkingStart.current,
          isStreaming: true,
        };
        setThinkingMap((prev) => ({ ...prev, __streaming__: snapshot }));
      }
    });
  }, []);

  useEffect(() => {
    return () => {
      if (rafHandle.current !== null) {
        cancelAnimationFrame(rafHandle.current);
        rafHandle.current = null;
      }
    };
  }, []);

  /**
   * Render user message text, replacing recognized `@filename` tokens with
   * inline file chips. A token is recognized only if its filename matches a
   * known vault article — this avoids turning stray emails or `@user`
   * mentions into broken file pills.
   */
  const renderUserContent = useCallback((content: string): React.ReactNode => {
    const nodes: React.ReactNode[] = [];
    const re = /(^|\s)@(\S+)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let key = 0;
    while ((match = re.exec(content)) !== null) {
      const [full, lead, token] = match;
      const article = articleIndex.get(token);
      if (!article) continue;
      const tokenStart = match.index + lead.length;
      if (tokenStart > lastIndex) {
        nodes.push(content.slice(lastIndex, tokenStart));
      }
      nodes.push(
        <button
          key={`m-${key++}`}
          type="button"
          onClick={() => viewArticle(article.filename)}
          title={article.filename}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded-md bg-[rgba(124,58,237,0.25)] hover:bg-[rgba(124,58,237,0.4)] text-text-primary text-xs font-medium align-baseline cursor-pointer transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-primary-border"
        >
          <FileText size={11} className="opacity-80" />
          <span>{article.title}</span>
        </button>,
      );
      lastIndex = match.index + full.length;
    }
    if (lastIndex < content.length) {
      nodes.push(content.slice(lastIndex));
    }
    return nodes.length > 0 ? nodes : content;
  }, [articleIndex, viewArticle]);

  const handleWikilinkClick = useCallback(async (target: string) => {
    try {
      const resolved = await window.api.resolveWikilink(target);
      if (resolved.exists && resolved.filename) {
        viewArticle(resolved.filename);
      }
    } catch { /* ignore */ }
  }, [viewArticle]);

  const refreshHistory = useCallback(async () => {
    try { setHistoryList(await window.api.listChatSessions()); } catch { /* ignore */ }
  }, []);

  const refreshArticleIndex = useCallback(async () => {
    try {
      const list = await window.api.listArticles();
      const map = new Map<string, ArticleMeta>();
      for (const a of list) map.set(a.filename, a);
      setArticleIndex(map);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    refreshArticleIndex();
  }, [refreshArticleIndex, vaultKey]);

  // Historically `/ingest` would also write a tiny `Ingest-<basename>-<ts>.md`
  // stub into the vault root just to record "we ingested this". That stub
  // never carried any knowledge content (just Source/Kind/Chunks/Summary),
  // duplicated information the chat session itself preserves, and — more
  // importantly — collided with the CLAUDE.md workflow where the model
  // owns `wiki/sources/<name>.md` and `wiki/log.md`. We deleted the helper.
  // If you want a vault-level audit trail of ingests, do it in `wiki/log.md`
  // via the model.

  /**
   * Build the user-facing prompt for an `/ingest <filename>` slash command.
   *
   * The renderer used to call `window.api.ingestFile()` (which rasterized
   * the file and stuffed the result into the message as content blocks),
   * but that bypassed CLAUDE.md's wiki workflow and confused the model.
   * Now `/ingest` is purely a prompt-template expander: the model owns the
   * entire ingest decision tree via the `ingest_source` tool + INGEST.md.
   *
   * `command.prompt` is whatever the user typed after the filename, or the
   * default placeholder set in `parseSlashCommand`. We surface it as
   * "additional instruction" so a verbose user prompt doesn't drown the
   * standardised ingest directive.
   */
  const buildIngestPrompt = useCallback(
    (command: Extract<ChatSendCommand, { type: 'ingest' }>): string => {
      const lines = [
        `Please ingest \`${command.filename}\` following CLAUDE.md and INGEST.md.`,
        ``,
        `Start by calling \`ingest_source({ path: "${command.filename}" })\` to extract the content, then complete the wiki Ingest workflow as described in CLAUDE.md.`,
        ``,
        `To find affected pages, use \`search_wiki\` or \`grep\` on the entities/terms you just extracted — do not \`cat wiki/index.md\` (or glossary/overview) in full.`,
      ];
      const extra = command.prompt?.trim();
      // Suppress the boring default placeholder we generate when the user
      // didn't actually type anything past the filename. Sending it would
      // just be noise.
      const defaultPlaceholder =
        "Please analyze the attached file and answer the user's request.";
      if (extra && extra !== defaultPlaceholder) {
        lines.push("", "Additional instruction from the user:", extra);
      }
      return lines.join("\n");
    },
    [],
  );

  /**
   * Build the user-facing prompt for `/lint [prompt…]` (whole-wiki lint).
   *
   * `/lint` used to target a single file (`buildLintUserPayload` would
   * inline the file content into the user message). The new contract is:
   * the model owns the lint loop end-to-end via `shell` calls, walking
   * `wiki/` itself and following CLAUDE.md's Lint workflow. We keep the
   * renderer's job to a single thing: tell the model "go run /lint" in
   * a way that triggers that workflow unambiguously, optionally appending
   * a user-supplied focus instruction (e.g. `/lint focus on entities`).
   *
   * `extra` is the parsed `command.prompt` (already stripped of `/lint`),
   * so we use it verbatim. We deliberately do NOT scrape `content` — the
   * caret-driven parser is the single source of truth for what's "lint
   * args" vs. "command verb".
   */
  const buildLintPrompt = useCallback((extra: string | undefined): string => {
    const lines = [
      'Please lint the entire knowledge base following the **Lint** workflow in CLAUDE.md.',
      '',
      'Walk `wiki/` with `shell` calls, surface contradictions / staleness / orphan pages / inconsistent terminology, then propose fixes and ask which to apply (per the workflow). Append the lint log entry when done.',
    ];
    const userExtra = (extra ?? '').trim();
    if (userExtra) {
      lines.push('', 'Additional instruction from the user:', userExtra);
    }
    return lines.join('\n');
  }, []);

  const persistSession = useCallback(async () => {
    try {
      const s = await window.api.getChatSession();
      if (!s || s.messages.length === 0) return;
      sessionRef.current = s;
      await window.api.saveChatSession(s);
      // Remember which session is active so the next app launch reopens it
      // instead of spinning up a fresh empty session that orphans this one.
      window.api.saveConfig({ lastChatSessionId: s.id }).catch(() => {});
    } catch (err) {
      console.warn('Failed to persist chat session:', err);
    }
    await refreshHistory();
  }, [refreshHistory]);

  /* ── Session initialisation ─────────────────────────────────── */

  const initSession = useCallback(async () => {
    try {
      const session = await window.api.startChatSession();
      sessionRef.current = session;
      setMessages(session.messages.filter((m) => m.role !== 'system'));
      setShowWelcome(true);
      setError(null);
      setStreamingContent('');
      streamBuf.current = '';
      setWarning(null);
      // Drop any stale "last session" pointer — until this fresh session has
      // content it isn't worth resuming, and keeping the old id around would
      // cause restarts to reopen an unrelated conversation.
      window.api.saveConfig({ lastChatSessionId: '' }).catch(() => {});
    } catch {
      // If session init fails, we still show the welcome screen
    }
  }, []);

  /* ── Restore persisted UI state on mount ───────────────────── */

  useEffect(() => {
    window.api.getConfig().then((cfg) => {
      if (cfg.chatHistorySidebarOpen) setShowHistory(true);
      if (cfg.lastChatSessionId) {
        loadSession(cfg.lastChatSessionId).catch(() => initSession());
      } else {
        initSession();
      }
    }).catch(() => initSession());
    refreshHistory();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Re-initialize when vault changes ──────────────────────── */

  const isFirstMount = useRef(true);
  useEffect(() => {
    if (isFirstMount.current) { isFirstMount.current = false; return; }
    setMessages([]);
    setStreamingContent('');
    setError(null);
    setShowWelcome(true);
    sessionRef.current = null;
    initSession();
    refreshHistory();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultKey]);

  /* ── Persist sidebar open state ────────────────────────────── */

  const toggleHistory = useCallback((open: boolean) => {
    setShowHistory(open);
    window.api.saveConfig({ chatHistorySidebarOpen: open }).catch(() => {});
  }, []);

  const handleHistoryResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsHistoryResizing(true);
    document.body.classList.add('is-resizing');
    const startX = e.clientX;
    const startWidth = historyWidth;
    const onMove = (ev: MouseEvent) => {
      setHistoryWidth(Math.max(180, Math.min(400, startWidth + (ev.clientX - startX))));
    };
    const onUp = () => {
      setIsHistoryResizing(false);
      document.body.classList.remove('is-resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [historyWidth]);

  /* ── IPC listeners ──────────────────────────────────────────── */

  useEffect(() => {

    window.api.onChatChunk((chunk: string) => {
      if (!chunk) return;
      streamBuf.current += chunk;
      pendingTextUpdate.current = true;
      if (!firstTextFlushed.current) {
        firstTextFlushed.current = true;
        flushNow();
      } else {
        scheduleFlush();
      }
    });

    window.api.onChatThinkingChunk((chunk: string) => {
      if (typeof chunk !== 'string' || chunk.length === 0) return;
      if (!thinkingBuf.current && traceBuf.current.length === 0) thinkingStart.current = Date.now();
      thinkingBuf.current += chunk;
      pendingThinkingUpdate.current = true;
      if (!firstThinkingFlushed.current) {
        firstThinkingFlushed.current = true;
        flushNow();
      } else {
        scheduleFlush();
      }
    });

    window.api.onChatTraceChunk((chunk) => {
      if (!chunk) return;
      if (!thinkingBuf.current && traceBuf.current.length === 0) thinkingStart.current = Date.now();
      if (chunk.type === 'narration') {
        if (chunk.content) traceBuf.current.push({ kind: 'narration', content: chunk.content });
      } else if (chunk.type === 'tool_call') {
        traceBuf.current.push({ kind: 'tool_call', id: chunk.id, name: chunk.name, args: chunk.args });
      } else if (chunk.type === 'tool_result') {
        traceBuf.current.push({ kind: 'tool_result', id: chunk.id, output: chunk.output });
      }
      pendingThinkingUpdate.current = true;
      // tool_call/tool_result events are infrequent and important — flush them
      // immediately so the sidebar reflects the current step without delay.
      if (chunk.type !== 'narration' || !firstThinkingFlushed.current) {
        firstThinkingFlushed.current = true;
        flushNow();
      } else {
        scheduleFlush();
      }
    });

    window.api.onChatEnd((err?: string) => {
      // Cancel any pending rAF flush — we'll commit the final state
      // synchronously below so onChatEnd never races a half-flushed buffer.
      if (rafHandle.current !== null) {
        cancelAnimationFrame(rafHandle.current);
        rafHandle.current = null;
      }
      pendingTextUpdate.current = false;
      pendingThinkingUpdate.current = false;
      firstTextFlushed.current = false;
      firstThinkingFlushed.current = false;
      setIsGenerating(false);

      if (err) {
        clearIngestQueueRef.current();
        let errorType = 'unknown';
        let errorMessage = err;
        const colonIdx = err.indexOf(':');
        if (colonIdx > 0 && colonIdx < 20) {
          errorType = err.slice(0, colonIdx).trim();
          errorMessage = err.slice(colonIdx + 1).trim();
        }
        setError({ type: errorType, message: errorMessage });
        // Drop the streaming thinking entry on error — it's incomplete and
        // would otherwise persist as a "Working…" sidebar that never resolves.
        setThinkingMap((prev) => { const { __streaming__: _drop, ...rest } = prev; return rest; });
        setActiveThinkingMsgId((prev) => prev === '__streaming__' ? null : prev);
      } else if (streamBuf.current || thinkingBuf.current || traceBuf.current.length > 0) {
        // Always persist a final assistant message when *any* signal arrived,
        // even if the text body is empty. Otherwise the thinking trace
        // (e.g. tool calls) is silently dropped on the floor.
        const assistantMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: streamBuf.current,
          timestamp: new Date().toISOString(),
        };
        if (thinkingBuf.current || traceBuf.current.length > 0) {
          const finalDuration = Date.now() - thinkingStart.current;
          const finalContent = thinkingBuf.current;
          const finalTrace = [...traceBuf.current];
          setThinkingMap((prev) => {
            const { __streaming__: _drop, ...rest } = prev;
            return {
              ...rest,
              [assistantMsg.id]: {
                content: finalContent,
                trace: finalTrace,
                durationMs: finalDuration,
                isStreaming: false,
              },
            };
          });
          setActiveThinkingMsgId((prev) => prev === '__streaming__' ? assistantMsg.id : prev);
        }
        // Only show a bubble in the message list if there's actual text;
        // pure tool-call turns are visible only via the thinking chip.
        if (streamBuf.current) {
          setMessages((prev) => [...prev, assistantMsg]);
        }
      }

      if (!err) {
        advanceIngestQueueRef.current();
      }

      setStreamingContent('');
      streamBuf.current = '';
      thinkingBuf.current = '';
      traceBuf.current = [];
      setTimeout(() => persistSession(), 100);
    });

    window.api.onChatWarning((msg: string) => {
      setWarning(msg);
      // Auto-dismiss after 5 seconds
      setTimeout(() => setWarning(null), 5000);
    });

    window.api.onConfirmRequest((request) => {
      setConfirmationQueue((prev) =>
        prev.some((r) => r.id === request.id) ? prev : [...prev, request],
      );
    });

    return () => {
      window.api.removeChatListeners();
      window.api.removeConfirmRequestListener();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Keyboard shortcut: Ctrl/Cmd+N ─────────────────────────── */

  // Mirror `visible` into a ref so the (mount-once) keydown handler reads the
  // latest value without re-binding. ChatView stays mounted across view
  // switches, but ⌘N should only create a new chat session when the user is
  // actually looking at the chat surface — otherwise it would hijack the
  // shortcut while the user is in Files / Graph / Settings / etc.
  const visibleRef = useRef(visible);
  useEffect(() => { visibleRef.current = visible; }, [visible]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!visibleRef.current) return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        handleNewSession();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Handlers ───────────────────────────────────────────────── */

  const respondConfirmation = useCallback(
    async (approved: boolean) => {
      // Respond to (and dequeue) the frontmost prompt. Each click resolves
      // exactly one request; if a second prompt is pending it slides up
      // into place without the user having to do anything special.
      setConfirmationQueue((prev) => {
        if (prev.length === 0) return prev;
        const [head, ...rest] = prev;
        void window.api.replyConfirm(head.id, approved);
        return rest;
      });
    },
    [],
  );

  const handleNewSession = useCallback(async () => {
    clearIngestQueue();
    if (isGenerating) {
      await window.api.stopChatGeneration();
      setIsGenerating(false);
    }
    setMessages([]);
    setStreamingContent('');
    streamBuf.current = '';
    thinkingBuf.current = '';
    traceBuf.current = [];
    firstTextFlushed.current = false;
    firstThinkingFlushed.current = false;
    userClosedStreamingRef.current = false;
    setThinkingMap({});
    setActiveThinkingMsgId(null);
    setError(null);
    setShowWelcome(true);
    await initSession();
  }, [isGenerating, initSession, clearIngestQueue]);

  const loadSession = useCallback(async (sessionId: string) => {
    // Critical: sync the *main-process* chat session too. Without this, the
    // ChatService keeps appending to whatever session it auto-created at
    // startup (or after the previous turn), so the next message gets persisted
    // under that orphan id and shows up as a brand-new entry in history.
    const session = await window.api.loadChatSession(sessionId);
    if (!session) return;
    sessionRef.current = session;
    setMessages(session.messages.filter((m) => m.role !== 'system'));
    setShowWelcome(false);
    setError(null);
    setStreamingContent('');
    streamBuf.current = '';
    thinkingBuf.current = '';
    setThinkingMap({});
    setActiveThinkingMsgId(null);
    window.api.saveConfig({ lastChatSessionId: sessionId }).catch(() => {});
  }, []);

  const deleteSession = useCallback(async (sessionId: string) => {
    await window.api.deleteChatSession(sessionId);
    refreshHistory();
    if (sessionRef.current?.id === sessionId) handleNewSession();
  }, [refreshHistory]);

  const renameSession = useCallback(async (sessionId: string, newTitle: string) => {
    // Optimistic local update so the new label appears immediately even if
    // the IPC round-trip lags. We still refresh from the source of truth so
    // the displayed title stays in sync with whatever the backend stored
    // (it normalises empty / oversized inputs).
    setHistoryList((prev) => prev.map((e) => (e.id === sessionId ? { ...e, title: newTitle } : e)));
    try {
      await window.api.renameChatSession(sessionId, newTitle);
    } finally {
      refreshHistory();
    }
  }, [refreshHistory]);

  const handleSend = useCallback(
    async (content: string, mentions: string[] = [], command?: ChatSendCommand) => {
      setError(null);
      setShowWelcome(false);

      // Optimistically add user message to the list. Display the user's
      // original text — the @filename tokens are rendered as chips by the
      // message renderer; the full file payload only goes to the LLM.
      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);

      setIsGenerating(true);
      streamBuf.current = '';
      setStreamingContent('');
      thinkingBuf.current = '';
      traceBuf.current = [];
      firstTextFlushed.current = false;
      firstThinkingFlushed.current = false;
      userClosedStreamingRef.current = false;
      // Clear sidebar selection so the right panel doesn't keep showing the
      // previous round's thinking while the new round streams.
      setActiveThinkingMsgId(null);

      let payload = content;
      let payloadBlocks: ChatContentBlock[] | undefined;
      let sendOpts: { reloadClaudeMd?: boolean } | undefined;

      if (command?.type === 'ingest') {
        // Pure prompt-template expansion. No IPC, no payload blocks — the
        // model handles file extraction itself via the `ingest_source` tool
        // (see INGEST.md, which is appended to the system prompt).
        payload = buildIngestPrompt(command);
        // Force CLAUDE.md/INGEST.md reload so any user edits to either are
        // picked up before the ingest workflow starts.
        sendOpts = { reloadClaudeMd: true };
      } else if (command?.type === 'lint') {
        // Pure prompt-template expansion. No file IO — the model walks
        // the wiki via `shell` itself, following CLAUDE.md's Lint
        // workflow. `command.prompt` is the optional free-form text the
        // user typed after `/lint`. Reload CLAUDE.md so any user edits
        // land in the system prompt before the lint pass starts.
        payload = buildLintPrompt(command.prompt);
        sendOpts = { reloadClaudeMd: true };
      } else if (mentions.length > 0) {
        // Backward-compatible @filename context injection for plain text turns.
        const reads = await Promise.all(
          mentions.map(async (filename) => {
            try {
              const text = await window.api.readFile(filename);
              return { filename, text, ok: true as const };
            } catch {
              return { filename, text: '', ok: false as const };
            }
          }),
        );
        const blocks = reads
          .filter((r) => r.ok)
          .map((r) => `<file path="${r.filename}">\n${r.text}\n</file>`)
          .join('\n\n');
        if (blocks) {
          payload = `The user has attached the following file(s) for context:\n\n${blocks}\n\n---\n\n${content}`;
        }
      }

      try {
        await window.api.sendChatMessage(payload, payloadBlocks, sendOpts);
      } catch {
        setIsGenerating(false);
        setError({ type: 'network', message: 'Failed to send message.' });
      }
    },
    [buildIngestPrompt, buildLintPrompt],
  );

  // Files sidebar → "Ingest": new session + `/ingest` workflow for that raw file.
  const pendingIngestNonce = pendingIngestRequest?.nonce;
  useEffect(() => {
    if (pendingIngestNonce === undefined || !pendingIngestRequest) return;
    const { filename } = pendingIngestRequest;
    clearPendingIngestRequest();
    void (async () => {
      await handleNewSession();
      await handleSend(
        formatIngestSlashCommand(filename),
        [],
        { type: 'ingest', filename, prompt: DEFAULT_INGEST_PROMPT },
      );
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on nonce only
  }, [pendingIngestNonce]);

  const handleStop = useCallback(async () => {
    clearIngestQueue();
    try {
      await window.api.stopChatGeneration();
    } catch {
      // ignore
    }
  }, [clearIngestQueue]);

  const handleRetry = useCallback(async () => {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMsg) return;

    // Remove thinking for the last assistant message being regenerated
    const lastAssistantMsg = [...messages].reverse().find((m) => m.role === 'assistant');
    if (lastAssistantMsg) {
      setThinkingMap((prev) => { const { [lastAssistantMsg.id]: _, ...rest } = prev; return rest; });
      setActiveThinkingMsgId((prev) => prev === lastAssistantMsg.id ? null : prev);
    }

    setError(null);
    setIsGenerating(true);
    streamBuf.current = '';
    setStreamingContent('');
    thinkingBuf.current = '';
    traceBuf.current = [];
    firstTextFlushed.current = false;
    firstThinkingFlushed.current = false;
    userClosedStreamingRef.current = false;

    // Recreate one-shot ingest payload or @mention payload from the last user turn.
    let payload = lastUserMsg.content;
    let payloadBlocks: ChatContentBlock[] | undefined;
    let sendOpts: { reloadClaudeMd?: boolean } | undefined;

    const slash = parseSlashCommand(lastUserMsg.content);
    if (slash?.type === 'ingest') {
      // See handleSend: pure prompt-template path, model handles extraction.
      payload = buildIngestPrompt(slash);
      sendOpts = { reloadClaudeMd: true };
    } else if (slash?.type === 'lint') {
      // See handleSend: pure prompt-template path, model owns the lint loop.
      payload = buildLintPrompt(slash.prompt);
      sendOpts = { reloadClaudeMd: true };
    }

    const mentionRe = /(?:^|\s)@(\S+)/g;
    const mentioned: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = mentionRe.exec(lastUserMsg.content)) !== null) {
      mentioned.push(m[1]);
    }
    if (!payloadBlocks && !slash && mentioned.length > 0) {
      const reads = await Promise.all(
        mentioned.map(async (filename) => {
          try {
            const text = await window.api.readFile(filename);
            return { filename, text, ok: true as const };
          } catch {
            return { filename, text: '', ok: false as const };
          }
        }),
      );
      const blocks = reads
        .filter((r) => r.ok)
        .map((r) => `<file path="${r.filename}">\n${r.text}\n</file>`)
        .join('\n\n');
      if (blocks) {
        payload = `The user has attached the following file(s) for context:\n\n${blocks}\n\n---\n\n${lastUserMsg.content}`;
      }
    }

    window.api.sendChatMessage(payload, payloadBlocks, sendOpts).catch(() => {
      setIsGenerating(false);
      setError({ type: 'network', message: 'Failed to send message.' });
    });
  }, [messages, buildIngestPrompt, buildLintPrompt]);

  /* ── Determine what to show ─────────────────────────────────── */

  const hasMessages = messages.length > 0 || streamingContent.length > 0;
  const displayWelcome = showWelcome && !hasMessages;

  /* ── Thinking chip handler ──────────────────────────────────── */

  const handleThinkingChipClick = useCallback((msgId: string) => {
    setActiveThinkingMsgId((prev) => {
      const next = prev === msgId ? null : msgId;
      if (msgId === '__streaming__' && next === null) {
        userClosedStreamingRef.current = true;
      }
      return next;
    });
  }, []);

  // Expose close function to parent via ref
  useEffect(() => {
    if (closeThinkingRef) {
      closeThinkingRef.current = () => {
        setActiveThinkingMsgId((prev) => {
          if (prev === '__streaming__') userClosedStreamingRef.current = true;
          return null;
        });
      };
    }
    return () => { if (closeThinkingRef) closeThinkingRef.current = null; };
  }, [closeThinkingRef]);

  // Auto-open the thinking sidebar when a streaming entry appears for the
  // current generation, including when the panel still points at a prior
  // round's finalized message. Respect explicit user closes.
  useEffect(() => {
    if (
      thinkingMap.__streaming__ &&
      isGenerating &&
      activeThinkingMsgId !== '__streaming__' &&
      !userClosedStreamingRef.current
    ) {
      setActiveThinkingMsgId('__streaming__');
    }
  }, [thinkingMap, activeThinkingMsgId, isGenerating]);

  // Notify parent (AppShell) when active thinking changes
  useEffect(() => {
    // While generating, always source the sidebar from the live `__streaming__`
    // entry so it stays in lockstep with the inline shell-command badge in the
    // message list (which reads `__streaming__` directly). Relying solely on
    // `activeThinkingMsgId` here could leave the sidebar one tool-call behind
    // (extra state hop) or pointed at a finalized prior-turn entry, so the
    // currently-executing command would show inline but not in the panel.
    const streamingEntry = thinkingMap.__streaming__;
    const entry =
      isGenerating && streamingEntry
        ? streamingEntry
        : activeThinkingMsgId
          ? thinkingMap[activeThinkingMsgId]
          : null;
    // Diagnostic: surface the active thinking entry into the debug panel so
    // we can see what the sidebar is being asked to render.
    try {
      window.api.notifyDebug?.("thinking", "active entry changed", {
        activeId: activeThinkingMsgId,
        usingStreaming: isGenerating && !!streamingEntry,
        keys: Object.keys(thinkingMap),
        entrySummary: entry
          ? {
              contentLen: entry.content.length,
              traceLen: entry.trace.length,
              isStreaming: entry.isStreaming,
              durationMs: entry.durationMs,
            }
          : null,
      });
    } catch { /* ignore */ }

    if (!entry) {
      onThinkingChange?.(null);
    } else {
      onThinkingChange?.({ ...entry, onWikilinkClick: handleWikilinkClick });
    }
  }, [activeThinkingMsgId, thinkingMap, isGenerating, onThinkingChange, handleWikilinkClick]);

  /* ── Render ─────────────────────────────────────────────────── */

  // Centered column padding: keeps content at max 720px, centered
  const colStyle: React.CSSProperties = {
    paddingLeft: 'max(1rem, calc(50% - 360px))',
    paddingRight: 'max(1rem, calc(50% - 360px))',
  };

  // Group history entries by recency. Backend already returns them sorted by
  // updatedAt DESC (newest first), so we just bucket them into time bands and
  // preserve the incoming order within each bucket.
  const historyGroups = useMemo(() => groupHistoryByRecency(historyList), [historyList]);

  return (
    <div className="flex flex-1 min-h-0">
      {/* History sidebar */}
      {showHistory && (
        <>
          <div
            className="shrink-0 border-r border-border bg-sidebar-bg flex flex-col overflow-hidden"
            style={{ width: historyWidth }}
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
              <span className="text-xs font-semibold text-text-primary">History</span>
              <button type="button" onClick={handleNewSession} className="text-text-secondary hover:text-text-primary cursor-pointer" aria-label="New chat">
                <SquarePen size={14} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto py-1">
              {historyList.length === 0 && (
                <p className="px-3 py-4 text-xs text-text-secondary">No history yet</p>
              )}
              {historyGroups.map((group) => (
                <div key={group.bucket} className="mb-1">
                  <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-text-secondary/80 select-none">
                    {group.label}
                  </div>
                  {group.entries.map((entry) => (
                    <HistoryEntryRow
                      key={entry.id}
                      entry={entry}
                      isActive={sessionRef.current?.id === entry.id}
                      onLoad={loadSession}
                      onDelete={deleteSession}
                      onRename={renameSession}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
          <div
            className={`lumina-resize-handle${isHistoryResizing ? ' is-dragging' : ''}`}
            onMouseDown={handleHistoryResizeStart}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize chat history sidebar"
          />
        </>
      )}

      {/* Main chat area */}
      <div className="flex flex-col flex-1 min-h-0 bg-main-bg">

      {/* History toggle */}
      <div className="flex items-center px-3 py-1.5 shrink-0">
        <button
          type="button"
          onClick={() => { toggleHistory(!showHistory); if (!showHistory) refreshHistory(); }}
          className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors cursor-pointer ${showHistory ? 'bg-primary-bg text-primary' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'}`}
          aria-label="Toggle history"
        >
          <History size={16} />
        </button>
      </div>

      {/* Offline banner */}
      {isOffline && (
        <div
          className="flex items-center gap-2 px-4 py-2 bg-yellow-500/10 border-b border-yellow-500/20 text-yellow-600 dark:text-yellow-400 text-xs shrink-0"
          role="status"
        >
          <WifiOff size={14} />
          <span>You are offline. Chat is unavailable.</span>
        </div>
      )}

      {/* Warning banner */}
      {warning && (
        <div
          className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 text-amber-700 dark:text-amber-400 text-xs shrink-0"
          role="status"
        >
          {warning}
        </div>
      )}

      {/* Scrollable middle: welcome or messages */}
      <div className="flex-1 min-h-0 flex flex-col">
        {displayWelcome ? (
          <div className="flex-1 min-h-0 flex items-center justify-center px-4">
            <div className="flex flex-col items-center gap-3 text-center max-w-sm">
              <div className="w-12 h-12 rounded-full bg-primary-bg flex items-center justify-center">
                <SquarePen size={22} className="text-primary" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-text-primary mb-1">
                  How can I help you today?
                </h2>
                <p className="text-sm text-text-secondary leading-relaxed">
                  Type a message below.{' '}
                  <kbd className="px-1 py-0.5 rounded bg-surface-hover text-text-primary text-xs font-mono">
                    {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+N
                  </kbd>{' '}
                  starts a new session.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <MessageList
            messages={messages}
            streamingContent={streamingContent}
            isGenerating={isGenerating}
            renderAssistantContent={(content) => <AssistantContent content={content} onWikilinkClick={handleWikilinkClick} />}
            renderUserContent={renderUserContent}
            onRegenerate={handleRetry}
            thinkingMap={thinkingMap}
            activeThinkingMsgId={activeThinkingMsgId}
            onThinkingChipClick={handleThinkingChipClick}
          />
        )}
      </div>

      {/* Error display */}
      {error && (
        <div className="border-t border-red-500/20 bg-red-500/5 shrink-0" style={colStyle}>
          <div className="flex items-center justify-between gap-3 py-2.5">
            <p className="text-sm text-red-600 dark:text-red-400">
              {ERROR_MESSAGES[error.type] ?? error.message}
            </p>
            <button
              type="button"
              onClick={handleRetry}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 transition-colors cursor-pointer shrink-0 focus-visible:ring-2 focus-visible:ring-primary-border focus-visible:outline-none"
            >
              <RefreshCw size={12} />
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Generic confirmation banner — shows whatever yes/no prompt is at
          the head of the queue (venv install, model-issued
          request_user_confirmation, etc.). Sits directly above the input
          so the prompt reads as a precondition to the current turn. */}
      <ConfirmationBanner
        request={confirmationQueue[0] ?? null}
        onRespond={(approved) => { void respondConfirmation(approved); }}
        colStyle={colStyle}
      />

      {/* Chat input */}
      <ChatInput
        onSend={handleSend}
        onStop={handleStop}
        onNewSession={handleNewSession}
        isGenerating={isGenerating}
        isOffline={isOffline}
        colStyle={colStyle}
      />
      </div>
    </div>
  );
};

export default ChatView;

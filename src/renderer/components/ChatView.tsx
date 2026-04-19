import React, { useState, useEffect, useCallback, useRef } from 'react';
import { SquarePen, RefreshCw, WifiOff, History, Trash2 } from 'lucide-react';
import type { ChatMessage, ChatSession, ChatHistoryEntry } from '../../shared/types';
import { MessageList } from './chat/MessageList';
import { ChatInput } from './chat/ChatInput';
import { CodeBlock } from './chat/CodeBlock';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { useNavigation } from './AppShell';

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
    } else if (parsed.type === 'ul') {
      const items: string[] = [parsed.content];
      i++;
      while (i < lines.length) {
        const next = classifyLine(lines[i]);
        if (next.type !== 'ul') break;
        items.push(next.content);
        i++;
      }
      blocks.push({ type: 'ul', items });
    } else if (parsed.type === 'ol') {
      const items: string[] = [parsed.content];
      i++;
      while (i < lines.length) {
        const next = classifyLine(lines[i]);
        if (next.type !== 'ol') break;
        items.push(next.content);
        i++;
      }
      blocks.push({ type: 'ol', items });
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
 * Apply inline formatting to a text string.
 * Handles **bold**, *italic*, and `inline code`. Unclosed markers are treated as plain text.
 * Returns an array of React nodes.
 */
export function applyInlineFormatting(text: string, onWikilinkClick?: (target: string) => void): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Match **bold**, *italic* (not preceded/followed by *), `code`, [[wikilink]], or [ ]/[x] checkbox
  const inlineRegex = /(\*\*(.+?)\*\*|\*([^*]+)\*|`([^`]+)`|\[\[([^\]]+)\]\]|\[([ xX])\])/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = inlineRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    if (match[2] !== undefined) {
      nodes.push(<strong key={key++} className="font-semibold">{match[2]}</strong>);
    } else if (match[3] !== undefined) {
      nodes.push(<em key={key++}>{match[3]}</em>);
    } else if (match[4] !== undefined) {
      nodes.push(
        <code
          key={key++}
          className="px-[5px] py-[2px] rounded-md bg-[rgba(255,255,255,0.08)] font-mono text-[0.85em] text-text-primary"
        >
          {match[4]}
        </code>,
      );
    } else if (match[5] !== undefined) {
      // [[wikilink]]
      const target = match[5];
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
    } else if (match[6] !== undefined) {
      // Checkbox [ ] or [x]
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
              <ol key={i} className="text-sm space-y-1 pl-5" style={{ listStyleType: 'decimal' }}>
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

export interface ThinkingEntry {
  content: string;
  trace: TraceItem[];
  durationMs: number;
  isStreaming: boolean;
}

export interface ChatViewProps {
  onThinkingChange?: (data: ThinkingEntry | null) => void;
  /** Ref that ChatView populates with a function to close the thinking sidebar */
  closeThinkingRef?: React.MutableRefObject<(() => void) | null>;
  /** Incremented by AppShell whenever the active vault changes */
  vaultKey?: number;
}

const ChatView: React.FC<ChatViewProps> = ({ onThinkingChange, closeThinkingRef, vaultKey }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [error, setError] = useState<ChatError | null>(null);
  const [showWelcome, setShowWelcome] = useState(true);
  const [warning, setWarning] = useState<string | null>(null);
  const [historyList, setHistoryList] = useState<ChatHistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  const { isOffline } = useNetworkStatus();
  const { viewArticle } = useNavigation();
  const sessionRef = useRef<ChatSession | null>(null);
  const streamBuf = useRef('');

  // ── Thinking state ──────────────────────────────────────────
  const [thinkingMap, setThinkingMap] = useState<Record<string, ThinkingEntry>>({});
  const [activeThinkingMsgId, setActiveThinkingMsgId] = useState<string | null>(null);
  const thinkingBuf = useRef('');
  const thinkingStart = useRef<number>(0);
  const traceBuf = useRef<TraceItem[]>([]);

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

  const persistSession = useCallback(async () => {
    try {
      const s = await window.api.getChatSession();
      if (!s || s.messages.length === 0) return;
      sessionRef.current = s;
      await window.api.saveChatSession(s);
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

  /* ── IPC listeners ──────────────────────────────────────────── */

  useEffect(() => {

    window.api.onChatChunk((chunk: string) => {
      streamBuf.current += chunk;
      setStreamingContent(streamBuf.current);
    });

    window.api.onChatThinkingChunk((chunk: string) => {
      if (!thinkingBuf.current && traceBuf.current.length === 0) thinkingStart.current = Date.now();
      thinkingBuf.current += chunk;
      setThinkingMap((prev) => ({
        ...prev,
        __streaming__: {
          content: thinkingBuf.current,
          trace: [...traceBuf.current],
          durationMs: Date.now() - thinkingStart.current,
          isStreaming: true,
        },
      }));
    });

    window.api.onChatTraceChunk((chunk) => {
      if (!thinkingBuf.current && traceBuf.current.length === 0) thinkingStart.current = Date.now();
      if (chunk.type === 'narration') {
        traceBuf.current.push({ kind: 'narration', content: chunk.content });
      } else if (chunk.type === 'tool_call') {
        traceBuf.current.push({ kind: 'tool_call', id: chunk.id, name: chunk.name, args: chunk.args });
      } else if (chunk.type === 'tool_result') {
        traceBuf.current.push({ kind: 'tool_result', id: chunk.id, output: chunk.output });
      }
      setThinkingMap((prev) => ({
        ...prev,
        __streaming__: {
          content: thinkingBuf.current,
          trace: [...traceBuf.current],
          durationMs: Date.now() - thinkingStart.current,
          isStreaming: true,
        },
      }));
    });

    window.api.onChatEnd((err?: string) => {
      setIsGenerating(false);

      if (err) {
        let errorType = 'unknown';
        let errorMessage = err;
        const colonIdx = err.indexOf(':');
        if (colonIdx > 0 && colonIdx < 20) {
          errorType = err.slice(0, colonIdx).trim();
          errorMessage = err.slice(colonIdx + 1).trim();
        }
        setError({ type: errorType, message: errorMessage });
      } else if (streamBuf.current) {
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
            const { __streaming__, ...rest } = prev;
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
        setMessages((prev) => [...prev, assistantMsg]);
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

    return () => {
      window.api.removeChatListeners();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Keyboard shortcut: Ctrl/Cmd+N ─────────────────────────── */

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        handleNewSession();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Handlers ───────────────────────────────────────────────── */

  const handleNewSession = useCallback(async () => {
    if (isGenerating) {
      await window.api.stopChatGeneration();
      setIsGenerating(false);
    }
    setMessages([]);
    setStreamingContent('');
    streamBuf.current = '';
    thinkingBuf.current = '';
    setThinkingMap({});
    setActiveThinkingMsgId(null);
    setError(null);
    setShowWelcome(true);
    await initSession();
  }, [isGenerating, initSession]);

  const loadSession = useCallback(async (sessionId: string) => {
    const data = await window.api.getChatHistory(sessionId);
    if (!data) return;
    sessionRef.current = { id: data.id, systemPrompt: data.systemPrompt, messages: data.messages, createdAt: data.createdAt };
    setMessages(data.messages.filter((m) => m.role !== 'system'));
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

  const handleSend = useCallback(
    async (content: string) => {
      setError(null);
      setShowWelcome(false);

      // Optimistically add user message to the list
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

      try {
        await window.api.sendChatMessage(content);
      } catch {
        setIsGenerating(false);
        setError({ type: 'network', message: 'Failed to send message.' });
      }
    },
    [],
  );

  const handleStop = useCallback(async () => {
    try {
      await window.api.stopChatGeneration();
    } catch {
      // ignore
    }
  }, []);

  const handleRetry = useCallback(() => {
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

    window.api.sendChatMessage(lastUserMsg.content).catch(() => {
      setIsGenerating(false);
      setError({ type: 'network', message: 'Failed to send message.' });
    });
  }, [messages]);

  /* ── Determine what to show ─────────────────────────────────── */

  const hasMessages = messages.length > 0 || streamingContent.length > 0;
  const displayWelcome = showWelcome && !hasMessages;

  /* ── Thinking chip handler ──────────────────────────────────── */

  const handleThinkingChipClick = useCallback((msgId: string) => {
    setActiveThinkingMsgId((prev) => prev === msgId ? null : msgId);
  }, []);

  // Expose close function to parent via ref
  useEffect(() => {
    if (closeThinkingRef) closeThinkingRef.current = () => setActiveThinkingMsgId(null);
    return () => { if (closeThinkingRef) closeThinkingRef.current = null; };
  }, [closeThinkingRef]);

  // Notify parent (AppShell) when active thinking changes
  useEffect(() => {
    if (!activeThinkingMsgId || !thinkingMap[activeThinkingMsgId]) {
      onThinkingChange?.(null);
    } else {
      onThinkingChange?.(thinkingMap[activeThinkingMsgId]);
    }
  }, [activeThinkingMsgId, thinkingMap, onThinkingChange]);

  /* ── Render ─────────────────────────────────────────────────── */

  // Centered column padding: keeps content at max 720px, centered
  const colStyle: React.CSSProperties = {
    paddingLeft: 'max(1rem, calc(50% - 360px))',
    paddingRight: 'max(1rem, calc(50% - 360px))',
  };

  return (
    <div className="flex flex-1 min-h-0">
      {/* History sidebar */}
      {showHistory && (
        <div className="w-56 shrink-0 border-r border-border bg-sidebar-bg flex flex-col overflow-hidden">
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
            {historyList.map((entry) => (
              <div
                key={entry.id}
                className={`group flex items-center gap-1 px-3 py-2 text-xs cursor-pointer transition-colors ${sessionRef.current?.id === entry.id ? 'bg-primary-bg text-text-primary' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'}`}
                onClick={() => loadSession(entry.id)}
              >
                <span className="truncate flex-1">{entry.title || 'Untitled'}</span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); deleteSession(entry.id); }}
                  className="shrink-0 opacity-0 group-hover:opacity-100 text-text-secondary hover:text-red-400 transition-opacity cursor-pointer"
                  aria-label="Delete"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
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

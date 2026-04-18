import React, { useState, useEffect, useCallback, useRef } from 'react';
import { SquarePen, RefreshCw, WifiOff } from 'lucide-react';
import type { ChatMessage, ChatSession } from '../../shared/types';
import { MessageList } from './chat/MessageList';
import { ChatInput } from './chat/ChatInput';
import { CodeBlock } from './chat/CodeBlock';
import { useNetworkStatus } from '../hooks/useNetworkStatus';

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

  while (i < lines.length) {
    // Table detection: line starts with |
    if (lines[i].trimStart().startsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      // Need at least header + separator (2 lines)
      if (tableLines.length >= 2 && /^\s*\|[\s:]*-+/.test(tableLines[1])) {
        const parseCells = (line: string) =>
          line.split('|').slice(1, -1).map((c) => c.trim());
        const headers = parseCells(tableLines[0]);
        const rows = tableLines.slice(2).map(parseCells);
        blocks.push({ type: 'table', headers, rows });
        continue;
      }
      // Not a valid table — fall through as paragraphs
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
export function applyInlineFormatting(text: string): React.ReactNode[] {
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
      nodes.push(
        <span key={key++} className="text-accent font-medium">
          {match[5]}
        </span>,
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
const MarkdownText: React.FC<{ content: string }> = ({ content }) => {
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
                {applyInlineFormatting(block.content)}
              </Tag>
            );
          }
          case 'ul':
            return (
              <ul key={i} className="text-sm space-y-1 pl-5" style={{ listStyleType: 'disc' }}>
                {block.items.map((item, j) => (
                  <li key={j} className="break-words leading-relaxed pl-0.5">
                    {applyInlineFormatting(item)}
                  </li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i} className="text-sm space-y-1 pl-5" style={{ listStyleType: 'decimal' }}>
                {block.items.map((item, j) => (
                  <li key={j} className="break-words leading-relaxed pl-0.5">
                    {applyInlineFormatting(item)}
                  </li>
                ))}
              </ol>
            );
          case 'table':
            return (
              <div key={i} className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-[rgba(255,255,255,0.04)]">
                      {block.headers.map((h, j) => (
                        <th key={j} className="px-3 py-2 text-left font-semibold text-text-primary whitespace-nowrap">
                          {applyInlineFormatting(h)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, ri) => (
                      <tr key={ri} className="border-b border-border last:border-b-0">
                        {row.map((cell, ci) => (
                          <td key={ci} className="px-3 py-2 text-text-secondary break-words">
                            {applyInlineFormatting(cell)}
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
                {applyInlineFormatting(block.content)}
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
export const AssistantContent: React.FC<{ content: string }> = ({ content }) => {
  const segments = parseMarkdownSegments(content);

  return (
    <div className="flex flex-col gap-3">
      {segments.map((seg, i) =>
        seg.type === 'code' ? (
          <CodeBlock key={i} code={seg.content} language={seg.language} />
        ) : (
          <MarkdownText key={i} content={seg.content} />
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

const ChatView: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [error, setError] = useState<ChatError | null>(null);
  const [showWelcome, setShowWelcome] = useState(true);
  const [warning, setWarning] = useState<string | null>(null);

  const { isOffline } = useNetworkStatus();
  const sessionRef = useRef<ChatSession | null>(null);
  const streamBuf = useRef('');

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

  /* ── IPC listeners ──────────────────────────────────────────── */

  useEffect(() => {
    initSession();

    window.api.onChatChunk((chunk: string) => {
      streamBuf.current += chunk;
      setStreamingContent(streamBuf.current);
    });

    window.api.onChatEnd((err?: string) => {
      setIsGenerating(false);

      if (err) {
        // Try to parse error type from the string (ChatService sends "type:message" or just a message)
        let errorType = 'unknown';
        let errorMessage = err;
        const colonIdx = err.indexOf(':');
        if (colonIdx > 0 && colonIdx < 20) {
          errorType = err.slice(0, colonIdx).trim();
          errorMessage = err.slice(colonIdx + 1).trim();
        }
        setError({ type: errorType, message: errorMessage });
      } else if (streamBuf.current) {
        // Successful completion — add the assistant message to the list
        const assistantMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: streamBuf.current,
          timestamp: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, assistantMsg]);
      }

      setStreamingContent('');
      streamBuf.current = '';
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
    setError(null);
    setShowWelcome(true);
    await initSession();
  }, [isGenerating, initSession]);

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
    // Find the last user message and resend it
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMsg) return;

    setError(null);
    setIsGenerating(true);
    streamBuf.current = '';
    setStreamingContent('');

    window.api.sendChatMessage(lastUserMsg.content).catch(() => {
      setIsGenerating(false);
      setError({ type: 'network', message: 'Failed to send message.' });
    });
  }, [messages]);

  /* ── Determine what to show ─────────────────────────────────── */

  const hasMessages = messages.length > 0 || streamingContent.length > 0;
  const displayWelcome = showWelcome && !hasMessages;

  /* ── Render ─────────────────────────────────────────────────── */

  // Centered column padding: keeps content at max 720px, centered
  const colStyle: React.CSSProperties = {
    paddingLeft: 'max(1rem, calc(50% - 360px))',
    paddingRight: 'max(1rem, calc(50% - 360px))',
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-main-bg">

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
            renderAssistantContent={(content) => <AssistantContent content={content} />}
            onRegenerate={handleRetry}
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
  );
};

export default ChatView;

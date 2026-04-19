import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { X, Trash2, Pause, Play, Download, Copy } from 'lucide-react';
import type { DebugLogEntry, DebugLogLevel } from '../../shared/types';

export interface DebugLogPanelProps {
  open: boolean;
  onClose: () => void;
}

const LEVEL_COLOR: Record<DebugLogLevel, string> = {
  info: '#7dcfff',
  warn: '#e0af68',
  error: '#f7768e',
  debug: '#bb9af7',
  stream: '#9ece6a',
};

const TAG_COLOR = '#7aa2f7';
const TS_COLOR = '#565f89';
const META_COLOR = '#a9b1d6';
const BG = '#0b0d14';
const BG_HEADER = '#11141d';
const BORDER = '#1f2335';

function formatTs(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function safeJson(value: unknown): string {
  try {
    if (typeof value === 'string') return value;
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const MAX_RENDERED = 1000;

export const DebugLogPanel: React.FC<DebugLogPanelProps> = ({ open, onClose }) => {
  const [entries, setEntries] = useState<DebugLogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const pausedBufRef = useRef<DebugLogEntry[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Subscribe once on mount; keep listening even when collapsed so the
  // backlog stays current.
  useEffect(() => {
    let mounted = true;
    window.api.getDebugLogBacklog().then((backlog) => {
      if (!mounted) return;
      setEntries(backlog.slice(-MAX_RENDERED));
    });
    window.api.onDebugLog((entry) => {
      if (!mounted) return;
      if (paused) {
        pausedBufRef.current.push(entry);
        return;
      }
      setEntries((prev) => {
        const next = prev.length >= MAX_RENDERED ? prev.slice(-MAX_RENDERED + 1) : prev.slice();
        next.push(entry);
        return next;
      });
    });
    return () => {
      mounted = false;
      window.api.removeDebugLogListeners();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When unpausing, drain the buffered entries.
  useEffect(() => {
    if (paused) return;
    if (pausedBufRef.current.length === 0) return;
    const drained = pausedBufRef.current;
    pausedBufRef.current = [];
    setEntries((prev) => {
      const merged = prev.concat(drained);
      return merged.length > MAX_RENDERED ? merged.slice(-MAX_RENDERED) : merged;
    });
  }, [paused]);

  // Autoscroll when new entries arrive (unless user scrolled up).
  useEffect(() => {
    if (!open || !autoScroll) return;
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [entries, open, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setAutoScroll(nearBottom);
  }, []);

  const filteredEntries = useMemo(() => {
    if (!filter.trim()) return entries;
    const f = filter.toLowerCase();
    return entries.filter((e) => {
      if (e.tag.toLowerCase().includes(f)) return true;
      if (e.message.toLowerCase().includes(f)) return true;
      if (e.level.toLowerCase().includes(f)) return true;
      if (e.data !== undefined && safeJson(e.data).toLowerCase().includes(f)) return true;
      return false;
    });
  }, [entries, filter]);

  const handleClear = useCallback(() => {
    setEntries([]);
    pausedBufRef.current = [];
  }, []);

  const handleCopy = useCallback(async () => {
    const text = filteredEntries
      .map((e) => {
        const head = `[${formatTs(e.ts)}] ${e.level.toUpperCase().padEnd(6)} ${e.tag}: ${e.message}`;
        return e.data !== undefined ? `${head}\n${safeJson(e.data)}` : head;
      })
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  }, [filteredEntries]);

  const handleDownload = useCallback(() => {
    const text = filteredEntries
      .map((e) => {
        const head = `[${new Date(e.ts).toISOString()}] ${e.level.toUpperCase()} ${e.tag}: ${e.message}`;
        return e.data !== undefined ? `${head}\n${safeJson(e.data)}` : head;
      })
      .join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lumina-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [filteredEntries]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="Debug log"
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        height: '40vh',
        minHeight: 220,
        maxHeight: '70vh',
        background: BG,
        borderTop: `1px solid ${BORDER}`,
        boxShadow: '0 -8px 24px rgba(0,0,0,0.45)',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: 12,
        color: META_COLOR,
      }}
    >
      {/* Title bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          background: BG_HEADER,
          borderBottom: `1px solid ${BORDER}`,
          color: META_COLOR,
        }}
      >
        <span style={{ color: '#9ece6a', fontWeight: 600 }}>● debug</span>
        <span style={{ color: TS_COLOR }}>·</span>
        <span style={{ color: TS_COLOR }}>{filteredEntries.length}/{entries.length} lines</span>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter (tag, message, json)…"
          style={{
            flex: 1,
            background: '#0a0c12',
            border: `1px solid ${BORDER}`,
            borderRadius: 4,
            color: META_COLOR,
            padding: '3px 8px',
            outline: 'none',
            fontFamily: 'inherit',
            fontSize: 12,
            marginLeft: 8,
          }}
        />
        <ToolbarButton
          title={paused ? 'Resume' : 'Pause'}
          onClick={() => setPaused((p) => !p)}
        >
          {paused ? <Play size={13} /> : <Pause size={13} />}
        </ToolbarButton>
        <ToolbarButton title="Copy visible" onClick={handleCopy}>
          <Copy size={13} />
        </ToolbarButton>
        <ToolbarButton title="Download" onClick={handleDownload}>
          <Download size={13} />
        </ToolbarButton>
        <ToolbarButton title="Clear" onClick={handleClear}>
          <Trash2 size={13} />
        </ToolbarButton>
        <ToolbarButton title="Close (⌘⇧D)" onClick={onClose}>
          <X size={13} />
        </ToolbarButton>
      </div>

      {/* Log body */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '6px 10px 10px 10px',
          background: BG,
          lineHeight: 1.45,
        }}
      >
        {filteredEntries.length === 0 && (
          <div style={{ color: TS_COLOR, padding: '8px 0' }}>
            {entries.length === 0
              ? '$ waiting for logs…'
              : 'No matches for filter.'}
          </div>
        )}
        {filteredEntries.map((e, i) => (
          <LogLine key={i} entry={e} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
};

const ToolbarButton: React.FC<{ title: string; onClick: () => void; children: React.ReactNode }> = ({
  title,
  onClick,
  children,
}) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    style={{
      background: 'transparent',
      border: `1px solid ${BORDER}`,
      borderRadius: 4,
      color: META_COLOR,
      padding: '3px 6px',
      cursor: 'pointer',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}
  >
    {children}
  </button>
);

const LogLine: React.FC<{ entry: DebugLogEntry }> = ({ entry }) => {
  const [expanded, setExpanded] = useState(false);
  const dataStr = entry.data === undefined ? null : safeJson(entry.data);
  const isLong = dataStr !== null && (dataStr.length > 280 || dataStr.includes('\n'));
  const collapsed = isLong && !expanded;
  const dataPreview = collapsed && dataStr ? dataStr.slice(0, 220) + '…' : dataStr;

  return (
    <div style={{ padding: '1px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      <span style={{ color: TS_COLOR }}>[{formatTs(entry.ts)}] </span>
      <span style={{ color: LEVEL_COLOR[entry.level], fontWeight: 600 }}>
        {entry.level.toUpperCase().padEnd(6)}
      </span>{' '}
      <span style={{ color: TAG_COLOR }}>{entry.tag}:</span>{' '}
      <span style={{ color: '#c0caf5' }}>{entry.message}</span>
      {dataStr && (
        <>
          {' '}
          {isLong ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              style={{
                background: 'transparent',
                border: 'none',
                color: TS_COLOR,
                cursor: 'pointer',
                padding: 0,
                font: 'inherit',
              }}
            >
              {expanded ? '[collapse]' : '[expand]'}
            </button>
          ) : null}
          <pre
            style={{
              margin: '2px 0 4px 16px',
              padding: '4px 8px',
              background: '#06070b',
              border: `1px solid ${BORDER}`,
              borderRadius: 3,
              color: '#a9b1d6',
              fontFamily: 'inherit',
              fontSize: 11,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {dataPreview}
          </pre>
        </>
      )}
    </div>
  );
};

export default DebugLogPanel;

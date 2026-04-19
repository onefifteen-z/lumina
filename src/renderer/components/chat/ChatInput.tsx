import React, { useRef, useCallback, useState, useEffect, useMemo } from 'react';
import { Send, Square, SquarePen, FileText } from 'lucide-react';
import type { ArticleMeta } from '../../../shared/types';

export interface ChatInputProps {
  onSend: (content: string, mentions: string[]) => void;
  onStop: () => void;
  onNewSession: () => void;
  isGenerating: boolean;
  isOffline: boolean;
  colStyle?: React.CSSProperties;
}

interface MentionState {
  /** Character offset of the `@` that opened the picker */
  start: number;
  /** Current query string (text after the `@`) */
  query: string;
}

const MAX_RESULTS = 8;

/**
 * Find an active `@`-mention at the caret position. Returns null if the caret
 * is not currently inside a mention token. A mention is "active" when the
 * preceding `@` is preceded by start-of-input or whitespace, and the substring
 * between `@` and the caret contains no whitespace.
 */
export function detectMention(text: string, caret: number): MentionState | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '@') {
      if (i === 0 || /\s/.test(text[i - 1])) {
        return { start: i, query: text.slice(i + 1, caret) };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}

/* ── Mention highlight segmentation ─────────────────────────────── */

/**
 * Segment of input text used by the highlight overlay. `mention` segments are
 * recognised `@filename` tokens that should be drawn with a chip background;
 * `text` segments are everything else (rendered as-is, preserving whitespace).
 */
export type InputSegment =
  | { type: 'text'; content: string }
  | { type: 'mention'; content: string; filename: string };

/**
 * Walk `text` and split it into segments, marking `@filename` tokens whose
 * filename matches a known article. Non-matching `@foo` stays as plain text so
 * we don't accidentally paint chips around stray emails or `@user` mentions.
 */
export function segmentInput(text: string, knownFilenames: Set<string>): InputSegment[] {
  const segments: InputSegment[] = [];
  if (!text) return segments;

  // Match `@token` where `@` is at start-of-input or preceded by whitespace and
  // `token` is one or more non-whitespace characters.
  const re = /(^|\s)@(\S+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const [full, lead, token] = match;
    if (!knownFilenames.has(token)) continue;
    const tokenStart = match.index + lead.length;
    if (tokenStart > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, tokenStart) });
    }
    segments.push({ type: 'mention', content: `@${token}`, filename: token });
    lastIndex = match.index + full.length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return segments;
}

/** Score a candidate by how well it matches the query. Lower is better. */
function scoreCandidate(filename: string, title: string, q: string): number {
  if (!q) return 0;
  const ql = q.toLowerCase();
  const fnl = filename.toLowerCase();
  const tl = title.toLowerCase();
  if (fnl === ql || tl === ql) return 0;
  if (fnl.startsWith(ql) || tl.startsWith(ql)) return 1;
  const fIdx = fnl.indexOf(ql);
  const tIdx = tl.indexOf(ql);
  if (fIdx >= 0 || tIdx >= 0) return 2;
  return 100;
}

export const ChatInput: React.FC<ChatInputProps> = ({
  onSend,
  onStop,
  onNewSession,
  isGenerating,
  isOffline,
  colStyle,
}) => {
  const [value, setValue] = useState('');
  const [articles, setArticles] = useState<ArticleMeta[]>([]);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Lazily load article list on first focus and refresh when vault changes.
  const loadArticles = useCallback(async () => {
    try {
      const list = await window.api.listArticles();
      setArticles(list);
    } catch {
      // ignore — picker just stays empty
    }
  }, []);

  useEffect(() => {
    loadArticles();
    window.api.onVaultChange(() => loadArticles());
    window.api.onVaultSwitched(() => loadArticles());
    return () => {
      window.api.removeVaultChangeListener();
      window.api.removeVaultSwitchedListener();
    };
  }, [loadArticles]);

  const resetHeight = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, []);

  const updateMentionFromCaret = useCallback((text: string) => {
    const ta = textareaRef.current;
    const caret = ta?.selectionStart ?? text.length;
    const next = detectMention(text, caret);
    setMention(next);
    setHighlightIdx(0);
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      setValue(newValue);
      resetHeight();
      updateMentionFromCaret(newValue);
    },
    [resetHeight, updateMentionFromCaret],
  );

  /** Extract @filename tokens from `value`. Filenames here are vault-relative paths. */
  const extractMentions = useCallback((text: string): string[] => {
    const set = new Set<string>();
    const re = /(?:^|\s)@(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const token = m[1];
      // Must be a known article filename to count as a mention
      if (articles.some((a) => a.filename === token)) {
        set.add(token);
      }
    }
    return [...set];
  }, [articles]);

  const send = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || isGenerating || isOffline) return;
    const mentions = extractMentions(trimmed);
    onSend(trimmed, mentions);
    setValue('');
    setMention(null);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) ta.style.height = 'auto';
    });
  }, [value, isGenerating, isOffline, onSend, extractMentions]);

  // Filter and rank candidates by current query
  const candidates = useMemo(() => {
    if (!mention) return [];
    const q = mention.query;
    const scored = articles
      .map((a) => ({ a, score: scoreCandidate(a.filename, a.title, q) }))
      .filter((s) => s.score < 100)
      .sort((x, y) => x.score - y.score || x.a.filename.localeCompare(y.a.filename))
      .slice(0, MAX_RESULTS);
    return scored.map((s) => s.a);
  }, [mention, articles]);

  const insertCandidate = useCallback(
    (article: ArticleMeta) => {
      if (!mention) return;
      const before = value.slice(0, mention.start);
      const afterStart = mention.start + 1 + mention.query.length;
      const after = value.slice(afterStart);
      const insertion = `@${article.filename} `;
      const next = before + insertion + after;
      setValue(next);
      setMention(null);
      // Move caret to just after the inserted token
      const newCaret = before.length + insertion.length;
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(newCaret, newCaret);
          resetHeight();
        }
      });
    },
    [mention, value, resetHeight],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Picker navigation takes precedence when open
      if (mention && candidates.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setHighlightIdx((i) => (i + 1) % candidates.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setHighlightIdx((i) => (i - 1 + candidates.length) % candidates.length);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          insertCandidate(candidates[highlightIdx]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setMention(null);
          return;
        }
      }

      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        send();
      }
    },
    [send, mention, candidates, highlightIdx, insertCandidate],
  );

  // Re-detect mention when caret moves without typing (arrow keys, clicks).
  const handleSelect = useCallback(() => {
    updateMentionFromCaret(value);
  }, [updateMentionFromCaret, value]);

  // ── Highlight overlay ────────────────────────────────────────
  // We render a non-interactive layer beneath the textarea that paints chip
  // backgrounds behind recognised `@filename` tokens. The textarea itself uses
  // a transparent text colour but a visible caret, so users see the styled
  // mention while still typing/selecting normally.
  const knownFilenames = useMemo(
    () => new Set(articles.map((a) => a.filename)),
    [articles],
  );
  const segments = useMemo(
    () => segmentInput(value, knownFilenames),
    [value, knownFilenames],
  );
  const hasMention = segments.some((s) => s.type === 'mention');

  // Keep the overlay's scroll position in lock-step with the textarea so chips
  // don't drift away from the underlying text when the input scrolls.
  const handleScroll = useCallback(() => {
    const ta = textareaRef.current;
    const ov = overlayRef.current;
    if (!ta || !ov) return;
    ov.scrollTop = ta.scrollTop;
    ov.scrollLeft = ta.scrollLeft;
  }, []);

  return (
    <div className="shrink-0 pb-4 pt-2" style={colStyle}>
      {/* Input box */}
      <div className="relative rounded-xl border border-border bg-sidebar-bg focus-within:border-primary-border transition-colors" style={{ padding: '20px 20px 16px 20px' }}>
        {/* Mention picker */}
        {mention && candidates.length > 0 && (
          <div
            role="listbox"
            aria-label="File mentions"
            className="absolute left-4 right-4 bottom-full mb-2 max-h-64 overflow-y-auto rounded-lg border border-border bg-sidebar-bg shadow-lg z-20"
          >
            {candidates.map((c, i) => (
              <button
                key={c.filename}
                type="button"
                role="option"
                aria-selected={i === highlightIdx}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertCandidate(c);
                }}
                onMouseEnter={() => setHighlightIdx(i)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors cursor-pointer ${i === highlightIdx ? 'bg-primary-bg text-text-primary' : 'text-text-secondary hover:bg-surface-hover'}`}
              >
                <FileText size={14} className="shrink-0 opacity-70" />
                <span className="truncate font-medium text-text-primary">{c.title}</span>
                <span className="ml-auto truncate text-[11px] text-text-secondary opacity-70">{c.filename}</span>
              </button>
            ))}
          </div>
        )}

        {/* Text area + highlight overlay. Both share font, padding and line
            height so the chip backgrounds line up exactly with the typed text. */}
        <div className="relative">
          {hasMention && (
            <div
              ref={overlayRef}
              aria-hidden="true"
              className="absolute inset-0 w-full text-sm leading-relaxed pb-3 pointer-events-none select-none overflow-hidden text-text-primary"
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: '200px',
                minHeight: '52px',
              }}
            >
              {segments.map((seg, i) =>
                seg.type === 'mention' ? (
                  <span
                    key={i}
                    className="rounded-md text-primary"
                    style={{
                      backgroundColor: 'rgba(124,58,237,0.22)',
                      // Slight horizontal padding visually inflates the chip
                      // without shifting glyphs — negative margins pull the
                      // layout back so the overlay stays character-aligned
                      // with the textarea underneath.
                      padding: '0 2px',
                      margin: '0 -2px',
                    }}
                  >
                    {seg.content}
                  </span>
                ) : (
                  <span key={i}>{seg.content}</span>
                ),
              )}
              {/* Trailing newline guard: pre-wrap collapses a final \n, which
                  would shift the overlay one line above the textarea when the
                  user just hit Enter. A zero-width space keeps the last empty
                  line measured. */}
              {value.endsWith('\n') && '\u200b'}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onSelect={handleSelect}
            onClick={handleSelect}
            onScroll={handleScroll}
            disabled={isOffline || isGenerating}
            placeholder={
              isOffline
                ? 'Chat unavailable while offline'
                : isGenerating
                  ? 'Generating…'
                  : 'Message Lumina… (use @ to attach a file)'
            }
            rows={1}
            aria-label="Chat message input"
            className={`relative w-full resize-none bg-transparent text-sm placeholder:text-text-secondary focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 leading-relaxed pb-3 ${hasMention ? 'text-transparent' : 'text-text-primary'}`}
            style={{
              maxHeight: '200px',
              minHeight: '52px',
              overflowY: 'auto',
              display: 'block',
              caretColor: 'var(--text-primary, #fff)',
            }}
          />
        </div>

        {/* Bottom action row */}
        <div className="flex items-center justify-end gap-1.5">
          {/* New Chat */}
          <button
            type="button"
            onClick={onNewSession}
            aria-label="New session"
            className="flex items-center justify-center w-8 h-8 rounded-lg text-text-secondary hover:bg-surface-hover hover:text-text-primary transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-primary-border focus-visible:outline-none"
          >
            <SquarePen size={16} />
          </button>

          {/* Send / Stop */}
          {isGenerating ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop generation"
              className="flex items-center justify-center w-8 h-8 rounded-lg bg-text-primary text-main-bg hover:opacity-80 transition-colors cursor-pointer shrink-0 focus-visible:ring-2 focus-visible:ring-primary-border focus-visible:outline-none"
            >
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!value.trim() || isOffline}
              aria-label="Send message"
              className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors cursor-pointer shrink-0 disabled:opacity-30 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-primary-border focus-visible:outline-none"
            >
              <Send size={15} />
            </button>
          )}
        </div>
      </div>

      <p className="mt-1.5 text-center text-[11px] text-text-secondary opacity-60">
        {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter to send · @ to attach file
      </p>
    </div>
  );
};

export default ChatInput;

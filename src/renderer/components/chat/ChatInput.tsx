import React, { useRef, useCallback, useState, useEffect, useMemo } from 'react';
import { Send, Square, SquarePen, FileText } from 'lucide-react';
import type { ArticleMeta, ChatSendCommand } from '../../../shared/types';
import { isConfigFile } from '../../lib/file-classification';

export interface ChatInputProps {
  onSend: (content: string, mentions: string[], command?: ChatSendCommand) => void;
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

type PickerState =
  | { kind: 'mention'; start: number; query: string }
  | { kind: 'ingest'; start: number; query: string; quoted: boolean }
  | { kind: 'slash'; start: number; query: string };

const MAX_RESULTS = 8;

/**
 * Catalogue of supported slash commands. The picker shows these whenever the
 * caret sits inside the leading `/word` of the input. Keep `name` as the bare
 * verb (no leading slash) — `insertion` is what gets typed in, including the
 * trailing space that primes the next picker (e.g. ingest's filename picker).
 */
export interface SlashCommandSpec {
  name: string;
  description: string;
  insertion: string;
}

export const SLASH_COMMANDS: SlashCommandSpec[] = [
  {
    name: 'lint',
    description: 'Lint the current knowledge base',
    insertion: '/lint ',
  },
  {
    name: 'ingest',
    description: 'Ingest a source file (PDF/PPTX/image/text) into the wiki',
    insertion: '/ingest ',
  },
];

/**
 * Detect whether the caret is inside a leading slash-command token, e.g.
 * `/in|gest`. The picker only fires when:
 *   - The slash sits at the very start of the input (after optional leading
 *     whitespace) — slashes mid-message are normal text.
 *   - The caret is still inside the unbroken `/word` token (no whitespace yet).
 *
 * Returns the offset of the leading `/` and the partial verb typed so far.
 */
export function detectSlashCommand(text: string, caret: number): {
  start: number;
  query: string;
} | null {
  const leadingWsMatch = text.match(/^\s*/);
  const leadingWs = leadingWsMatch ? leadingWsMatch[0].length : 0;
  if (text[leadingWs] !== '/') return null;
  if (caret < leadingWs) return null;

  // Walk forward from the slash until whitespace; the picker is active only
  // while the caret is within that contiguous token. As soon as the user
  // types a space, we hand off to `/lint` / `/ingest` filename pickers (or
  // plain text mode).
  let end = leadingWs + 1;
  while (end < text.length && !/\s/.test(text[end])) end++;
  if (caret > end) return null;

  return {
    start: leadingWs,
    query: text.slice(leadingWs + 1, caret),
  };
}

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

/** True if `trimmed` begins with `prefix` as a whole command word (not `/linter` for `/lint`). */
export function isSlashCommandPrefix(trimmed: string, prefix: string): boolean {
  if (!trimmed.startsWith(prefix)) return false;
  const next = trimmed[prefix.length];
  return next === undefined || /\s/.test(next);
}

const DEFAULT_INGEST_PROMPT =
  "Please analyze the attached file and answer the user's request.";

/**
 * Detect whether the caret is inside `/ingest <filename>` (first filename
 * argument). Supports quoted and unquoted filename input.
 *
 * Note: `/lint` no longer takes a filename argument — it lints the entire
 * wiki using CLAUDE.md as the source of conventions — so the parameter is
 * intentionally narrowed to `'/ingest'`.
 */
export function detectSlashFilename(
  text: string,
  caret: number,
  cmd: '/ingest',
): {
  start: number;
  query: string;
  quoted: boolean;
} | null {
  const leadingWsMatch = text.match(/^\s*/);
  const leadingWs = leadingWsMatch ? leadingWsMatch[0].length : 0;
  if (!text.slice(leadingWs).startsWith(cmd)) return null;

  const cmdStart = leadingWs;
  const cmdEnd = cmdStart + cmd.length;
  if (text[cmdEnd] && !/\s/.test(text[cmdEnd])) return null;
  if (caret < cmdEnd) return null;

  let argStart = cmdEnd;
  while (argStart < text.length && /\s/.test(text[argStart])) argStart++;

  if (caret <= argStart) {
    return { start: argStart, query: '', quoted: false };
  }

  if (text[argStart] === '"') {
    const quoteStart = argStart;
    const tokenStart = quoteStart + 1;
    const closingQuote = text.indexOf('"', tokenStart);
    if (closingQuote >= 0 && caret > closingQuote) return null;
    return {
      start: quoteStart,
      query: text.slice(tokenStart, caret),
      quoted: true,
    };
  }

  const raw = text.slice(argStart, caret);
  if (/\s/.test(raw)) return null;
  return { start: argStart, query: raw, quoted: false };
}

export function detectIngestFilename(text: string, caret: number) {
  return detectSlashFilename(text, caret, '/ingest');
}

/**
 * Parse `/ingest <filename> [prompt…]` from the current input. Supports both
 * unquoted and quoted (for filenames with spaces) forms. Returns null if the
 * line isn't an `/ingest` command, the filename is missing, or the quoting
 * is malformed.
 */
function parseIngestSlashCommand(trimmed: string): ChatSendCommand | null {
  const rest = trimmed.slice('/ingest'.length).trim();
  if (!rest) return null;

  let filename = '';
  let prompt = '';
  if (rest.startsWith('"')) {
    const closing = rest.indexOf('"', 1);
    if (closing <= 1) return null;
    filename = rest.slice(1, closing).trim();
    prompt = rest.slice(closing + 1).trim();
  } else {
    const firstSpace = rest.search(/\s/);
    if (firstSpace < 0) {
      filename = rest;
      prompt = '';
    } else {
      filename = rest.slice(0, firstSpace).trim();
      prompt = rest.slice(firstSpace + 1).trim();
    }
  }

  if (!filename) return null;
  return {
    type: 'ingest',
    filename,
    prompt: prompt || DEFAULT_INGEST_PROMPT,
  };
}

/**
 * Parse supported slash-commands from the current input.
 *
 * Supported:
 *   - `/lint [prompt…]`           — lint the entire knowledge base. Any free
 *                                   text after `/lint` is captured as
 *                                   `prompt` and forwarded to the model as
 *                                   "additional instruction" appended to
 *                                   the lint-workflow boilerplate (e.g.
 *                                   `/lint focus on the entities pages`).
 *   - `/ingest <file> [prompt…]`  — ingest a single source file.
 */
export function parseSlashCommand(text: string): ChatSendCommand | null {
  const trimmed = text.trim();
  if (isSlashCommandPrefix(trimmed, '/lint')) {
    const rest = trimmed.slice('/lint'.length).trim();
    return rest ? { type: 'lint', prompt: rest } : { type: 'lint' };
  }
  if (isSlashCommandPrefix(trimmed, '/ingest')) {
    return parseIngestSlashCommand(trimmed);
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
 * Walk `text` and split it into segments, marking known filenames so the
 * overlay can paint them as chips. Two trigger forms are recognised:
 *
 *   1. `@filename` mentions (the original form). The `@` must be at start of
 *      input or preceded by whitespace, and the filename must exist in
 *      `knownFilenames`. Unknown `@foo` stays plain so we don't chip emails
 *      or `@user` handles.
 *   2. `/ingest <filename>` (and quoted form) — the leading verb of the
 *      ingest slash command. We highlight the filename argument (NOT the
 *      `/ingest` keyword) the same way as a mention so the user gets
 *      immediate visual feedback that the file resolved. Quoted form lets
 *      filenames contain spaces; the surrounding quotes are kept inside the
 *      chip so the chip contour matches what's typed.
 *
 * `/lint` is intentionally NOT chipped — it's a no-arg command that lints
 * the entire wiki, so there's nothing to highlight. The two forms above
 * are mutually exclusive in practice: if a line begins with `/ingest`, we
 * only look for that command's filename and skip `@`-scanning on that
 * span. For all other lines (including `/lint …`) we fall back to
 * `@`-mention scanning.
 */
export function segmentInput(text: string, knownFilenames: Set<string>): InputSegment[] {
  const segments: InputSegment[] = [];
  if (!text) return segments;

  const ingest = matchLeadingSlashFile(text, knownFilenames, '/ingest');
  if (ingest) {
    if (ingest.chipStart > 0) {
      segments.push({ type: 'text', content: text.slice(0, ingest.chipStart) });
    }
    segments.push({
      type: 'mention',
      content: text.slice(ingest.chipStart, ingest.chipEnd),
      filename: ingest.filename,
    });
    if (ingest.chipEnd < text.length) {
      segments.push({ type: 'text', content: text.slice(ingest.chipEnd) });
    }
    return segments;
  }

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

/**
 * If `text` starts with `/ingest` plus a resolved filename that matches a
 * known article, return the chip span. Otherwise null.
 *
 * The chip span includes the surrounding quotes (when present). We do not
 * chip the command verb itself. (`/lint` doesn't take a filename, so it
 * has no chip — see `parseSlashCommand`.)
 */
function matchLeadingSlashFile(
  text: string,
  knownFilenames: Set<string>,
  cmd: '/ingest',
): { chipStart: number; chipEnd: number; filename: string } | null {
  const leadingWsMatch = text.match(/^\s*/);
  const leadingWs = leadingWsMatch ? leadingWsMatch[0].length : 0;
  if (!text.slice(leadingWs).startsWith(cmd)) return null;

  const cmdEnd = leadingWs + cmd.length;
  if (text[cmdEnd] && !/\s/.test(text[cmdEnd])) return null;

  let argStart = cmdEnd;
  while (argStart < text.length && /\s/.test(text[argStart])) argStart++;
  if (argStart >= text.length) return null;

  if (text[argStart] === '"') {
    const closing = text.indexOf('"', argStart + 1);
    if (closing < 0) return null;
    const filename = text.slice(argStart + 1, closing);
    if (!knownFilenames.has(filename)) return null;
    return { chipStart: argStart, chipEnd: closing + 1, filename };
  }

  const wsMatch = text.slice(argStart).search(/\s/);
  const argEnd = wsMatch < 0 ? text.length : argStart + wsMatch;
  const filename = text.slice(argStart, argEnd);
  if (!filename || !knownFilenames.has(filename)) return null;
  return { chipStart: argStart, chipEnd: argEnd, filename };
}

/**
 * Vault folder where ingest sources live (created by `VaultInitDialog`).
 * Match is case-insensitive and accepts both `/` and `\` separators so the
 * same logic works on Windows-style article paths.
 */
export const RAW_FOLDER_PREFIX = 'raw/';

/**
 * True if `filename` lives under the conventional `raw/` source folder.
 * Used to scope the `/ingest` picker so it only suggests candidate source
 * files, not every article in the vault.
 *
 * Match rules (deliberately lenient so user mistakes don't hide files):
 *   - case-insensitive (`Raw/` and `RAW/` count)
 *   - accepts `\` and `/` as separators
 *   - bare `raw` (no slash) does NOT match — we want a folder, not a file
 *     called `raw.md` at vault root
 */
export function isRawSource(filename: string): boolean {
  const normalised = filename.replace(/\\/g, '/').toLowerCase();
  return normalised.startsWith(RAW_FOLDER_PREFIX);
}

/**
 * Pick the candidate pool for the `/ingest` picker.
 *
 * Primary behaviour: only files under `raw/` are eligible — that's the
 * convention seeded by VaultInitDialog and matches user intent ("ingest
 * something I haven't processed yet"). Showing every article in the vault
 * was noisy and surfaced wiki notes that you'd never want to re-ingest.
 *
 * Fallback: if the vault has no `raw/` files at all (legacy vaults that
 * predated init, or vaults where the user manually deleted raw/), we fall
 * back to the full visible-article list. Returning an empty list would make
 * the picker silently broken — falling back is less surprising and the user
 * can still pick whatever they want.
 */
export function filterIngestCandidates(visible: ArticleMeta[]): ArticleMeta[] {
  const raw = visible.filter((a) => isRawSource(a.filename));
  return raw.length > 0 ? raw : visible;
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
  const [picker, setPicker] = useState<PickerState | null>(null);
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

  const updatePickerFromCaret = useCallback((text: string) => {
    const ta = textareaRef.current;
    const caret = ta?.selectionStart ?? text.length;
    // Order matters: slash-verb picker takes precedence while the caret is
    // inside the leading `/word`. Once the user types a space after
    // `/ingest`, the ingest filename detector kicks in. (`/lint` is a
    // no-arg command, so it has no follow-up filename picker.) Mentions
    // are last because `/ingest @x` shouldn't pop the @-picker over the
    // filename picker.
    const slash = detectSlashCommand(text, caret);
    if (slash) {
      setPicker({ kind: 'slash', start: slash.start, query: slash.query });
      setHighlightIdx(0);
      return;
    }
    const ingest = detectIngestFilename(text, caret);
    if (ingest) {
      setPicker({
        kind: 'ingest',
        start: ingest.start,
        query: ingest.query,
        quoted: ingest.quoted,
      });
      setHighlightIdx(0);
      return;
    }
    const mention = detectMention(text, caret);
    if (mention) {
      setPicker({ kind: 'mention', start: mention.start, query: mention.query });
      setHighlightIdx(0);
      return;
    }
    setPicker(null);
    setHighlightIdx(0);
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      setValue(newValue);
      resetHeight();
      updatePickerFromCaret(newValue);
    },
    [resetHeight, updatePickerFromCaret],
  );

  /**
   * Vault articles eligible to appear in the @-picker. Hidden / config files
   * (anything whose path has a `.`-prefixed segment, e.g. `.CLAUDE.md` or
   * `.git/HEAD`) are filtered out — surfacing them as mention candidates is
   * noisy and rarely intended.
   */
  const visibleArticles = useMemo(
    () => articles.filter((a) => !isConfigFile(a.filename)),
    [articles],
  );

  /** Extract @filename tokens from `value`. Filenames here are vault-relative paths. */
  const extractMentions = useCallback((text: string): string[] => {
    const set = new Set<string>();
    const re = /(?:^|\s)@(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const token = m[1];
      // Must be a known, non-hidden article filename to count as a mention.
      // Hidden/config files are excluded so a stray `@.CLAUDE.md` typed by
      // the user doesn't accidentally surface them as injected context.
      if (
        !isConfigFile(token) &&
        articles.some((a) => a.filename === token)
      ) {
        set.add(token);
      }
    }
    return [...set];
  }, [articles]);

  const send = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || isGenerating || isOffline) return;
    const command = parseSlashCommand(trimmed);
    const mentions = command ? [] : extractMentions(trimmed);
    onSend(trimmed, mentions, command ?? undefined);
    setValue('');
    setPicker(null);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) ta.style.height = 'auto';
    });
  }, [value, isGenerating, isOffline, onSend, extractMentions]);

  // Filter and rank file candidates (mention/ingest pickers).
  // The `/ingest` picker is scoped to the `raw/` folder (with a fallback
  // when raw/ is empty); `@`-mentions still see the whole visible vault.
  const candidates = useMemo(() => {
    if (!picker || picker.kind === 'slash') return [];
    const pool =
      picker.kind === 'ingest'
        ? filterIngestCandidates(visibleArticles)
        : visibleArticles;
    const q = picker.query;
    const scored = pool
      .map((a) => ({ a, score: scoreCandidate(a.filename, a.title, q) }))
      .filter((s) => s.score < 100)
      .sort((x, y) => x.score - y.score || x.a.filename.localeCompare(y.a.filename))
      .slice(0, MAX_RESULTS);
    return scored.map((s) => s.a);
  }, [picker, visibleArticles]);

  // Slash-command suggestions: prefix-match the verb the user has typed so
  // far. Empty query (just `/`) shows everything.
  const slashCandidates = useMemo(() => {
    if (!picker || picker.kind !== 'slash') return [];
    const q = picker.query.toLowerCase();
    return SLASH_COMMANDS
      .filter((c) => !q || c.name.toLowerCase().startsWith(q))
      .slice(0, MAX_RESULTS);
  }, [picker]);

  // Total count drives keyboard navigation regardless of which picker is
  // active.
  const pickerCount = picker?.kind === 'slash' ? slashCandidates.length : candidates.length;

  const insertCandidate = useCallback(
    (article: ArticleMeta) => {
      if (!picker || picker.kind === 'slash') return;
      let before = '';
      let afterStart = 0;
      let insertion = '';
      if (picker.kind === 'mention') {
        before = value.slice(0, picker.start);
        afterStart = picker.start + 1 + picker.query.length;
        insertion = `@${article.filename} `;
      } else {
        // `/ingest` filename argument
        before = value.slice(0, picker.start);
        const consumed = picker.quoted ? 1 + picker.query.length : picker.query.length;
        afterStart = picker.start + consumed;
        const needsQuotes = picker.quoted || /\s/.test(article.filename);
        insertion = needsQuotes ? `"${article.filename}" ` : `${article.filename} `;
      }
      const after = value.slice(afterStart);
      const next = before + insertion + after;
      setValue(next);
      setPicker(null);
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
    [picker, value, resetHeight],
  );

  /**
   * Apply a slash-command suggestion: replace the leading `/word` token with
   * the command's `insertion` (typically `/<verb> `), positioning the caret
   * right after the trailing space so the next picker (e.g. ingest's filename
   * picker) can take over immediately.
   */
  const insertSlashCommand = useCallback(
    (cmd: SlashCommandSpec) => {
      if (!picker || picker.kind !== 'slash') return;
      const before = value.slice(0, picker.start);
      // Consume the existing `/query` token. `+1` covers the leading slash.
      const afterStart = picker.start + 1 + picker.query.length;
      const after = value.slice(afterStart);
      const next = before + cmd.insertion + after;
      setValue(next);
      setPicker(null);
      const newCaret = before.length + cmd.insertion.length;
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(newCaret, newCaret);
          resetHeight();
          // Re-run picker detection so a follow-up picker (e.g. /ingest's
          // filename picker) opens immediately after the verb is committed.
          updatePickerFromCaret(next);
        }
      });
    },
    [picker, value, resetHeight, updatePickerFromCaret],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Picker navigation takes precedence when open
      if (picker && pickerCount > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setHighlightIdx((i) => (i + 1) % pickerCount);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setHighlightIdx((i) => (i - 1 + pickerCount) % pickerCount);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          if (picker.kind === 'slash') {
            insertSlashCommand(slashCandidates[highlightIdx]);
          } else {
            insertCandidate(candidates[highlightIdx]);
          }
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setPicker(null);
          return;
        }
      }

      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        send();
      }
    },
    [send, picker, pickerCount, candidates, slashCandidates, highlightIdx, insertCandidate, insertSlashCommand],
  );

  // Re-detect mention when caret moves without typing (arrow keys, clicks).
  const handleSelect = useCallback(() => {
    updatePickerFromCaret(value);
  }, [updatePickerFromCaret, value]);

  // ── Highlight overlay ────────────────────────────────────────
  // We render a non-interactive layer beneath the textarea that paints chip
  // backgrounds behind recognised `@filename` tokens. The textarea itself uses
  // a transparent text colour but a visible caret, so users see the styled
  // mention while still typing/selecting normally.
  const knownFilenames = useMemo(
    () => new Set(visibleArticles.map((a) => a.filename)),
    [visibleArticles],
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
        {/* Slash-command picker */}
        {picker?.kind === 'slash' && slashCandidates.length > 0 && (
          <div
            role="listbox"
            aria-label="Slash commands"
            className="absolute left-4 right-4 bottom-full mb-2 max-h-64 overflow-y-auto rounded-lg border border-border bg-sidebar-bg shadow-lg z-20"
          >
            {slashCandidates.map((c, i) => (
              <button
                key={c.name}
                type="button"
                role="option"
                aria-selected={i === highlightIdx}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertSlashCommand(c);
                }}
                onMouseEnter={() => setHighlightIdx(i)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors cursor-pointer ${i === highlightIdx ? 'bg-primary-bg text-text-primary' : 'text-text-secondary hover:bg-surface-hover'}`}
              >
                <span className="font-mono text-text-primary">/{c.name}</span>
                <span className="ml-auto truncate text-[11px] text-text-secondary opacity-70">{c.description}</span>
              </button>
            ))}
          </div>
        )}

        {/* File picker (mention / ingest) */}
        {picker && picker.kind !== 'slash' && candidates.length > 0 && (
          <div
            role="listbox"
            aria-label={
              picker.kind === 'ingest'
                ? 'Ingest file suggestions'
                : 'File mentions'
            }
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
        {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter to send · @ attach file · / for commands
      </p>
    </div>
  );
};

export default ChatInput;

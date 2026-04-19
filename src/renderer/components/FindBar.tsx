import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronUp, ChevronDown, X, CaseSensitive, WholeWord } from "lucide-react";
import {
  getActiveFindBackend,
  subscribeFindBackend,
  type FindBackend,
  type FindOptions,
} from "../find/page-find-controller";

export interface FindBarProps {
  open: boolean;
  initialQuery?: string;
  onClose: () => void;
}

const DEFAULT_OPTS: FindOptions = { caseSensitive: false, wholeWord: false };

export const FindBar: React.FC<FindBarProps> = ({ open, initialQuery, onClose }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(initialQuery ?? "");
  const [opts, setOpts] = useState<FindOptions>(DEFAULT_OPTS);
  const [result, setResult] = useState<{ total: number; current: number }>({ total: 0, current: 0 });
  const [backend, setBackend] = useState<FindBackend | null>(getActiveFindBackend());

  // Track the current active backend (changes when switching files / modes).
  useEffect(() => {
    return subscribeFindBackend((b) => setBackend(b));
  }, []);

  // Re-search whenever the query, options, or backend change.
  useEffect(() => {
    if (!open) return;
    const b = backend;
    if (!b) {
      setResult({ total: 0, current: 0 });
      return;
    }
    if (!query) {
      b.clear();
      setResult({ total: 0, current: 0 });
      return;
    }
    setResult(b.search(query, opts));
  }, [open, query, opts, backend]);

  // Focus + select-all whenever the bar opens (so the next keystroke replaces
  // the previous query). Also seed from the optional `initialQuery` so callers
  // can pre-populate from selected text.
  useEffect(() => {
    if (!open) return;
    if (initialQuery !== undefined) setQuery(initialQuery);
    // Defer to next tick so the input is mounted.
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [open, initialQuery]);

  // Clear backend highlights when the bar closes.
  useEffect(() => {
    if (open) return;
    backend?.clear();
  }, [open, backend]);

  const goNext = useCallback(() => {
    if (!backend) return;
    setResult(backend.next());
  }, [backend]);

  const goPrev = useCallback(() => {
    if (!backend) return;
    setResult(backend.prev());
  }, [backend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) goPrev();
        else goNext();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g") {
        e.preventDefault();
        if (e.shiftKey) goPrev();
        else goNext();
      }
    },
    [goNext, goPrev, onClose],
  );

  if (!open) return null;

  const hasQuery = query.length > 0;
  const showNoMatch = hasQuery && result.total === 0;

  return (
    <div
      role="dialog"
      aria-label="Find in page"
      className="fixed top-12 right-6 z-[60] flex items-center gap-1.5 rounded-md border border-border bg-sidebar-bg shadow-lg px-2 py-1.5 text-sm"
      style={{ minWidth: 320 }}
    >
      <input
        ref={inputRef}
        type="text"
        spellCheck={false}
        placeholder="Find in page"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        className={`flex-1 bg-transparent outline-none text-text-primary placeholder:text-text-secondary text-[13px] px-1 ${
          showNoMatch ? "text-red-400" : ""
        }`}
        aria-label="Search query"
      />

      <span
        className="text-[11px] tabular-nums text-text-secondary min-w-[3.5rem] text-right select-none"
        aria-live="polite"
      >
        {hasQuery ? `${result.current}/${result.total}` : "0/0"}
      </span>

      <button
        type="button"
        onClick={() => setOpts((o) => ({ ...o, caseSensitive: !o.caseSensitive }))}
        className={`p-1 rounded hover:bg-surface-hover ${opts.caseSensitive ? "bg-surface-hover text-primary" : "text-text-secondary"}`}
        aria-pressed={opts.caseSensitive}
        title="Match case"
      >
        <CaseSensitive size={14} />
      </button>

      <button
        type="button"
        onClick={() => setOpts((o) => ({ ...o, wholeWord: !o.wholeWord }))}
        className={`p-1 rounded hover:bg-surface-hover ${opts.wholeWord ? "bg-surface-hover text-primary" : "text-text-secondary"}`}
        aria-pressed={opts.wholeWord}
        title="Match whole word"
      >
        <WholeWord size={14} />
      </button>

      <div className="w-px h-4 bg-border mx-0.5" aria-hidden="true" />

      <button
        type="button"
        onClick={goPrev}
        disabled={result.total === 0}
        className="p-1 rounded text-text-secondary hover:text-text-primary hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed"
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        onClick={goNext}
        disabled={result.total === 0}
        className="p-1 rounded text-text-secondary hover:text-text-primary hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed"
        title="Next match (Enter)"
        aria-label="Next match"
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        onClick={onClose}
        className="p-1 rounded text-text-secondary hover:text-text-primary hover:bg-surface-hover ml-0.5"
        title="Close (Esc)"
        aria-label="Close"
      >
        <X size={14} />
      </button>
    </div>
  );
};

export default FindBar;

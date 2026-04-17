import * as React from "react";
import { useState, useEffect, useCallback, useRef } from "react";
import { Search as SearchIcon, Loader2, FileText, Tag } from "lucide-react";
import type { SearchResult, ArticleMeta } from "../../shared/types";
import { cn } from "../lib/utils";

// ── Debounce hook ──────────────────────────────────────────────

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

interface DisplayResult {
  title: string;
  filename: string;
  excerpt: string;
  snippets: string[];
  isTagResult: boolean;
}

export interface SearchPopupProps {
  open: boolean;
  onClose: () => void;
  onSelectArticle: (filename: string) => void;
}

export function SearchPopup({ open, onClose, onSelectArticle }: SearchPopupProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DisplayResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debouncedQuery = useDebounce(query, 200);

  // Reset & focus on open
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Search
  useEffect(() => {
    const trimmed = debouncedQuery.trim();
    if (!trimmed) { setResults([]); return; }
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        if (trimmed.startsWith("#")) {
          const tag = trimmed.slice(1).trim();
          if (!tag) { setResults([]); return; }
          const tagResults: ArticleMeta[] = await window.api.searchByTag(tag);
          if (!cancelled) setResults(tagResults.map(m => ({ title: m.title, filename: m.filename, excerpt: m.excerpt, snippets: [], isTagResult: true })));
        } else {
          const sr: SearchResult[] = await window.api.search(trimmed);
          if (!cancelled) setResults(sr.map(r => ({ title: r.title, filename: r.filename, excerpt: r.excerpt, snippets: r.matches.map(m => m.snippet), isTagResult: false })));
        }
      } catch { if (!cancelled) setResults([]); }
      finally { if (!cancelled) setLoading(false); }
    })();

    return () => { cancelled = true; };
  }, [debouncedQuery]);

  // Reset selection when results change
  useEffect(() => { setSelectedIndex(0); }, [results]);

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const select = useCallback((filename: string) => {
    onSelectArticle(filename);
    onClose();
  }, [onSelectArticle, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIndex(i => Math.min(i + 1, results.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIndex(i => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter" && results[selectedIndex]) { e.preventDefault(); select(results[selectedIndex].filename); }
  }, [results, selectedIndex, select, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]" onClick={onClose}>
      <div
        className="w-full max-w-[560px] rounded-xl bg-rail-bg border border-border shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Input */}
        <div className="flex items-center gap-2 px-4 border-b border-border" style={{ height: 52 }}>
          <SearchIcon size={18} className="text-text-secondary shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search articles… (# for tags)"
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="flex-1 bg-transparent text-text-primary placeholder:text-text-secondary text-sm outline-none"
          />
          {loading && <Loader2 size={16} className="text-text-secondary animate-spin shrink-0" />}
        </div>

        {/* Results */}
        {results.length > 0 && (
          <div ref={listRef} className="max-h-[360px] overflow-y-auto py-1">
            {results.map((r, i) => (
              <button
                key={r.filename}
                type="button"
                onClick={() => select(r.filename)}
                onMouseEnter={() => setSelectedIndex(i)}
                className={cn(
                  "flex items-start gap-3 w-full text-left px-4 py-2.5 transition-colors cursor-pointer",
                  i === selectedIndex ? "bg-surface-hover" : ""
                )}
              >
                {r.isTagResult
                  ? <Tag size={16} className="mt-0.5 shrink-0 text-primary" />
                  : <FileText size={16} className="mt-0.5 shrink-0 text-text-secondary" />}
                <div className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-text-primary truncate">{r.title}</span>
                  <span className="block text-xs text-text-secondary truncate mt-0.5">
                    {r.excerpt.length > 100 ? r.excerpt.slice(0, 100) + "…" : r.excerpt}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Empty state */}
        {query.trim() && !loading && results.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-text-secondary">No results found</div>
        )}

        {/* Footer hint */}
        <div className="flex items-center justify-end gap-3 px-4 py-2 border-t border-border text-[11px] text-text-secondary">
          <span><kbd className="px-1 py-0.5 rounded bg-surface-hover text-text-secondary">↑↓</kbd> navigate</span>
          <span><kbd className="px-1 py-0.5 rounded bg-surface-hover text-text-secondary">↵</kbd> open</span>
          <span><kbd className="px-1 py-0.5 rounded bg-surface-hover text-text-secondary">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

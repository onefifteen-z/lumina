import * as React from "react";
import { useState, useEffect, useCallback, useRef } from "react";
import { Search as SearchIcon, Loader2 } from "lucide-react";
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

// ── Types ──────────────────────────────────────────────────────

interface DisplayResult {
  title: string;
  filename: string;
  excerpt: string;
  snippets: string[];
  isTagResult: boolean;
}

// ── SearchView ─────────────────────────────────────────────────

export interface SearchViewProps {
  onSelectArticle: (filename: string) => void;
}

export function SearchView({ onSelectArticle }: SearchViewProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DisplayResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const debouncedQuery = useDebounce(query, 300);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Execute search when debounced query changes
  useEffect(() => {
    const trimmed = debouncedQuery.trim();
    if (!trimmed) {
      setResults([]);
      setHasSearched(false);
      setError(null);
      return;
    }

    let cancelled = false;

    const executeSearch = async () => {
      setLoading(true);
      setError(null);

      try {
        if (trimmed.startsWith("#")) {
          // Tag-based search
          const tag = trimmed.slice(1).trim();
          if (!tag) {
            setResults([]);
            setHasSearched(true);
            return;
          }
          const tagResults: ArticleMeta[] = await window.api.searchByTag(tag);
          if (!cancelled) {
            setResults(
              tagResults.map((meta) => ({
                title: meta.title,
                filename: meta.filename,
                excerpt: meta.excerpt,
                snippets: [],
                isTagResult: true,
              }))
            );
            setHasSearched(true);
          }
        } else {
          // Full-text search
          const searchResults: SearchResult[] = await window.api.search(trimmed);
          if (!cancelled) {
            setResults(
              searchResults.map((sr) => ({
                title: sr.title,
                filename: sr.filename,
                excerpt: sr.excerpt,
                snippets: sr.matches.map((m) => m.snippet),
                isTagResult: false,
              }))
            );
            setHasSearched(true);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Search failed");
          setResults([]);
          setHasSearched(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    executeSearch();
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  const handleResultClick = useCallback(
    (filename: string) => {
      onSelectArticle(filename);
    },
    [onSelectArticle]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setQuery(e.target.value);
    },
    []
  );

  return (
    <div className="flex flex-col h-full">
      {/* Heading */}
      <div className="px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">
          Search
        </h2>
      </div>

      {/* Search input */}
      <div className="px-3 py-3">
        <div className="relative">
          <SearchIcon
            size={16}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none"
          />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search… (# for tags)"
            value={query}
            onChange={handleInputChange}
            aria-label="Search articles"
            className={cn(
              "w-full pl-8 pr-3 py-2 text-sm rounded-md",
              "bg-rail-bg border border-border text-text-primary placeholder:text-text-secondary",
              "focus:outline-none focus:ring-1 focus:ring-accent focus-visible:ring-2 focus-visible:ring-accent transition-colors"
            )}
          />
          {loading && (
            <Loader2
              size={16}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-secondary animate-spin"
              aria-label="Searching"
            />
          )}
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        {error && (
          <p className="px-4 py-6 text-sm text-red-400" role="alert">
            {error}
          </p>
        )}

        {!error && hasSearched && results.length === 0 && (
          <p className="px-4 py-6 text-sm text-text-secondary">
            No results found
          </p>
        )}

        {results.map((result) => (
          <button
            key={result.filename}
            type="button"
            onClick={() => handleResultClick(result.filename)}
            className={cn(
              "block w-full text-left px-4 py-2.5 transition-colors cursor-pointer",
              "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
            )}
          >
            <span className="flex items-center gap-2">
              <span className="text-sm font-medium truncate text-text-primary">
                {result.title}
              </span>
              {result.isTagResult && (
                <span className="shrink-0 text-xs px-1.5 py-0.5 rounded bg-accent/20 text-accent">
                  tag
                </span>
              )}
            </span>
            <span className="block text-xs mt-0.5 truncate">
              {result.excerpt.length > 120
                ? result.excerpt.slice(0, 120) + "…"
                : result.excerpt}
            </span>
            {result.snippets.length > 0 && (
              <div className="mt-1 space-y-0.5">
                {result.snippets.slice(0, 2).map((snippet, i) => (
                  <span
                    key={i}
                    className="block text-xs text-text-secondary/70 truncate"
                    dangerouslySetInnerHTML={{ __html: snippet }}
                  />
                ))}
              </div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { SearchResult, ArticleMeta } from '../../shared/types';
import { useNavigation } from './AppShell';

// ── Debounce helper ────────────────────────────────────────────

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

// ── Types for unified result display ───────────────────────────

interface DisplayResult {
  title: string;
  excerpt: string;
  snippets: string[];
  isTagResult: boolean;
}

// ── SearchPanel ────────────────────────────────────────────────

const SearchPanel: React.FC = () => {
  const { editArticle } = useNavigation();

  const [query, setQuery] = useState('');
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
        if (trimmed.startsWith('#')) {
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
          setError(err instanceof Error ? err.message : 'Search failed');
          setResults([]);
          setHasSearched(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    executeSearch();
    return () => { cancelled = true; };
  }, [debouncedQuery]);

  const handleResultClick = useCallback(
    (title: string) => {
      editArticle(title);
    },
    [editArticle]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setQuery(e.target.value);
    },
    []
  );

  return (
    <div className="search-panel">
      <div className="search-panel__header">
        <input
          ref={inputRef}
          className="search-panel__input"
          type="text"
          placeholder="Search articles… (use # for tag search)"
          value={query}
          onChange={handleInputChange}
          aria-label="Search articles"
        />
        {loading && <span className="search-panel__spinner" aria-label="Searching">⏳</span>}
      </div>

      <div className="search-panel__results">
        {error && (
          <div className="search-panel__error" role="alert">{error}</div>
        )}

        {!error && hasSearched && results.length === 0 && (
          <div className="search-panel__empty">No articles found</div>
        )}

        {results.map((result) => (
          <button
            key={result.title}
            className="search-panel__result"
            onClick={() => handleResultClick(result.title)}
          >
            <span className="search-panel__result-title">{result.title}</span>
            {result.isTagResult && (
              <span className="search-panel__result-badge">tag</span>
            )}
            <span className="search-panel__result-excerpt">
              {result.excerpt.length > 200
                ? result.excerpt.slice(0, 200) + '…'
                : result.excerpt}
            </span>
            {result.snippets.length > 0 && (
              <div className="search-panel__result-snippets">
                {result.snippets.map((snippet, i) => (
                  <span
                    key={i}
                    className="search-panel__result-snippet"
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
};

export default SearchPanel;

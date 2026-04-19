/**
 * page-find-controller.ts
 *
 * A tiny pub-sub registry that lets the active page (article preview or the
 * markdown editor) register a "find backend" so the global FindBar can drive
 * it without prop drilling. Each backend exposes a uniform search/navigate
 * interface; the FindBar is intentionally agnostic about whether matches live
 * in the DOM or in a CodeMirror document.
 */

export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface FindResult {
  /** Total number of matches in the current backend. */
  total: number;
  /** 1-based index of the currently active match (0 if none). */
  current: number;
}

export interface FindBackend {
  /**
   * Apply a query and return a result snapshot. Highlighting all matches and
   * scrolling the active one into view is the backend's responsibility.
   */
  search(query: string, opts: FindOptions): FindResult;
  /** Move to the next match (wraps). Returns the new result snapshot. */
  next(): FindResult;
  /** Move to the previous match (wraps). Returns the new result snapshot. */
  prev(): FindResult;
  /** Clear all highlights and reset internal state. */
  clear(): void;
}

type Listener = (backend: FindBackend | null) => void;

let activeBackend: FindBackend | null = null;
const listeners = new Set<Listener>();

export function registerFindBackend(backend: FindBackend): () => void {
  activeBackend = backend;
  for (const l of listeners) l(backend);
  return () => {
    if (activeBackend === backend) {
      activeBackend = null;
      for (const l of listeners) l(null);
    }
  };
}

export function getActiveFindBackend(): FindBackend | null {
  return activeBackend;
}

export function subscribeFindBackend(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* ── helpers shared by backends ─────────────────────────────────────────── */

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildQueryRegex(query: string, opts: FindOptions): RegExp | null {
  if (!query) return null;
  let pattern = escapeRegExp(query);
  if (opts.wholeWord) pattern = `\\b${pattern}\\b`;
  const flags = opts.caseSensitive ? "g" : "gi";
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

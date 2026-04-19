import { useEffect } from "react";
import { EditorView, Decoration, type DecorationSet } from "@codemirror/view";
import { StateField, StateEffect, EditorSelection } from "@codemirror/state";
import { SearchCursor } from "@codemirror/search";
import {
  registerFindBackend,
  type FindBackend,
  type FindOptions,
  type FindResult,
} from "./page-find-controller";

interface MatchRange {
  from: number;
  to: number;
}

interface FindState {
  matches: MatchRange[];
  active: number; // -1 if none
}

const setFindState = StateEffect.define<FindState>();

const matchDeco = Decoration.mark({ class: "lumina-find-hl" });
const activeDeco = Decoration.mark({ class: "lumina-find-hl lumina-find-hl--active" });

const findField = StateField.define<FindState>({
  create() {
    return { matches: [], active: -1 };
  },
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setFindState)) next = e.value;
    }
    // Document edits invalidate stored ranges; clear so the user re-runs find.
    if (tr.docChanged && next === value && value.matches.length > 0) {
      next = { matches: [], active: -1 };
    }
    return next;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (state): DecorationSet => {
      if (state.matches.length === 0) return Decoration.none;
      const builder: Array<{ from: number; to: number; deco: Decoration }> = state.matches.map(
        (m, i) => ({ from: m.from, to: m.to, deco: i === state.active ? activeDeco : matchDeco }),
      );
      builder.sort((a, b) => a.from - b.from || a.to - b.to);
      return Decoration.set(builder.map((b) => b.deco.range(b.from, b.to)));
    }),
});

function findAll(view: EditorView, query: string, opts: FindOptions): MatchRange[] {
  const matches: MatchRange[] = [];
  if (!query) return matches;
  const doc = view.state.doc;
  const normalize = opts.caseSensitive ? undefined : (s: string) => s.toLowerCase();
  const cursor = new SearchCursor(doc, query, 0, doc.length, normalize);
  while (!cursor.next().done) {
    const { from, to } = cursor.value;
    if (opts.wholeWord) {
      const before = from > 0 ? doc.sliceString(from - 1, from) : "";
      const after = to < doc.length ? doc.sliceString(to, to + 1) : "";
      if (/\w/.test(before) || /\w/.test(after)) continue;
    }
    matches.push({ from, to });
  }
  return matches;
}

/**
 * Register a CodeMirror-based find backend tied to `viewRef.current`.
 *
 * `version` causes a re-register whenever the active editor changes (e.g. the
 * user opened a different file). The backend installs a StateField on first
 * use to render highlight decorations.
 */
export function useCodeMirrorFindBackend(
  viewRef: React.MutableRefObject<EditorView | null>,
  enabled: boolean,
  version: unknown,
): void {
  useEffect(() => {
    if (!enabled) return;
    const view = viewRef.current;
    if (!view) return;

    // Lazily install the StateField on first use; harmless if re-installed.
    if (!view.state.field(findField, false)) {
      view.dispatch({ effects: StateEffect.appendConfig.of(findField) });
    }

    let matches: MatchRange[] = [];
    let active = -1;

    const dispatch = (): void => {
      if (!viewRef.current) return;
      viewRef.current.dispatch({ effects: setFindState.of({ matches, active }) });
      if (active >= 0 && matches[active]) {
        const range = matches[active];
        viewRef.current.dispatch({
          selection: EditorSelection.single(range.from, range.to),
          effects: EditorView.scrollIntoView(range.from, { y: "center" }),
        });
      }
    };

    const snapshot = (): FindResult => ({
      total: matches.length,
      current: active >= 0 ? active + 1 : 0,
    });

    const move = (delta: number): FindResult => {
      if (matches.length === 0) return snapshot();
      active = ((active + delta) % matches.length + matches.length) % matches.length;
      dispatch();
      return snapshot();
    };

    const backend: FindBackend = {
      search(query, opts) {
        const v = viewRef.current;
        if (!v) {
          matches = [];
          active = -1;
          return snapshot();
        }
        matches = findAll(v, query, opts);
        active = matches.length > 0 ? 0 : -1;
        dispatch();
        return snapshot();
      },
      next: () => move(1),
      prev: () => move(-1),
      clear() {
        matches = [];
        active = -1;
        dispatch();
      },
    };

    const unregister = registerFindBackend(backend);
    return () => {
      backend.clear();
      unregister();
    };
  }, [enabled, viewRef, version]);
}

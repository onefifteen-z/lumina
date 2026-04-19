import { useEffect } from "react";
import {
  buildQueryRegex,
  registerFindBackend,
  type FindBackend,
  type FindOptions,
  type FindResult,
} from "./page-find-controller";

const HL_CLASS = "lumina-find-hl";
const HL_ACTIVE_CLASS = "lumina-find-hl--active";

interface MatchSpan {
  el: HTMLSpanElement;
}

/** Walk the visible text inside `root` and yield every TextNode that's not
 *  inside a script/style or already wrapped by a previous highlight pass. */
function* walkTextNodes(root: HTMLElement): Generator<Text> {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      // Skip nodes inside our own highlight wrappers — they get cleared first
      // anyway, but be defensive.
      if (parent.classList.contains(HL_CLASS)) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
        return NodeFilter.FILTER_REJECT;
      }
      // Skip empty/whitespace-only nodes.
      if (!node.textContent || !node.textContent.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n: Node | null;
  while ((n = walker.nextNode())) {
    yield n as Text;
  }
}

/** Remove all highlight wrappers and merge their text back into the parents. */
function clearHighlights(root: HTMLElement): void {
  const wrappers = root.querySelectorAll<HTMLSpanElement>(`.${HL_CLASS}`);
  wrappers.forEach((w) => {
    const parent = w.parentNode;
    if (!parent) return;
    while (w.firstChild) parent.insertBefore(w.firstChild, w);
    parent.removeChild(w);
  });
  // Coalesce adjacent text nodes so future searches see contiguous strings.
  root.normalize();
}

/** Wrap every regex match inside the live DOM and return the wrappers. */
function highlightAll(root: HTMLElement, re: RegExp): MatchSpan[] {
  const matches: MatchSpan[] = [];
  // Snapshot first; we'll mutate the DOM as we go.
  const textNodes: Text[] = Array.from(walkTextNodes(root));
  for (const tn of textNodes) {
    const text = tn.nodeValue ?? "";
    if (!text) continue;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let lastIndex = 0;
    const pieces: Array<{ text: string; isMatch: boolean }> = [];
    while ((m = re.exec(text)) !== null) {
      if (m.index > lastIndex) pieces.push({ text: text.slice(lastIndex, m.index), isMatch: false });
      pieces.push({ text: m[0], isMatch: true });
      lastIndex = m.index + m[0].length;
      // Defensive: zero-width matches would loop forever.
      if (m[0].length === 0) re.lastIndex++;
    }
    if (lastIndex === 0) continue; // no matches in this node
    if (lastIndex < text.length) pieces.push({ text: text.slice(lastIndex), isMatch: false });

    const frag = document.createDocumentFragment();
    for (const p of pieces) {
      if (p.isMatch) {
        const span = document.createElement("span");
        span.className = HL_CLASS;
        span.textContent = p.text;
        matches.push({ el: span });
        frag.appendChild(span);
      } else {
        frag.appendChild(document.createTextNode(p.text));
      }
    }
    tn.parentNode?.replaceChild(frag, tn);
  }
  return matches;
}

/**
 * Register a DOM-based find backend rooted at the element returned by
 * `getRoot`. Lifetime is tied to the React component's mount cycle.
 *
 * The backend re-binds whenever `enabled`, `getRoot()`, or `version` changes,
 * which lets callers re-register after switching files (so the new article's
 * DOM becomes the active search scope).
 */
export function useDomFindBackend(
  getRoot: () => HTMLElement | null,
  enabled: boolean,
  version: unknown,
): void {
  useEffect(() => {
    if (!enabled) return;
    const root = getRoot();
    if (!root) return;

    let matches: MatchSpan[] = [];
    let activeIdx = -1;

    const setActive = (idx: number): void => {
      if (matches.length === 0) {
        activeIdx = -1;
        return;
      }
      const wrapped = ((idx % matches.length) + matches.length) % matches.length;
      if (activeIdx >= 0 && matches[activeIdx]) {
        matches[activeIdx].el.classList.remove(HL_ACTIVE_CLASS);
      }
      activeIdx = wrapped;
      const el = matches[activeIdx].el;
      el.classList.add(HL_ACTIVE_CLASS);
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    };

    const snapshot = (): FindResult => ({
      total: matches.length,
      current: activeIdx >= 0 ? activeIdx + 1 : 0,
    });

    const backend: FindBackend = {
      search(query: string, opts: FindOptions): FindResult {
        clearHighlights(root);
        matches = [];
        activeIdx = -1;
        const re = buildQueryRegex(query, opts);
        if (!re) return snapshot();
        matches = highlightAll(root, re);
        if (matches.length > 0) setActive(0);
        return snapshot();
      },
      next(): FindResult {
        if (matches.length === 0) return snapshot();
        setActive(activeIdx + 1);
        return snapshot();
      },
      prev(): FindResult {
        if (matches.length === 0) return snapshot();
        setActive(activeIdx - 1);
        return snapshot();
      },
      clear(): void {
        clearHighlights(root);
        matches = [];
        activeIdx = -1;
      },
    };

    const unregister = registerFindBackend(backend);
    return () => {
      backend.clear();
      unregister();
    };
  }, [enabled, getRoot, version]);
}

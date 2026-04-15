import {
  autocompletion,
  CompletionContext,
  type CompletionResult,
  type Completion,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";

/**
 * CodeMirror 6 autocompletion source that triggers after `[[` is typed.
 * Fetches article titles via `window.api.listArticles()` and offers them
 * as completions. Selecting a completion inserts the title followed by `]]`.
 */
async function wikilinkCompletionSource(
  context: CompletionContext,
): Promise<CompletionResult | null> {
  // Match `[[` followed by any non-] characters (the partial title typed so far)
  const match = context.matchBefore(/\[\[[^\]]*/);
  if (!match) return null;

  // The text after `[[` is the filter query
  const query = match.text.slice(2).toLowerCase();

  let articles: { title: string }[];
  try {
    articles = await window.api.listArticles();
  } catch {
    return null;
  }

  const options: Completion[] = articles
    .filter((a) => a.title.toLowerCase().includes(query))
    .map((a) => ({
      label: a.title,
      apply: (view, completion, from, to) => {
        // Replace from the start of `[[` match to cursor with `[[Title]]`
        view.dispatch({
          changes: { from: match.from, to, insert: `[[${completion.label}]]` },
        });
      },
    }));

  return {
    from: match.from + 2, // position after `[[`
    options,
    filter: false, // we already filtered above
  };
}

/**
 * Returns a CodeMirror 6 extension that provides wikilink autocomplete.
 * When the user types `[[`, a popup appears with matching article titles.
 */
export function wikilinkAutocomplete(): Extension {
  return autocompletion({
    override: [wikilinkCompletionSource],
    activateOnTyping: true,
  });
}

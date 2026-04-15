import * as React from "react";
import { Plus, Sparkles } from "lucide-react";
import type { ArticleMeta } from "../../shared/types";
import { cn } from "../lib/utils";

export interface FilesViewProps {
  articles: ArticleMeta[];
  selectedFilename: string | null;
  loading: boolean;
  error: string | null;
  onSelectArticle: (filename: string) => void;
  onNewArticle: () => void;
  onGenerateArticle: () => void;
}

export function FilesView({
  articles,
  selectedFilename,
  loading,
  error,
  onSelectArticle,
  onNewArticle,
  onGenerateArticle,
}: FilesViewProps) {
  const sortedArticles = React.useMemo(
    () =>
      [...articles].sort(
        (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime()
      ),
    [articles]
  );

  return (
    <div className="flex flex-col h-full">
      {/* Heading */}
      <div className="px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">
          Files
        </h2>
      </div>

      {/* Action buttons */}
      <div className="flex flex-col gap-2 px-3 py-3">
        <button
          type="button"
          onClick={onNewArticle}
          className={cn(
            "flex items-center justify-center gap-2 w-full px-3 py-2 text-sm font-medium rounded-md cursor-pointer",
            "bg-accent text-white hover:bg-accent-hover transition-colors",
            "focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          )}
        >
          <Plus size={16} />
          New Article
        </button>
        <button
          type="button"
          onClick={onGenerateArticle}
          className={cn(
            "flex items-center justify-center gap-2 w-full px-3 py-2 text-sm font-medium rounded-md cursor-pointer",
            "border border-accent text-accent hover:bg-accent hover:text-white transition-colors",
            "focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          )}
        >
          <Sparkles size={16} />
          Generate with AI
        </button>
      </div>

      {/* Article list */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <p className="px-4 py-6 text-sm text-text-secondary">Loading articles…</p>
        )}

        {!loading && error && (
          <p className="px-4 py-6 text-sm text-red-400">{error}</p>
        )}

        {!loading && !error && sortedArticles.length === 0 && (
          <p className="px-4 py-6 text-sm text-text-secondary">No articles yet</p>
        )}

        {!loading &&
          !error &&
          sortedArticles.map((article) => {
            const isSelected = article.filename === selectedFilename;
            return (
              <button
                key={article.filename}
                type="button"
                onClick={() => onSelectArticle(article.filename)}
                className={cn(
                  "block w-full text-left px-4 py-2.5 text-sm truncate transition-colors",
                  "focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none",
                  isSelected
                    ? "bg-surface-active text-text-primary"
                    : "text-text-secondary hover:bg-surface-hover hover:text-text-primary cursor-pointer"
                )}
              >
                {article.title}
              </button>
            );
          })}
      </div>
    </div>
  );
}

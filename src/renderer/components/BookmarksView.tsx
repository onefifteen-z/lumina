import * as React from "react";
import { useMemo } from "react";
import { Bookmark, X } from "lucide-react";
import type { ArticleMeta } from "../../shared/types";
import { cn } from "../lib/utils";

export interface BookmarksViewProps {
  articles: ArticleMeta[];
  bookmarkedFilenames: string[];
  selectedFilename: string | null;
  onOpenBookmark: (filename: string) => void;
  onRemoveBookmark: (filename: string) => void;
}

export function BookmarksView({
  articles,
  bookmarkedFilenames,
  selectedFilename,
  onOpenBookmark,
  onRemoveBookmark,
}: BookmarksViewProps) {
  const metaByFilename = useMemo(
    () => new Map(articles.map((a) => [a.filename, a])),
    [articles],
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto py-1">
        {bookmarkedFilenames.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-text-secondary">
            <Bookmark size={32} className="opacity-40" />
            <p className="text-sm text-center">No bookmarks yet. Use the toolbar icon when viewing an article.</p>
          </div>
        ) : (
          bookmarkedFilenames.map((filename) => {
            const meta = metaByFilename.get(filename);
            const label = meta?.title ?? filename;
            const isStale = !meta;
            const isSelected = filename === selectedFilename;
            return (
              <div
                key={filename}
                className={cn(
                  "group flex items-stretch gap-0 border-b border-border/40 last:border-b-0",
                  isSelected && "bg-primary-bg",
                )}
              >
                <button
                  type="button"
                  title={isStale ? `${filename} (missing file)` : filename}
                  onClick={() => onOpenBookmark(filename)}
                  className={cn(
                    "flex-1 min-w-0 text-left px-4 py-2 transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-border focus-visible:ring-inset",
                    isSelected
                      ? "text-text-primary"
                      : "text-text-secondary hover:bg-surface-hover hover:text-text-primary cursor-pointer",
                  )}
                >
                  <span className={cn("block truncate text-[12.5px]", isSelected ? "font-semibold" : "font-medium")}>
                    {(filename.split("/").pop() ?? filename).replace(/\.md$/i, "")}
                  </span>
                  {isStale ? (
                    <span className="block truncate text-[11px] text-amber-600/90 dark:text-amber-400/90 leading-tight mt-px">
                      File not in vault — remove if obsolete
                    </span>
                  ) : filename.includes("/") ? (
                    <span className="block truncate text-[11px] text-text-secondary/60 leading-tight mt-px">
                      {filename.substring(0, filename.lastIndexOf("/"))}
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  aria-label={`Remove bookmark ${label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveBookmark(filename);
                  }}
                  className={cn(
                    "shrink-0 px-2.5 text-text-secondary hover:text-text-primary hover:bg-surface-hover",
                    "opacity-70 group-hover:opacity-100 transition-opacity cursor-pointer",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-border",
                  )}
                >
                  <X size={14} className="mx-auto" />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

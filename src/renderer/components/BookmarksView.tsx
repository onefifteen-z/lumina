import { Bookmark } from "lucide-react";

export function BookmarksView() {
  return (
    <div className="flex flex-col h-full">
      {/* Heading — matches FilesView heading style */}
      <div className="px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">
          Bookmarks
        </h2>
      </div>

      {/* Placeholder */}
      <div className="flex-1 flex flex-col items-center justify-center gap-3 px-4 text-text-secondary">
        <Bookmark size={32} className="opacity-40" />
        <p className="text-sm">Bookmarks coming soon</p>
      </div>
    </div>
  );
}

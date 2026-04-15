import * as React from "react";
import { Files, Search, Bookmark, Settings } from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "./ui/tooltip";
import { cn } from "../lib/utils";

export type SidebarView = "files" | "search" | "bookmarks" | "settings";

export interface IconRailProps {
  activeView: SidebarView;
  onViewChange: (view: SidebarView) => void;
  isSidebarOpen: boolean;
}

const topItems: { view: SidebarView; icon: React.ElementType; label: string }[] = [
  { view: "files", icon: Files, label: "Files" },
  { view: "search", icon: Search, label: "Search" },
  { view: "bookmarks", icon: Bookmark, label: "Bookmarks" },
];

const bottomItems: { view: SidebarView; icon: React.ElementType; label: string }[] = [
  { view: "settings", icon: Settings, label: "Settings" },
];

const allItems = [...topItems, ...bottomItems];

export function IconRail({ activeView, onViewChange, isSidebarOpen }: IconRailProps) {
  const buttonRefs = React.useRef<(HTMLButtonElement | null)[]>([]);

  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    let nextIndex: number | null = null;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      nextIndex = (index + 1) % allItems.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      nextIndex = (index - 1 + allItems.length) % allItems.length;
    }

    if (nextIndex !== null) {
      buttonRefs.current[nextIndex]?.focus();
    }
  };

  const renderButton = (
    item: { view: SidebarView; icon: React.ElementType; label: string },
    index: number
  ) => {
    const Icon = item.icon;
    const isActive = activeView === item.view;

    return (
      <Tooltip key={item.view}>
        <TooltipTrigger asChild>
          <button
            ref={(el) => { buttonRefs.current[index] = el; }}
            type="button"
            role="tab"
            aria-label={item.label}
            aria-selected={isActive}
            tabIndex={0}
            className={cn(
              "flex items-center justify-center w-10 h-10 rounded-md transition-colors cursor-pointer",
              "focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none",
              isActive
                ? "bg-accent text-white"
                : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
            )}
            onClick={() => onViewChange(item.view)}
            onKeyDown={(e) => handleKeyDown(e, index)}
          >
            <Icon size={20} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{item.label}</TooltipContent>
      </Tooltip>
    );
  };

  return (
    <nav
      role="toolbar"
      aria-label="Navigation"
      aria-orientation="vertical"
      className="flex flex-col items-center w-12 bg-rail-bg border-r border-border py-2 gap-1 shrink-0"
    >
      {/* Top group: Files, Search, Bookmarks */}
      <div className="flex flex-col items-center gap-1">
        {topItems.map((item, i) => renderButton(item, i))}
      </div>

      {/* Bottom group: Settings pushed to bottom */}
      <div className="flex flex-col items-center gap-1 mt-auto">
        {bottomItems.map((item, i) =>
          renderButton(item, topItems.length + i)
        )}
      </div>
    </nav>
  );
}

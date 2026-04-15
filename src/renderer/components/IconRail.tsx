import * as React from "react";
import { Files, Search, Bookmark, Settings, Sun, Moon, Network } from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "./ui/tooltip";
import { cn } from "../lib/utils";

export type SidebarView = "files" | "search" | "bookmarks" | "graph" | "settings";

export interface IconRailProps {
  activeView: SidebarView;
  onViewChange: (view: SidebarView) => void;
  isSidebarOpen: boolean;
  currentTheme: "light" | "dark" | "system";
  onToggleTheme: () => void;
}

const topItems: { view: SidebarView; icon: React.ElementType; label: string }[] = [
  { view: "files", icon: Files, label: "Files" },
  { view: "search", icon: Search, label: "Search" },
  { view: "bookmarks", icon: Bookmark, label: "Bookmarks" },
  { view: "graph", icon: Network, label: "Graph" },
];

const bottomItems: { view: SidebarView; icon: React.ElementType; label: string }[] = [
  { view: "settings", icon: Settings, label: "Settings" },
];

const allItems = [...topItems, ...bottomItems];

export function IconRail({ activeView, onViewChange, isSidebarOpen, currentTheme, onToggleTheme }: IconRailProps) {
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
              "flex items-center justify-center w-8 h-8 rounded-md transition-colors cursor-pointer",
              "focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none",
              isActive
                ? "bg-accent text-white"
                : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
            )}
            onClick={() => onViewChange(item.view)}
            onKeyDown={(e) => handleKeyDown(e, index)}
          >
            <Icon size={18} />
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
      style={{ paddingTop: "16px", paddingBottom: "48px" }}
      className="relative flex flex-col items-center w-11 bg-rail-bg border-r border-border gap-1 shrink-0"
    >
      {/* Top group: Files, Search, Bookmarks */}
      <div className="flex flex-col items-center gap-1">
        {topItems.map((item, i) => renderButton(item, i))}
      </div>

      {/* Settings pushed to bottom */}
      <div className="flex flex-col items-center gap-1 mt-auto">
        {bottomItems.map((item, i) =>
          renderButton(item, topItems.length + i)
        )}
      </div>

      {/* Theme toggle — absolutely pinned to bottom-left corner */}
      <div className="absolute bottom-2 left-0 right-0 flex justify-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={currentTheme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              className="flex items-center justify-center w-8 h-8 rounded-md transition-colors cursor-pointer text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
              onClick={onToggleTheme}
            >
              {currentTheme === "dark" ? <Moon size={18} /> : <Sun size={18} />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {currentTheme === "dark" ? "Light mode" : "Dark mode"}
          </TooltipContent>
        </Tooltip>
      </div>
    </nav>
  );
}

import * as React from "react";
import { Files, Search, Bookmark, MessageSquare, Settings, Sun, Moon, Network, FileCode } from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "./ui/tooltip";
import { cn } from "../lib/utils";

import type { ArticleMeta } from "../../shared/types";

export type SidebarView = "files" | "search" | "bookmarks" | "chat" | "graph" | "settings";

export interface IconRailProps {
  activeView: SidebarView;
  onViewChange: (view: SidebarView) => void;
  isSidebarOpen: boolean;
  currentTheme: "light" | "dark" | "system";
  onToggleTheme: () => void;
  configFiles?: ArticleMeta[];
  onSelectConfigFile?: (filename: string) => void;
  hasClaudeMd?: boolean;
}


const topItems: { view: SidebarView; icon: React.ElementType; label: string }[] = [
  { view: "files", icon: Files, label: "Files" },
  { view: "chat", icon: MessageSquare, label: "Chat" },
  { view: "search", icon: Search, label: "Search" },
  { view: "bookmarks", icon: Bookmark, label: "Bookmarks" },
  { view: "graph", icon: Network, label: "Graph" },
];

const bottomItems: { view: SidebarView; icon: React.ElementType; label: string }[] = [
  { view: "settings", icon: Settings, label: "Settings" },
];

const allItems = [...topItems, ...bottomItems];

export function IconRail({ activeView, onViewChange, isSidebarOpen, currentTheme, onToggleTheme, configFiles, onSelectConfigFile, hasClaudeMd = true }: IconRailProps) {
  const visibleTopItems = hasClaudeMd ? topItems : topItems.filter((i) => i.view !== "chat");
  const allVisibleItems = [...visibleTopItems, ...bottomItems];
  const buttonRefs = React.useRef<(HTMLButtonElement | null)[]>([]);

  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    let nextIndex: number | null = null;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      nextIndex = (index + 1) % allVisibleItems.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      nextIndex = (index - 1 + allVisibleItems.length) % allVisibleItems.length;
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
              "focus-visible:ring-2 focus-visible:ring-primary-border focus-visible:outline-none",
              isActive
                ? "bg-primary text-white"
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
      style={{ paddingTop: "6px", paddingBottom: "48px" }}
      className="relative flex flex-col items-center w-11 bg-rail-bg border-r border-border gap-1 shrink-0"
    >
      {/* Top group */}
      <div className="flex flex-col items-center gap-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        {visibleTopItems.map((item, i) => renderButton(item, i))}
      </div>

      {/* Config button + Settings pushed to bottom */}
      <div className="flex flex-col items-center gap-1 mt-auto" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        {configFiles && configFiles.length > 0 && onSelectConfigFile && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Open CLAUDE.md"
                onClick={() => onSelectConfigFile(configFiles[0].filename)}
                className="flex items-center justify-center w-8 h-8 rounded-md transition-colors cursor-pointer text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-primary-border focus-visible:outline-none"
              >
                <FileCode size={18} aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">CLAUDE.md</TooltipContent>
          </Tooltip>
        )}
        {bottomItems.map((item, i) =>
          renderButton(item, visibleTopItems.length + i)
        )}
      </div>

      {/* Theme toggle — absolutely pinned to bottom-left corner */}
      <div className="absolute bottom-2 left-0 right-0 flex justify-center" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={currentTheme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              className="flex items-center justify-center w-8 h-8 rounded-md transition-colors cursor-pointer text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-primary-border focus-visible:outline-none"
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

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
  /**
   * Invoked when the user clicks the CLAUDE.md slot but no CLAUDE.md file
   * exists yet in the vault. Lets the host open the editor pre-filled with
   * the bundled template (saving creates the file; cancelling is a no-op).
   */
  onCreateClaudeMdFromTemplate?: () => void;
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

export function IconRail({ activeView, onViewChange, isSidebarOpen, currentTheme, onToggleTheme, configFiles, onSelectConfigFile, hasClaudeMd = true, onCreateClaudeMdFromTemplate }: IconRailProps) {
  const visibleTopItems = hasClaudeMd ? topItems : topItems.filter((i) => i.view !== "chat");
  // The CLAUDE.md slot is always visible. When the vault has no CLAUDE.md we
  // surface a muted appearance so the user can tell the file doesn't exist
  // yet, but the button is still actionable: clicking it opens an editor
  // pre-seeded with the bundled template.
  const claudeFile = configFiles?.[0];
  const claudeButtonVisible = Boolean(
    (claudeFile && onSelectConfigFile) || onCreateClaudeMdFromTemplate,
  );
  const claudeButtonEnabled = Boolean(claudeFile || onCreateClaudeMdFromTemplate);
  const handleClaudeClick = (): void => {
    if (claudeFile && onSelectConfigFile) {
      onSelectConfigFile(claudeFile.filename);
    } else {
      onCreateClaudeMdFromTemplate?.();
    }
  };
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
        {claudeButtonVisible && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={claudeFile ? "Open CLAUDE.md" : "Create CLAUDE.md from template"}
                disabled={!claudeButtonEnabled}
                onClick={handleClaudeClick}
                className={cn(
                  "flex items-center justify-center w-8 h-8 rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-primary-border focus-visible:outline-none",
                  claudeButtonEnabled
                    ? "cursor-pointer text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                    : "cursor-not-allowed text-text-tertiary opacity-50",
                  // Muted state when CLAUDE.md doesn't exist yet — keeps the
                  // slot visually distinct from "open existing file" without
                  // hiding the affordance.
                  !claudeFile && claudeButtonEnabled && "text-text-tertiary hover:text-text-secondary"
                )}
              >
                <FileCode size={18} aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {claudeFile ? "CLAUDE.md" : "CLAUDE.md (not in vault — click to create)"}
            </TooltipContent>
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

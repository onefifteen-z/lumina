import * as React from "react";
import { Files, Search, Bookmark, MessageSquare, Settings, Sun, Moon, Network } from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "./ui/tooltip";
import { cn } from "../lib/utils";

export type SidebarView = "files" | "search" | "bookmarks" | "chat" | "graph" | "settings";

export interface IconRailProps {
  activeView: SidebarView;
  onViewChange: (view: SidebarView) => void;
  isSidebarOpen: boolean;
  currentTheme: "light" | "dark" | "system";
  onToggleTheme: () => void;
}

// ── Custom traffic light buttons ───────────────────────────────

const TrafficLights: React.FC = () => {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "8px",
        padding: "16px 0 8px",
        width: "100%",
        WebkitAppRegion: "no-drag",
        flexShrink: 0,
      } as React.CSSProperties}
    >
      {/* Close — red */}
      <button
        type="button"
        aria-label="Close"
        onClick={() => window.api.windowClose()}
        style={{
          width: 12, height: 12, borderRadius: "50%",
          background: "#ff5f57", border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 8, fontWeight: "bold", color: "transparent",
          transition: "color 0.1s",
        }}
        onMouseEnter={e => (e.currentTarget.style.color = "#4d0000")}
        onMouseLeave={e => (e.currentTarget.style.color = "transparent")}
      >
        ✕
      </button>
      {/* Minimize — yellow */}
      <button
        type="button"
        aria-label="Minimize"
        onClick={() => window.api.windowMinimize()}
        style={{
          width: 12, height: 12, borderRadius: "50%",
          background: "#febc2e", border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 8, fontWeight: "bold", color: "transparent",
          transition: "color 0.1s",
        }}
        onMouseEnter={e => (e.currentTarget.style.color = "#5a3700")}
        onMouseLeave={e => (e.currentTarget.style.color = "transparent")}
      >
        −
      </button>
      {/* Maximize — green */}
      <button
        type="button"
        aria-label="Maximize"
        onClick={() => window.api.windowMaximize()}
        style={{
          width: 12, height: 12, borderRadius: "50%",
          background: "#28c840", border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 8, fontWeight: "bold", color: "transparent",
          transition: "color 0.1s",
        }}
        onMouseEnter={e => (e.currentTarget.style.color = "#003300")}
        onMouseLeave={e => (e.currentTarget.style.color = "transparent")}
      >
        +
      </button>
    </div>
  );
};

// ── Nav items ──────────────────────────────────────────────────

const topItems: { view: SidebarView; icon: React.ElementType; label: string }[] = [
  { view: "files", icon: Files, label: "Files" },
  { view: "search", icon: Search, label: "Search" },
  { view: "bookmarks", icon: Bookmark, label: "Bookmarks" },
  { view: "chat", icon: MessageSquare, label: "Chat" },
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
      style={{ paddingTop: "0px", paddingBottom: "48px" }}
      className="relative flex flex-col items-center w-11 bg-rail-bg border-r border-border gap-1 shrink-0"
    >
      {/* Custom traffic light buttons */}
      <TrafficLights />

      {/* Top group: Files, Search, Bookmarks */}
      <div className="flex flex-col items-center gap-1 mt-3" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        {topItems.map((item, i) => renderButton(item, i))}
      </div>

      {/* Settings pushed to bottom */}
      <div className="flex flex-col items-center gap-1 mt-auto" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        {bottomItems.map((item, i) =>
          renderButton(item, topItems.length + i)
        )}
      </div>

      {/* Theme toggle — absolutely pinned to bottom-left corner */}
      <div className="absolute bottom-2 left-0 right-0 flex justify-center" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
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

import * as React from "react";
import { useState, useRef, useEffect, useCallback } from "react";
import { FileCode } from "lucide-react";
import type { ArticleMeta } from "../../shared/types";
import { cn } from "../lib/utils";

export interface ConfigMenuProps {
  configFiles: ArticleMeta[];
  onSelectFile: (filename: string) => void;
}

/** Strip leading dot from a basename for readability (e.g. ".CLAUDE.md" → "CLAUDE.md"). */
function displayName(filename: string): string {
  const basename = filename.split("/").pop() ?? filename;
  return basename.startsWith(".") ? basename.slice(1) : basename;
}

export function ConfigMenu({ configFiles, onSelectFile }: ConfigMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Close on Escape
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    },
    [],
  );

  const handleSelect = useCallback(
    (filename: string) => {
      onSelectFile(filename);
      setOpen(false);
    },
    [onSelectFile],
  );

  return (
    <div ref={menuRef} className="relative" onKeyDown={handleKeyDown}>
      {/* Trigger button */}
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Config files"
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          "flex items-center justify-center w-8 h-8 rounded-md transition-colors cursor-pointer",
          "focus-visible:ring-2 focus-visible:ring-primary-border focus-visible:outline-none",
          open
            ? "bg-primary text-white"
            : "text-text-secondary hover:bg-surface-hover hover:text-text-primary",
        )}
      >
        <FileCode size={18} aria-hidden="true" />
      </button>

      {/* Dropdown popover */}
      {open && (
        <div
          role="menu"
          className={cn(
            "absolute left-full top-0 ml-2 z-50",
            "min-w-[200px] max-w-[280px] max-h-[320px] overflow-y-auto",
            "rounded-md border border-border bg-sidebar-bg shadow-lg",
            "py-1",
          )}
        >
          {configFiles.length === 0 ? (
            <p className="px-3 py-4 text-xs text-text-secondary text-center">
              No configuration files found
            </p>
          ) : (
            configFiles.map((file) => (
              <button
                key={file.filename}
                type="button"
                role="menuitem"
                onClick={() => handleSelect(file.filename)}
                className={cn(
                  "block w-full text-left px-3 py-1.5 text-sm transition-colors cursor-pointer",
                  "text-text-secondary hover:bg-surface-hover hover:text-text-primary",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-border",
                )}
              >
                {displayName(file.filename)}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

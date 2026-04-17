import * as React from "react";
import { useState, useEffect, useRef, useCallback } from "react";
import { ChevronsUpDown, Check, Trash2, Plus } from "lucide-react";
import type { VaultEntry } from "../../shared/types";
import { cn } from "../lib/utils";

export interface VaultSwitcherProps {
  currentVaultPath: string;
  currentVaultName: string;
  onSwitched: (vaultPath: string, vaultName: string) => void;
}

export function VaultSwitcher({ currentVaultPath, currentVaultName, onSwitched }: VaultSwitcherProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [history, setHistory] = useState<VaultEntry[]>([]);
  const [switching, setSwitching] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const loadHistory = useCallback(async () => {
    const list = await window.api.getVaultHistory();
    setHistory(list);
  }, []);

  useEffect(() => {
    if (dropdownOpen) void loadHistory();
  }, [dropdownOpen, loadHistory]);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  const handleSwitch = useCallback(async (vaultPath: string, vaultName: string) => {
    if (vaultPath === currentVaultPath) { setDropdownOpen(false); return; }
    setDropdownOpen(false);
    setSwitching(true);
    try {
      await window.api.switchVault(vaultPath);
      onSwitched(vaultPath, vaultName);
    } finally {
      setSwitching(false);
    }
  }, [currentVaultPath, onSwitched]);

  const handleOpenVault = useCallback(async () => {
    setDropdownOpen(false);
    const selected = await window.api.selectVaultFolder();
    if (!selected) return;
    setSwitching(true);
    try {
      await window.api.switchVault(selected);
      const name = selected.split("/").filter(Boolean).pop() ?? selected;
      onSwitched(selected, name);
    } finally {
      setSwitching(false);
    }
  }, [onSwitched]);

  const handleRemove = useCallback(async (vaultPath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await window.api.removeVaultFromHistory(vaultPath);
    setHistory((prev) => prev.filter((v) => v.path !== vaultPath));
  }, []);

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger */}
      <button
        type="button"
        disabled={switching}
        onClick={() => setDropdownOpen((o) => !o)}
        style={{ padding: "10px 16px", gap: "10px" }}
        className={cn(
          "flex items-center w-full transition-colors cursor-pointer",
          "border-t border-border",
          "hover:bg-surface-hover",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-border",
          switching && "opacity-50 cursor-wait",
        )}
      >
        <ChevronsUpDown size={14} className="shrink-0 text-text-secondary" />
        <span className="flex-1 truncate text-left text-sm font-medium text-text-primary">
          {switching ? "Switching…" : currentVaultName}
        </span>
      </button>

      {/* Dropdown — opens upward */}
      {dropdownOpen && (
        <div
          className={cn(
            "absolute bottom-full left-0 right-0 mb-1 z-50",
            "rounded-md border border-border bg-sidebar-bg shadow-lg",
            "py-1 overflow-hidden",
          )}
        >
          {history.length === 0 ? (
            <p className="px-4 py-2 text-xs text-text-secondary">No other vaults</p>
          ) : (
            history.map((vault) => {
              const isCurrent = vault.path === currentVaultPath;
              return (
                <button
                  key={vault.path}
                  type="button"
                  onClick={() => handleSwitch(vault.path, vault.name)}
                  className={cn(
                    "flex items-center gap-2.5 w-full px-4 py-2.5 transition-colors cursor-pointer",
                    "focus-visible:outline-none",
                    isCurrent
                      ? "text-text-primary"
                      : "text-text-secondary hover:bg-surface-hover hover:text-text-primary",
                  )}
                >
                  <Check
                    size={13}
                    className={cn("shrink-0", isCurrent ? "opacity-100 text-accent" : "opacity-0")}
                  />
                  <span className="flex-1 truncate text-left text-sm">{vault.name}</span>
                  {!isCurrent && (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => handleRemove(vault.path, e)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleRemove(vault.path, e as unknown as React.MouseEvent); }}
                      className="p-0.5 rounded text-text-secondary hover:text-red-400 transition-colors"
                      aria-label={`Remove ${vault.name}`}
                    >
                      <Trash2 size={12} />
                    </span>
                  )}
                </button>
              );
            })
          )}

          <div className="my-1 border-t border-border" />
          <button
            type="button"
            onClick={handleOpenVault}
            className={cn(
              "flex items-center gap-2.5 w-full px-4 py-2.5 text-sm transition-colors cursor-pointer",
              "text-text-secondary hover:bg-surface-hover hover:text-text-primary",
              "focus-visible:outline-none",
            )}
          >
            <Plus size={13} className="shrink-0" />
            Open Vault…
          </button>
        </div>
      )}
    </div>
  );
}

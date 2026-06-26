import React, { useState, useEffect } from "react";
import { FileCode2 } from "lucide-react";
import type { VaultPromptDraftFilename } from "../../shared/vault-prompt-files";

export interface VaultPromptCreateDialogProps {
  kind: VaultPromptDraftFilename;
  open: boolean;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

const COPY: Record<
  VaultPromptDraftFilename,
  { title: string; description: string; ariaId: string }
> = {
  "CLAUDE.md": {
    title: "Create vault CLAUDE.md",
    ariaId: "lumina-vault-prompt-create-claude",
    description:
      "Chat is currently using Lumina's bundled CLAUDE.md template. Create a vault-specific copy so you can customize wiki structure, workflows, and lint conventions.",
  },
  "INGEST.md": {
    title: "Create vault INGEST.md",
    ariaId: "lumina-vault-prompt-create-ingest",
    description:
      "Ingest workflows currently use Lumina's bundled INGEST.md template. Create a vault-specific copy to customize the source extraction protocol and ingest_source tool contract.",
  },
};

export const VaultPromptCreateDialog: React.FC<VaultPromptCreateDialogProps> = ({
  kind,
  open,
  onConfirm,
  onCancel,
}) => {
  const [loading, setLoading] = useState(false);
  const copy = COPY[kind];

  useEffect(() => {
    if (!open || loading) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, loading, onCancel]);

  if (!open) return null;

  const handleConfirm = async () => {
    setLoading(true);
    try {
      await onConfirm();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 px-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !loading) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={copy.ariaId}
        className="w-full max-w-sm rounded-lg border border-border bg-sidebar-bg p-4 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary-bg">
            <FileCode2 size={18} className="text-text-primary" />
          </div>
          <h2 id={copy.ariaId} className="text-sm font-semibold text-text-primary">
            {copy.title}
          </h2>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-text-secondary">{copy.description}</p>
        <p className="mt-2 text-xs leading-relaxed text-text-secondary">
          The default template will open in the editor. Nothing is written to disk until you save.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="rounded-md border border-border bg-main-bg px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={loading}
            className="rounded-md border border-primary-border bg-accent/15 px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
          >
            {loading ? "Opening…" : "Create & edit"}
          </button>
        </div>
      </div>
    </div>
  );
};

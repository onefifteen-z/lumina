import React, { useState } from 'react';
import { FolderOpen } from 'lucide-react';

export interface VaultInitDialogProps {
  open: boolean;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

export const VaultInitDialog: React.FC<VaultInitDialogProps> = ({ open, onConfirm, onCancel }) => {
  const [loading, setLoading] = useState(false);

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
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" role="dialog" aria-modal="true">
      <div className="bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-border)] shadow-2xl p-6 max-w-sm w-full mx-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-primary-bg flex items-center justify-center">
            <FolderOpen size={20} className="text-primary" />
          </div>
          <h2 className="text-base font-semibold text-text-primary">Initialize Vault</h2>
        </div>
        <p className="text-sm text-text-secondary mb-1">
          This vault doesn't have a <code className="px-1 py-0.5 rounded bg-[rgba(255,255,255,0.08)] text-xs font-mono">claude.md</code> configuration file yet.
        </p>
        <p className="text-sm text-text-secondary mb-5">
          Create the following structure?
        </p>
        <div className="text-xs font-mono text-text-secondary bg-[rgba(255,255,255,0.04)] rounded-lg p-3 mb-5 space-y-0.5">
          <div>📄 claude.md</div>
          <div>📁 raw/</div>
          <div>📁 wiki/</div>
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 text-sm rounded-lg text-text-secondary hover:bg-surface-hover transition-colors cursor-pointer"
          >
            Skip
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={loading}
            className="px-4 py-2 text-sm rounded-lg bg-primary text-white hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50"
          >
            {loading ? 'Creating…' : 'Initialize'}
          </button>
        </div>
      </div>
    </div>
  );
};

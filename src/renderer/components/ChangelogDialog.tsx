import React from 'react';
import { Sparkles } from 'lucide-react';
import type { ChangelogEntry } from '../lib/changelog';

export interface ChangelogDialogProps {
  open: boolean;
  entries: ChangelogEntry[];
  appVersion: string;
  onClose: () => void;
}

function renderInlineMarkdown(text: string): React.ReactNode {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <strong key={i} className="font-semibold text-text-primary">
        {part}
      </strong>
    ) : (
      part
    ),
  );
}

export const ChangelogDialog: React.FC<ChangelogDialogProps> = ({
  open,
  entries,
  appVersion,
  onClose,
}) => {
  if (!open || entries.length === 0) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="changelog-title"
    >
      <div className="bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-border)] shadow-2xl max-w-lg w-full max-h-[min(80vh,640px)] flex flex-col">
        <div className="flex items-center gap-3 px-6 pt-6 pb-4 border-b border-[var(--color-border)]">
          <div className="w-10 h-10 rounded-lg bg-primary-bg flex items-center justify-center shrink-0">
            <Sparkles size={20} className="text-primary" />
          </div>
          <div className="min-w-0">
            <h2 id="changelog-title" className="text-base font-semibold text-text-primary">
              What&apos;s new in Lumina {appVersion}
            </h2>
            <p className="text-xs text-text-secondary mt-0.5">
              {entries.length === 1
                ? 'Changes since your last version'
                : `Changes in ${entries.length} releases since your last version`}
            </p>
          </div>
        </div>

        <div className="overflow-y-auto px-6 py-4 space-y-5 flex-1">
          {entries.map((entry) => (
            <section key={entry.version}>
              <h3 className="text-sm font-semibold text-text-primary mb-2">
                v{entry.version}
                {entry.date ? (
                  <span className="font-normal text-text-secondary ml-2">{entry.date}</span>
                ) : null}
              </h3>
              <ul className="space-y-1.5 text-sm text-text-secondary list-none">
                {entry.items.map((item, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-primary shrink-0 mt-0.5">•</span>
                    <span>{renderInlineMarkdown(item)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="flex justify-end px-6 py-4 border-t border-[var(--color-border)]">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg bg-primary text-white hover:opacity-90 transition-opacity cursor-pointer"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
};

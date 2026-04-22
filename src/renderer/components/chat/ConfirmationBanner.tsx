import React from 'react';
import type { ConfirmationRequest, ConfirmationTone } from '../../../shared/types';

/**
 * Tone-specific classes. Kept inline rather than looked up by key so the
 * Tailwind JIT can see every class literally — dynamic string concat with
 * `bg-${tone}-500` would get purged in production.
 *
 * `container` is the outer banner frame; `confirmButton` is the primary
 * action (stands out from `cancel`, which is always a muted ghost button
 * regardless of tone).
 */
const TONE_STYLES: Record<
  ConfirmationTone,
  { container: string; confirmButton: string }
> = {
  default: {
    container: 'border-primary-border/40 bg-primary-bg/40',
    confirmButton:
      'bg-primary text-white hover:brightness-110 focus-visible:ring-primary-border',
  },
  warning: {
    container: 'border-amber-500/40 bg-amber-500/10',
    confirmButton:
      'bg-amber-500 text-white hover:brightness-110 focus-visible:ring-amber-400',
  },
  danger: {
    container: 'border-red-500/40 bg-red-500/10',
    confirmButton:
      'bg-red-600 text-white hover:brightness-110 focus-visible:ring-red-400',
  },
};

export interface ConfirmationBannerProps {
  /** The request to render; when `null` the banner collapses to nothing. */
  request: ConfirmationRequest | null;
  /** Called with `true` for confirm, `false` for cancel. */
  onRespond: (approved: boolean) => void;
  /** Forwarded to the outer container so the banner spans the chat column. */
  colStyle?: React.CSSProperties;
}

/**
 * Yes/no prompt rendered directly above the chat input. Intentionally
 * "quiet" — no modal overlay, no focus trap — because:
 *   1. the user should still be able to scroll the conversation while
 *      deciding ("what did the model say it was about to do?"),
 *   2. the prompt is always tied to a specific assistant turn in the
 *      same visual column, so modal framing would over-dramatise it.
 *
 * Use this component for **any** main-process → renderer confirmation
 * (venv install, destructive wiki edits, bulk deletes, etc.). The main
 * process sends a `ConfirmationRequest`, the renderer calls `onRespond`
 * with the user's choice.
 */
export const ConfirmationBanner: React.FC<ConfirmationBannerProps> = ({
  request,
  onRespond,
  colStyle,
}) => {
  if (!request) return null;

  const tone: ConfirmationTone = request.tone ?? 'default';
  const styles = TONE_STYLES[tone];
  const confirmLabel = request.confirmLabel ?? 'Continue';
  const cancelLabel = request.cancelLabel ?? 'Cancel';

  return (
    <div
      className={`border-t shrink-0 ${styles.container}`}
      style={colStyle}
      role="alertdialog"
      aria-labelledby={`confirm-title-${request.id}`}
      aria-describedby={
        request.description ? `confirm-desc-${request.id}` : undefined
      }
    >
      <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 pr-2">
          <p
            id={`confirm-title-${request.id}`}
            className="text-sm font-medium text-text-primary"
          >
            {request.title}
          </p>
          {request.description && (
            <p
              id={`confirm-desc-${request.id}`}
              className="mt-0.5 text-xs text-text-secondary leading-relaxed whitespace-pre-wrap"
            >
              {request.description}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 sm:shrink-0">
          <button
            type="button"
            onClick={() => onRespond(false)}
            className="px-3 py-1.5 rounded-md text-xs font-medium text-text-secondary hover:bg-surface-hover hover:text-text-primary transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-primary-border focus-visible:outline-none"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => onRespond(true)}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold transition cursor-pointer focus-visible:ring-2 focus-visible:outline-none ${styles.confirmButton}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmationBanner;

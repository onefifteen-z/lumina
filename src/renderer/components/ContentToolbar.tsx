import * as React from 'react';
import { ChevronLeft, ChevronRight, Bookmark, Pencil, Eye } from 'lucide-react';
import { cn } from '../lib/utils';

// ── Breadcrumb helper ──────────────────────────────────────────

function buildBreadcrumb(vaultName: string, filename: string): string[] {
  const withoutExt = filename.replace(/\.md$/, '');
  return [vaultName, ...withoutExt.split('/')];
}

// ── Props ──────────────────────────────────────────────────────

export interface ContentToolbarProps {
  /** Vault-relative path of the current article (null = no article open) */
  filename: string | null;
  /** Display name of the vault root (last segment of vault path) */
  vaultName: string;
  /** Currently in edit mode */
  isEditing: boolean;
  /** Editing a brand-new (unsaved) article */
  isNewArticle: boolean;
  isBookmarked: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onToggleBookmark: () => void;
  onToggleEditMode: () => void;
}

// ── Component ──────────────────────────────────────────────────

export function ContentToolbar({
  filename,
  vaultName,
  isEditing,
  isNewArticle,
  isBookmarked,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onToggleBookmark,
  onToggleEditMode,
}: ContentToolbarProps) {
  const parts = filename ? buildBreadcrumb(vaultName, filename) : null;

  const navBtn = (active: boolean, onClick: () => void, label: string, children: React.ReactNode) => (
    <button
      type="button"
      onClick={onClick}
      disabled={!active}
      aria-label={label}
      className={cn(
        'flex items-center justify-center w-7 h-7 rounded-md transition-colors',
        active
          ? 'text-text-secondary hover:bg-surface-hover hover:text-text-primary cursor-pointer'
          : 'text-text-secondary opacity-25 cursor-default'
      )}
    >
      {children}
    </button>
  );

  const actionBtn = (onClick: () => void, label: string, active: boolean, children: React.ReactNode) => (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        'flex items-center justify-center w-7 h-7 rounded-md transition-colors cursor-pointer',
        active
          ? 'text-primary hover:bg-surface-hover'
          : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
      )}
    >
      {children}
    </button>
  );

  return (
    <div
      className="flex items-center shrink-0 border-b border-border bg-main-bg px-2 gap-1"
      style={{ height: '36px' }}
    >
      {/* ── Left: back / forward ─────────────────────────────── */}
      <div className="flex items-center gap-0.5 shrink-0">
        {navBtn(canGoBack, onBack, 'Go back', <ChevronLeft size={17} />)}
        {navBtn(canGoForward, onForward, 'Go forward', <ChevronRight size={17} />)}
      </div>

      {/* ── Centre: breadcrumb ───────────────────────────────── */}
      <div className="flex-1 flex items-center justify-center overflow-hidden px-2">
        {isNewArticle && (
          <span className="text-sm font-semibold text-text-primary select-none">New Article</span>
        )}
        {!isNewArticle && parts && (
          <div className="flex items-center gap-1 text-sm min-w-0 select-none">
            {parts.map((part, i) => (
              <React.Fragment key={i}>
                {i > 0 && (
                  <span className="text-text-secondary opacity-50 shrink-0">/</span>
                )}
                <span
                  className={cn(
                    'truncate',
                    i === parts.length - 1
                      ? 'font-semibold text-text-primary'
                      : 'text-text-secondary'
                  )}
                >
                  {part}
                </span>
              </React.Fragment>
            ))}
          </div>
        )}
      </div>

      {/* ── Right: bookmark + view/edit toggle ───────────────── */}
      <div className="flex items-center gap-0.5 shrink-0">
        {filename && !isNewArticle &&
          actionBtn(
            onToggleBookmark,
            isBookmarked ? 'Remove bookmark' : 'Add bookmark',
            isBookmarked,
            <Bookmark size={15} fill={isBookmarked ? 'currentColor' : 'none'} />
          )
        }
        {(filename || isNewArticle) &&
          actionBtn(
            onToggleEditMode,
            isEditing ? 'Switch to read mode' : 'Switch to edit mode',
            false,
            isEditing ? <Eye size={15} /> : <Pencil size={15} />
          )
        }
      </div>
    </div>
  );
}

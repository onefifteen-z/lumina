/**
 * Persist resizable panel widths in `localStorage` so they survive both
 * view changes (which can unmount the owning component, e.g. the chat
 * history sidebar) and app restarts.
 *
 * Reads are clamped to the same bounds the resize handlers use so a
 * stale or out-of-range stored value can't produce a broken layout.
 */

export function readStoredPanelWidth(
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  } catch {
    return fallback;
  }
}

export function writeStoredPanelWidth(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(Math.round(value)));
  } catch {
    // localStorage may be unavailable (private mode, quota); width still
    // works in-session, it just won't persist.
  }
}

export const LEFT_PANEL_WIDTH_KEY = 'lumina-left-panel-width';
export const RIGHT_PANEL_WIDTH_KEY = 'lumina-right-panel-width';
export const CHAT_HISTORY_WIDTH_KEY = 'lumina-chat-history-width';

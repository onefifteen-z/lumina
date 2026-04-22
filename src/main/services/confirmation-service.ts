import type { BrowserWindow } from "electron";
import type {
  ConfirmationRequest,
  ConfirmationTone,
} from "../../shared/types";

/**
 * Generic "ask the user yes/no" prompt for the main process.
 *
 * Callers invoke `request({ title, description, … })` and await a boolean.
 * The service:
 *   1. allocates a unique id,
 *   2. parks the caller on a promise,
 *   3. sends `wiki:confirmRequest` to the renderer with the full request,
 *   4. resolves the promise when the renderer replies via
 *      `wiki:confirmReply` (or a shutdown / dispose arrives, in which case
 *      every outstanding request rejects to `false`).
 *
 * Deliberately decoupled from ingest: the first consumer is the venv-
 * install consent gate, but this is also wired up to the `request_user_confirmation`
 * tool the model can call before destructive wiki edits. Anything that needs
 * "prompt above the chat input, wait for yes/no" should go through here.
 *
 * Not wired to OS-level dialogs on purpose — we want the confirmation to
 * appear in the same visual region as the chat so the model's narration
 * and the prompt stay associated.
 */
export class ConfirmationService {
  private getWindow: () => BrowserWindow | null;
  private pending = new Map<string, (approved: boolean) => void>();
  private seq = 0;
  private disposed = false;

  constructor(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow;
  }

  /**
   * Ask the user for confirmation. Resolves to the user's choice, or
   * `false` if the service is disposed / the window is gone before the
   * reply arrives. Never throws — callers treat rejection as a hard no.
   */
  request(options: {
    title: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: ConfirmationTone;
  }): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return Promise.resolve(false);

    const id = `confirm-${Date.now()}-${++this.seq}`;
    const payload: ConfirmationRequest = {
      id,
      title: options.title,
      description: options.description,
      confirmLabel: options.confirmLabel,
      cancelLabel: options.cancelLabel,
      tone: options.tone,
    };

    return new Promise<boolean>((resolve) => {
      this.pending.set(id, resolve);
      window.webContents.send("wiki:confirmRequest", payload);
    });
  }

  /**
   * Settle a pending request with the user's reply. Unknown ids are
   * silently ignored — they can happen legitimately (stale reply after a
   * window reload) and turning them into errors would just be noise.
   */
  resolve(id: string, approved: boolean): void {
    const resolver = this.pending.get(id);
    if (!resolver) return;
    this.pending.delete(id);
    resolver(approved);
  }

  /**
   * Cancel every outstanding request with `false`. Call on window close /
   * service shutdown so the awaiting promise chains don't leak.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [id, resolver] of this.pending) {
      resolver(false);
      this.pending.delete(id);
    }
  }

  /** Number of outstanding prompts. Exposed for tests. */
  pendingCount(): number {
    return this.pending.size;
  }
}

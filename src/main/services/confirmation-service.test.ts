import { describe, it, expect, vi } from "vitest";
import { ConfirmationService } from "./confirmation-service";
import type { BrowserWindow } from "electron";

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Minimal BrowserWindow stub. We only care that `isDestroyed` is false
 * and that `webContents.send` captures the payload we're supposed to
 * forward to the renderer. Returning `null` simulates "no window yet".
 */
function mockWindow(): {
  window: BrowserWindow;
  sent: Array<{ channel: string; payload: unknown }>;
} {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => {
        sent.push({ channel, payload });
      },
    },
  } as unknown as BrowserWindow;
  return { window, sent };
}

describe("ConfirmationService", () => {
  it("sends a confirmRequest with all supplied fields and resolves true on approval", async () => {
    const { window, sent } = mockWindow();
    const svc = new ConfirmationService(() => window);

    const pending = svc.request({
      title: "Update wiki?",
      description: "Will add 3 new entries to index.md",
      confirmLabel: "Update",
      cancelLabel: "Skip",
      tone: "warning",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe("wiki:confirmRequest");
    const payload = sent[0].payload as Record<string, unknown>;
    expect(payload.title).toBe("Update wiki?");
    expect(payload.description).toBe("Will add 3 new entries to index.md");
    expect(payload.confirmLabel).toBe("Update");
    expect(payload.cancelLabel).toBe("Skip");
    expect(payload.tone).toBe("warning");
    expect(typeof payload.id).toBe("string");

    svc.resolve(payload.id as string, true);
    await expect(pending).resolves.toBe(true);
  });

  it("resolves false when the user declines", async () => {
    const { window, sent } = mockWindow();
    const svc = new ConfirmationService(() => window);
    const pending = svc.request({ title: "Delete files?" });
    const id = (sent[0].payload as { id: string }).id;
    svc.resolve(id, false);
    await expect(pending).resolves.toBe(false);
  });

  it("returns false immediately when the window is missing", async () => {
    const svc = new ConfirmationService(() => null);
    await expect(svc.request({ title: "x" })).resolves.toBe(false);
  });

  /**
   * Regression for the bug where `main.ts` passed `mainWindow` by value
   * (still `null` at register time) instead of via a getter. The service
   * MUST re-read the getter each time — otherwise the first few IPC calls
   * silently short-circuit to `false` and the user never sees the banner.
   */
  it("re-reads the window getter on every request instead of caching the initial value", async () => {
    let current: BrowserWindow | null = null;
    const svc = new ConfirmationService(() => current);

    // First request: no window yet. Must resolve false without throwing.
    await expect(svc.request({ title: "a" })).resolves.toBe(false);

    // Window becomes available later (mirrors the real-world
    // registerIpcHandlers-then-createWindow ordering in main.ts).
    const { window, sent } = mockWindow();
    current = window;

    const pending = svc.request({ title: "b" });
    expect(sent).toHaveLength(1);
    const id = (sent[0].payload as { id: string }).id;
    svc.resolve(id, true);
    await expect(pending).resolves.toBe(true);
  });

  it("returns false immediately when the window is destroyed", async () => {
    const destroyed = {
      isDestroyed: () => true,
      webContents: { send: vi.fn() },
    } as unknown as BrowserWindow;
    const svc = new ConfirmationService(() => destroyed);
    await expect(svc.request({ title: "x" })).resolves.toBe(false);
  });

  it("ignores unknown reply ids instead of throwing", () => {
    const { window } = mockWindow();
    const svc = new ConfirmationService(() => window);
    expect(() => svc.resolve("never-allocated", true)).not.toThrow();
  });

  it("keeps concurrent requests isolated by id", async () => {
    const { window, sent } = mockWindow();
    const svc = new ConfirmationService(() => window);

    const first = svc.request({ title: "A" });
    const second = svc.request({ title: "B" });
    expect(sent).toHaveLength(2);
    const idA = (sent[0].payload as { id: string }).id;
    const idB = (sent[1].payload as { id: string }).id;
    expect(idA).not.toBe(idB);
    expect(svc.pendingCount()).toBe(2);

    // Reply out of order. Each id should route to its own resolver.
    svc.resolve(idB, true);
    svc.resolve(idA, false);
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(svc.pendingCount()).toBe(0);
  });

  it("dispose() settles every outstanding request with false", async () => {
    const { window } = mockWindow();
    const svc = new ConfirmationService(() => window);
    const a = svc.request({ title: "A" });
    const b = svc.request({ title: "B" });
    svc.dispose();
    await expect(a).resolves.toBe(false);
    await expect(b).resolves.toBe(false);
    expect(svc.pendingCount()).toBe(0);
  });

  it("dispose() makes subsequent requests resolve false without touching the window", async () => {
    const { window, sent } = mockWindow();
    const svc = new ConfirmationService(() => window);
    svc.dispose();
    await expect(svc.request({ title: "x" })).resolves.toBe(false);
    expect(sent).toHaveLength(0);
  });
});

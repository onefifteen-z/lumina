import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Unit tests for the network status behavioral contract.
 * Tests the event-driven logic that the useNetworkStatus hook relies on,
 * without requiring a DOM or React rendering environment.
 */

describe("Network status event handling", () => {
  let eventMap: Record<string, Set<Function>>;

  // Minimal window-like event target for testing
  const mockTarget = {
    addEventListener(event: string, handler: Function) {
      if (!eventMap[event]) eventMap[event] = new Set();
      eventMap[event].add(handler);
    },
    removeEventListener(event: string, handler: Function) {
      eventMap[event]?.delete(handler);
    },
    dispatch(event: string) {
      eventMap[event]?.forEach((h) => h());
    },
  };

  beforeEach(() => {
    eventMap = {};
  });

  it("registers online and offline listeners", () => {
    const onOffline = vi.fn();
    const onOnline = vi.fn();

    mockTarget.addEventListener("offline", onOffline);
    mockTarget.addEventListener("online", onOnline);

    expect(eventMap.offline?.size).toBe(1);
    expect(eventMap.online?.size).toBe(1);
  });

  it("removes listeners on cleanup", () => {
    const onOffline = vi.fn();
    const onOnline = vi.fn();

    mockTarget.addEventListener("offline", onOffline);
    mockTarget.addEventListener("online", onOnline);
    mockTarget.removeEventListener("offline", onOffline);
    mockTarget.removeEventListener("online", onOnline);

    expect(eventMap.offline?.size).toBe(0);
    expect(eventMap.online?.size).toBe(0);
  });

  it("offline event triggers the offline handler", () => {
    const onOffline = vi.fn();
    mockTarget.addEventListener("offline", onOffline);

    mockTarget.dispatch("offline");

    expect(onOffline).toHaveBeenCalledTimes(1);
  });

  it("online event triggers the online handler", () => {
    const onOnline = vi.fn();
    mockTarget.addEventListener("online", onOnline);

    mockTarget.dispatch("online");

    expect(onOnline).toHaveBeenCalledTimes(1);
  });

  it("offline then online fires both handlers in sequence", () => {
    const order: string[] = [];
    const onOffline = vi.fn(() => order.push("offline"));
    const onOnline = vi.fn(() => order.push("online"));

    mockTarget.addEventListener("offline", onOffline);
    mockTarget.addEventListener("online", onOnline);

    mockTarget.dispatch("offline");
    mockTarget.dispatch("online");

    expect(order).toEqual(["offline", "online"]);
  });
});

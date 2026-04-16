import { describe, it, expect, vi } from "vitest";
import { formatTimestamp } from "./MessageList";

describe("formatTimestamp", () => {
  it("formats an ISO 8601 timestamp to HH:mm", () => {
    // 2024-01-15T14:30:00.000Z — local time depends on timezone,
    // so we construct a date with known local hours/minutes.
    const date = new Date(2024, 0, 15, 9, 5); // Jan 15 2024, 09:05 local
    const result = formatTimestamp(date.toISOString());
    expect(result).toBe("09:05");
  });

  it("pads single-digit hours and minutes with leading zeros", () => {
    const date = new Date(2024, 5, 1, 3, 7); // 03:07 local
    const result = formatTimestamp(date.toISOString());
    expect(result).toBe("03:07");
  });

  it("handles midnight correctly", () => {
    const date = new Date(2024, 0, 1, 0, 0); // 00:00 local
    const result = formatTimestamp(date.toISOString());
    expect(result).toBe("00:00");
  });

  it("handles 23:59 correctly", () => {
    const date = new Date(2024, 11, 31, 23, 59); // 23:59 local
    const result = formatTimestamp(date.toISOString());
    expect(result).toBe("23:59");
  });

  it("returns HH:mm pattern (two digits, colon, two digits)", () => {
    const date = new Date(2024, 6, 10, 15, 42);
    const result = formatTimestamp(date.toISOString());
    expect(result).toMatch(/^\d{2}:\d{2}$/);
  });
});

// ── Integration tests: Fox indicator rendering in MessageList ──
// These tests call the MessageList component function directly and inspect
// the returned React element tree (vdom). No DOM / jsdom required.
// React hooks are mocked at the module level since there is no React renderer.

import { type ReactElement } from "react";

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    default: {
      ...actual,
      useRef: () => ({ current: null }),
      useEffect: () => {},
      useState: (init: unknown) => [
        typeof init === "function" ? (init as () => unknown)() : init,
        () => {},
      ],
      useCallback: (fn: unknown) => fn,
    },
    useRef: () => ({ current: null }),
    useEffect: () => {},
    useState: (init: unknown) => [
      typeof init === "function" ? (init as () => unknown)() : init,
      () => {},
    ],
    useCallback: (fn: unknown) => fn,
  };
});

const { MessageList } = await import("./MessageList");

// ── Helpers to traverse React element trees ──

function flattenElements(node: unknown): ReactElement[] {
  if (!node || typeof node !== "object" || !("props" in (node as any)))
    return [];
  const el = node as ReactElement;
  const result: ReactElement[] = [el];
  const children = (el.props as any)?.children;
  if (children == null) return result;
  if (Array.isArray(children)) {
    for (const child of children) {
      result.push(...flattenElements(child));
    }
  } else {
    result.push(...flattenElements(children));
  }
  return result;
}

function findByTestId(root: ReactElement, testId: string): ReactElement[] {
  return flattenElements(root).filter(
    (el) => (el.props as any)?.["data-testid"] === testId,
  );
}

// ── Tests ──

describe("MessageList fox indicator integration", () => {
  it("renders fox indicator when isGenerating=true and streamingContent is empty string", () => {
    const tree = MessageList({
      messages: [],
      isGenerating: true,
      streamingContent: "",
    });
    const foxContainers = findByTestId(
      tree as ReactElement,
      "fox-thinking-container",
    );
    const streamingMsgs = findByTestId(
      tree as ReactElement,
      "streaming-message",
    );

    expect(foxContainers.length).toBeGreaterThanOrEqual(1);
    expect(streamingMsgs).toHaveLength(0);
  });

  it("renders fox indicator when isGenerating=true and streamingContent is undefined", () => {
    const tree = MessageList({
      messages: [],
      isGenerating: true,
    });
    const foxContainers = findByTestId(
      tree as ReactElement,
      "fox-thinking-container",
    );

    expect(foxContainers.length).toBeGreaterThanOrEqual(1);
  });

  it("hides fox indicator when isGenerating=true and streamingContent has content", () => {
    const tree = MessageList({
      messages: [],
      isGenerating: true,
      streamingContent: "Hello",
    });
    const foxContainers = findByTestId(
      tree as ReactElement,
      "fox-thinking-container",
    );
    const streamingMsgs = findByTestId(
      tree as ReactElement,
      "streaming-message",
    );

    expect(foxContainers).toHaveLength(0);
    expect(streamingMsgs.length).toBeGreaterThanOrEqual(1);
  });

  it("removes fox indicator when isGenerating=false", () => {
    const tree = MessageList({
      messages: [],
      isGenerating: false,
      streamingContent: "",
    });
    const foxContainers = findByTestId(
      tree as ReactElement,
      "fox-thinking-container",
    );

    expect(foxContainers).toHaveLength(0);
  });

  it("fox indicator container has justify-start class (left-aligned)", () => {
    const tree = MessageList({
      messages: [],
      isGenerating: true,
      streamingContent: "",
    });
    const foxContainers = findByTestId(
      tree as ReactElement,
      "fox-thinking-container",
    );

    expect(foxContainers.length).toBeGreaterThanOrEqual(1);
    const container = foxContainers[0];
    const className = (container.props as any).className as string;
    expect(className).toContain("justify-start");
  });
});

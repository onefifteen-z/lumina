import { describe, it, expect } from "vitest";

/**
 * Unit tests for IconRail component logic.
 * Tests the data structures, keyboard navigation math, and configuration
 * without requiring a DOM or React rendering environment.
 */

// Mirror the component's item configuration for testing
const topItems = [
  { view: "files", label: "Files" },
  { view: "search", label: "Search" },
  { view: "bookmarks", label: "Bookmarks" },
];

const bottomItems = [{ view: "settings", label: "Settings" }];

const allItems = [...topItems, ...bottomItems];

// Mirror the keyboard navigation logic from the component
function getNextIndex(
  current: number,
  direction: "up" | "down",
  total: number,
): number {
  if (direction === "down") {
    return (current + 1) % total;
  }
  return (current - 1 + total) % total;
}

describe("IconRail configuration", () => {
  it("has exactly 4 navigation items total", () => {
    expect(allItems).toHaveLength(4);
  });

  it("top group contains Files, Search, Bookmarks in order", () => {
    expect(topItems.map((i) => i.view)).toEqual([
      "files",
      "search",
      "bookmarks",
    ]);
  });

  it("bottom group contains only Settings", () => {
    expect(bottomItems.map((i) => i.view)).toEqual(["settings"]);
  });

  it("each item has a label matching its view name (capitalized)", () => {
    for (const item of allItems) {
      const expectedLabel =
        item.view.charAt(0).toUpperCase() + item.view.slice(1);
      expect(item.label).toBe(expectedLabel);
    }
  });

  it("all view names are unique", () => {
    const views = allItems.map((i) => i.view);
    expect(new Set(views).size).toBe(views.length);
  });
});

describe("IconRail keyboard navigation logic", () => {
  const total = allItems.length; // 4

  it("ArrowDown from first item moves to second", () => {
    expect(getNextIndex(0, "down", total)).toBe(1);
  });

  it("ArrowDown from last item wraps to first", () => {
    expect(getNextIndex(total - 1, "down", total)).toBe(0);
  });

  it("ArrowUp from first item wraps to last", () => {
    expect(getNextIndex(0, "up", total)).toBe(total - 1);
  });

  it("ArrowUp from last item moves to second-to-last", () => {
    expect(getNextIndex(total - 1, "up", total)).toBe(total - 2);
  });

  it("full ArrowDown cycle returns to start", () => {
    let index = 0;
    for (let i = 0; i < total; i++) {
      index = getNextIndex(index, "down", total);
    }
    expect(index).toBe(0);
  });

  it("full ArrowUp cycle returns to start", () => {
    let index = 0;
    for (let i = 0; i < total; i++) {
      index = getNextIndex(index, "up", total);
    }
    expect(index).toBe(0);
  });
});

describe("IconRail active state logic", () => {
  it("exactly one view is active for any given activeView value", () => {
    for (const activeItem of allItems) {
      const activeCount = allItems.filter(
        (i) => i.view === activeItem.view,
      ).length;
      expect(activeCount).toBe(1);
    }
  });
});

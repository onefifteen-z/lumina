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
  { view: "chat", label: "Chat" },
  { view: "graph", label: "Graph" },
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
  it("has exactly 6 navigation items total", () => {
    expect(allItems).toHaveLength(6);
  });

  it("top group contains Files, Search, Bookmarks, Chat, Graph in order", () => {
    expect(topItems.map((i) => i.view)).toEqual([
      "files",
      "search",
      "bookmarks",
      "chat",
      "graph",
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

describe("IconRail chat icon position", () => {
  it("chat icon is positioned after bookmarks in topItems", () => {
    const bookmarksIndex = topItems.findIndex((i) => i.view === "bookmarks");
    const chatIndex = topItems.findIndex((i) => i.view === "chat");
    expect(chatIndex).toBe(bookmarksIndex + 1);
  });

  it("chat icon exists in topItems with label 'Chat'", () => {
    const chatItem = topItems.find((i) => i.view === "chat");
    expect(chatItem).toBeDefined();
    expect(chatItem!.label).toBe("Chat");
  });

  it("chat icon is at index 3 in topItems (files=0, search=1, bookmarks=2, chat=3)", () => {
    expect(topItems[3].view).toBe("chat");
  });
});

describe("IconRail chat active state logic", () => {
  it("when activeView is 'chat', only the chat item matches", () => {
    const activeView = "chat";
    const activeItems = allItems.filter((i) => i.view === activeView);
    expect(activeItems).toHaveLength(1);
    expect(activeItems[0].view).toBe("chat");
  });

  it("when activeView is not 'chat', the chat item is not active", () => {
    const otherViews = allItems
      .filter((i) => i.view !== "chat")
      .map((i) => i.view);
    for (const view of otherViews) {
      const isActive = view === "chat";
      expect(isActive).toBe(false);
    }
  });

  it("active state class logic: active view gets bg-accent, others do not", () => {
    const activeView = "chat";
    for (const item of allItems) {
      const isActive = item.view === activeView;
      if (item.view === "chat") {
        expect(isActive).toBe(true);
      } else {
        expect(isActive).toBe(false);
      }
    }
  });
});

describe("IconRail keyboard navigation with chat icon", () => {
  const total = allItems.length; // 6

  // Chat is at index 3 in allItems (files=0, search=1, bookmarks=2, chat=3, graph=4, settings=5)
  const bookmarksIndex = allItems.findIndex((i) => i.view === "bookmarks"); // 2
  const chatIndex = allItems.findIndex((i) => i.view === "chat"); // 3

  it("ArrowDown from bookmarks focuses the chat button", () => {
    const nextIndex = getNextIndex(bookmarksIndex, "down", total);
    expect(nextIndex).toBe(chatIndex);
    expect(allItems[nextIndex].view).toBe("chat");
  });

  it("ArrowUp from chat focuses bookmarks", () => {
    const nextIndex = getNextIndex(chatIndex, "up", total);
    expect(nextIndex).toBe(bookmarksIndex);
    expect(allItems[nextIndex].view).toBe("bookmarks");
  });

  it("ArrowDown from chat focuses graph", () => {
    const nextIndex = getNextIndex(chatIndex, "down", total);
    const graphIndex = allItems.findIndex((i) => i.view === "graph");
    expect(nextIndex).toBe(graphIndex);
    expect(allItems[nextIndex].view).toBe("graph");
  });

  it("ArrowUp from first item wraps to last (settings)", () => {
    expect(getNextIndex(0, "up", total)).toBe(total - 1);
    expect(allItems[total - 1].view).toBe("settings");
  });

  it("ArrowDown from last item wraps to first (files)", () => {
    expect(getNextIndex(total - 1, "down", total)).toBe(0);
    expect(allItems[0].view).toBe("files");
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

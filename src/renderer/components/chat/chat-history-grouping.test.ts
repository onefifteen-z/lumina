import { describe, it, expect } from "vitest";
import {
  bucketForTimestamp,
  groupHistoryByRecency,
  formatHistoryTimestamp,
  type HistoryBucket,
} from "../ChatView";

const NOW = new Date("2026-04-19T12:00:00Z");

function iso(daysAgo: number, hours = 0): string {
  const d = new Date(NOW.getTime() - daysAgo * 86_400_000 - hours * 3_600_000);
  return d.toISOString();
}

describe("bucketForTimestamp", () => {
  it.each<[string, HistoryBucket]>([
    [iso(0, 0), "today"],
    [iso(0, 5), "today"],
    [iso(1, 0), "yesterday"],
    [iso(2, 0), "last7"],
    [iso(6, 23), "last7"],
    [iso(8, 0), "last30"],
    [iso(29, 23), "last30"],
    [iso(40, 0), "older"],
    [iso(365, 0), "older"],
  ])("classifies %s as %s", (ts, expected) => {
    expect(bucketForTimestamp(ts, NOW)).toBe(expected);
  });

  it("falls back to 'older' for invalid timestamps", () => {
    expect(bucketForTimestamp("not-a-date", NOW)).toBe("older");
  });
});

describe("groupHistoryByRecency", () => {
  it("emits buckets in fixed recency order, dropping empty ones", () => {
    const entries = [
      { id: "a", updatedAt: iso(0, 1) },
      { id: "b", updatedAt: iso(1, 0) },
      { id: "c", updatedAt: iso(40, 0) },
    ];
    const groups = groupHistoryByRecency(entries, NOW);
    expect(groups.map((g) => g.bucket)).toEqual(["today", "yesterday", "older"]);
  });

  it("preserves the input order within each bucket (newest-first contract)", () => {
    const entries = [
      { id: "newest", updatedAt: iso(0, 1) },
      { id: "middle", updatedAt: iso(0, 3) },
      { id: "oldest", updatedAt: iso(0, 6) },
    ];
    const groups = groupHistoryByRecency(entries, NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].bucket).toBe("today");
    expect(groups[0].entries.map((e) => e.id)).toEqual(["newest", "middle", "oldest"]);
  });

  it("returns an empty array for empty input", () => {
    expect(groupHistoryByRecency([], NOW)).toEqual([]);
  });

  it("attaches a non-empty human-readable label to every emitted group", () => {
    const groups = groupHistoryByRecency(
      [
        { id: "a", updatedAt: iso(0, 1) },
        { id: "b", updatedAt: iso(40, 0) },
      ],
      NOW,
    );
    for (const g of groups) {
      expect(g.label.length).toBeGreaterThan(0);
    }
  });
});

describe("formatHistoryTimestamp", () => {
  it("returns 'just now' for sub-minute deltas", () => {
    expect(formatHistoryTimestamp(iso(0, 0), NOW)).toBe("just now");
  });

  it("returns minute-precision for sub-hour deltas", () => {
    const ts = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString();
    expect(formatHistoryTimestamp(ts, NOW)).toBe("5m ago");
  });

  it("returns hour-precision for same-day older deltas", () => {
    const ts = new Date(NOW.getTime() - 3 * 60 * 60 * 1000).toISOString();
    expect(formatHistoryTimestamp(ts, NOW)).toBe("3h ago");
  });

  it("returns 'Yesterday' for the yesterday bucket", () => {
    expect(formatHistoryTimestamp(iso(1, 2), NOW)).toBe("Yesterday");
  });

  it("returns a month-day stamp for older same-year entries", () => {
    const result = formatHistoryTimestamp(iso(40, 0), NOW);
    expect(result).toMatch(/^[A-Za-z]{3} \d{1,2}$/);
  });

  it("returns empty string for invalid input", () => {
    expect(formatHistoryTimestamp("not-a-date", NOW)).toBe("");
  });
});

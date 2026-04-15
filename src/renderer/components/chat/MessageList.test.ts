import { describe, it, expect } from "vitest";
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

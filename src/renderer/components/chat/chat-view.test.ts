import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { formatTimestamp } from "./MessageList";

/**
 * Property 5: Timestamp formatting to HH:mm
 *
 * For any valid ISO 8601 timestamp string, the formatted display string
 * SHALL match the pattern HH:mm (two-digit hour, colon, two-digit minute)
 * and represent the correct local time.
 *
 * **Validates: Requirements 4.6**
 */
describe("Property 5: Timestamp formatting to HH:mm", () => {
  it("should always produce a string matching HH:mm pattern", () => {
    fc.assert(
      fc.property(fc.date(), (date) => {
        const iso = date.toISOString();
        const result = formatTimestamp(iso);
        expect(result).toMatch(/^\d{2}:\d{2}$/);
      }),
      { numRuns: 100 },
    );
  });

  it("should produce hours and minutes matching the local time of the input date", () => {
    fc.assert(
      fc.property(fc.date(), (date) => {
        const iso = date.toISOString();
        const result = formatTimestamp(iso);

        const expectedHours = date.getHours().toString().padStart(2, "0");
        const expectedMinutes = date.getMinutes().toString().padStart(2, "0");
        const expected = `${expectedHours}:${expectedMinutes}`;

        expect(result).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });
});

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import type { ChatMessage, ChatSession } from "./types";

const chatMessageArb: fc.Arbitrary<ChatMessage> = fc.record({
  id: fc.uuid(),
  role: fc.constantFrom(
    "user" as const,
    "assistant" as const,
    "system" as const,
  ),
  content: fc.string(),
  timestamp: fc.date().map((d) => d.toISOString()),
});

const chatSessionArb: fc.Arbitrary<ChatSession> = fc.record({
  id: fc.uuid(),
  systemPrompt: fc.string(),
  messages: fc.array(chatMessageArb, { minLength: 0, maxLength: 50 }),
  createdAt: fc.date().map((d) => d.toISOString()),
});

describe("ChatMessage and ChatSession JSON round-trip", () => {
  it("Property 6: ChatMessage JSON round-trip — serializing and deserializing produces a deeply equal object", () => {
    /**
     * Validates: Requirements 8.1, 8.3
     *
     * For any valid ChatMessage object (with id, role, content, and ISO 8601 timestamp),
     * serializing to JSON via JSON.stringify and deserializing via JSON.parse
     * SHALL produce a deeply equal object.
     */
    fc.assert(
      fc.property(chatMessageArb, (message: ChatMessage) => {
        const serialized = JSON.stringify(message);
        const deserialized: ChatMessage = JSON.parse(serialized);
        expect(deserialized).toStrictEqual(message);
      }),
      { numRuns: 100 },
    );
  });

  it("Property 7: ChatSession JSON round-trip — serializing and deserializing produces a deeply equal object", () => {
    /**
     * Validates: Requirements 8.2, 8.4
     *
     * For any valid ChatSession object (with id, systemPrompt, ordered messages array,
     * and ISO 8601 createdAt), serializing to JSON via JSON.stringify and deserializing
     * via JSON.parse SHALL produce a deeply equal object.
     */
    fc.assert(
      fc.property(chatSessionArb, (session: ChatSession) => {
        const serialized = JSON.stringify(session);
        const deserialized: ChatSession = JSON.parse(serialized);
        expect(deserialized).toStrictEqual(session);
      }),
      { numRuns: 100 },
    );
  });
});

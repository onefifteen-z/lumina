import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";
import { ChatService } from "./chat-service";
import { LLMService } from "./llm-service";
import { FileSystemService } from "./filesystem-service";
import type { ChatMessage } from "../../shared/types";

// ── Helpers ──────────────────────────────────────────────────────

/** Create a mock FileSystemService that returns the given content for readRawFile. */
function mockFileSystem(claudeContent: string): FileSystemService {
  return {
    readRawFile: vi.fn().mockResolvedValue(claudeContent),
  } as unknown as FileSystemService;
}

/** Create a mock LLMService whose generateChat yields the given chunks. */
function mockLLMService(chunks: string[]): LLMService {
  return {
    generateChat: vi.fn().mockImplementation(async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    }),
  } as unknown as LLMService;
}

/**
 * Create a mock LLMService whose generateChat captures the messages argument
 * and yields a single empty chunk so the generator completes.
 */
function mockLLMServiceCapture(
  capturedMessages: Array<{ role: string; content: string }>[],
): LLMService {
  return {
    generateChat: vi.fn().mockImplementation(async function* (
      messages: Array<{ role: string; content: string }>,
    ) {
      capturedMessages.push([...messages]);
      yield "";
    }),
  } as unknown as LLMService;
}

/** Arbitrary for a ChatMessage with user or assistant role. */
const chatMessageArb: fc.Arbitrary<ChatMessage> = fc.record({
  id: fc.uuid(),
  role: fc.constantFrom("user" as const, "assistant" as const),
  content: fc.string(),
  timestamp: fc.date().map((d) => d.toISOString()),
});

/** Drain an async generator, collecting all yielded values. */
async function drainGenerator(gen: AsyncGenerator<string>): Promise<string[]> {
  const results: string[] = [];
  for await (const chunk of gen) {
    results.push(chunk);
  }
  return results;
}

// ── Property Tests ───────────────────────────────────────────────

describe("ChatService property-based tests", () => {
  it("Property 1: System prompt reflects file content — for any non-empty claude.md content, startSession sets systemPrompt to that content exactly", async () => {
    /**
     * Validates: Requirements 2.3
     *
     * For any non-empty string stored in claude.md, when ChatService creates
     * a new session, the resulting ChatSession.systemPrompt SHALL equal that
     * file content exactly.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
        async (fileContent) => {
          const fs = mockFileSystem(fileContent);
          const llm = mockLLMService([]);
          const service = new ChatService(llm, fs);

          const { session } = await service.startSession();

          expect(session.systemPrompt).toBe(fileContent);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Property 2: Sending a message appends it to the session — for any valid message, sendMessage appends a user ChatMessage with that exact content", async () => {
    /**
     * Validates: Requirements 3.1
     *
     * For any valid (non-empty, non-whitespace) message string and any existing
     * ChatSession, calling sendMessage SHALL append a ChatMessage with role 'user'
     * and that exact content to the session's messages array, increasing its
     * length by one.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
        fc.array(chatMessageArb, { minLength: 0, maxLength: 20 }),
        async (messageContent, existingMessages) => {
          const fs = mockFileSystem("system prompt");
          const llm = mockLLMService(["response"]);
          const service = new ChatService(llm, fs);

          // Start session and seed existing messages
          await service.startSession();
          const session = service.getSession()!;
          session.messages.push(...existingMessages);

          const lengthBefore = session.messages.length;

          // Send the message (drain the generator to complete the flow)
          await drainGenerator(service.sendMessage(messageContent));

          const currentSession = service.getSession()!;
          // After sendMessage: +1 user message, +1 assistant message
          // We check the user message was appended correctly
          const userMessage = currentSession.messages[lengthBefore];
          expect(userMessage.role).toBe("user");
          expect(userMessage.content).toBe(messageContent);
          // Total length: existing + 1 user + 1 assistant
          expect(currentSession.messages.length).toBe(lengthBefore + 2);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Property 3: Streaming chunks accumulate by concatenation — the assistant message content equals the concatenation of all received chunks", async () => {
    /**
     * Validates: Requirements 3.3, 3.5
     *
     * For any sequence of string chunks, the accumulated assistant message
     * content SHALL equal the concatenation of all received chunks in order.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string(), { minLength: 0, maxLength: 50 }),
        async (chunks) => {
          const fs = mockFileSystem("system prompt");
          const llm = mockLLMService(chunks);
          const service = new ChatService(llm, fs);

          await service.startSession();

          const yielded = await drainGenerator(
            service.sendMessage("test message"),
          );

          // Yielded chunks should match input chunks
          expect(yielded).toEqual(chunks);

          // The assistant message content should be the concatenation
          const session = service.getSession()!;
          const assistantMessage =
            session.messages[session.messages.length - 1];
          expect(assistantMessage.role).toBe("assistant");
          expect(assistantMessage.content).toBe(chunks.join(""));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Property 4: Complete message history is sent with each request — messages passed to generateChat contain system prompt + all N session messages", async () => {
    /**
     * Validates: Requirements 3.7, 6.6
     *
     * For any ChatSession with N messages, the messages array passed to
     * LLMService.generateChat SHALL contain exactly N+1 entries: the system
     * prompt as the first message (role 'system'), followed by all N session
     * messages in their original order.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.array(chatMessageArb, { minLength: 0, maxLength: 20 }),
        fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
        async (existingMessages, systemPrompt) => {
          const fs = mockFileSystem(systemPrompt);
          const capturedMessages: Array<{ role: string; content: string }>[] =
            [];
          const llm = mockLLMServiceCapture(capturedMessages);
          const service = new ChatService(llm, fs);

          // Start session and seed existing messages
          await service.startSession();
          const session = service.getSession()!;
          session.messages.push(...existingMessages);

          // Send a new message to trigger generateChat
          const userContent = "new user message";
          await drainGenerator(service.sendMessage(userContent));

          // generateChat should have been called once
          expect(capturedMessages.length).toBe(1);

          const sentMessages = capturedMessages[0];
          // N existing messages + 1 new user message = N+1 session messages
          // Plus 1 system prompt = N+2 total entries sent to generateChat
          const totalSessionMessages = existingMessages.length + 1;
          expect(sentMessages.length).toBe(totalSessionMessages + 1);

          // First message should be the system prompt
          expect(sentMessages[0].role).toBe("system");
          expect(sentMessages[0].content).toBe(systemPrompt);

          // Remaining messages should match session messages in order
          for (let i = 0; i < existingMessages.length; i++) {
            expect(sentMessages[i + 1].role).toBe(existingMessages[i].role);
            expect(sentMessages[i + 1].content).toBe(
              existingMessages[i].content,
            );
          }

          // Last session message should be the new user message
          expect(sentMessages[sentMessages.length - 1].role).toBe("user");
          expect(sentMessages[sentMessages.length - 1].content).toBe(
            userContent,
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Edge Case Unit Tests ─────────────────────────────────────────

describe("ChatService edge case unit tests", () => {
  describe("default system prompt fallback", () => {
    it("uses default prompt when claude.md is missing (ENOENT)", async () => {
      const fs = {
        readRawFile: vi.fn().mockRejectedValue(
          Object.assign(new Error("ENOENT: no such file or directory"), {
            code: "ENOENT",
          }),
        ),
      } as unknown as FileSystemService;

      const service = new ChatService(null, fs);
      const { session, warning } = await service.startSession();

      expect(session.systemPrompt).toBe("You are a helpful assistant.");
      expect(warning).toBeUndefined();
    });

    it("uses default prompt when claude.md is empty string", async () => {
      const fs = mockFileSystem("");
      const service = new ChatService(null, fs);
      const { session, warning } = await service.startSession();

      expect(session.systemPrompt).toBe("You are a helpful assistant.");
      expect(warning).toBeUndefined();
    });

    it("uses default prompt when claude.md is whitespace only", async () => {
      const fs = mockFileSystem("   \n\t  \n  ");
      const service = new ChatService(null, fs);
      const { session, warning } = await service.startSession();

      expect(session.systemPrompt).toBe("You are a helpful assistant.");
      expect(warning).toBeUndefined();
    });
  });

  describe("I/O error fallback with warning", () => {
    it("uses default prompt and returns warning on non-ENOENT error", async () => {
      const fs = {
        readRawFile: vi.fn().mockRejectedValue(
          Object.assign(new Error("Permission denied"), {
            code: "EACCES",
          }),
        ),
      } as unknown as FileSystemService;

      const service = new ChatService(null, fs);
      const { session, warning } = await service.startSession();

      expect(session.systemPrompt).toBe("You are a helpful assistant.");
      expect(warning).toBeDefined();
      expect(warning).toContain("Permission denied");
    });
  });

  describe("new session clears history", () => {
    it("clears message history when starting a new session", async () => {
      const fs = mockFileSystem("system prompt");
      const llm = mockLLMService(["response"]);
      const service = new ChatService(llm, fs);

      // Start first session and send a message
      await service.startSession();
      await drainGenerator(service.sendMessage("hello"));

      const firstSession = service.getSession()!;
      expect(firstSession.messages.length).toBeGreaterThan(0);

      // Start a new session — history should be cleared
      const { session: newSession } = await service.startSession();

      expect(newSession.messages).toEqual([]);
      expect(service.getSession()!.messages).toEqual([]);
    });
  });
});

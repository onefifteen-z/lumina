import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";
import {
  ChatService,
  clampShellTimeout,
  stripHeavyDataUrlsFromText,
  compactExtraMessages,
  isCatalogFullRead,
} from "./chat-service";
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
        yield { type: 'text', content: chunk };
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
      yield { type: 'text', content: '' };
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
async function drainGenerator(gen: AsyncGenerator<any>): Promise<any[]> {
  const results: any[] = [];
  for await (const chunk of gen) {
    results.push(chunk);
  }
  return results;
}

/**
 * Default template-loader stub used across the existing edge-case tests.
 * Returning null lets the previous "vault has no/empty CLAUDE.md → trivial
 * default prompt" assertions keep holding (the new behaviour adds a step in
 * between, but only when the template is actually present).
 */
const NO_TEMPLATE = (): Promise<string | null> => Promise.resolve(null);

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
          const service = new ChatService(llm, fs, NO_TEMPLATE);

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
          const service = new ChatService(llm, fs, NO_TEMPLATE);

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
          const service = new ChatService(llm, fs, NO_TEMPLATE);

          await service.startSession();

          const yielded = await drainGenerator(
            service.sendMessage("test message"),
          );

          // Yielded chunks should match input chunks (as ChatChunk objects)
          expect(yielded.map((c: any) => c.content)).toEqual(chunks);

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
          const service = new ChatService(llm, fs, NO_TEMPLATE);

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

      const service = new ChatService(null, fs, NO_TEMPLATE);
      const { session, warning } = await service.startSession();

      expect(session.systemPrompt).toBe("You are a helpful assistant.");
      expect(warning).toBeUndefined();
    });

    it("uses default prompt when claude.md is empty string", async () => {
      const fs = mockFileSystem("");
      const service = new ChatService(null, fs, NO_TEMPLATE);
      const { session, warning } = await service.startSession();

      expect(session.systemPrompt).toBe("You are a helpful assistant.");
      expect(warning).toBeUndefined();
    });

    it("uses default prompt when claude.md is whitespace only", async () => {
      const fs = mockFileSystem("   \n\t  \n  ");
      const service = new ChatService(null, fs, NO_TEMPLATE);
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

      const service = new ChatService(null, fs, NO_TEMPLATE);
      const { session, warning } = await service.startSession();

      expect(session.systemPrompt).toBe("You are a helpful assistant.");
      expect(warning).toBeDefined();
      expect(warning).toContain("Permission denied");
    });
  });

  describe("bundled CLAUDE.md template fallback", () => {
    const TEMPLATE = "# Bundled template\n\nYou are the wiki maintainer.";
    const loadTemplate = (): Promise<string | null> => Promise.resolve(TEMPLATE);

    it("uses the template when vault CLAUDE.md is missing (ENOENT)", async () => {
      const fs = {
        readRawFile: vi.fn().mockRejectedValue(
          Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
        ),
      } as unknown as FileSystemService;
      const service = new ChatService(null, fs, loadTemplate);
      const { session, warning } = await service.startSession();
      expect(session.systemPrompt).toBe(TEMPLATE);
      expect(warning).toBeUndefined();
    });

    it("uses the template when vault CLAUDE.md is empty", async () => {
      const fs = mockFileSystem("");
      const service = new ChatService(null, fs, loadTemplate);
      const { session, warning } = await service.startSession();
      expect(session.systemPrompt).toBe(TEMPLATE);
      expect(warning).toBeUndefined();
    });

    it("uses the template when vault CLAUDE.md is whitespace only", async () => {
      const fs = mockFileSystem("   \n\t  ");
      const service = new ChatService(null, fs, loadTemplate);
      const { session } = await service.startSession();
      expect(session.systemPrompt).toBe(TEMPLATE);
    });

    it("vault CLAUDE.md still wins over the template when non-empty", async () => {
      const fs = mockFileSystem("Vault override prompt");
      const service = new ChatService(null, fs, loadTemplate);
      const { session } = await service.startSession();
      expect(session.systemPrompt).toBe("Vault override prompt");
    });

    it("falls back to the trivial default when the template is also missing", async () => {
      const fs = mockFileSystem("");
      const service = new ChatService(null, fs, NO_TEMPLATE);
      const { session } = await service.startSession();
      expect(session.systemPrompt).toBe("You are a helpful assistant.");
    });

    it("propagates a warning AND uses the template on EACCES", async () => {
      const fs = {
        readRawFile: vi.fn().mockRejectedValue(
          Object.assign(new Error("Permission denied"), { code: "EACCES" }),
        ),
      } as unknown as FileSystemService;
      const service = new ChatService(null, fs, loadTemplate);
      const { session, warning } = await service.startSession();
      expect(session.systemPrompt).toBe(TEMPLATE);
      expect(warning).toBeDefined();
      expect(warning).toContain("Permission denied");
    });
  });

  describe("system prompt is injected on ingest path (contentBlocks)", () => {
    /**
     * The /ingest UX shoves a ChatContentBlock[] payload into sendMessage
     * (instead of a plain string). The vault's CLAUDE.md (or its bundled
     * template fallback) must still drive the system message — otherwise
     * ingested PDFs/images would be processed without the wiki conventions.
     */
    it("vault CLAUDE.md is sent as system message even when payload is ChatContentBlock[]", async () => {
      const fs = mockFileSystem("VAULT PROMPT FROM CLAUDE.MD");
      const captured: Array<{ role: string; content: unknown }>[] = [];
      const llm = mockLLMServiceCapture(
        captured as Array<{ role: string; content: string }>[],
      );
      const service = new ChatService(llm, fs, NO_TEMPLATE);
      await service.startSession();

      const blocks = [
        { type: "text" as const, text: "ingested file contents…" },
        {
          type: "image_url" as const,
          image_url: { url: "data:image/png;base64,xxx", detail: "high" as const },
        },
      ];
      await drainGenerator(service.sendMessage("/ingest foo.png", blocks));

      expect(captured.length).toBe(1);
      const sent = captured[0];
      expect(sent[0].role).toBe("system");
      expect(sent[0].content).toBe("VAULT PROMPT FROM CLAUDE.MD");

      // The user message should carry the ContentBlock[] payload, not the
      // plain string — proves the ingest substitution happens AND the system
      // prompt still leads the request.
      const lastUser = sent[sent.length - 1];
      expect(lastUser.role).toBe("user");
      expect(Array.isArray(lastUser.content)).toBe(true);
      expect(lastUser.content).toEqual(blocks);
    });

    it("falls back to bundled template on ingest when vault has no CLAUDE.md", async () => {
      const TEMPLATE = "BUNDLED TEMPLATE";
      const loadTemplate = (): Promise<string | null> =>
        Promise.resolve(TEMPLATE);
      const fs = {
        readRawFile: vi.fn().mockRejectedValue(
          Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
        ),
      } as unknown as FileSystemService;
      const captured: Array<{ role: string; content: unknown }>[] = [];
      const llm = mockLLMServiceCapture(
        captured as Array<{ role: string; content: string }>[],
      );
      const service = new ChatService(llm, fs, loadTemplate);
      await service.startSession();

      const blocks = [{ type: "text" as const, text: "ingest body" }];
      await drainGenerator(service.sendMessage("/ingest x.txt", blocks));

      expect(captured.length).toBe(1);
      expect(captured[0][0].role).toBe("system");
      expect(captured[0][0].content).toBe(TEMPLATE);
    });

    it("falls back to trivial default on ingest when both vault file AND template are missing", async () => {
      const fs = {
        readRawFile: vi.fn().mockRejectedValue(
          Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
        ),
      } as unknown as FileSystemService;
      const captured: Array<{ role: string; content: unknown }>[] = [];
      const llm = mockLLMServiceCapture(
        captured as Array<{ role: string; content: string }>[],
      );
      const service = new ChatService(llm, fs, NO_TEMPLATE);
      await service.startSession();

      await drainGenerator(
        service.sendMessage("/ingest x.txt", [
          { type: "text" as const, text: "body" },
        ]),
      );

      expect(captured[0][0].role).toBe("system");
      expect(captured[0][0].content).toBe("You are a helpful assistant.");
    });
  });

  describe("reloadClaudeMd on sendMessage", () => {
    it("re-reads CLAUDE.md into session.systemPrompt before the LLM request", async () => {
      let readCount = 0;
      const fs = {
        readRawFile: vi.fn(async () => {
          readCount += 1;
          return readCount === 1 ? "first-prompt" : "second-prompt";
        }),
      } as unknown as FileSystemService;
      const captured: Array<{ role: string; content: unknown }[]> = [];
      const llm = {
        callNonStreaming: vi.fn(async (messages: Array<{ role: string; content: unknown }>) => {
          captured.push([...messages]);
          return { content: "done", toolCalls: null };
        }),
        generateChat: vi.fn(),
      } as unknown as LLMService;
      const service = new ChatService(llm, fs, NO_TEMPLATE);
      await service.startSession();
      expect(service.getSession()!.systemPrompt).toBe("first-prompt");

      await drainGenerator(service.sendMessage("hello", undefined, { reloadClaudeMd: true }));

      expect(service.getSession()!.systemPrompt).toBe("second-prompt");
      expect(captured.length).toBeGreaterThanOrEqual(1);
      expect(captured[0][0].role).toBe("system");
      expect(captured[0][0].content).toBe("second-prompt");
    });
  });

  describe("INGEST.md concatenation", () => {
    /**
     * INGEST.md should be appended to whichever CLAUDE.md the loader
     * resolves (vault override OR bundled template) — but NOT to the
     * trivial DEFAULT_SYSTEM_PROMPT, because that path means everything
     * else broke and muddling it with extraction protocol would just
     * confuse the user.
     */
    const INGEST_TMPL = "## INGEST PROTOCOL\nuse ingest_source.";
    const loadIngest = (): Promise<string | null> => Promise.resolve(INGEST_TMPL);

    it("appends INGEST.md to vault CLAUDE.md", async () => {
      const fs = mockFileSystem("VAULT CLAUDE");
      const service = new ChatService(null, fs, NO_TEMPLATE, loadIngest);
      const { session } = await service.startSession();
      expect(session.systemPrompt).toBe(`VAULT CLAUDE\n\n${INGEST_TMPL}`);
    });

    it("appends INGEST.md to bundled CLAUDE.md template", async () => {
      const fs = mockFileSystem("");
      const TEMPLATE = "BUNDLED CLAUDE";
      const loadTemplate = (): Promise<string | null> =>
        Promise.resolve(TEMPLATE);
      const service = new ChatService(null, fs, loadTemplate, loadIngest);
      const { session } = await service.startSession();
      expect(session.systemPrompt).toBe(`${TEMPLATE}\n\n${INGEST_TMPL}`);
    });

    it("does NOT append INGEST.md to the trivial default prompt", async () => {
      const fs = mockFileSystem("");
      const service = new ChatService(null, fs, NO_TEMPLATE, loadIngest);
      const { session } = await service.startSession();
      // Trivial default fires when both vault file AND bundled template
      // are unavailable. Adding ingest protocol here would be misleading.
      expect(session.systemPrompt).toBe("You are a helpful assistant.");
    });

    it("tolerates a missing/empty INGEST.md (just uses base prompt)", async () => {
      const fs = mockFileSystem("VAULT CLAUDE");
      const service = new ChatService(null, fs, NO_TEMPLATE, NO_TEMPLATE);
      const { session } = await service.startSession();
      expect(session.systemPrompt).toBe("VAULT CLAUDE");
    });

    it("tolerates an INGEST.md loader that throws (just uses base prompt)", async () => {
      const fs = mockFileSystem("VAULT CLAUDE");
      const failingIngest = (): Promise<string | null> => {
        throw new Error("fs blew up");
      };
      const service = new ChatService(null, fs, NO_TEMPLATE, failingIngest);
      const { session } = await service.startSession();
      expect(session.systemPrompt).toBe("VAULT CLAUDE");
    });

    /**
     * Pin the contract: even a one-line vault CLAUDE.md still gets the full
     * INGEST.md appended. Guards against a future "optimisation" that skips
     * INGEST.md for short prompts — the ingest protocol is part of the
     * product contract, not a length-gated nice-to-have.
     */
    it("appends INGEST.md to a one-line vault CLAUDE.md", async () => {
      const fs = mockFileSystem("hi");
      const service = new ChatService(null, fs, NO_TEMPLATE, loadIngest);
      const { session } = await service.startSession();
      expect(session.systemPrompt).toBe(`hi\n\n${INGEST_TMPL}`);
    });
  });

  describe("new session clears history", () => {
    it("clears message history when starting a new session", async () => {
      const fs = mockFileSystem("system prompt");
      const llm = mockLLMService(["response"]);
      const service = new ChatService(llm, fs, NO_TEMPLATE);

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

// ── stripHeavyDataUrlsFromText ───────────────────────────────────

describe("stripHeavyDataUrlsFromText", () => {
  it("keeps short base64 data URLs unchanged", () => {
    const short = `![](data:image/png;base64,${"A".repeat(200)})`;
    expect(stripHeavyDataUrlsFromText(short)).toBe(short);
  });

  it("replaces long data:image URLs with a placeholder", () => {
    const b64 = "A".repeat(2000);
    const input = `intro ![](data:image/png;base64,${b64}) outro`;
    const out = stripHeavyDataUrlsFromText(input);
    expect(out).toContain("intro ");
    expect(out).toContain(" outro");
    expect(out).toMatch(/\[omitted ~[\d.]+ KiB base64 data URL from an earlier message\]/);
    expect(out).not.toContain(b64.slice(0, 80));
  });

  it("handles application/pdf data URLs", () => {
    const b64 = "B".repeat(2000);
    const input = `x data:application/pdf;base64,${b64} y`;
    const out = stripHeavyDataUrlsFromText(input);
    expect(out).toContain("x ");
    expect(out).toContain(" y");
    expect(out).not.toContain(b64.slice(0, 80));
  });
});

// ── clampShellTimeout ────────────────────────────────────────────

/**
 * The model can pass an arbitrary `timeout_seconds` on shell tool calls.
 * Pinning the clamp behaviour here so we don't accidentally let a 999999s
 * value past (which would defeat the whole timeout-protection point) or
 * trip on negative / NaN inputs that some gateways emit.
 */
describe("clampShellTimeout", () => {
  it("returns the default when timeout_seconds is undefined", () => {
    expect(clampShellTimeout(undefined)).toBe(30);
  });

  it("returns the default for non-numeric input", () => {
    expect(clampShellTimeout("not a number")).toBe(30);
    expect(clampShellTimeout(null)).toBe(30);
    expect(clampShellTimeout({})).toBe(30);
    expect(clampShellTimeout(NaN)).toBe(30);
  });

  it("returns the default for Infinity", () => {
    // Both ±Infinity fail Number.isFinite — they should fall back, not
    // get clamped to the upper bound (which would be subtly wrong).
    expect(clampShellTimeout(Infinity)).toBe(30);
    expect(clampShellTimeout(-Infinity)).toBe(30);
  });

  it("clamps below-1 values up to 1", () => {
    expect(clampShellTimeout(0)).toBe(1);
    expect(clampShellTimeout(0.5)).toBe(1);
    expect(clampShellTimeout(-100)).toBe(1);
  });

  it("clamps above-600 values down to 600", () => {
    expect(clampShellTimeout(601)).toBe(600);
    expect(clampShellTimeout(99999)).toBe(600);
  });

  it("rounds fractional seconds to the nearest integer", () => {
    expect(clampShellTimeout(60.4)).toBe(60);
    expect(clampShellTimeout(60.5)).toBe(61);
  });

  it("accepts numeric strings (gateway sometimes serialises numbers)", () => {
    // A few gateways round-trip JSON numbers through strings; mirror that.
    expect(clampShellTimeout("120")).toBe(120);
    expect(clampShellTimeout("0")).toBe(1);
    expect(clampShellTimeout("700")).toBe(600);
  });

  it("preserves valid in-range values", () => {
    expect(clampShellTimeout(1)).toBe(1);
    expect(clampShellTimeout(30)).toBe(30);
    expect(clampShellTimeout(120)).toBe(120);
    expect(clampShellTimeout(600)).toBe(600);
  });
});

// ── request_user_confirmation tool ───────────────────────────────

/**
 * `request_user_confirmation` is the shared entrypoint for any model-
 * initiated yes/no prompt. Exercising it via the private `executeTool`
 * shim keeps the surface narrow — we don't need to drive a full LLM
 * round-trip to pin the contract the renderer depends on.
 */
describe("ChatService request_user_confirmation tool", () => {
  type ConfirmCall = Parameters<Parameters<ChatService["setConfirmationService"]>[0] extends null ? never : NonNullable<Parameters<ChatService["setConfirmationService"]>[0]>["request"]>[0];

  function buildService(
    respond: (opts: ConfirmCall) => Promise<boolean> | boolean,
  ): { chat: ChatService; calls: ConfirmCall[] } {
    const chat = new ChatService(
      mockLLMService([]),
      mockFileSystem(""),
    );
    const calls: ConfirmCall[] = [];
    chat.setConfirmationService({
      request: async (opts) => {
        calls.push(opts);
        return Promise.resolve(respond(opts));
      },
    });
    return { chat, calls };
  }

  async function invokeTool(
    chat: ChatService,
    args: Record<string, unknown>,
  ): Promise<string> {
    // Reach into the private method — the public tool surface is driven
    // by the LLM stream, which is overkill for a unit test.
    const run = (chat as unknown as {
      executeTool: (name: string, argsJson: string) => Promise<{ output: string }>;
    }).executeTool;
    const result = await run.call(chat, "request_user_confirmation", JSON.stringify(args));
    return result.output;
  }

  it("returns [confirm ok] on approval and forwards all fields", async () => {
    const { chat, calls } = buildService(() => true);
    const out = await invokeTool(chat, {
      title: "Overwrite index.md?",
      description: "Replaces 12 entries with 15.",
      confirm_label: "Overwrite",
      cancel_label: "Abort",
      tone: "warning",
    });
    expect(out).toMatch(/^\[confirm ok\]/);
    expect(out).toContain("approved");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      title: "Overwrite index.md?",
      description: "Replaces 12 entries with 15.",
      confirmLabel: "Overwrite",
      cancelLabel: "Abort",
      tone: "warning",
    });
  });

  it("returns [confirm cancelled] on decline", async () => {
    const { chat } = buildService(() => false);
    const out = await invokeTool(chat, { title: "Delete 7 files?" });
    expect(out).toMatch(/^\[confirm cancelled\]/);
    expect(out).toContain("Do NOT proceed");
  });

  it("rejects missing title with bad-args", async () => {
    const { chat, calls } = buildService(() => true);
    const out = await invokeTool(chat, { description: "no title" });
    expect(out).toMatch(/^\[confirm error bad-args\]/);
    expect(calls).toHaveLength(0);
  });

  it("rejects empty/whitespace title with bad-args", async () => {
    const { chat, calls } = buildService(() => true);
    const out = await invokeTool(chat, { title: "   " });
    expect(out).toMatch(/^\[confirm error bad-args\]/);
    expect(calls).toHaveLength(0);
  });

  it("returns no-channel when no confirmation service is wired", async () => {
    const chat = new ChatService(mockLLMService([]), mockFileSystem(""));
    // Explicitly leave the confirmation service unset — simulates the CLI
    // / test harness where there's no renderer to talk to.
    const run = (chat as unknown as {
      executeTool: (name: string, argsJson: string) => Promise<{ output: string }>;
    }).executeTool;
    const { output: out } = await run.call(
      chat,
      "request_user_confirmation",
      JSON.stringify({ title: "x" }),
    );
    expect(out).toMatch(/^\[confirm error no-channel\]/);
  });

  it("treats thrown dispatch errors as cancel to avoid fail-open", async () => {
    const chat = new ChatService(mockLLMService([]), mockFileSystem(""));
    chat.setConfirmationService({
      request: async () => {
        throw new Error("webContents went away");
      },
    });
    const out = await invokeTool(chat, { title: "x" });
    expect(out).toMatch(/^\[confirm error dispatch-failed\]/);
    expect(out).toContain("webContents went away");
    expect(out).toContain("cancel");
  });

  it("silently drops invalid tone instead of passing it through", async () => {
    const { chat, calls } = buildService(() => true);
    await invokeTool(chat, { title: "x", tone: "nuclear" });
    expect(calls).toHaveLength(1);
    expect(calls[0].tone).toBeUndefined();
  });

  it("ignores non-string label / description fields", async () => {
    const { chat, calls } = buildService(() => true);
    await invokeTool(chat, {
      title: "x",
      description: 42,
      confirm_label: true,
      cancel_label: null,
    });
    expect(calls[0]).toEqual({
      title: "x",
      description: undefined,
      confirmLabel: undefined,
      cancelLabel: undefined,
      tone: undefined,
    });
  });
});

// ── compactExtraMessages ─────────────────────────────────────────

/**
 * The tool loop re-sends every prior tool result on each planning call.
 * compactExtraMessages keeps the most recent results full and elides older
 * oversized ones so context doesn't grow O(n²) and trip the timeout.
 */
describe("compactExtraMessages", () => {
  const big = (n: number) => "x".repeat(n);
  const toolMsg = (content: string, id: string) => ({
    role: "tool",
    content,
    tool_call_id: id,
  });

  it("returns the input unchanged when there are <= 2 tool results", () => {
    const msgs = [
      { role: "assistant", content: "thinking" },
      toolMsg(big(9000), "a"),
      toolMsg(big(9000), "b"),
    ];
    expect(compactExtraMessages(msgs)).toBe(msgs);
  });

  it("elides older oversized tool results but keeps the latest two full", () => {
    const oldBody = `[ingest_source ok kind=text]\n${big(9000)}`;
    const midBody = `[exit: 0]\n${big(9000)}`;
    const recentA = big(9000);
    const recentB = big(9000);
    const msgs = [
      toolMsg(oldBody, "old"),
      toolMsg(midBody, "mid"),
      toolMsg(recentA, "rA"),
      toolMsg(recentB, "rB"),
    ];
    const out = compactExtraMessages(msgs);
    // Oldest two elided
    expect(out[0].content).toContain("[ingest_source ok kind=text]");
    expect(out[0].content).toContain("elided to save context");
    expect(out[1].content).toContain("elided to save context");
    // Most recent two preserved verbatim
    expect(out[2].content).toBe(recentA);
    expect(out[3].content).toBe(recentB);
  });

  it("does not elide small older results below the threshold", () => {
    const small = "short result";
    const msgs = [
      toolMsg(small, "old"),
      toolMsg(big(9000), "rA"),
      toolMsg(big(9000), "rB"),
    ];
    const out = compactExtraMessages(msgs);
    expect(out[0].content).toBe(small);
  });

  it("ignores non-tool messages when counting the keep window", () => {
    const msgs = [
      toolMsg(big(9000), "old"),
      { role: "assistant", content: "narration" },
      toolMsg(big(9000), "rA"),
      toolMsg(big(9000), "rB"),
    ];
    const out = compactExtraMessages(msgs);
    expect(out[0].content).toContain("elided to save context");
    expect(out[1].content).toBe("narration");
    expect(out[2].content).toBe(big(9000));
    expect(out[3].content).toBe(big(9000));
  });
});

// ── isCatalogFullRead ────────────────────────────────────────────

describe("isCatalogFullRead", () => {
  it("flags a full cat of a hub file", () => {
    expect(isCatalogFullRead("cat wiki/index.md")).toBe(true);
    expect(isCatalogFullRead("cat wiki/glossary.md")).toBe(true);
    expect(isCatalogFullRead("cat wiki/overview.md")).toBe(true);
    expect(isCatalogFullRead("cat wiki/log.md")).toBe(true);
  });

  it("does not flag narrowing reads of a hub file", () => {
    expect(isCatalogFullRead("grep -i term wiki/index.md")).toBe(false);
    expect(isCatalogFullRead("head -n 40 wiki/index.md")).toBe(false);
    expect(isCatalogFullRead("tail -n 30 wiki/log.md")).toBe(false);
    expect(isCatalogFullRead("wc -l wiki/index.md")).toBe(false);
  });

  it("does not flag non-hub files", () => {
    expect(isCatalogFullRead("cat wiki/sources/foo.md")).toBe(false);
    expect(isCatalogFullRead("cat raw/report.txt")).toBe(false);
  });
});

// ── search_wiki tool ─────────────────────────────────────────────

describe("ChatService search_wiki tool", () => {
  type SearchResultLite = { title: string; filename: string; excerpt: string };

  function buildService(
    search?: (query: string) => Promise<SearchResultLite[]>,
  ): ChatService {
    const chat = new ChatService(mockLLMService([]), mockFileSystem(""));
    if (search) chat.setSearchIndex({ search });
    return chat;
  }

  async function invoke(chat: ChatService, args: Record<string, unknown>): Promise<string> {
    const run = (chat as unknown as {
      executeTool: (name: string, argsJson: string) => Promise<{ output: string }>;
    }).executeTool;
    const result = await run.call(chat, "search_wiki", JSON.stringify(args));
    return result.output;
  }

  it("returns an error when no search index is wired", async () => {
    const chat = buildService();
    const out = await invoke(chat, { query: "transformers" });
    expect(out).toMatch(/^\[search_wiki error\]/);
  });

  it("rejects an empty query", async () => {
    const chat = buildService(async () => []);
    const out = await invoke(chat, { query: "   " });
    expect(out).toMatch(/^\[search_wiki error\]/);
  });

  it("formats matches as title | filename | excerpt and respects limit", async () => {
    const results: SearchResultLite[] = [
      { title: "Transformer", filename: "wiki/concepts/transformer.md", excerpt: "An  architecture\nwith attention" },
      { title: "Attention", filename: "wiki/concepts/attention.md", excerpt: "scaled dot product" },
      { title: "BERT", filename: "wiki/entities/bert.md", excerpt: "bidirectional" },
    ];
    const chat = buildService(async () => results);
    const out = await invoke(chat, { query: "attention", limit: 2 });
    expect(out).toMatch(/^\[search_wiki ok\]/);
    expect(out).toContain("2 of 3 matches");
    expect(out).toContain("- Transformer | wiki/concepts/transformer.md | An architecture with attention");
    expect(out).toContain("- Attention | wiki/concepts/attention.md | scaled dot product");
    expect(out).not.toContain("BERT");
  });

  it("reports no matches cleanly", async () => {
    const chat = buildService(async () => []);
    const out = await invoke(chat, { query: "nonexistent" });
    expect(out).toMatch(/^\[search_wiki ok\]/);
    expect(out).toContain("No pages matched");
  });
});

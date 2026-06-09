import { describe, it, expect } from "vitest";
import {
  messagesToResponsesInput,
  toolsToResponsesTools,
  parseResponsesOutput,
  parseResponsesStreamEvent,
  applyChatPromptCaching,
  type CanonicalMessage,
} from "./llm-service";

/**
 * Pure-function tests for the OpenAI Responses API translators.
 *
 * These pin the wire-format contract: how our canonical (Chat-Completions-
 * shaped) message format maps to the Responses API's `input[]` items,
 * how Responses API output gets folded back into the canonical
 * `{ content, toolCalls }` shape the rest of the codebase expects, and
 * how individual SSE delta events become `ChatChunk`-like values.
 */

// ── messagesToResponsesInput ──────────────────────────────────────

describe("messagesToResponsesInput", () => {
  it("converts a plain user text message into a user role item with input_text", () => {
    const out = messagesToResponsesInput([
      { role: "user", content: "Hello" },
    ]);
    expect(out).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Hello" }] },
    ]);
  });

  it("uses output_text for assistant role text", () => {
    const out = messagesToResponsesInput([
      { role: "assistant", content: "Reply" },
    ]);
    expect(out).toEqual([
      { role: "assistant", content: [{ type: "output_text", text: "Reply" }] },
    ]);
  });

  it("keeps the system role as-is (Responses API accepts both system and developer)", () => {
    const out = messagesToResponsesInput([
      { role: "system", content: "You are helpful." },
    ]);
    expect(out).toEqual([
      { role: "system", content: [{ type: "input_text", text: "You are helpful." }] },
    ]);
  });

  it("emits an empty content array when content is null", () => {
    const out = messagesToResponsesInput([{ role: "user", content: null }]);
    expect(out).toEqual([{ role: "user", content: [] }]);
  });

  it("translates image_url content blocks into input_image with flattened url", () => {
    const out = messagesToResponsesInput([
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AAAA", detail: "high" },
          },
        ],
      },
    ]);
    expect(out).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "look at this" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,AAAA",
            detail: "high",
          },
        ],
      },
    ]);
  });

  it("translates file content blocks into input_file with file_id + filename", () => {
    const out = messagesToResponsesInput([
      {
        role: "user",
        content: [
          {
            type: "file",
            file: { file_id: "file-abc", filename: "slides.pptx" },
          },
        ],
      },
    ]);
    expect(out).toEqual([
      {
        role: "user",
        content: [
          { type: "input_file", file_id: "file-abc", filename: "slides.pptx" },
        ],
      },
    ]);
  });

  it("turns a tool-result message into a top-level function_call_output item", () => {
    const out = messagesToResponsesInput([
      {
        role: "tool",
        tool_call_id: "call_123",
        content: "[ingest_source ok kind=text]\n\nhi",
      },
    ]);
    expect(out).toEqual([
      {
        type: "function_call_output",
        call_id: "call_123",
        output: "[ingest_source ok kind=text]\n\nhi",
      },
    ]);
  });

  it("emits assistant text first, then function_call items, when both are present", () => {
    const out = messagesToResponsesInput([
      {
        role: "assistant",
        content: "Let me check.",
        tool_calls: [
          {
            id: "call_a",
            function: { name: "shell", arguments: '{"command":"ls"}' },
          },
        ],
      },
    ]);
    expect(out).toEqual([
      {
        role: "assistant",
        content: [{ type: "output_text", text: "Let me check." }],
      },
      {
        type: "function_call",
        call_id: "call_a",
        name: "shell",
        arguments: '{"command":"ls"}',
      },
    ]);
  });

  it("emits only function_call items when assistant has null content", () => {
    const out = messagesToResponsesInput([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_b",
            function: { name: "ingest_source", arguments: '{"path":"raw/x.pdf"}' },
          },
        ],
      },
    ]);
    expect(out).toEqual([
      {
        type: "function_call",
        call_id: "call_b",
        name: "ingest_source",
        arguments: '{"path":"raw/x.pdf"}',
      },
    ]);
  });

  it("preserves chronological order across multiple turns with tool roundtrips", () => {
    const messages: CanonicalMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            function: { name: "shell", arguments: '{"command":"ls"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "[ok]" },
      { role: "assistant", content: "done" },
    ];
    const out = messagesToResponsesInput(messages);
    expect(out.map((i) => (i.type ? i.type : (i as any).role))).toEqual([
      "system",
      "user",
      "function_call",
      "function_call_output",
      "assistant",
    ]);
  });
});

// ── toolsToResponsesTools ─────────────────────────────────────────

describe("toolsToResponsesTools", () => {
  it("flattens Chat-Completions function tool defs", () => {
    const input = [
      {
        type: "function",
        function: {
          name: "shell",
          description: "Run a shell command.",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    expect(toolsToResponsesTools(input)).toEqual([
      {
        type: "function",
        name: "shell",
        description: "Run a shell command.",
        parameters: { type: "object", properties: {} },
      },
    ]);
  });

  it("preserves the strict flag when set", () => {
    const input = [
      {
        type: "function",
        function: {
          name: "x",
          parameters: {},
          strict: true,
        },
      },
    ];
    const out = toolsToResponsesTools(input) as Array<Record<string, unknown>>;
    expect(out[0].strict).toBe(true);
  });

  it("passes unknown tool types through unchanged (forward compat)", () => {
    const t = { type: "file_search", vector_store_ids: ["vs_1"] };
    expect(toolsToResponsesTools([t])).toEqual([t]);
  });
});

// ── parseResponsesOutput ──────────────────────────────────────────

describe("parseResponsesOutput", () => {
  it("concatenates output_text parts from a single assistant message", () => {
    const result = parseResponsesOutput({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "Hello, " },
            { type: "output_text", text: "world." },
          ],
        },
      ],
    });
    expect(result.content).toBe("Hello, world.");
    expect(result.toolCalls).toBeNull();
  });

  it("lifts function_call items into the canonical tool_calls shape", () => {
    const result = parseResponsesOutput({
      output: [
        {
          type: "function_call",
          call_id: "call_xyz",
          name: "shell",
          arguments: '{"command":"ls"}',
        },
      ],
    });
    expect(result.content).toBeNull();
    expect(result.toolCalls).toEqual([
      {
        id: "call_xyz",
        function: { name: "shell", arguments: '{"command":"ls"}' },
      },
    ]);
  });

  it("handles a mixed response (assistant narration + multiple tool calls)", () => {
    const result = parseResponsesOutput({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Let me check both." }],
        },
        {
          type: "function_call",
          call_id: "c1",
          name: "shell",
          arguments: '{"command":"ls"}',
        },
        {
          type: "function_call",
          call_id: "c2",
          name: "ingest_source",
          arguments: '{"path":"raw/x.pdf"}',
        },
      ],
    });
    expect(result.content).toBe("Let me check both.");
    expect(result.toolCalls).toEqual([
      { id: "c1", function: { name: "shell", arguments: '{"command":"ls"}' } },
      {
        id: "c2",
        function: {
          name: "ingest_source",
          arguments: '{"path":"raw/x.pdf"}',
        },
      },
    ]);
  });

  it("returns nulls when output is empty / malformed", () => {
    expect(parseResponsesOutput({ output: [] })).toEqual({
      content: null,
      toolCalls: null,
    });
    expect(parseResponsesOutput({})).toEqual({
      content: null,
      toolCalls: null,
    });
    expect(parseResponsesOutput(null)).toEqual({
      content: null,
      toolCalls: null,
    });
  });
});

// ── parseResponsesStreamEvent ─────────────────────────────────────

describe("parseResponsesStreamEvent", () => {
  it("emits a text chunk for response.output_text.delta", () => {
    expect(
      parseResponsesStreamEvent({
        type: "response.output_text.delta",
        delta: "Hi",
      }),
    ).toEqual({ type: "text", content: "Hi" });
  });

  it("emits a thinking chunk for response.reasoning_summary_text.delta", () => {
    expect(
      parseResponsesStreamEvent({
        type: "response.reasoning_summary_text.delta",
        delta: "considering options...",
      }),
    ).toEqual({ type: "thinking", content: "considering options..." });
  });

  it("emits a thinking chunk for response.reasoning.delta (alt naming)", () => {
    expect(
      parseResponsesStreamEvent({
        type: "response.reasoning.delta",
        delta: "step 1",
      }),
    ).toEqual({ type: "thinking", content: "step 1" });
  });

  it("returns null for events we don't care about (output_item.added, function_call.delta, etc.)", () => {
    expect(
      parseResponsesStreamEvent({
        type: "response.output_item.added",
        item: { type: "message" },
      }),
    ).toBeNull();
    expect(
      parseResponsesStreamEvent({
        type: "response.function_call_arguments.delta",
        delta: '{"cmd"',
      }),
    ).toBeNull();
    expect(
      parseResponsesStreamEvent({ type: "response.created" }),
    ).toBeNull();
  });

  it("returns null when delta is missing or empty", () => {
    expect(
      parseResponsesStreamEvent({ type: "response.output_text.delta" }),
    ).toBeNull();
    expect(
      parseResponsesStreamEvent({
        type: "response.output_text.delta",
        delta: "",
      }),
    ).toBeNull();
  });

  it("returns null on malformed input", () => {
    expect(parseResponsesStreamEvent(null)).toBeNull();
    expect(parseResponsesStreamEvent({})).toBeNull();
    expect(parseResponsesStreamEvent("just a string")).toBeNull();
  });
});

// ── applyChatPromptCaching ────────────────────────────────────────

describe("applyChatPromptCaching", () => {
  const convo: CanonicalMessage[] = [
    { role: "system", content: "Big stable system prompt" },
    { role: "user", content: "ingest foo.pdf" },
  ];

  it("OpenAI: adds prompt_cache_key and leaves messages untouched", () => {
    const { messages, bodyParams } = applyChatPromptCaching(
      convo,
      true,
      "lumina-wiki",
    );
    expect(messages).toBe(convo);
    expect(messages[0].content).toBe("Big stable system prompt");
    expect(bodyParams).toEqual({ prompt_cache_key: "lumina-wiki" });
  });

  it("non-OpenAI: marks the first system message with an ephemeral cache breakpoint", () => {
    const { messages, bodyParams } = applyChatPromptCaching(
      convo,
      false,
      "lumina-wiki",
    );
    expect(bodyParams).toEqual({});
    expect(messages[0].content).toEqual([
      {
        type: "text",
        text: "Big stable system prompt",
        cache_control: { type: "ephemeral" },
      },
    ]);
    // user message is left as a plain string
    expect(messages[1].content).toBe("ingest foo.pdf");
  });

  it("non-OpenAI: only marks the first system message", () => {
    const two: CanonicalMessage[] = [
      { role: "system", content: "first" },
      { role: "system", content: "second" },
    ];
    const { messages } = applyChatPromptCaching(two, false, "k");
    expect(Array.isArray(messages[0].content)).toBe(true);
    expect(messages[1].content).toBe("second");
  });

  it("non-OpenAI: skips a system message whose content is already an array", () => {
    const blocks: CanonicalMessage[] = [
      { role: "system", content: [{ type: "text", text: "already blocks" }] },
    ];
    const { messages } = applyChatPromptCaching(blocks, false, "k");
    expect(messages[0].content).toEqual([
      { type: "text", text: "already blocks" },
    ]);
  });
});

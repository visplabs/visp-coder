import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { mcpProductFeedbackHost } from "../../../src/mcp/product-feedback-host.js";
import { productReviewInstructions } from "../../../src/workflow/product/review/review-instructions.js";

describe("MCP configured host feedback", () => {
  it.each([
    { timeoutMs: undefined, passes: true },
    { timeoutMs: 90_000, passes: true },
    { timeoutMs: 30_000, passes: false },
  ])(
    "respects the host deadline $timeoutMs for a delayed sampling response",
    async ({ timeoutMs, passes }) => {
      const server = new McpServer({ name: "deadline-server", version: "1" });
      const client = new Client(
        { name: "deadline-client", version: "1" },
        { capabilities: { sampling: {} } },
      );
      client.setRequestHandler(CreateMessageRequestSchema, async () => {
        await new Promise((resolve) => setTimeout(resolve, 75_000));
        return {
          role: "assistant" as const,
          model: "delayed-fixture",
          content: { type: "text" as const, text: '{"assessments":[]}' },
        };
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        vi.useFakeTimers();
        const review = mcpProductFeedbackHost(server).review;
        if (!review) throw new Error("Missing sampling adapter");
        const result = review({ images: [] } as unknown as Parameters<typeof review>[0], {
          model: "host-configured",
          signal: new AbortController().signal,
          context: "fresh-preferred",
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }).then(
          (value) => ({ value }),
          (error) => ({ error: String(error) }),
        );
        await vi.advanceTimersByTimeAsync(75_000);
        expect(await result).toEqual(
          passes
            ? { value: { assessments: [] } }
            : { error: expect.stringContaining("Request timed out") },
        );
      } finally {
        vi.useRealTimers();
        await client.close();
        await server.close();
      }
    },
  );

  it("does not pretend to dispatch when sampling is absent", () => {
    const server = { server: { getClientCapabilities: () => ({}) } } as unknown as McpServer;
    expect(mcpProductFeedbackHost(server)).toEqual({ model: "host-configured" });
  });

  it("dispatches native images in a separate context, without overriding model preferences", async () => {
    const createMessage = vi.fn(async (_params: unknown, _options: unknown) => ({
      content: { type: "text", text: '{"assessments":[]}' },
    }));
    const server = {
      server: { getClientCapabilities: () => ({ sampling: {} }), createMessage },
    } as unknown as McpServer;
    const review = mcpProductFeedbackHost(server).review;
    if (!review) throw new Error("Missing sampling adapter");
    const request = {
      instructions: productReviewInstructions({ visual: true }),
      images: [{ data: "actual-image-bytes", mimeType: "image/png" }],
      originalRequest: "Preserved goal",
    } as unknown as Parameters<typeof review>[0];
    const signal = new AbortController().signal;
    expect(
      await review(request, { model: "host-configured", signal, context: "fresh-preferred" }),
    ).toEqual({ assessments: [] });
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining(request.instructions),
        includeContext: "none",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: '{"originalRequest":"Preserved goal"}' },
              { type: "image", data: "actual-image-bytes", mimeType: "image/png" },
            ],
          },
        ],
      }),
      { signal, timeout: 120_000 },
    );
    expect(createMessage.mock.calls[0]?.[0]).not.toHaveProperty("modelPreferences");
  });

  it.each([
    { type: "image", data: "bytes" },
    { type: "text", text: "not JSON" },
  ])("refuses unusable host results", async (content) => {
    const server = {
      server: {
        getClientCapabilities: () => ({ sampling: {} }),
        createMessage: async () => ({ content }),
      },
    } as unknown as McpServer;
    const review = mcpProductFeedbackHost(server).review;
    if (!review) throw new Error("Missing sampling adapter");
    await expect(
      review({ images: [] } as unknown as Parameters<typeof review>[0], {
        model: "host-configured",
        signal: new AbortController().signal,
        context: "fresh-preferred",
      }),
    ).rejects.toThrow();
  });
});

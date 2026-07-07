import { describe, expect, it } from "vitest";
import { LightRagKnowledgeFoundation } from "./adapter.js";

type Captured = { url: string; init: RequestInit };

function mockFetch(
  body: unknown,
  opts: { ok?: boolean; status?: number } = {},
): { fetchImpl: (url: string, init: RequestInit) => Promise<Response>; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => body,
    } as Response;
  };
  return { fetchImpl, calls };
}

describe("LightRagKnowledgeFoundation", () => {
  it("posts to /query with mode, limit, and api key, mapping references to snippets", async () => {
    const { fetchImpl, calls } = mockFetch({
      response: "synthesized answer (ignored)",
      references: [
        {
          reference_id: "doc-1",
          file_path: "kb/refunds.md",
          content: ["Refund window is 30 days"],
        },
        { reference_id: "doc-2", file_path: "kb/ship.md", content: ["Free shipping over $50"] },
      ],
    });
    const adapter = new LightRagKnowledgeFoundation({
      serverUrl: "http://localhost:9621/",
      mode: "hybrid",
      apiKey: "secret-token",
      fetchImpl,
    });

    const snippets = await adapter.retrieve({
      foundationId: "acme.kb",
      query: "refund policy",
      limit: 5,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:9621/query"); // trailing slash normalized
    expect((calls[0].init.headers as Record<string, string>)["X-API-Key"]).toBe("secret-token");
    const sent = JSON.parse(calls[0].init.body as string);
    expect(sent).toMatchObject({
      query: "refund policy",
      mode: "hybrid",
      top_k: 5,
      include_references: true,
      include_chunk_content: true,
    });
    expect(snippets).toEqual([
      {
        foundationId: "acme.kb",
        text: "Refund window is 30 days",
        title: "doc-1",
        source: "kb/refunds.md",
      },
      {
        foundationId: "acme.kb",
        text: "Free shipping over $50",
        title: "doc-2",
        source: "kb/ship.md",
      },
    ]);
  });

  it("caps flattened chunks at the limit and skips blank chunks", async () => {
    const { fetchImpl } = mockFetch({
      references: [{ reference_id: "d", content: ["a", "  ", "b", "c"] }],
    });
    const adapter = new LightRagKnowledgeFoundation({
      serverUrl: "http://x",
      mode: "mix",
      fetchImpl,
    });
    const snippets = await adapter.retrieve({ foundationId: "kb", query: "hello", limit: 2 });
    expect(snippets.map((snippet) => snippet.text)).toEqual(["a", "b"]);
  });

  it("skips too-short queries without calling the server", async () => {
    const { fetchImpl, calls } = mockFetch({});
    const adapter = new LightRagKnowledgeFoundation({
      serverUrl: "http://x",
      mode: "mix",
      fetchImpl,
    });
    expect(await adapter.retrieve({ foundationId: "kb", query: "hi", limit: 5 })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("omits the api-key header when unset and throws on non-200", async () => {
    const { fetchImpl, calls } = mockFetch({}, { ok: false, status: 502 });
    const adapter = new LightRagKnowledgeFoundation({
      serverUrl: "http://x",
      mode: "mix",
      fetchImpl,
    });
    await expect(
      adapter.retrieve({ foundationId: "kb", query: "hello", limit: 5 }),
    ).rejects.toThrow(/HTTP 502/);
    expect((calls[0].init.headers as Record<string, string>)["X-API-Key"]).toBeUndefined();
  });

  it("forwards the abort signal to fetch", async () => {
    const { fetchImpl, calls } = mockFetch({ references: [] });
    const adapter = new LightRagKnowledgeFoundation({
      serverUrl: "http://x",
      mode: "mix",
      fetchImpl,
    });
    const controller = new AbortController();
    await adapter.retrieve({
      foundationId: "kb",
      query: "hello",
      limit: 5,
      signal: controller.signal,
    });
    expect(calls[0].init.signal).toBe(controller.signal);
  });
});

import { describe, expect, it } from "vitest";
import { LightRagKnowledgeFoundation, type LightRagAdapterOptions } from "./adapter.js";

type Captured = { url: string; init: RequestInit };
type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

function mockFetch(
  body: unknown,
  opts: { ok?: boolean; status?: number } = {},
): { fetchImpl: FetchImpl; calls: Captured[] } {
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

function buildAdapter(overrides: Partial<LightRagAdapterOptions> = {}) {
  return new LightRagKnowledgeFoundation({
    foundationId: "kb",
    serverUrl: "http://x",
    kind: "remote",
    mode: "mix",
    ...overrides,
  });
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
    const adapter = buildAdapter({
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
    const adapter = buildAdapter({ fetchImpl });
    const snippets = await adapter.retrieve({ foundationId: "kb", query: "hello", limit: 2 });
    expect(snippets.map((snippet) => snippet.text)).toEqual(["a", "b"]);
  });

  it("skips too-short queries without calling the server", async () => {
    const { fetchImpl, calls } = mockFetch({});
    const adapter = buildAdapter({ fetchImpl });
    expect(await adapter.retrieve({ foundationId: "kb", query: "hi", limit: 5 })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("omits the api-key header when unset and throws on non-200", async () => {
    const { fetchImpl, calls } = mockFetch({}, { ok: false, status: 502 });
    const adapter = buildAdapter({ fetchImpl });
    await expect(
      adapter.retrieve({ foundationId: "kb", query: "hello", limit: 5 }),
    ).rejects.toThrow(/HTTP 502/);
    expect((calls[0].init.headers as Record<string, string>)["X-API-Key"]).toBeUndefined();
  });

  it("forwards the abort signal to fetch", async () => {
    const { fetchImpl, calls } = mockFetch({ references: [] });
    const adapter = buildAdapter({ fetchImpl });
    const controller = new AbortController();
    await adapter.retrieve({
      foundationId: "kb",
      query: "hello",
      limit: 5,
      signal: controller.signal,
    });
    expect(calls[0].init.signal).toBe(controller.signal);
  });

  describe("describe", () => {
    it("reports the configured kind, id, and server url", () => {
      const adapter = buildAdapter({
        foundationId: "acme.kb",
        serverUrl: "http://localhost:9621/",
        kind: "local",
      });
      expect(adapter.describe()).toEqual({
        kind: "local",
        displayName: "acme.kb",
        detail: "http://localhost:9621",
      });
    });

    it("strips credentials embedded in the server url", () => {
      // describe() crosses the gateway into the Control UI, so a password in
      // the configured url must never reach an operator's screen.
      const adapter = buildAdapter({ serverUrl: "http://admin:hunter2@lightrag.internal:9621" });
      expect(adapter.describe().detail).toBe("http://lightrag.internal:9621");
    });

    it("drops a query string or fragment that could carry a token", () => {
      const adapter = buildAdapter({ serverUrl: "https://kb.example.com/base?apiKey=sekret#tok" });
      expect(adapter.describe().detail).toBe("https://kb.example.com/base");
    });

    it("strips userinfo from an IPv6 host", () => {
      const adapter = buildAdapter({ serverUrl: "http://admin:hunter2@[::1]:9621" });
      expect(adapter.describe().detail).toBe("http://[::1]:9621");
    });

    it("withholds a non-HTTP scheme whose shape it cannot reason about", () => {
      const adapter = buildAdapter({ serverUrl: "file:///etc/lightrag/secret-token" });
      expect(adapter.describe().detail).toBe("(unrecognized server url)");
    });

    it("withholds an unparseable server url even without an @ marker", () => {
      // Nothing in an unparseable string is provably non-secret, so none of it
      // is echoed — not just the forms that look like they carry credentials.
      const adapter = buildAdapter({ serverUrl: "kb.example.com/s3cret-path" });
      expect(adapter.describe().detail).toBe("(unrecognized server url)");
    });
  });

  describe("testConnection", () => {
    it("probes GET /health with the api key and reports success", async () => {
      const { fetchImpl, calls } = mockFetch({ status: "healthy" });
      const adapter = buildAdapter({
        serverUrl: "http://localhost:9621/",
        apiKey: "secret-token",
        fetchImpl,
      });

      expect(await adapter.testConnection()).toEqual({ ok: true });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://localhost:9621/health");
      expect(calls[0].init.method).toBe("GET");
      expect((calls[0].init.headers as Record<string, string>)["X-API-Key"]).toBe("secret-token");
      // A timeout is always attached: an operator probe has no run-scoped
      // signal to bound it (see LIGHTRAG_CONNECTION_TIMEOUT_MS).
      expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    });

    it("reports the status code when the server answers non-2xx", async () => {
      const { fetchImpl } = mockFetch({}, { ok: false, status: 503 });
      const adapter = buildAdapter({ fetchImpl });
      expect(await adapter.testConnection()).toEqual({ ok: false, detail: "HTTP 503" });
    });

    it("surfaces the network error code when the server is unreachable", async () => {
      const adapter = buildAdapter({
        fetchImpl: async () => {
          throw Object.assign(new TypeError("fetch failed"), {
            cause: { code: "ECONNREFUSED" },
          });
        },
      });
      expect(await adapter.testConnection()).toEqual({ ok: false, detail: "ECONNREFUSED" });
    });

    it("falls back to a generic reason when the failure carries no code", async () => {
      const adapter = buildAdapter({
        fetchImpl: async () => {
          throw new TypeError("fetch failed");
        },
      });
      expect(await adapter.testConnection()).toEqual({ ok: false, detail: "unreachable" });
    });
  });
});

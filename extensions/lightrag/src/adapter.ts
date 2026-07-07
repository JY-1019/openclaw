// LightRAG knowledge foundation adapter: retrieves context chunks from a
// LightRAG API server (`POST /query`) and maps them onto ClawWorks knowledge
// snippets. The server, api key, and query mode come from plugin config.
import type {
  KnowledgeFoundationAdapter,
  KnowledgeSnippet,
} from "openclaw/plugin-sdk/enterprise-knowledge-host";

/** LightRAG server retrieval modes (see LightRAG /query `mode`). */
export type LightRagQueryMode = "local" | "global" | "hybrid" | "naive" | "mix" | "bypass";

// LightRAG rejects queries shorter than 3 chars with HTTP 400; skip those.
const LIGHTRAG_MIN_QUERY_CHARS = 3;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type LightRagAdapterOptions = {
  serverUrl: string;
  mode: LightRagQueryMode;
  apiKey?: string;
  /** Override the default global fetch (tests). */
  fetchImpl?: FetchLike;
};

/** One `references[]` entry in a LightRAG /query response. */
type LightRagReference = {
  reference_id?: string;
  file_path?: string;
  content?: string[];
};

type LightRagQueryResponse = {
  response?: string;
  references?: LightRagReference[];
};

export class LightRagKnowledgeFoundation implements KnowledgeFoundationAdapter {
  private readonly endpoint: string;

  constructor(private readonly options: LightRagAdapterOptions) {
    this.endpoint = `${options.serverUrl.replace(/\/+$/, "")}/query`;
  }

  async retrieve(params: {
    foundationId: string;
    query: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<KnowledgeSnippet[]> {
    if (params.query.trim().length < LIGHTRAG_MIN_QUERY_CHARS) {
      return [];
    }
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.apiKey) {
      headers["X-API-Key"] = this.options.apiKey;
    }
    const response = await fetchImpl(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: params.query,
        mode: this.options.mode,
        top_k: params.limit,
        include_references: true,
        include_chunk_content: true,
      }),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!response.ok) {
      throw new Error(
        `LightRAG query failed for foundation "${params.foundationId}": HTTP ${response.status}`,
      );
    }
    const body = (await response.json()) as LightRagQueryResponse;
    return mapReferencesToSnippets(body.references ?? [], params.foundationId, params.limit);
  }
}

/** Flatten LightRAG references into snippets, capped at the requested limit. */
function mapReferencesToSnippets(
  references: readonly LightRagReference[],
  foundationId: string,
  limit: number,
): KnowledgeSnippet[] {
  const snippets: KnowledgeSnippet[] = [];
  for (const reference of references) {
    for (const chunk of reference.content ?? []) {
      if (snippets.length >= limit) {
        return snippets;
      }
      const text = chunk.trim();
      if (!text) {
        continue;
      }
      snippets.push({
        foundationId,
        text,
        ...(reference.reference_id ? { title: reference.reference_id } : {}),
        ...(reference.file_path ? { source: reference.file_path } : {}),
      });
    }
  }
  return snippets;
}

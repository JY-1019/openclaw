// LightRAG knowledge foundation adapter: retrieves context chunks from a
// LightRAG API server (`POST /query`) and maps them onto ClawWorks knowledge
// snippets. The server, api key, and query mode come from plugin config.
import type {
  KnowledgeFoundationAdapter,
  KnowledgeFoundationConnectionResult,
  KnowledgeFoundationDescriptor,
  KnowledgeFoundationKind,
  KnowledgeSnippet,
} from "openclaw/plugin-sdk/enterprise-knowledge-host";

/** LightRAG server retrieval modes (see LightRAG /query `mode`). */
export type LightRagQueryMode = "local" | "global" | "hybrid" | "naive" | "mix" | "bypass";

// LightRAG rejects queries shorter than 3 chars with HTTP 400; skip those.
const LIGHTRAG_MIN_QUERY_CHARS = 3;

// The connection probe runs on an operator click, not an agent run, so no
// run-scoped signal bounds it; without an own timeout a hung server would hold
// the gateway request open until the socket died.
const LIGHTRAG_CONNECTION_TIMEOUT_MS = 5_000;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type LightRagAdapterOptions = {
  /** Configured foundation id; the operator-facing display name. */
  foundationId: string;
  serverUrl: string;
  /** Who administers this server's content (operator-declared, see config). */
  kind: KnowledgeFoundationKind;
  mode: LightRagQueryMode;
  apiKey?: string;
  /** Override the default global fetch (tests). */
  fetchImpl?: FetchLike;
};

// Shown instead of a server url whose secret-bearing parts cannot be identified.
const UNRECOGNIZED_SERVER_URL = "(unrecognized server url)";

/**
 * `serverUrl` reduced to a locator safe to display. `describe()` crosses the
 * gateway into the Control UI, so this allow-lists the two components that
 * cannot carry a secret (origin and path) rather than trying to strip the ones
 * that can — userinfo, query, and fragment are all used by token-in-URL
 * deployments. Anything unparseable or non-HTTP is withheld outright: its parts
 * cannot be identified, so no substring of it is provably safe to echo.
 */
function stripUrlCredentials(serverUrl: string): string {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return UNRECOGNIZED_SERVER_URL;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return UNRECOGNIZED_SERVER_URL;
  }
  // `origin` excludes userinfo by construction, so no manual clearing is needed.
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** Node wraps network faults as `TypeError: fetch failed` with a coded cause. */
function connectionFailureDetail(err: unknown): string {
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  return typeof cause?.code === "string" ? cause.code : "unreachable";
}

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
  private readonly baseUrl: string;

  constructor(private readonly options: LightRagAdapterOptions) {
    this.baseUrl = options.serverUrl.replace(/\/+$/, "");
  }

  /** Request headers with the API key attached when one is configured. */
  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      ...extra,
      ...(this.options.apiKey ? { "X-API-Key": this.options.apiKey } : {}),
    };
  }

  describe(): KnowledgeFoundationDescriptor {
    return {
      kind: this.options.kind,
      displayName: this.options.foundationId,
      detail: stripUrlCredentials(this.options.serverUrl),
    };
  }

  /**
   * Probe `GET /health`, LightRAG's liveness endpoint (answers 200 even to
   * unauthenticated callers). `/query` would also prove reachability but costs
   * an LLM call on every operator click.
   */
  async testConnection(): Promise<KnowledgeFoundationConnectionResult> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const timeout = AbortSignal.timeout(LIGHTRAG_CONNECTION_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${this.baseUrl}/health`, {
        method: "GET",
        headers: this.headers(),
        signal: timeout,
      });
      return response.ok ? { ok: true } : { ok: false, detail: `HTTP ${response.status}` };
    } catch (err) {
      if (timeout.aborted) {
        return { ok: false, detail: `timed out after ${LIGHTRAG_CONNECTION_TIMEOUT_MS}ms` };
      }
      return { ok: false, detail: connectionFailureDetail(err) };
    }
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
    const headers = this.headers({ "content-type": "application/json" });
    const response = await fetchImpl(`${this.baseUrl}/query`, {
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

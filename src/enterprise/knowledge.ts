/**
 * ClawWorks knowledge foundations: a process-local registry of retrieval
 * adapters (one per foundation id) plus the governed, ontology-scoped retrieval
 * entry point the `knowledge_search` tool calls. Which foundations a step may
 * query is an ontology allow-list (per-node `knowledgeFoundations`); config
 * governance policies then deny/audit/gate the foundations that remain in scope.
 *
 * Adapters are registered by bundled adapter plugins (e.g. LightRAG) through the
 * `plugin-sdk/enterprise-knowledge-host` facade, or directly by tests/examples;
 * the registry is import-light so agent hot paths stay cheap.
 */
import { createSubsystemLogger } from "../logging/subsystem.js";
import { evaluateKnowledgeRetrievalGovernance } from "./governance.js";
import { findPlanNode, resolvePlanNodePath } from "./plan.js";
import { getEnterpriseActiveRun, type EnterpriseRunTraceSink } from "./runtime.js";
import type {
  EnterprisePlanNode,
  KnowledgeFoundationAdapter,
  KnowledgeFoundationDescriptor,
  KnowledgeSnippet,
} from "./types.js";

const DEFAULT_KNOWLEDGE_LIMIT = 5;

const log = createSubsystemLogger("enterprise");

// Symbol-keyed global so duplicated dist chunks share one registry (same
// pattern as the enterprise active-run registry).
const FOUNDATIONS_KEY = Symbol.for("openclaw.enterpriseKnowledgeFoundations");

function foundations(): Map<string, KnowledgeFoundationAdapter> {
  const holder = globalThis as { [FOUNDATIONS_KEY]?: Map<string, KnowledgeFoundationAdapter> };
  holder[FOUNDATIONS_KEY] ??= new Map();
  return holder[FOUNDATIONS_KEY];
}

/** Register (or replace) the adapter for one knowledge foundation id. */
export function registerEnterpriseKnowledgeFoundation(
  foundationId: string,
  adapter: KnowledgeFoundationAdapter,
): void {
  foundations().set(foundationId, adapter);
}

/** Registered foundation ids in deterministic (sorted) order for stable digests. */
export function listEnterpriseKnowledgeFoundationIds(): string[] {
  return [...foundations().keys()].toSorted();
}

/** One registry entry, used to snapshot/restore across plugin (de)activation. */
export type EnterpriseKnowledgeFoundationRegistration = {
  foundationId: string;
  adapter: KnowledgeFoundationAdapter;
};

/** Snapshot the registry so the plugin loader can restore it on rollback/reload. */
export function listEnterpriseKnowledgeFoundations(): EnterpriseKnowledgeFoundationRegistration[] {
  return [...foundations().entries()].map(([foundationId, adapter]) => ({ foundationId, adapter }));
}

/** Replace the registry with a snapshot (plugin loader rollback/restore path). */
export function restoreEnterpriseKnowledgeFoundations(
  entries: readonly EnterpriseKnowledgeFoundationRegistration[],
): void {
  const map = foundations();
  map.clear();
  for (const entry of entries) {
    map.set(entry.foundationId, entry.adapter);
  }
}

/** Clear all registered foundations (plugin loader activation reset + tests). */
export function clearEnterpriseKnowledgeFoundations(): void {
  foundations().clear();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One registered foundation with its operator-facing descriptor. */
export type EnterpriseKnowledgeFoundationEntry = {
  foundationId: string;
  descriptor: KnowledgeFoundationDescriptor;
};

/**
 * Every registered foundation with a descriptor, in the same sorted order as
 * `listEnterpriseKnowledgeFoundationIds`. Adapters written against the
 * retrieval-only contract (no `describe`) get a neutral fallback, so the
 * inspector lists them rather than hiding what it cannot introspect.
 */
export function listEnterpriseKnowledgeFoundationDescriptors(): EnterpriseKnowledgeFoundationEntry[] {
  return listEnterpriseKnowledgeFoundationIds().map((foundationId) => ({
    foundationId,
    descriptor: describeFoundation(foundationId),
  }));
}

function describeFoundation(foundationId: string): KnowledgeFoundationDescriptor {
  const adapter = foundations().get(foundationId);
  const fallback: KnowledgeFoundationDescriptor = { kind: "remote", displayName: foundationId };
  if (!adapter?.describe) {
    return fallback;
  }
  try {
    return adapter.describe();
  } catch (err) {
    // A plugin-side describe() fault degrades one row to the fallback instead
    // of blanking the whole inspector list (same containment as retrieval).
    log.warn(
      `enterprise knowledge foundation "${foundationId}" describe failed: ${errorMessage(err)}`,
    );
    return fallback;
  }
}

/**
 * Host-level outcome of a connection probe. Wider than the adapter's own
 * `{ok}` because only the host can know an id is unregistered or that the
 * adapter cannot probe at all — the inspector renders those differently from a
 * server that answered "unreachable".
 */
export type KnowledgeFoundationConnectionStatus = {
  status: "ok" | "failed" | "unsupported" | "not-registered";
  detail?: string;
};

/** Probe one foundation's backing service for the operator inspector. */
export async function testEnterpriseKnowledgeFoundationConnection(
  foundationId: string,
): Promise<KnowledgeFoundationConnectionStatus> {
  const adapter = foundations().get(foundationId);
  if (!adapter) {
    return { status: "not-registered" };
  }
  if (!adapter.testConnection) {
    return { status: "unsupported" };
  }
  try {
    const result = await adapter.testConnection();
    return {
      status: result.ok ? "ok" : "failed",
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
    };
  } catch (err) {
    // Keep raw adapter errors (which may carry urls/credentials) out of the
    // operator-facing detail; log the specifics out-of-band like retrieval does.
    log.warn(
      `enterprise knowledge foundation "${foundationId}" connection test failed: ${errorMessage(err)}`,
    );
    return { status: "failed", detail: "connection test failed" };
  }
}

/**
 * Whether the active step's ontology allow-list admits a foundation. Each node
 * on the root→active path that declares a non-empty `knowledgeFoundations` set
 * is an independent gate (like tool scope); nodes that omit it don't restrict.
 */
function foundationAllowedByPath(
  path: readonly EnterprisePlanNode[],
  foundationId: string,
): boolean {
  return path.every((node) => {
    const declared = node.ontology.knowledgeFoundations;
    return !declared?.length || declared.includes(foundationId);
  });
}

/** A foundation the retrieval skipped, with the governance reason. */
export type SkippedKnowledgeFoundation = {
  foundationId: string;
  reason: string;
};

export type KnowledgeRetrievalResult = {
  snippets: KnowledgeSnippet[];
  /** Foundations denied/blocked by governance (not queried). */
  skipped: SkippedKnowledgeFoundation[];
  /** True when the run is enterprise-mediated; false means no scoping was applied. */
  mediated: boolean;
};

/**
 * Retrieve knowledge for the active workflow step: resolve the ontology-allowed
 * foundations in scope, gate each through config governance, and query the
 * registered adapters. Enforce-mode denials (and, lacking an interactive
 * channel here, require_approval decisions) skip the foundation; observe mode
 * records but still queries. Governance decisions are traced via the run sink.
 */
export async function resolveEnterpriseKnowledge(params: {
  runId: string;
  query: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<KnowledgeRetrievalResult> {
  const run = getEnterpriseActiveRun(params.runId);
  if (!run) {
    return { snippets: [], skipped: [], mediated: false };
  }
  const node = findPlanNode(run.plan, run.plan.activeNodeId);
  if (!node) {
    return { snippets: [], skipped: [], mediated: true };
  }
  const path = resolvePlanNodePath(run.plan, node.nodeId);
  const limit = params.limit && params.limit > 0 ? params.limit : DEFAULT_KNOWLEDGE_LIMIT;
  const enforce = run.plan.mode === "enforce";
  // Audit inherits down the path like the tool-call gate: an audited root
  // traces default-allowed retrievals from its leaves.
  const auditEnabled = path.some((step) => step.ontology.audit === true);

  const snippets: KnowledgeSnippet[] = [];
  const skipped: SkippedKnowledgeFoundation[] = [];
  for (const foundationId of listEnterpriseKnowledgeFoundationIds()) {
    if (!foundationAllowedByPath(path, foundationId)) {
      continue; // outside the step's ontology allow-list; not a governance denial
    }
    const decision = evaluateKnowledgeRetrievalGovernance({
      plan: run.plan,
      node,
      foundationId,
      policies: run.policies,
      path,
    });
    // No interactive approval channel inside retrieval, so approval gates fail
    // closed in enforce mode (and record) like a run-start approval would.
    const blocked =
      enforce && (decision.effect === "deny" || decision.effect === "require_approval");
    const traceable = decision.source !== "default" || auditEnabled;
    if (traceable) {
      recordKnowledgeDecision(run.sink, node.nodeId, {
        foundationId,
        effect: decision.effect,
        enforced: blocked,
        policyId: decision.policyId,
        source: decision.source,
        reason: decision.reason,
      });
    }
    if (blocked) {
      skipped.push({ foundationId, reason: decision.reason });
      continue;
    }
    const adapter = foundations().get(foundationId);
    if (!adapter) {
      continue;
    }
    try {
      const results = await adapter.retrieve({
        foundationId,
        query: params.query,
        limit,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      // Cap at the host boundary: a misbehaving adapter must not exceed the
      // advertised per-foundation limit in the model-facing output.
      snippets.push(...results.slice(0, limit));
    } catch (err) {
      // One foundation's failure (e.g. a down server) skips that foundation
      // rather than failing the whole tool call — but run cancellation still
      // propagates so an aborted run stops instead of masking the abort.
      if (params.signal?.aborted) {
        throw err;
      }
      // Keep raw adapter errors (which may carry urls/paths/credentials) out of
      // the model-facing skipped reason; log the detail out-of-band.
      log.warn(
        `enterprise knowledge foundation "${foundationId}" retrieval failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      skipped.push({ foundationId, reason: "retrieval failed" });
    }
  }
  return { snippets, skipped, mediated: true };
}

function recordKnowledgeDecision(
  sink: EnterpriseRunTraceSink | undefined,
  nodeId: string,
  payload: Record<string, unknown>,
): void {
  try {
    sink?.({ kind: "governance.decision", nodeId, payload: { subject: "knowledge", ...payload } });
  } catch {
    // Trace sinks fail open: a persistence fault must never affect retrieval.
  }
}

/**
 * In-memory reference adapter over a fixed snippet set. Serves examples and
 * tests; production foundations come from adapter plugins. Ranks by naive
 * case-insensitive term overlap so `retrieve` is deterministic.
 */
export class InMemoryKnowledgeFoundation implements KnowledgeFoundationAdapter {
  constructor(private readonly documents: readonly KnowledgeSnippet[]) {}

  async retrieve(params: {
    foundationId: string;
    query: string;
    limit: number;
  }): Promise<KnowledgeSnippet[]> {
    const terms = params.query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = this.documents
      .map((doc) => ({ doc, score: overlapScore(doc.text, terms) }))
      .filter((entry) => entry.score > 0)
      .toSorted((a, b) => b.score - a.score || a.doc.text.localeCompare(b.doc.text));
    return scored
      .slice(0, params.limit)
      .map((entry) => rankedSnippet(entry.doc, params.foundationId, entry.score));
  }
}

/** Re-stamp a document with the querying foundation id + rank, dropping unset fields. */
function rankedSnippet(
  doc: KnowledgeSnippet,
  foundationId: string,
  score: number,
): KnowledgeSnippet {
  const snippet: KnowledgeSnippet = { foundationId, text: doc.text, score };
  if (doc.title !== undefined) {
    snippet.title = doc.title;
  }
  if (doc.source !== undefined) {
    snippet.source = doc.source;
  }
  return snippet;
}

function overlapScore(text: string, terms: readonly string[]): number {
  if (terms.length === 0) {
    return 0;
  }
  const haystack = text.toLowerCase();
  return terms.reduce((count, term) => (haystack.includes(term) ? count + 1 : count), 0);
}

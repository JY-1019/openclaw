// Control UI controller manages the knowledge foundations gateway state.
import type {
  EnterpriseKnowledgeConnectionStatus,
  EnterpriseKnowledgeFoundationsListResult,
  EnterpriseKnowledgeFoundationsTestConnectionResult,
  EnterpriseKnowledgeFoundationSummary,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../gateway.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

/**
 * Per-foundation probe state. A closed union rather than a status plus a
 * parallel `testing` boolean, so "in flight" and "answered unreachable" cannot
 * both be true for one row.
 */
export type KnowledgeConnectionState =
  | { phase: "testing" }
  | { phase: "done"; status: EnterpriseKnowledgeConnectionStatus; detail?: string };

/**
 * List lifecycle. "unloaded" exists so the view can tell "nobody has asked yet"
 * from "the gateway answered with none" — an empty array alone would let a tab
 * opened by deep link claim no foundations are registered before the first
 * request has even started.
 */
export type KnowledgeListPhase = "unloaded" | "loading" | "ready" | "failed";

export type KnowledgeState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  knowledgePhase: KnowledgeListPhase;
  knowledgeFoundations: EnterpriseKnowledgeFoundationSummary[];
  knowledgeConnections: Record<string, KnowledgeConnectionState>;
  knowledgeError: string | null;
};

// Monotonic token so the latest list load wins. A "skip if already loading"
// guard would make a refresh triggered right after a tab switch a no-op; the
// token instead lets the newer load supersede, dropping the older response.
let listRequestSeq = 0;

// Probes run per foundation and concurrently, so one shared counter cannot say
// which response is current. The counter stays globally monotonic (no id can
// ever see a stale seq as newer) while the map records the live request per id,
// which is what a double-click on one row needs.
let testRequestSeq = 0;
const latestTestSeqByFoundation = new Map<string, number>();

export async function loadKnowledgeFoundations(state: KnowledgeState) {
  if (!state.client || !state.connected) {
    return;
  }
  const requestSeq = ++listRequestSeq;
  state.knowledgePhase = "loading";
  state.knowledgeError = null;
  try {
    const result = await state.client.request<EnterpriseKnowledgeFoundationsListResult>(
      "enterprise.knowledge.foundations.list",
      {},
    );
    if (requestSeq !== listRequestSeq) {
      return;
    }
    state.knowledgeFoundations = result.foundations;
    forgetRemovedFoundations(state, result.foundations);
    state.knowledgePhase = "ready";
  } catch (err) {
    if (requestSeq !== listRequestSeq) {
      return;
    }
    applyError(state, err);
    state.knowledgePhase = "failed";
  }
}

export async function testKnowledgeFoundationConnection(
  state: KnowledgeState,
  foundationId: string,
) {
  if (!state.client || !state.connected) {
    return;
  }
  const requestSeq = ++testRequestSeq;
  latestTestSeqByFoundation.set(foundationId, requestSeq);
  setConnection(state, foundationId, { phase: "testing" });
  try {
    const result = await state.client.request<EnterpriseKnowledgeFoundationsTestConnectionResult>(
      "enterprise.knowledge.foundations.testConnection",
      { foundationId },
    );
    if (latestTestSeqByFoundation.get(foundationId) !== requestSeq) {
      return;
    }
    setConnection(state, foundationId, {
      phase: "done",
      status: result.status,
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
    });
  } catch (err) {
    if (latestTestSeqByFoundation.get(foundationId) !== requestSeq) {
      return;
    }
    if (isMissingOperatorReadScopeError(err)) {
      applyError(state, err);
      return;
    }
    // A transport failure is about this probe, not the whole tab: leave the
    // list intact and mark just this row unreachable.
    setConnection(state, foundationId, {
      phase: "done",
      status: "failed",
      detail: String(err),
    });
  } finally {
    // Release ownership only if this probe is still the live one, so the map
    // does not grow for the lifetime of the session. A superseded probe leaves
    // the newer entry alone; a probe whose foundation was pruned mid-flight
    // finds nothing to release and is already dropped by the guards above.
    if (latestTestSeqByFoundation.get(foundationId) === requestSeq) {
      latestTestSeqByFoundation.delete(foundationId);
    }
  }
}

function setConnection(
  state: KnowledgeState,
  foundationId: string,
  connection: KnowledgeConnectionState,
) {
  // Reassign rather than mutate: Lit reactivity compares by identity.
  state.knowledgeConnections = { ...state.knowledgeConnections, [foundationId]: connection };
}

/**
 * Forget every trace of foundations this load no longer returns: a deactivated
 * plugin's last known status must not linger, and dropping its request token
 * also invalidates any probe still in flight for it. Without the token drop, a
 * probe that resolves after the removal would re-add a hidden entry that a
 * later foundation reusing the same id would inherit as a stale status chip.
 */
function forgetRemovedFoundations(
  state: KnowledgeState,
  foundations: readonly EnterpriseKnowledgeFoundationSummary[],
): void {
  const live = new Set(foundations.map((foundation) => foundation.id));
  const retained: Record<string, KnowledgeConnectionState> = {};
  for (const [foundationId, connection] of Object.entries(state.knowledgeConnections)) {
    if (live.has(foundationId)) {
      retained[foundationId] = connection;
    }
  }
  state.knowledgeConnections = retained;
  for (const foundationId of latestTestSeqByFoundation.keys()) {
    if (!live.has(foundationId)) {
      latestTestSeqByFoundation.delete(foundationId);
    }
  }
}

function applyError(state: KnowledgeState, err: unknown) {
  if (isMissingOperatorReadScopeError(err)) {
    // Advance both tokens so any in-flight list/probe response is dropped by
    // its own guard, then wipe the data this connection may no longer read.
    listRequestSeq++;
    testRequestSeq++;
    latestTestSeqByFoundation.clear();
    state.knowledgePhase = "failed";
    state.knowledgeFoundations = [];
    state.knowledgeConnections = {};
    state.knowledgeError = formatMissingOperatorReadScopeMessage("knowledge foundations");
    return;
  }
  state.knowledgeError = String(err);
}

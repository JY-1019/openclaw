// Control UI controller manages the knowledge foundations gateway state.
import {
  ENTERPRISE_KNOWLEDGE_DOCUMENT_MAX_BYTES,
  type EnterpriseKnowledgeConnectionStatus,
  type EnterpriseKnowledgeDocument,
  type EnterpriseKnowledgeDocumentsListResult,
  type EnterpriseKnowledgeDocumentsRemoveResult,
  type EnterpriseKnowledgeDocumentsUploadResult,
  type EnterpriseKnowledgeFoundationsListResult,
  type EnterpriseKnowledgeFoundationsTestConnectionResult,
  type EnterpriseKnowledgeFoundationSummary,
} from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";
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

/**
 * Per-foundation file list state. Same reason the top-level list carries a
 * phase: "no documents" is a claim about the gateway's answer, and an empty
 * array before the answer arrives would assert it prematurely.
 */
export type KnowledgeDocumentsState =
  | { phase: "loading" }
  | { phase: "ready"; documents: EnterpriseKnowledgeDocument[] }
  | { phase: "unavailable"; status: EnterpriseKnowledgeDocumentsListResult["status"] };

/** A destructive file action awaiting operator confirmation. */
export type KnowledgeDocumentConfirm = {
  foundationId: string;
  documentId: string;
  documentName: string;
};

export type KnowledgeState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  knowledgePhase: KnowledgeListPhase;
  knowledgeFoundations: EnterpriseKnowledgeFoundationSummary[];
  knowledgeConnections: Record<string, KnowledgeConnectionState>;
  knowledgeError: string | null;
  /** Foundation whose Files section is open, or null when all are collapsed. */
  knowledgeFilesOpenFor: string | null;
  knowledgeDocuments: Record<string, KnowledgeDocumentsState>;
  /** Foundation with an upload in flight; its controls stay disabled. */
  knowledgeUploadingFor: string | null;
  knowledgeDocumentConfirm: KnowledgeDocumentConfirm | null;
  /** Last file-action message (upload rejected, removal started, ...). */
  knowledgeDocumentNotice: string | null;
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

  // Same treatment for file state, plus the open section itself: leaving it
  // open on a foundation that no longer exists would render a headless panel.
  const retainedDocuments: Record<string, KnowledgeDocumentsState> = {};
  for (const [foundationId, documents] of Object.entries(state.knowledgeDocuments)) {
    if (live.has(foundationId)) {
      retainedDocuments[foundationId] = documents;
    }
  }
  state.knowledgeDocuments = retainedDocuments;
  for (const foundationId of latestDocumentsSeqByFoundation.keys()) {
    if (!live.has(foundationId)) {
      latestDocumentsSeqByFoundation.delete(foundationId);
    }
  }
  if (state.knowledgeFilesOpenFor && !live.has(state.knowledgeFilesOpenFor)) {
    state.knowledgeFilesOpenFor = null;
    state.knowledgeDocumentNotice = null;
  }
  if (state.knowledgeDocumentConfirm && !live.has(state.knowledgeDocumentConfirm.foundationId)) {
    // Never leave a confirm dialog pointing at a foundation that vanished.
    state.knowledgeDocumentConfirm = null;
  }
}

// Document loads race the same way probes do: one token per foundation, with a
// globally monotonic counter so no id can mistake an older seq for a newer one.
let documentsRequestSeq = 0;
const latestDocumentsSeqByFoundation = new Map<string, number>();

/** Open one foundation's Files section (closing any other) and load it. */
export async function openKnowledgeFiles(state: KnowledgeState, foundationId: string) {
  state.knowledgeFilesOpenFor = foundationId;
  state.knowledgeDocumentNotice = null;
  await loadKnowledgeDocuments(state, foundationId);
}

export function closeKnowledgeFiles(state: KnowledgeState) {
  state.knowledgeFilesOpenFor = null;
  state.knowledgeDocumentNotice = null;
}

export async function loadKnowledgeDocuments(state: KnowledgeState, foundationId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  const requestSeq = ++documentsRequestSeq;
  latestDocumentsSeqByFoundation.set(foundationId, requestSeq);
  setDocuments(state, foundationId, { phase: "loading" });
  try {
    const result = await state.client.request<EnterpriseKnowledgeDocumentsListResult>(
      "enterprise.knowledge.documents.list",
      { foundationId },
    );
    if (latestDocumentsSeqByFoundation.get(foundationId) !== requestSeq) {
      return;
    }
    setDocuments(
      state,
      foundationId,
      result.status === "ok"
        ? { phase: "ready", documents: result.documents }
        : { phase: "unavailable", status: result.status },
    );
  } catch (err) {
    if (latestDocumentsSeqByFoundation.get(foundationId) !== requestSeq) {
      return;
    }
    if (isMissingOperatorReadScopeError(err)) {
      applyError(state, err);
      return;
    }
    setDocuments(state, foundationId, { phase: "unavailable", status: "failed" });
  } finally {
    if (latestDocumentsSeqByFoundation.get(foundationId) === requestSeq) {
      latestDocumentsSeqByFoundation.delete(foundationId);
    }
  }
}

export async function uploadKnowledgeDocument(
  state: KnowledgeState,
  foundationId: string,
  file: File,
) {
  if (!state.client || !state.connected || state.knowledgeUploadingFor) {
    return;
  }
  // Check the size here too, not only server-side: the alternative is base64
  // encoding a file that is already known to be over the limit and shipping it
  // across the socket just to be told no.
  if (file.size > ENTERPRISE_KNOWLEDGE_DOCUMENT_MAX_BYTES) {
    state.knowledgeDocumentNotice = t("knowledge.uploadTooLarge", {
      limit: formatMegabytes(ENTERPRISE_KNOWLEDGE_DOCUMENT_MAX_BYTES),
    });
    return;
  }
  state.knowledgeUploadingFor = foundationId;
  state.knowledgeDocumentNotice = null;
  try {
    const result = await state.client.request<EnterpriseKnowledgeDocumentsUploadResult>(
      "enterprise.knowledge.documents.upload",
      {
        foundationId,
        name: file.name,
        contentBase64: toBase64(await file.arrayBuffer()),
      },
    );
    state.knowledgeDocumentNotice = uploadNotice(result, file.name);
    if (result.status === "accepted") {
      // Indexing continues in the background, so the row appears as pending;
      // reload to show it rather than leaving the list looking unchanged.
      await loadKnowledgeDocuments(state, foundationId);
    }
  } catch (err) {
    if (isMissingOperatorReadScopeError(err)) {
      applyError(state, err);
      return;
    }
    state.knowledgeDocumentNotice = String(err);
  } finally {
    state.knowledgeUploadingFor = null;
  }
}

export function requestKnowledgeDocumentRemoval(
  state: KnowledgeState,
  confirm: KnowledgeDocumentConfirm,
) {
  state.knowledgeDocumentConfirm = confirm;
}

export function cancelKnowledgeDocumentRemoval(state: KnowledgeState) {
  state.knowledgeDocumentConfirm = null;
}

export async function confirmKnowledgeDocumentRemoval(state: KnowledgeState) {
  const confirm = state.knowledgeDocumentConfirm;
  if (!confirm || !state.client || !state.connected) {
    return;
  }
  state.knowledgeDocumentConfirm = null;
  state.knowledgeDocumentNotice = null;
  try {
    const result = await state.client.request<EnterpriseKnowledgeDocumentsRemoveResult>(
      "enterprise.knowledge.documents.remove",
      { foundationId: confirm.foundationId, documentId: confirm.documentId },
    );
    state.knowledgeDocumentNotice = removalNotice(result, confirm.documentName);
    // Reload even on "started": removal is a background job, so the row may
    // still be listed. The notice, not the list, is what says it was accepted.
    await loadKnowledgeDocuments(state, confirm.foundationId);
  } catch (err) {
    if (isMissingOperatorReadScopeError(err)) {
      applyError(state, err);
      return;
    }
    state.knowledgeDocumentNotice = String(err);
  }
}

function uploadNotice(result: EnterpriseKnowledgeDocumentsUploadResult, fileName: string): string {
  switch (result.status) {
    case "accepted":
      return t("knowledge.uploadAccepted", { name: fileName });
    case "duplicate":
      return t("knowledge.uploadDuplicate", { name: fileName });
    case "too-large":
      return t("knowledge.uploadTooLarge", {
        limit: formatMegabytes(ENTERPRISE_KNOWLEDGE_DOCUMENT_MAX_BYTES),
      });
    case "read-only":
      return t("knowledge.filesReadOnly");
    default:
      return t("knowledge.uploadFailed", { detail: result.detail ?? result.status });
  }
}

function removalNotice(result: EnterpriseKnowledgeDocumentsRemoveResult, name: string): string {
  switch (result.status) {
    case "started":
      // Deliberately "started": the store deletes in the background, and
      // claiming it is gone would be a lie the next reload contradicts.
      return t("knowledge.removeStarted", { name });
    case "busy":
      return t("knowledge.removeBusy");
    case "read-only":
      return t("knowledge.filesReadOnly");
    default:
      return t("knowledge.removeFailed", { detail: result.detail ?? result.status });
  }
}

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  // Chunked: spreading a multi-megabyte array into String.fromCharCode at once
  // overflows the call stack.
  const CHUNK = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

function setDocuments(
  state: KnowledgeState,
  foundationId: string,
  documents: KnowledgeDocumentsState,
) {
  state.knowledgeDocuments = { ...state.knowledgeDocuments, [foundationId]: documents };
}

function applyError(state: KnowledgeState, err: unknown) {
  if (isMissingOperatorReadScopeError(err)) {
    // Advance both tokens so any in-flight list/probe response is dropped by
    // its own guard, then wipe the data this connection may no longer read.
    listRequestSeq++;
    testRequestSeq++;
    documentsRequestSeq++;
    latestTestSeqByFoundation.clear();
    latestDocumentsSeqByFoundation.clear();
    state.knowledgePhase = "failed";
    state.knowledgeFoundations = [];
    state.knowledgeConnections = {};
    state.knowledgeDocuments = {};
    state.knowledgeFilesOpenFor = null;
    state.knowledgeUploadingFor = null;
    state.knowledgeDocumentConfirm = null;
    state.knowledgeDocumentNotice = null;
    state.knowledgeError = formatMissingOperatorReadScopeMessage("knowledge foundations");
    return;
  }
  state.knowledgeError = String(err);
}

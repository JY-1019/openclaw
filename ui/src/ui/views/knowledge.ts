// Control UI view renders the knowledge foundations inspector.
import { html, nothing } from "lit";
import type {
  EnterpriseKnowledgeConnectionStatus,
  EnterpriseKnowledgeDocument,
  EnterpriseKnowledgeFoundationReference,
  EnterpriseKnowledgeFoundationSummary,
} from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";
import "../components/modal-dialog.ts";
import type {
  KnowledgeConnectionState,
  KnowledgeDocumentConfirm,
  KnowledgeDocumentsState,
  KnowledgeListPhase,
} from "../controllers/knowledge.ts";

export type KnowledgeProps = {
  phase: KnowledgeListPhase;
  foundations: EnterpriseKnowledgeFoundationSummary[];
  connections: Record<string, KnowledgeConnectionState>;
  error: string | null;
  /** Whether the session may upload/remove documents (operator.admin). */
  canManageFiles: boolean;
  filesOpenFor: string | null;
  documents: Record<string, KnowledgeDocumentsState>;
  uploadingFor: string | null;
  documentConfirm: KnowledgeDocumentConfirm | null;
  documentNotice: string | null;
  onRefresh: () => void;
  onTestConnection: (foundationId: string) => void;
  onOpenFiles: (foundationId: string) => void;
  onCloseFiles: () => void;
  onUpload: (foundationId: string, file: File) => void;
  onRequestRemove: (confirm: KnowledgeDocumentConfirm) => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
};

export function renderKnowledge(props: KnowledgeProps) {
  const loading = props.phase === "loading";
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${t("knowledge.title")}</div>
          <div class="card-sub">${t("knowledge.subtitle")}</div>
        </div>
        <button class="btn" ?disabled=${loading} @click=${props.onRefresh}>
          ${loading ? t("common.loading") : t("common.refresh")}
        </button>
      </div>
      ${props.error
        ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
        : nothing}
    </section>

    <section class="card" style="margin-top: 16px;">
      <div class="list">
        ${props.foundations.length === 0
          ? renderEmpty(props.phase)
          : props.foundations.map((foundation) => renderFoundation(foundation, props))}
      </div>
    </section>
    ${renderRemoveConfirm(props)}
  `;
}

function renderEmpty(phase: KnowledgeListPhase) {
  // "No foundations are registered" is a claim about the gateway's answer, so
  // it is only made once an answer arrived. Before that (deep link into the tab
  // before its load starts, or a load still running) the view says nothing, and
  // a failed load is already explained by the error callout above.
  if (phase !== "ready") {
    return phase === "failed" ? nothing : html`<div class="muted">${t("common.loading")}</div>`;
  }
  return html`<div class="muted">
    <div>${t("knowledge.empty")}</div>
    <div style="margin-top: 4px;">${t("knowledge.emptyHint")}</div>
  </div>`;
}

function renderFoundation(foundation: EnterpriseKnowledgeFoundationSummary, props: KnowledgeProps) {
  const connection = props.connections[foundation.id];
  const testing = connection?.phase === "testing";
  const onTestConnection = props.onTestConnection;
  return html`<div class="list-item">
    <div class="row" style="justify-content: space-between; gap: 8px; align-items: flex-start;">
      <div class="list-main">
        <div class="list-title">
          ${foundation.displayName}
          <span class="chip" title=${kindTitle(foundation.kind)}
            >${kindLabel(foundation.kind)}</span
          >
        </div>
        ${foundation.description
          ? html`<div class="list-sub">${foundation.description}</div>`
          : nothing}
        <div class="list-sub">${foundation.id}</div>
        ${foundation.detail ? html`<div class="list-meta">${foundation.detail}</div>` : nothing}
      </div>
      <div class="row" style="gap: 8px; align-items: center;">
        ${renderConnectionStatus(connection)}
        <button class="btn" ?disabled=${testing} @click=${() => onTestConnection(foundation.id)}>
          ${testing ? t("knowledge.testing") : t("knowledge.testConnection")}
        </button>
      </div>
    </div>
    ${renderReferences(foundation.referencedBy)}${renderFiles(foundation, props)}
  </div>`;
}

/**
 * The Files section only exists for foundations this deployment administers.
 * A remote foundation is read-only by contract, so offering the controls and
 * then refusing the call would be a dead affordance.
 */
function renderFiles(foundation: EnterpriseKnowledgeFoundationSummary, props: KnowledgeProps) {
  if (foundation.kind !== "local") {
    return nothing;
  }
  const open = props.filesOpenFor === foundation.id;
  return html`<div style="margin-top: 8px;">
    <button
      class="btn"
      @click=${() => (open ? props.onCloseFiles() : props.onOpenFiles(foundation.id))}
    >
      ${open ? t("knowledge.filesHide") : t("knowledge.filesShow")}
    </button>
    ${open ? renderFilesPanel(foundation, props) : nothing}
  </div>`;
}

function renderFilesPanel(foundation: EnterpriseKnowledgeFoundationSummary, props: KnowledgeProps) {
  const state = props.documents[foundation.id];
  const uploadingThis = props.uploadingFor === foundation.id;
  // Uploads are serialized across the whole tab, so a request for a different
  // foundation still blocks this one. Disabling only the in-flight foundation's
  // control would leave the others looking usable while a pick silently no-ops.
  const uploadBlocked = props.uploadingFor !== null;
  // Only offer upload once the list has actually answered. While it is loading
  // we do not yet know the store accepts documents, and an "unsupported" or
  // "not-registered" answer means a pick would just come back refused.
  const canUpload = props.canManageFiles && state?.phase === "ready";
  return html`<div style="margin-top: 8px;">
    <div class="row" style="justify-content: space-between; align-items: center;">
      <div class="card-sub">${t("knowledge.files")}</div>
      ${canUpload
        ? html`<label class="btn" style=${uploadBlocked ? "opacity: 0.6;" : nothing}>
            ${uploadingThis ? t("knowledge.uploading") : t("knowledge.upload")}
            <input
              type="file"
              style="display: none;"
              ?disabled=${uploadBlocked}
              @change=${(event: Event) => {
                const input = event.target as HTMLInputElement;
                const file = input.files?.[0];
                if (file) {
                  props.onUpload(foundation.id, file);
                }
                // Reset so re-picking the same file fires change again.
                input.value = "";
              }}
            />
          </label>`
        : nothing}
    </div>
    ${props.documentNotice
      ? html`<div class="callout" style="margin-top: 8px;">${props.documentNotice}</div>`
      : nothing}
    ${renderDocuments(foundation, state, props)}
  </div>`;
}

function renderDocuments(
  foundation: EnterpriseKnowledgeFoundationSummary,
  state: KnowledgeDocumentsState | undefined,
  props: KnowledgeProps,
) {
  if (!state || state.phase === "loading") {
    return html`<div class="muted" style="margin-top: 8px;">${t("common.loading")}</div>`;
  }
  if (state.phase === "unavailable") {
    return html`<div class="muted" style="margin-top: 8px;">
      ${documentsUnavailableLabel(state.status)}
    </div>`;
  }
  if (state.documents.length === 0) {
    return html`<div class="muted" style="margin-top: 8px;">${t("knowledge.filesEmpty")}</div>`;
  }
  return html`<div class="list" style="margin-top: 8px;">
    ${state.documents.map((document) => renderDocument(foundation, document, props))}
  </div>`;
}

function renderDocument(
  foundation: EnterpriseKnowledgeFoundationSummary,
  document: EnterpriseKnowledgeDocument,
  props: KnowledgeProps,
) {
  return html`<div class="list-item">
    <div class="row" style="justify-content: space-between; gap: 8px; align-items: flex-start;">
      <div class="list-main">
        <div class="list-title">${document.name}</div>
        <div class="chip-row" style="margin-top: 4px;">
          <span class="chip" style=${`color: ${documentStatusColor(document.status)};`}>
            ${documentStatusLabel(document.status)}
          </span>
          ${document.chunkCount !== undefined
            ? html`<span class="chip"
                >${t("knowledge.docChunks", { count: String(document.chunkCount) })}</span
              >`
            : nothing}
        </div>
        ${document.error
          ? html`<div class="list-meta" style="color: var(--danger);">${document.error}</div>`
          : nothing}
      </div>
      ${props.canManageFiles
        ? html`<button
            class="btn danger"
            @click=${() =>
              props.onRequestRemove({
                foundationId: foundation.id,
                documentId: document.id,
                documentName: document.name,
              })}
          >
            ${t("knowledge.remove")}
          </button>`
        : nothing}
    </div>
    <details style="margin-top: 4px;">
      <summary class="list-meta">${t("knowledge.docSummary")}</summary>
      <div class="muted" style="margin-top: 4px; white-space: pre-wrap;">
        ${document.summary ?? t("knowledge.docNoSummary")}
      </div>
    </details>
  </div>`;
}

function renderRemoveConfirm(props: KnowledgeProps) {
  const confirm = props.documentConfirm;
  if (!confirm) {
    return nothing;
  }
  const title = t("knowledge.removeTitle", { name: confirm.documentName });
  return html`<openclaw-modal-dialog
    label=${title}
    description=${t("knowledge.removeBody")}
    @modal-cancel=${props.onCancelRemove}
  >
    <div class="card">
      <div class="card-title">${title}</div>
      <div class="card-sub">${t("knowledge.removeBody")}</div>
      <div class="row" style="justify-content: flex-end; gap: 8px; margin-top: 12px;">
        <button class="btn" @click=${props.onCancelRemove}>${t("common.cancel")}</button>
        <button class="btn danger" @click=${props.onConfirmRemove}>${t("knowledge.remove")}</button>
      </div>
    </div>
  </openclaw-modal-dialog>`;
}

type DocumentsUnavailableStatus = Extract<
  KnowledgeDocumentsState,
  { phase: "unavailable" }
>["status"];

function documentsUnavailableLabel(status: DocumentsUnavailableStatus) {
  switch (status) {
    case "read-only":
      return t("knowledge.filesReadOnly");
    case "unsupported":
      return t("knowledge.filesUnsupported");
    case "not-registered":
      return t("knowledge.filesNotRegistered");
    default:
      return t("knowledge.filesFailed");
  }
}

function documentStatusLabel(status: EnterpriseKnowledgeDocument["status"]) {
  switch (status) {
    case "pending":
      return t("knowledge.docStatusPending");
    case "processing":
      return t("knowledge.docStatusProcessing");
    case "indexed":
      return t("knowledge.docStatusIndexed");
    case "failed":
      return t("knowledge.docStatusFailed");
    case "unknown":
      return t("knowledge.docStatusUnknown");
  }
  const unreachable: never = status;
  return unreachable;
}

function documentStatusColor(status: EnterpriseKnowledgeDocument["status"]) {
  switch (status) {
    case "indexed":
      return "var(--ok)";
    case "failed":
      return "var(--danger)";
    default:
      // Pending/processing/unknown are in-progress or unclassified, not errors.
      return "var(--muted)";
  }
}

function renderConnectionStatus(connection: KnowledgeConnectionState | undefined) {
  if (!connection || connection.phase === "testing") {
    return nothing;
  }
  const title = statusTitle(connection.status);
  return html`<span
    class="chip"
    style=${`color: ${statusColor(connection.status)};`}
    title=${title ?? nothing}
    >${statusLabel(connection.status)}${connection.detail ? html` — ${connection.detail}` : nothing}
  </span>`;
}

function renderReferences(references: readonly EnterpriseKnowledgeFoundationReference[]) {
  if (references.length === 0) {
    // An unreferenced foundation is registered but unreachable by any step, so
    // it is called out rather than silently rendered as an empty section.
    return html`<div class="list-meta" style="margin-top: 8px;">
      ${t("knowledge.referencedByNone")}
    </div>`;
  }
  return html`<details style="margin-top: 8px;">
    <summary class="list-meta">
      ${t("knowledge.referencedBy", { count: String(references.length) })}
    </summary>
    <div class="muted" style="margin-top: 4px;">${t("knowledge.referencedByHint")}</div>
    <div class="chip-row" style="margin-top: 4px;">
      ${references.map(
        (reference) =>
          html`<span class="chip" title=${`${reference.treeId} / ${reference.nodeId}`}>
            ${reference.treeName} · ${reference.nodeTitle}
          </span>`,
      )}
    </div>
  </details>`;
}

function kindLabel(kind: EnterpriseKnowledgeFoundationSummary["kind"]) {
  return kind === "local" ? t("knowledge.kindLocal") : t("knowledge.kindRemote");
}

function kindTitle(kind: EnterpriseKnowledgeFoundationSummary["kind"]) {
  return kind === "local" ? t("knowledge.kindLocalTitle") : t("knowledge.kindRemoteTitle");
}

function statusLabel(status: EnterpriseKnowledgeConnectionStatus) {
  switch (status) {
    case "ok":
      return t("knowledge.statusOk");
    case "failed":
      return t("knowledge.statusFailed");
    case "unsupported":
      return t("knowledge.statusUnsupported");
    case "not-registered":
      return t("knowledge.statusNotRegistered");
  }
  // Keeps the switch exhaustiveness-checked: a new status becomes a type error
  // here rather than silently rendering as a blank chip.
  const unreachable: never = status;
  return unreachable;
}

/** Extra context for the two statuses that are neither reachable nor down. */
function statusTitle(status: EnterpriseKnowledgeConnectionStatus) {
  switch (status) {
    case "unsupported":
      return t("knowledge.statusUnsupportedTitle");
    case "not-registered":
      return t("knowledge.statusNotRegisteredTitle");
    default:
      return undefined;
  }
}

function statusColor(status: EnterpriseKnowledgeConnectionStatus) {
  switch (status) {
    case "ok":
      return "var(--ok)";
    case "failed":
      return "var(--danger)";
    // "cannot check" and "gone from the registry" are not failures of the
    // server, so they must not read as red.
    default:
      return "var(--muted)";
  }
}

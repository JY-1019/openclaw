// Control UI view renders the knowledge foundations inspector.
import { html, nothing } from "lit";
import type {
  EnterpriseKnowledgeConnectionStatus,
  EnterpriseKnowledgeFoundationReference,
  EnterpriseKnowledgeFoundationSummary,
} from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";
import type { KnowledgeConnectionState, KnowledgeListPhase } from "../controllers/knowledge.ts";

export type KnowledgeProps = {
  phase: KnowledgeListPhase;
  foundations: EnterpriseKnowledgeFoundationSummary[];
  connections: Record<string, KnowledgeConnectionState>;
  error: string | null;
  onRefresh: () => void;
  onTestConnection: (foundationId: string) => void;
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
          : props.foundations.map((foundation) =>
              renderFoundation(
                foundation,
                props.connections[foundation.id],
                props.onTestConnection,
              ),
            )}
      </div>
    </section>
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

function renderFoundation(
  foundation: EnterpriseKnowledgeFoundationSummary,
  connection: KnowledgeConnectionState | undefined,
  onTestConnection: (foundationId: string) => void,
) {
  const testing = connection?.phase === "testing";
  return html`<div class="list-item">
    <div class="row" style="justify-content: space-between; gap: 8px; align-items: flex-start;">
      <div class="list-main">
        <div class="list-title">
          ${foundation.displayName}
          <span class="chip" title=${kindTitle(foundation.kind)}
            >${kindLabel(foundation.kind)}</span
          >
        </div>
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
    ${renderReferences(foundation.referencedBy)}
  </div>`;
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

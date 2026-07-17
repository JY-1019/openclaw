// ClawWorks enterprise gateway methods expose read-only projections of the
// workflow-tree registry and the run trace store to operator clients (the UI
// enterprise tab). The wire shapes trim the model-visible plan/ontology to the
// execution-scoping fields an inspector renders; the internal records carry more.
import {
  type EnterprisePlanNode,
  type EnterpriseRunDetail,
  type EnterpriseRunEvent,
  type EnterpriseRunSummary,
  type EnterpriseTreeDetail,
  type EnterpriseTreeNode,
  type EnterpriseTreeOntology,
  type EnterpriseTreesExportResult,
  type EnterpriseTreesGetResult,
  type EnterpriseTreesHistoryGetResult,
  type EnterpriseTreesHistoryListResult,
  type EnterpriseTreesImportResult,
  type EnterpriseTreesRemoveResult,
  type EnterpriseTreeSummary,
  type EnterpriseTreeVersionSummary,
  type EnterpriseObjectsListResult,
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateEnterpriseObjectsListParams,
  validateEnterpriseRunsGetParams,
  validateEnterpriseRunsListParams,
  validateEnterpriseTreesExportParams,
  validateEnterpriseTreesGetParams,
  validateEnterpriseTreesHistoryGetParams,
  validateEnterpriseTreesHistoryListParams,
  validateEnterpriseTreesImportParams,
  validateEnterpriseModeGetParams,
  validateEnterpriseModeSetParams,
  validateEnterpriseTreesListParams,
  validateEnterpriseTreesRemoveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { readConfigFileSnapshotForWrite } from "../../config/io.js";
import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  addressableObjectEntityIds,
  searchOntologyObjects,
} from "../../enterprise/object-store.sqlite.js";
import { hashWorkflowTree } from "../../enterprise/plan.js";
import { resolveEnterpriseMode } from "../../enterprise/runtime.js";
import {
  type EnterpriseRunEventRecord,
  type EnterpriseRunRecord,
  getEnterpriseRunRecordByExecutionId,
  listEnterpriseRunEvents,
  listEnterpriseRunExecutions,
  listEnterpriseRunRecords,
} from "../../enterprise/trace-store.sqlite.js";
import {
  exportWorkflowTree,
  importWorkflowTreeContent,
  removeImportedWorkflowTree,
  serializeWorkflowTree,
} from "../../enterprise/tree-io.js";
import {
  countWorkflowTreeNodes,
  getWorkflowTreeRegistrySnapshot,
  type WorkflowTreeRegistryEntry,
} from "../../enterprise/tree-registry.js";
import {
  getEnterpriseWorkflowTreeVersion,
  listEnterpriseWorkflowTreeVersions,
} from "../../enterprise/tree-store.sqlite.js";
import type {
  OntologyBinding,
  WorkflowNodeDefinition,
  WorkflowTreeMatch,
} from "../../enterprise/types.js";
import { resolveSessionStoreKey } from "../session-store-key.js";
import { commitGatewayConfigWrite } from "./config-write-flow.js";
import type { GatewayRequestHandlers } from "./types.js";

/** Default page size for the object inspector when the caller omits `limit`. */
const ENTERPRISE_OBJECTS_DEFAULT_LIMIT = 50;

type PlanNodeRecord = EnterpriseRunRecord["plan"]["nodes"][number];

/** Project only the execution-scoping ontology fields the inspector shows. */
function mapOntology(ontology: PlanNodeRecord["ontology"]): EnterprisePlanNode["ontology"] {
  return {
    ...(ontology.allowedTools ? { allowedTools: ontology.allowedTools } : {}),
    ...(ontology.deniedTools ? { deniedTools: ontology.deniedTools } : {}),
    ...(ontology.knowledgeFoundations
      ? { knowledgeFoundations: ontology.knowledgeFoundations }
      : {}),
    ...(ontology.contextHints ? { contextHints: ontology.contextHints } : {}),
    ...(ontology.expectedOutput !== undefined ? { expectedOutput: ontology.expectedOutput } : {}),
    ...(ontology.audit !== undefined ? { audit: ontology.audit } : {}),
  };
}

function mapPlanNode(node: PlanNodeRecord): EnterprisePlanNode {
  return {
    nodeId: node.nodeId,
    parentId: node.parentId,
    seq: node.seq,
    title: node.title,
    ...(node.description !== undefined ? { description: node.description } : {}),
    ontology: mapOntology(node.ontology),
  };
}

function mapRunSummary(record: EnterpriseRunRecord): EnterpriseRunSummary {
  return {
    executionId: record.executionId,
    runId: record.runId,
    sessionKey: record.sessionKey,
    treeId: record.treeId,
    treeVersion: record.treeVersion,
    mode: record.mode,
    status: record.status,
    requestSummary: record.requestSummary,
    activeNodeId: record.plan.activeNodeId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    endedAt: record.endedAt,
  };
}

function mapEvent(event: EnterpriseRunEventRecord): EnterpriseRunEvent {
  return {
    seq: event.seq,
    nodeId: event.nodeId,
    kind: event.kind,
    payload: event.payload,
    createdAt: event.createdAt,
  };
}

function mapRunDetail(
  record: EnterpriseRunRecord,
  events: EnterpriseRunEventRecord[],
  executionCount: number,
): EnterpriseRunDetail {
  return {
    executionId: record.executionId,
    runId: record.runId,
    sessionKey: record.sessionKey,
    agentId: record.agentId,
    treeId: record.treeId,
    treeVersion: record.treeVersion,
    treeName: record.plan.treeName,
    ...(record.plan.treeHash ? { treeHash: record.plan.treeHash } : {}),
    mode: record.mode,
    status: record.status,
    matchedBy: record.plan.matchedBy,
    requestSummary: record.requestSummary,
    activeNodeId: record.plan.activeNodeId,
    // The route is the run's headline (which branch it took, and how much of the
    // tree that covers), so the inspector gets it verbatim rather than by
    // re-deriving it from the plan node list.
    ...(record.plan.route ? { route: structuredClone(record.plan.route) } : {}),
    nodes: record.plan.nodes.map(mapPlanNode),
    events: events.map(mapEvent),
    executionCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    endedAt: record.endedAt,
  };
}

/** Project a node's full ontology (structure graph + execution scope). */
function mapTreeOntology(ontology: OntologyBinding | undefined): EnterpriseTreeOntology {
  if (!ontology) {
    return {};
  }
  const projected: EnterpriseTreeOntology = {};
  if (ontology.entities?.length) {
    projected.entities = ontology.entities.map((entity) => ({
      id: entity.id,
      title: entity.title,
      description: entity.description,
      properties: entity.properties ? structuredClone(entity.properties) : undefined,
    }));
  }
  if (ontology.relationships?.length) {
    projected.relationships = ontology.relationships.map((relationship) => ({
      id: relationship.id,
      from: relationship.from,
      to: relationship.to,
      cardinality: relationship.cardinality,
      inverse: relationship.inverse,
      description: relationship.description,
    }));
  }
  if (ontology.actions?.length) {
    // Clone the tool globs: the registry snapshot is process-stable and shared,
    // so the read-only payload must not hand out its mutable arrays.
    projected.actions = ontology.actions.map((action) => ({
      id: action.id,
      title: action.title,
      description: action.description,
      tools: action.tools ? [...action.tools] : undefined,
      parameters: action.parameters ? structuredClone(action.parameters) : undefined,
      preconditions: action.preconditions ? [...action.preconditions] : undefined,
      effects: action.effects ? structuredClone(action.effects) : undefined,
    }));
  }
  if (ontology.functions?.length) {
    projected.functions = ontology.functions.map((fn) => ({
      id: fn.id,
      title: fn.title,
      description: fn.description,
      entity: fn.entity,
      expression: fn.expression,
      returns: fn.returns,
    }));
  }
  if (ontology.constraints?.length) {
    projected.constraints = ontology.constraints.map((constraint) => ({
      id: constraint.id,
      description: constraint.description,
    }));
  }
  if (ontology.allowedTools) {
    projected.allowedTools = [...ontology.allowedTools];
  }
  if (ontology.deniedTools) {
    projected.deniedTools = [...ontology.deniedTools];
  }
  if (ontology.knowledgeFoundations) {
    projected.knowledgeFoundations = [...ontology.knowledgeFoundations];
  }
  if (ontology.contextHints) {
    projected.contextHints = [...ontology.contextHints];
  }
  if (ontology.expectedOutput !== undefined) {
    projected.expectedOutput = ontology.expectedOutput;
  }
  if (ontology.audit !== undefined) {
    projected.audit = ontology.audit;
  }
  return projected;
}

/** Flatten a tree root depth-first into wire nodes carrying parent id + depth. */
function flattenTreeNodes(root: WorkflowNodeDefinition): EnterpriseTreeNode[] {
  const nodes: EnterpriseTreeNode[] = [];
  const walk = (node: WorkflowNodeDefinition, parentId: string | null, depth: number): void => {
    nodes.push({
      id: node.id,
      parentId,
      depth,
      title: node.title,
      description: node.description,
      ontology: mapTreeOntology(node.ontology),
    });
    for (const child of node.children ?? []) {
      walk(child, node.id, depth + 1);
    }
  };
  walk(root, null, 0);
  return nodes;
}

function mapTreeMatch(match: WorkflowTreeMatch): NonNullable<EnterpriseTreeDetail["match"]> {
  // Clone the shared registry arrays so payload mutation can't affect selection.
  const projected: NonNullable<EnterpriseTreeDetail["match"]> = {};
  if (match.keywords) {
    projected.keywords = [...match.keywords];
  }
  if (match.triggers) {
    projected.triggers = [...match.triggers];
  }
  if (match.priority !== undefined) {
    projected.priority = match.priority;
  }
  return projected;
}

function buildTreeDetail(entry: WorkflowTreeRegistryEntry): EnterpriseTreeDetail {
  const detail: EnterpriseTreeDetail = {
    id: entry.tree.id,
    version: entry.tree.version,
    // The hash lets a client prove this IS the definition a given run planned
    // against — something `version` cannot do, since it is author-controlled and
    // an imported override can be removed to reveal a different built-in.
    hash: hashWorkflowTree(entry.tree),
    name: entry.tree.name,
    description: entry.tree.description,
    source: entry.source,
    nodes: flattenTreeNodes(entry.tree.root),
  };
  if (entry.tree.match) {
    detail.match = mapTreeMatch(entry.tree.match);
  }
  return detail;
}

export const enterpriseHandlers: GatewayRequestHandlers = {
  "enterprise.trees.list": ({ params, respond }) => {
    if (!validateEnterpriseTreesListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid enterprise.trees.list params: ${formatValidationErrors(validateEnterpriseTreesListParams.errors)}`,
        ),
      );
      return;
    }
    const snapshot = getWorkflowTreeRegistrySnapshot();
    respond(true, {
      trees: snapshot.entries.map(
        (entry): EnterpriseTreeSummary => ({
          id: entry.tree.id,
          version: entry.tree.version,
          name: entry.tree.name,
          source: entry.source,
          nodeCount: countWorkflowTreeNodes(entry.tree.root),
        }),
      ),
      importErrors: snapshot.importErrors,
      ...(snapshot.storeError !== undefined ? { storeError: snapshot.storeError } : {}),
    });
  },
  "enterprise.trees.get": ({ params, respond }) => {
    if (!validateEnterpriseTreesGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid enterprise.trees.get params: ${formatValidationErrors(validateEnterpriseTreesGetParams.errors)}`,
        ),
      );
      return;
    }
    // Use the full snapshot (not just the resolved entry) so import/store load
    // failures for this id are surfaced. Otherwise a corrupt imported override
    // would return the stale built-in, and a failed imported-only tree would
    // return null, both as a misleadingly successful lookup.
    const snapshot = getWorkflowTreeRegistrySnapshot();
    const entry = snapshot.entries.find((candidate) => candidate.tree.id === params.treeId);
    const importError = snapshot.importErrors.find((issue) => issue.treeId === params.treeId);
    const result: EnterpriseTreesGetResult = { tree: entry ? buildTreeDetail(entry) : null };
    if (snapshot.storeError !== undefined) {
      result.storeError = snapshot.storeError;
    }
    if (importError) {
      result.importError = importError.message;
    }
    respond(true, result);
  },
  "enterprise.objects.list": ({ params, respond }) => {
    if (!validateEnterpriseObjectsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid enterprise.objects.list params: ${formatValidationErrors(validateEnterpriseObjectsListParams.errors)}`,
        ),
      );
      return;
    }
    // Fail closed on a non-authoritative definition: object rows persist in
    // SQLite across imports, so a tree whose current definition failed to load
    // (corrupt override -> importError, or an unreadable store) can still have
    // seed/runtime rows from its last valid definition. Serving them would leak
    // stale objects for a tree the registry no longer trusts, so gate on the same
    // authority check enterprise.trees.get surfaces, and return no rows otherwise.
    const snapshot = getWorkflowTreeRegistrySnapshot();
    const entry = snapshot.entries.find((candidate) => candidate.tree.id === params.treeId);
    const hasImportError = snapshot.importErrors.some((issue) => issue.treeId === params.treeId);
    const authoritative = !hasImportError && snapshot.storeError === undefined;
    if (!entry || !authoritative) {
      respond(true, { objects: [] } satisfies EnterpriseObjectsListResult);
      return;
    }
    // Only the tree's currently-declared, addressable object types may be read.
    // A re-import that drops an entity (or its primaryKey) leaves that entity's
    // runtime rows in SQLite, so without this a caller could still read objects
    // for a type the authoritative definition no longer declares.
    if (!addressableObjectEntityIds(entry.tree).has(params.entity)) {
      respond(true, { objects: [] } satisfies EnterpriseObjectsListResult);
      return;
    }
    // Instances are stored tree-wide by object type; this is an operator read
    // (operator.read), so it surfaces every property — unlike the model tools,
    // which scope properties to the active node. `properties` is omitted here so
    // the inspector shows the full object, and searchOntologyObjects reads only
    // the requested tree/entity, never another tree's data.
    const objects = searchOntologyObjects({
      treeId: params.treeId,
      entity: params.entity,
      ...(params.match ? { match: params.match } : {}),
      limit: params.limit ?? ENTERPRISE_OBJECTS_DEFAULT_LIMIT,
    });
    const result: EnterpriseObjectsListResult = {
      objects: objects.map((object) => ({
        objectId: object.objectId,
        properties: object.properties,
        provenance: object.provenance,
        updatedAt: object.updatedAt,
      })),
    };
    respond(true, result);
  },
  "enterprise.trees.import": ({ params, respond }) => {
    if (!validateEnterpriseTreesImportParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid enterprise.trees.import params: ${formatValidationErrors(validateEnterpriseTreesImportParams.errors)}`,
        ),
      );
      return;
    }
    // Persist + snapshot a revision + refresh the registry. Schema-invalid
    // content is user data, not a protocol error: report it as ok:false issues
    // the editor renders inline rather than a request failure.
    const outcome = importWorkflowTreeContent({ content: params.content, format: params.format });
    const result: EnterpriseTreesImportResult = outcome.ok
      ? { ok: true, treeId: outcome.tree.id, replaced: outcome.replaced }
      : { ok: false, issues: structuredClone(outcome.issues) };
    respond(true, result);
  },
  "enterprise.trees.export": ({ params, respond }) => {
    if (!validateEnterpriseTreesExportParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid enterprise.trees.export params: ${formatValidationErrors(validateEnterpriseTreesExportParams.errors)}`,
        ),
      );
      return;
    }
    const outcome = exportWorkflowTree({ treeId: params.treeId, format: params.format });
    const result: EnterpriseTreesExportResult = outcome.ok
      ? { content: outcome.content, source: outcome.source }
      : { content: null, reason: outcome.reason };
    respond(true, result);
  },
  "enterprise.trees.remove": ({ params, respond }) => {
    if (!validateEnterpriseTreesRemoveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid enterprise.trees.remove params: ${formatValidationErrors(validateEnterpriseTreesRemoveParams.errors)}`,
        ),
      );
      return;
    }
    // Only imported rows are removable; a shadowed built-in reappears. The
    // append-only version history is retained as an audit trail.
    const result: EnterpriseTreesRemoveResult = {
      removed: removeImportedWorkflowTree(params.treeId),
    };
    respond(true, result);
  },
  "enterprise.trees.history.list": ({ params, respond }) => {
    if (!validateEnterpriseTreesHistoryListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid enterprise.trees.history.list params: ${formatValidationErrors(validateEnterpriseTreesHistoryListParams.errors)}`,
        ),
      );
      return;
    }
    // Bound the read: history is append-only and grows per save. Default to a
    // page of the newest revisions when the client does not specify a limit.
    const limit = params.limit ?? 100;
    const result: EnterpriseTreesHistoryListResult = {
      versions: listEnterpriseWorkflowTreeVersions(params.treeId, {}, limit).map(
        (record): EnterpriseTreeVersionSummary => ({
          revision: record.revision,
          version: record.version,
          name: record.name,
          sourceFormat: record.sourceFormat,
          savedAt: record.savedAt,
        }),
      ),
    };
    respond(true, result);
  },
  "enterprise.trees.history.get": ({ params, respond }) => {
    if (!validateEnterpriseTreesHistoryGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid enterprise.trees.history.get params: ${formatValidationErrors(validateEnterpriseTreesHistoryGetParams.errors)}`,
        ),
      );
      return;
    }
    // Serialize the stored revision into the requested exchange format so the
    // editor can load it directly. Null content signals an unknown revision.
    const detail = getEnterpriseWorkflowTreeVersion(params.treeId, params.revision);
    const result: EnterpriseTreesHistoryGetResult = detail
      ? { content: serializeWorkflowTree(detail.tree, params.format), savedAt: detail.savedAt }
      : { content: null };
    respond(true, result);
  },
  "enterprise.runs.list": ({ params, respond }) => {
    if (!validateEnterpriseRunsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid enterprise.runs.list params: ${formatValidationErrors(validateEnterpriseRunsListParams.errors)}`,
        ),
      );
      return;
    }
    // The stored session_key is the RESOLVED store key (chat canonicalizes UI
    // aliases like "main" into "agent:main:main" before a run is traced), so the
    // filter has to canonicalize the requested key the same way or the most
    // common session would match nothing.
    const cfg = getRuntimeConfigSnapshot();
    const sessionKey =
      params.sessionKey && cfg
        ? resolveSessionStoreKey({ cfg, sessionKey: params.sessionKey })
        : params.sessionKey;
    const records = listEnterpriseRunRecords({
      ...(params.limit ? { limit: params.limit } : {}),
      ...(sessionKey ? { sessionKey } : {}),
    });
    respond(true, { runs: records.map(mapRunSummary) });
  },
  "enterprise.runs.get": ({ params, respond }) => {
    if (!validateEnterpriseRunsGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid enterprise.runs.get params: ${formatValidationErrors(validateEnterpriseRunsGetParams.errors)}`,
        ),
      );
      return;
    }
    const record = getEnterpriseRunRecordByExecutionId(params.executionId);
    if (!record) {
      // Null (not an error) is the schema's not-found signal; the inspector
      // renders an empty-state instead of surfacing a request failure.
      respond(true, { run: null });
      return;
    }
    const events = listEnterpriseRunEvents(record.executionId);
    // Sibling execution count for the same runId gives the inspector "run N of M".
    const executionCount = listEnterpriseRunExecutions(record.runId).length;
    respond(true, { run: mapRunDetail(record, events, executionCount) });
  },
  "enterprise.mode.get": ({ params, respond }) => {
    if (!validateEnterpriseModeGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid enterprise.mode.get params: ${formatValidationErrors(validateEnterpriseModeGetParams.errors)}`,
        ),
      );
      return;
    }
    // Read the RESOLVED mode (defaults applied), which is what runs actually
    // enforce — not the raw config value, which may be absent.
    respond(true, { mode: resolveEnterpriseMode(getRuntimeConfigSnapshot() ?? undefined) });
  },
  "enterprise.mode.set": async ({ params, respond, context }) => {
    if (!validateEnterpriseModeSetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid enterprise.mode.set params: ${formatValidationErrors(validateEnterpriseModeSetParams.errors)}`,
        ),
      );
      return;
    }
    const mode = params.mode;
    try {
      const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
      // Write against `resolved` (the authored config), NOT the runtime config:
      // writing the runtime shape would bake every applied default into the file.
      const nextConfig = {
        ...snapshot.resolved,
        enterprise: { ...snapshot.resolved.enterprise, mode },
      } as OpenClawConfig;
      const write = await commitGatewayConfigWrite({
        snapshot,
        // Pin the snapshot this write was derived from. nextConfig is a full copy
        // of the file as it looked when we read it, so without this a config edit
        // landing in between would be silently reverted by a mode toggle. With it
        // the commit fails as a conflict instead, and the chat selector reverts.
        writeOptions: { ...writeOptions, baseSnapshot: snapshot },
        nextConfig,
        ...(context ? { context } : {}),
      });
      write.queueFollowUp();
      respond(true, { mode });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `could not persist enterprise mode: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  },
};

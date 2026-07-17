// Gateway Protocol schema module defines protocol validation shapes.
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/**
 * ClawWorks enterprise inspection protocol schemas.
 *
 * Read-only projections of the workflow-tree registry and the run trace store,
 * surfaced to operator clients (the UI enterprise tab). These are bounded
 * summaries — the model-visible plan/ontology carries more, but only the
 * execution-scoping fields an inspector renders are exposed here.
 */

const TimestampSchema = Type.Integer({ minimum: 0 });

/** Closed enterprise run lifecycle statuses (mirror EnterpriseRunStatus). */
export const EnterpriseRunStatusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("blocked"),
  Type.Literal("aborted"),
  Type.Literal("timed_out"),
]);

/** How a workflow tree definition reached the runtime registry. */
export const EnterpriseTreeSourceSchema = Type.Union([
  Type.Literal("builtin"),
  Type.Literal("imported"),
]);

/** One registry tree, summarized for the tree list. */
export const EnterpriseTreeSummarySchema = Type.Object(
  {
    id: NonEmptyString,
    version: Type.String(),
    name: Type.String(),
    source: EnterpriseTreeSourceSchema,
    nodeCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** A tree import that exists but failed to load; enforce-mode fails closed on it. */
export const EnterpriseTreeImportErrorSchema = Type.Object(
  {
    treeId: Type.String(),
    message: Type.String(),
  },
  { additionalProperties: false },
);

/** Tree list request (no filters; the registry is small and process-stable). */
export const EnterpriseTreesListParamsSchema = Type.Object({}, { additionalProperties: false });

/** Tree list response including the imported-tree load state. */
export const EnterpriseTreesListResultSchema = Type.Object(
  {
    trees: Type.Array(EnterpriseTreeSummarySchema),
    importErrors: Type.Array(EnterpriseTreeImportErrorSchema),
    storeError: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Value types an ontology property or action parameter carries. */
export const EnterpriseOntologyValueTypeSchema = Type.Union([
  Type.Literal("string"),
  Type.Literal("number"),
  Type.Literal("boolean"),
  Type.Literal("date"),
  Type.Literal("id"),
]);

/** One typed field on an ontology object type. */
export const EnterpriseOntologyPropertySchema = Type.Object(
  {
    id: NonEmptyString,
    type: EnterpriseOntologyValueTypeSchema,
    primaryKey: Type.Optional(Type.Boolean()),
    required: Type.Optional(Type.Boolean()),
    description: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** One ontology object type (a domain concept the step reasons about). */
export const EnterpriseOntologyEntitySchema = Type.Object(
  {
    id: NonEmptyString,
    title: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    properties: Type.Optional(Type.Array(EnterpriseOntologyPropertySchema)),
  },
  { additionalProperties: false },
);

/** How many instances each side of a link type may bind to. */
export const EnterpriseOntologyCardinalitySchema = Type.Union([
  Type.Literal("one-to-one"),
  Type.Literal("one-to-many"),
  Type.Literal("many-to-one"),
  Type.Literal("many-to-many"),
]);

/** A directed link type between two object types (an ontology-graph edge). */
export const EnterpriseOntologyRelationshipSchema = Type.Object(
  {
    id: NonEmptyString,
    from: NonEmptyString,
    to: NonEmptyString,
    cardinality: Type.Optional(EnterpriseOntologyCardinalitySchema),
    inverse: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** One declared input to an action type. */
export const EnterpriseOntologyActionParameterSchema = Type.Object(
  {
    id: NonEmptyString,
    type: EnterpriseOntologyValueTypeSchema,
    required: Type.Optional(Type.Boolean()),
    description: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** What an action does to an object type when it runs. */
export const EnterpriseOntologyActionEffectSchema = Type.Object(
  {
    entity: NonEmptyString,
    kind: Type.Union([
      Type.Literal("read"),
      Type.Literal("create"),
      Type.Literal("update"),
      Type.Literal("delete"),
    ]),
    description: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** An action type a step may perform: bound tools plus what it reads/writes. */
export const EnterpriseOntologyActionSchema = Type.Object(
  {
    id: NonEmptyString,
    title: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    tools: Type.Optional(Type.Array(Type.String())),
    parameters: Type.Optional(Type.Array(EnterpriseOntologyActionParameterSchema)),
    preconditions: Type.Optional(Type.Array(Type.String())),
    effects: Type.Optional(Type.Array(EnterpriseOntologyActionEffectSchema)),
  },
  { additionalProperties: false },
);

/** A derived value computed from one object type's own properties. */
export const EnterpriseOntologyFunctionSchema = Type.Object(
  {
    id: NonEmptyString,
    title: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    entity: NonEmptyString,
    expression: NonEmptyString,
    returns: EnterpriseOntologyValueTypeSchema,
  },
  { additionalProperties: false },
);

/** A constraint the step must respect (prompt guidance). */
export const EnterpriseOntologyConstraintSchema = Type.Object(
  { id: NonEmptyString, description: Type.String() },
  { additionalProperties: false },
);

/** Full ontology binding for a tree node (structure + execution scope). */
export const EnterpriseTreeOntologySchema = Type.Object(
  {
    entities: Type.Optional(Type.Array(EnterpriseOntologyEntitySchema)),
    relationships: Type.Optional(Type.Array(EnterpriseOntologyRelationshipSchema)),
    actions: Type.Optional(Type.Array(EnterpriseOntologyActionSchema)),
    functions: Type.Optional(Type.Array(EnterpriseOntologyFunctionSchema)),
    constraints: Type.Optional(Type.Array(EnterpriseOntologyConstraintSchema)),
    allowedTools: Type.Optional(Type.Array(Type.String())),
    deniedTools: Type.Optional(Type.Array(Type.String())),
    knowledgeFoundations: Type.Optional(Type.Array(Type.String())),
    contextHints: Type.Optional(Type.Array(Type.String())),
    expectedOutput: Type.Optional(Type.String()),
    audit: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** One workflow-tree node, flattened depth-first with parent + depth for layout. */
export const EnterpriseTreeNodeSchema = Type.Object(
  {
    id: NonEmptyString,
    parentId: Type.Union([Type.String(), Type.Null()]),
    depth: Type.Integer({ minimum: 0 }),
    title: Type.String(),
    description: Type.Optional(Type.String()),
    ontology: EnterpriseTreeOntologySchema,
  },
  { additionalProperties: false },
);

/** Tree selection hints (how a request binds to the tree). */
export const EnterpriseTreeMatchSchema = Type.Object(
  {
    keywords: Type.Optional(Type.Array(Type.String())),
    triggers: Type.Optional(Type.Array(Type.String())),
    priority: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);

/** Full workflow-tree definition for the visualization/editor. */
export const EnterpriseTreeDetailSchema = Type.Object(
  {
    id: NonEmptyString,
    version: Type.String(),
    /** Content hash of THIS definition; lets a client prove it is the one a run used. */
    hash: Type.Optional(Type.String()),
    name: Type.String(),
    description: Type.Optional(Type.String()),
    source: EnterpriseTreeSourceSchema,
    match: Type.Optional(EnterpriseTreeMatchSchema),
    nodes: Type.Array(EnterpriseTreeNodeSchema),
  },
  { additionalProperties: false },
);

/** Tree detail lookup by tree id. */
export const EnterpriseTreesGetParamsSchema = Type.Object(
  { treeId: NonEmptyString },
  { additionalProperties: false },
);

/**
 * Tree detail response. `tree` is null when the id is not registered. When the
 * requested tree's imported definition failed to load, `importError` carries the
 * reason (a stale built-in may still be returned as `tree`); `storeError` is set
 * when the whole tree store is unreadable. Callers must not treat a present
 * `tree` as authoritative while `importError`/`storeError` is set.
 */
export const EnterpriseTreesGetResultSchema = Type.Object(
  {
    tree: Type.Union([EnterpriseTreeDetailSchema, Type.Null()]),
    importError: Type.Optional(Type.String()),
    storeError: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** A concrete ontology property VALUE (an object instance carries these). */
export const EnterpriseOntologyValueSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);

/** One ontology object INSTANCE, as the operator inspector renders it. */
export const EnterpriseOntologyObjectSchema = Type.Object(
  {
    objectId: NonEmptyString,
    properties: Type.Record(Type.String(), EnterpriseOntologyValueSchema),
    /** Whether the tree declared this object (`seed`) or an action created it (`runtime`). */
    provenance: Type.Union([Type.Literal("seed"), Type.Literal("runtime")]),
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

/** Instances of one object type in one tree, for the node inspector. */
export const EnterpriseObjectsListParamsSchema = Type.Object(
  {
    treeId: NonEmptyString,
    entity: NonEmptyString,
    /** Case-insensitive substring over property values. */
    match: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  { additionalProperties: false },
);

export const EnterpriseObjectsListResultSchema = Type.Object(
  { objects: Type.Array(EnterpriseOntologyObjectSchema) },
  { additionalProperties: false },
);

/** Exchange serialization format for tree import/export. */
export const EnterpriseTreeFormatSchema = Type.Union([Type.Literal("yaml"), Type.Literal("json")]);

/** One validation issue for a rejected tree import (path + message). */
export const EnterpriseTreeImportIssueSchema = Type.Object(
  { path: Type.String(), message: Type.String() },
  { additionalProperties: false },
);

/** Import (create/overwrite) one tree from raw YAML/JSON content. */
export const EnterpriseTreesImportParamsSchema = Type.Object(
  { content: Type.String(), format: EnterpriseTreeFormatSchema },
  { additionalProperties: false },
);

/**
 * Import outcome. `ok: true` carries the stored id and what it replaced (an
 * existing import, a shadowed built-in, or nothing). `ok: false` carries the
 * schema validation issues so the editor can surface them inline; the request
 * itself still succeeds (bad content is user data, not a protocol error).
 */
export const EnterpriseTreesImportResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    treeId: Type.Optional(NonEmptyString),
    replaced: Type.Optional(
      Type.Union([Type.Literal("builtin"), Type.Literal("imported"), Type.Null()]),
    ),
    issues: Type.Optional(Type.Array(EnterpriseTreeImportIssueSchema)),
  },
  { additionalProperties: false },
);

/** Export one registered tree as YAML/JSON. */
export const EnterpriseTreesExportParamsSchema = Type.Object(
  { treeId: NonEmptyString, format: EnterpriseTreeFormatSchema },
  { additionalProperties: false },
);

/** Export result; `content` is null (with a `reason`) when the id is unknown. */
export const EnterpriseTreesExportResultSchema = Type.Object(
  {
    content: Type.Union([Type.String(), Type.Null()]),
    source: Type.Optional(EnterpriseTreeSourceSchema),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Remove one imported tree (a shadowed built-in reappears). */
export const EnterpriseTreesRemoveParamsSchema = Type.Object(
  { treeId: NonEmptyString },
  { additionalProperties: false },
);

/** Remove result; `removed` is false when no imported row existed. */
export const EnterpriseTreesRemoveResultSchema = Type.Object(
  { removed: Type.Boolean() },
  { additionalProperties: false },
);

/** One recorded revision of a tree, summarized for the history list. */
export const EnterpriseTreeVersionSummarySchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 1 }),
    version: Type.String(),
    name: Type.String(),
    sourceFormat: EnterpriseTreeFormatSchema,
    savedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

/** List the saved revisions of one tree (newest first), bounded by limit. */
export const EnterpriseTreesHistoryListParamsSchema = Type.Object(
  {
    treeId: NonEmptyString,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  },
  { additionalProperties: false },
);

export const EnterpriseTreesHistoryListResultSchema = Type.Object(
  { versions: Type.Array(EnterpriseTreeVersionSummarySchema) },
  { additionalProperties: false },
);

/** Load one saved revision's definition, serialized in the requested format. */
export const EnterpriseTreesHistoryGetParamsSchema = Type.Object(
  {
    treeId: NonEmptyString,
    revision: Type.Integer({ minimum: 1 }),
    format: EnterpriseTreeFormatSchema,
  },
  { additionalProperties: false },
);

/** History get result; `content` is null when the revision is unknown. */
export const EnterpriseTreesHistoryGetResultSchema = Type.Object(
  {
    content: Type.Union([Type.String(), Type.Null()]),
    savedAt: Type.Optional(TimestampSchema),
  },
  { additionalProperties: false },
);

/** One run execution, summarized for the run list. */
export const EnterpriseRunSummarySchema = Type.Object(
  {
    executionId: NonEmptyString,
    runId: NonEmptyString,
    // Chat filters the run list by session to show only THIS thread's route.
    // Optional on the wire: an older gateway omits it entirely, and a required
    // field would make its responses undecodable for generated clients.
    sessionKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    treeId: Type.String(),
    treeVersion: Type.String(),
    mode: Type.String(),
    status: EnterpriseRunStatusSchema,
    requestSummary: Type.String(),
    activeNodeId: Type.String(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    endedAt: Type.Union([TimestampSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

/** Recent-run list request with bounded limit. */
export const EnterpriseRunsListParamsSchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    /** Only runs bound to this session (chat shows one thread's route). */
    sessionKey: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Recent-run list response, newest first. */
export const EnterpriseRunsListResultSchema = Type.Object(
  {
    runs: Type.Array(EnterpriseRunSummarySchema),
  },
  { additionalProperties: false },
);

/** Execution-scoping ontology fields shown in the node inspector. */
export const EnterpriseNodeOntologySchema = Type.Object(
  {
    allowedTools: Type.Optional(Type.Array(Type.String())),
    deniedTools: Type.Optional(Type.Array(Type.String())),
    knowledgeFoundations: Type.Optional(Type.Array(Type.String())),
    contextHints: Type.Optional(Type.Array(Type.String())),
    expectedOutput: Type.Optional(Type.String()),
    audit: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** One flattened plan node for the tree/node inspector. */
export const EnterprisePlanNodeSchema = Type.Object(
  {
    nodeId: NonEmptyString,
    parentId: Type.Union([Type.String(), Type.Null()]),
    seq: Type.Integer({ minimum: 0 }),
    title: Type.String(),
    description: Type.Optional(Type.String()),
    ontology: EnterpriseNodeOntologySchema,
  },
  { additionalProperties: false },
);

/** Closed trace event kinds (mirror EnterpriseRunEventKind). */
export const EnterpriseRunEventKindSchema = Type.Union([
  Type.Literal("run.started"),
  Type.Literal("route.selected"),
  Type.Literal("run.ended"),
  Type.Literal("governance.decision"),
  Type.Literal("node.entered"),
  Type.Literal("node.completed"),
  Type.Literal("action.invoked"),
]);

/** One trace event in an execution timeline. */
export const EnterpriseRunEventSchema = Type.Object(
  {
    seq: Type.Integer({ minimum: 0 }),
    nodeId: Type.Union([Type.String(), Type.Null()]),
    kind: EnterpriseRunEventKindSchema,
    payload: Type.Record(Type.String(), Type.Unknown()),
    createdAt: TimestampSchema,
  },
  { additionalProperties: false },
);

/** Full run detail: plan nodes + event timeline for the inspector. */
/** Which part of the tree the run planned, and why. */
export const EnterpriseRunRouteSchema = Type.Object(
  {
    routes: Type.Array(Type.String()),
    rationale: Type.String(),
    source: Type.Union([Type.Literal("planner"), Type.Literal("whole-tree")]),
    selectedNodes: Type.Integer({ minimum: 0 }),
    totalNodes: Type.Integer({ minimum: 0 }),
    invalidRoutes: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export const EnterpriseRunDetailSchema = Type.Object(
  {
    executionId: NonEmptyString,
    runId: NonEmptyString,
    sessionKey: Type.Union([Type.String(), Type.Null()]),
    agentId: Type.Union([Type.String(), Type.Null()]),
    treeId: Type.String(),
    treeVersion: Type.String(),
    treeName: Type.String(),
    /** Content hash of the tree definition the run planned against. */
    treeHash: Type.Optional(Type.String()),
    mode: Type.String(),
    status: EnterpriseRunStatusSchema,
    matchedBy: Type.String(),
    requestSummary: Type.String(),
    activeNodeId: Type.String(),
    route: Type.Optional(EnterpriseRunRouteSchema),
    nodes: Type.Array(EnterprisePlanNodeSchema),
    events: Type.Array(EnterpriseRunEventSchema),
    executionCount: Type.Integer({ minimum: 0 }),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    endedAt: Type.Union([TimestampSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

/** Run detail lookup by execution id (one specific listed run row). */
export const EnterpriseRunsGetParamsSchema = Type.Object(
  {
    executionId: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Run detail response; `run` is null when no trace exists for the execution id. */
export const EnterpriseRunsGetResultSchema = Type.Object(
  {
    run: Type.Union([EnterpriseRunDetailSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

/** Enterprise execution mode, switchable from the chat surface. */
export const EnterpriseModeSchema = Type.Union([
  Type.Literal("enforce"),
  Type.Literal("observe"),
  Type.Literal("off"),
]);

export const EnterpriseModeGetParamsSchema = Type.Object({}, { additionalProperties: false });

export const EnterpriseModeGetResultSchema = Type.Object(
  { mode: EnterpriseModeSchema },
  { additionalProperties: false },
);

export const EnterpriseModeSetParamsSchema = Type.Object(
  { mode: EnterpriseModeSchema },
  { additionalProperties: false },
);

export const EnterpriseModeSetResultSchema = Type.Object(
  { mode: EnterpriseModeSchema },
  { additionalProperties: false },
);

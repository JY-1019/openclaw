/**
 * ClawWorks enterprise domain contracts: workflow trees, per-node ontology
 * bindings, governance policies, and per-run execution plans.
 */
// Type-only: the planner package decides which tree governs a run, so it owns
// the vocabulary for how that choice was reached.
import type { WorkflowTreeSource } from "@openclaw/enterprise-planner";

/** Enterprise execution mode resolved from config. Default: "enforce". */
export type EnterpriseMode = "enforce" | "observe" | "off";

/** Stable dotted identifier used for trees, nodes, and ontology objects. */
export type EnterpriseId = string;

/**
 * Value types an ontology property or action parameter can carry. A closed set:
 * the model-facing digest and the UI both render by type, and an open string
 * would let a typo silently become a new "type".
 */
export type OntologyValueType = "string" | "number" | "boolean" | "date" | "id";

/**
 * A value an ontology property can carry. `date` and `id` are strings (ISO-8601
 * and opaque, respectively), so the runtime carries four shapes, not five.
 */
export type OntologyValue = string | number | boolean | null;

/** One typed field on an object type. */
export type OntologyProperty = {
  id: EnterpriseId;
  type: OntologyValueType;
  /** Marks the field that identifies an instance of the object type. */
  primaryKey?: boolean;
  required?: boolean;
  description?: string;
};

/**
 * Ontology object type (entity) relevant to a workflow step: the domain concept
 * plus the typed properties an instance carries.
 */
export type OntologyEntity = {
  id: EnterpriseId;
  /** Human-readable name; falls back to the id when omitted. */
  title?: string;
  description?: string;
  properties?: OntologyProperty[];
};

/** How many instances each side of a link type may bind to. */
export type OntologyCardinality = "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";

/** Directed link type between two ontology object types. */
export type OntologyRelationship = {
  id: EnterpriseId;
  from: EnterpriseId;
  to: EnterpriseId;
  /** Defaults to many-to-many when omitted (the least-constrained reading). */
  cardinality?: OntologyCardinality;
  /** Name of the reverse traversal, when the link reads differently backwards. */
  inverse?: string;
  description?: string;
};

/** One declared input to an action type. */
export type OntologyActionParameter = {
  id: EnterpriseId;
  type: OntologyValueType;
  required?: boolean;
  description?: string;
};

/** What an action does to an object type when it runs. */
export type OntologyActionEffect = {
  /** Object type id this action touches. */
  entity: EnterpriseId;
  kind: "read" | "create" | "update" | "delete";
  description?: string;
};

/**
 * Ontology action type: a named operation a step may perform, declaring what it
 * reads and writes.
 *
 * `effects` are the AUTHORIZATION, enforced by invoke_action: an action may only
 * touch the object types they name, in the way they name. One declaring only
 * `kind: read` cannot write at all. `parameters` are validated against the call,
 * and a parameter whose id matches a property of an affected object type is what
 * gets written to it.
 *
 * Governance scopes policies at this level (`actions` selector) against the
 * action the model ACTUALLY invoked, so a policy pinned to one action denies or
 * gates exactly that one.
 *
 * `preconditions` remain advisory: they are natural language, so they reach the
 * model in the digest but nothing can enforce them. Do not read them as guarantees.
 */
export type OntologyAction = {
  id: EnterpriseId;
  title?: string;
  description?: string;
  /** Tool name globs this action is expected to use. */
  tools?: string[];
  parameters?: OntologyActionParameter[];
  /** Natural-language preconditions surfaced to the model before it acts. */
  preconditions?: string[];
  effects?: OntologyActionEffect[];
};

/**
 * Derived value computed from one object's properties — the ontology's read-only
 * counterpart to an action.
 *
 * `expression` is NOT JavaScript: it is evaluated by the closed, total op set in
 * ontology-expression.ts. A workflow tree arrives through an import, so treating
 * an expression as code would make "import a tree" mean "run arbitrary code".
 * Properties are referenced with a `$` sigil ($claimed-amount), because ontology
 * ids are hyphenated and a bare id would lex as subtraction.
 */
export type OntologyFunction = {
  id: EnterpriseId;
  title?: string;
  description?: string;
  /** Object type whose properties the expression reads. */
  entity: EnterpriseId;
  /** Closed-op expression over that entity's declared properties. */
  expression: string;
  /** Value type the expression yields; checked against the computed value. */
  returns: OntologyValueType;
};

/**
 * One object INSTANCE the tree declares up front.
 *
 * The tree owns what it declares: a seed is re-applied on every import, so
 * editing the definition updates it. Objects an action creates during a run are
 * `runtime`-provenance and are never clobbered by a re-import. Instances live in
 * SQLite; this is the exchange format, not the runtime store.
 */
export type OntologyObjectSeed = {
  /** Object type this is an instance of. */
  entity: EnterpriseId;
  /** Property values keyed by property id. Must carry the type's primaryKey. */
  properties: Record<string, OntologyValue>;
};

/** One declared link between two seeded objects (instance level, not type level). */
export type OntologyLinkSeed = {
  /** Link type id declared under `relationships`. */
  relationship: EnterpriseId;
  /** primaryKey value of the source object. */
  from: string;
  /** primaryKey value of the target object. */
  to: string;
};

/** Constraint the step must respect; blocking constraints join governance denials. */
export type OntologyConstraint = {
  id: EnterpriseId;
  description: string;
};

/**
 * Ontology binding for one workflow node. This is executable metadata: tool
 * globs feed the per-call governance gate and the context fields feed the
 * step digest injected into the model prompt.
 */
export type OntologyBinding = {
  entities?: OntologyEntity[];
  relationships?: OntologyRelationship[];
  actions?: OntologyAction[];
  functions?: OntologyFunction[];
  /** Object instances the tree declares. Materialized into SQLite on import. */
  objects?: OntologyObjectSeed[];
  /** Links between the declared objects. Materialized into SQLite on import. */
  links?: OntologyLinkSeed[];
  constraints?: OntologyConstraint[];
  /** Tool name globs allowed for this node. Empty/omitted = allow all (repo tool-policy semantics). */
  allowedTools?: string[];
  /** Tool name globs denied for this node. Deny wins over allow. */
  deniedTools?: string[];
  /** Knowledge foundation ids this node may query. Empty/omitted = all configured foundations. */
  knowledgeFoundations?: string[];
  /** Compact context lines surfaced to the model in the step digest. */
  contextHints?: string[];
  /** Expected output shape/summary for this step. */
  expectedOutput?: string;
  /** Record detailed audit events for every tool decision under this node. */
  audit?: boolean;
};

/** One step in a workflow tree definition. */
export type WorkflowNodeDefinition = {
  /** Dotted stable id unique within the tree (e.g. "assist.respond"). */
  id: EnterpriseId;
  title: string;
  description?: string;
  ontology?: OntologyBinding;
  children?: WorkflowNodeDefinition[];
};

/** Which runs a tree can bind to, and how it orders against other candidates. */
export type WorkflowTreeMatch = {
  /**
   * RETIRED. Keyword scoring no longer picks the governing tree — a model
   * judges that now (see @openclaw/enterprise-planner). Still accepted so trees
   * imported before the change keep loading; nothing reads it.
   */
  keywords?: string[];
  /** Run triggers this tree applies to. Empty/omitted = user-triggered runs. */
  triggers?: WorkflowTreeTrigger[];
  /** Candidate order: higher first, equal priority breaks on tree id. */
  priority?: number;
};

/** Run trigger classes a tree can bind to (mirrors EmbeddedRunTrigger families). */
export type WorkflowTreeTrigger = "user" | "system" | "subagent";

export const WORKFLOW_TREE_SCHEMA = "clawworks.workflow-tree" as const;
export const WORKFLOW_TREE_SCHEMA_VERSION = 1 as const;

/** Versioned, importable/exportable workflow tree definition. */
export type WorkflowTreeDefinition = {
  schema: typeof WORKFLOW_TREE_SCHEMA;
  schemaVersion: typeof WORKFLOW_TREE_SCHEMA_VERSION;
  /** Dotted stable id (e.g. "clawworks.assist"). */
  id: EnterpriseId;
  /** Organization-managed definition version (free-form, e.g. "1.0.0"). */
  version: string;
  name: string;
  description?: string;
  match?: WorkflowTreeMatch;
  root: WorkflowNodeDefinition;
};

/** Governance policy effects. Precedence: deny > require_approval > allow > audit. */
export type GovernanceEffect = "allow" | "deny" | "audit" | "require_approval";

/** Approval delivery settings for require_approval policies. */
export type GovernanceApprovalSettings = {
  /** Milliseconds to wait for a human decision before timeoutBehavior applies. */
  timeoutMs?: number;
  /** What happens when nobody decides in time. Default: deny. */
  timeoutBehavior?: "allow" | "deny";
  /** Approval prompt severity shown to reviewers. Default: warning. */
  severity?: "info" | "warning" | "critical";
};

/**
 * One governance policy. All present selectors must match for the policy to
 * apply; a policy with no subject selectors (tools/actions/knowledge)
 * applies at run level when the tree/node selectors match.
 */
export type GovernancePolicy = {
  id: EnterpriseId;
  description?: string;
  effect: GovernanceEffect;
  /** Workflow tree id globs this policy applies to. */
  trees?: string[];
  /** Workflow node id globs this policy applies to. */
  nodes?: string[];
  /** Tool name globs this policy applies to (tool-call scope). */
  tools?: string[];
  /**
   * Ontology action id globs (tool-call scope). Matches when the active node
   * declares a matching action and the called tool falls inside that
   * action's tool globs (an action without tools covers every tool).
   */
  actions?: string[];
  /** Knowledge foundation id globs (knowledge-retrieval scope). */
  knowledge?: string[];
  /** Approval settings when effect is "require_approval". */
  approval?: GovernanceApprovalSettings;
};

/** Outcome of one governance evaluation. */
export type GovernanceDecision = {
  effect: GovernanceEffect;
  /** Matching policy id, or null when the default/ontology rule decided. */
  policyId: EnterpriseId | null;
  /** "ontology" | "policy" | "default" — which layer produced the effect. */
  source: "ontology" | "policy" | "default";
  reason: string;
  /** Approval settings carried from a require_approval policy. */
  approval?: GovernanceApprovalSettings;
};

/** Flattened plan node with its resolved ontology. */
export type EnterprisePlanNode = {
  nodeId: EnterpriseId;
  parentId: EnterpriseId | null;
  /** Deterministic depth-first order within the plan. */
  seq: number;
  title: string;
  description?: string;
  ontology: OntologyBinding;
};

/**
 * Which part of the tree this run actually plans. `routes` are the cut points a
 * planner chose; the plan holds their subtrees plus the ancestors above them.
 * Coverage is the score that makes route selection measurable: a correct route
 * is a small fraction of the tree, a confused one is most of it.
 */
export type EnterpriseRoutePlan = {
  routes: EnterpriseId[];
  rationale: string;
  source: "planner" | "whole-tree";
  /** Nodes planned out of the tree's total. */
  selectedNodes: number;
  totalNodes: number;
  /** Routes the planner named that do not exist in the tree (hallucinations). */
  invalidRoutes?: string[];
};

/** Prepared execution plan for one enterprise-mode run. */
export type EnterpriseRunPlan = {
  runId: string;
  treeId: EnterpriseId;
  treeVersion: string;
  treeName: string;
  /**
   * How the tree was chosen for this request. "fallback" is the one that needs
   * reading: the planner could not be trusted to choose (unreachable, or an
   * unusable reply), so a work-map was bound rather than the permissive default.
   */
  matchedBy: WorkflowTreeSource;
  /**
   * Why the tree was chosen, when the model chose it. Model text about the
   * request, so it is redacted and bounded like the route rationale before it is
   * persisted.
   */
  treeRationale?: string;
  /**
   * Content hash of the tree DEFINITION this run planned against.
   *
   * `version` cannot answer "is the live tree still the one this run governed":
   * it is author-controlled, a tree can be re-imported unchanged at the same
   * version, and removing an imported override silently reveals a different
   * built-in. A hash answers it exactly, which is what the inspector needs
   * before it draws a run's route on a tree's branches.
   *
   * Optional: plans persisted before hashes existed have none, and the inspector
   * treats a missing hash as "cannot prove identity" (it withholds the picture)
   * rather than failing to load the run.
   */
  treeHash?: string;
  /** Truncated, secret-redacted request text for trace inspection. */
  requestSummary: string;
  /** Depth-first flattened nodes: the selected route, or the whole subtree. */
  nodes: EnterprisePlanNode[];
  /** How the route through the tree was chosen. */
  route?: EnterpriseRoutePlan;
  /**
   * Node whose step the run is currently executing. Starts at the subtree root
   * and advances through the depth-first leaf sequence as turns progress.
   * Governance scopes the tool call with this node's ontology merged down the
   * root→node path (see resolvePlanNodePath), so the root scope always holds.
   */
  activeNodeId: EnterpriseId;
  mode: Exclude<EnterpriseMode, "off">;
  createdAt: number;
};

/** Closed terminal states for a mediated run (aligned with agent-run outcomes). */
export type EnterpriseRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "aborted"
  | "timed_out";

/** One retrieved knowledge snippet returned by a foundation adapter. */
export type KnowledgeSnippet = {
  /** Foundation the snippet came from. */
  foundationId: EnterpriseId;
  /** Short title/reference for the snippet, when the source provides one. */
  title?: string;
  text: string;
  /** Adapter-provided relevance score (higher is better) when available. */
  score?: number;
  /** Origin path/uri/citation the model can surface. */
  source?: string;
};

/**
 * Who administers a foundation's content. "local" means the backing server is
 * one this deployment owns, so an operator may manage its documents from here;
 * "remote" means someone else operates it and it is read-only to us. This is an
 * explicit operator declaration, not something inferred from the URL shape — a
 * localhost address can front a shared corpus, and a public hostname can front
 * a server this deployment owns.
 */
export type KnowledgeFoundationKind = "remote" | "local";

/** Operator-facing identity of one registered foundation. */
export type KnowledgeFoundationDescriptor = {
  kind: KnowledgeFoundationKind;
  displayName: string;
  /**
   * Short non-secret locator (e.g. a server origin) shown to operators.
   * Adapters must strip credentials before putting anything here: this crosses
   * the gateway to the Control UI, unlike raw adapter errors which stay logged
   * out-of-band (see resolveEnterpriseKnowledge's catch).
   */
  detail?: string;
  /**
   * One-line, non-secret summary of what this foundation covers. Surfaced to the
   * model in the step digest so it can route a `knowledge_search` to the right
   * foundation (see knowledge-search-tool's `foundations` arg). Like `detail` it
   * crosses the gateway to the model/Control UI, so keep it credential-free.
   */
  description?: string;
};

/** Outcome of probing whether a foundation's backing service is reachable. */
export type KnowledgeFoundationConnectionResult = {
  ok: boolean;
  /** Non-secret human-readable status/reason, surfaced to operators. */
  detail?: string;
};

/**
 * Normalized indexing lifecycle for one document. Adapters map their store's
 * own vocabulary onto this closed set so the inspector can render status
 * without knowing which backend produced it. "unknown" is deliberate: a store
 * may add states faster than adapters track them, and an unrecognized state
 * must degrade to a neutral chip rather than break the list.
 */
export type KnowledgeDocumentStatus = "pending" | "processing" | "indexed" | "failed" | "unknown";

/** One document held by a foundation that stores operator-supplied files. */
export type KnowledgeFoundationDocument = {
  id: string;
  /** File name as the backing store reports it. */
  name: string;
  status: KnowledgeDocumentStatus;
  /**
   * Short excerpt the store derived from the content. Some stores (LightRAG
   * among them) expose no full-text read, so this is all a viewer can show.
   */
  summary?: string;
  /** Content length in characters, when the store reports one. */
  contentLength?: number;
  chunkCount?: number;
  /** Indexing error, present when status is "failed". */
  error?: string;
  updatedAt?: string;
};

/**
 * Upload outcome. Duplicate and size rejections are their own cases because
 * they are operator-actionable ("delete the existing one", "send a smaller
 * file") rather than a fault to retry.
 */
export type KnowledgeDocumentUploadOutcome =
  | { outcome: "accepted"; trackingId?: string }
  | { outcome: "duplicate"; detail?: string }
  | { outcome: "too-large"; detail?: string }
  | { outcome: "rejected"; detail?: string };

/**
 * Removal outcome. "started" rather than "removed": stores commonly delete in
 * the background, so the caller must not report the document as gone yet.
 */
export type KnowledgeDocumentRemovalOutcome =
  | { outcome: "started" }
  | { outcome: "busy"; detail?: string }
  | { outcome: "refused"; detail?: string };

/**
 * Adapter that retrieves from one knowledge foundation. Plugins (e.g. LightRAG)
 * register an adapter per foundation id; the built-in in-memory adapter serves
 * examples and tests.
 *
 * Only `retrieve` is required. The rest are optional so an adapter written
 * against the retrieval-only contract keeps working unchanged; callers fall
 * back (describe) or report "not supported" (testConnection) when absent.
 */
export type KnowledgeFoundationAdapter = {
  retrieve(params: {
    foundationId: EnterpriseId;
    query: string;
    limit: number;
    /** Aborts when the agent run is cancelled/timed out; remote adapters honor it. */
    signal?: AbortSignal;
  }): Promise<KnowledgeSnippet[]>;
  /** Operator-facing identity for the foundations inspector. */
  describe?(): KnowledgeFoundationDescriptor;
  /**
   * Probe reachability for the inspector's "test connection" action. Takes no
   * signal: this runs on an operator request rather than an agent run, so there
   * is nothing run-scoped to cancel it, and the adapter owns a bounding timeout
   * instead. (Adding a signal later stays additive; removing one would not.)
   */
  testConnection?(): Promise<KnowledgeFoundationConnectionResult>;
  /**
   * Document management, implemented only by foundations this deployment
   * administers (`describe().kind === "local"`). An adapter implements all
   * three or none: the inspector offers the Files section when `listDocuments`
   * is present, and an upload button with no `uploadDocument` behind it would
   * be a dead control.
   */
  listDocuments?(): Promise<KnowledgeFoundationDocument[]>;
  uploadDocument?(file: {
    name: string;
    /** Raw bytes; the gateway decodes its base64 transport before this call. */
    content: Uint8Array;
  }): Promise<KnowledgeDocumentUploadOutcome>;
  removeDocument?(documentId: string): Promise<KnowledgeDocumentRemovalOutcome>;
};

/**
 * Trace event kinds appended to enterprise_run_events. `node.entered` /
 * `node.completed` bracket each workflow step as the run advances through the
 * plan; they are only emitted for governed trees (a node carries ontology
 * guidance), so guidance-free built-in runs stay write-quiet like slice 1.
 */
export type EnterpriseRunEventKind =
  | "run.started"
  | "route.selected"
  | "run.ended"
  | "governance.decision"
  | "node.entered"
  | "node.completed"
  /**
   * An ontology action ran and wrote to the object store. The governance
   * decision that PERMITTED it is a separate event; this one records what it
   * actually did, which no other event captures.
   */
  | "action.invoked";

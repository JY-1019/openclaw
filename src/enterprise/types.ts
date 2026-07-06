/**
 * ClawWorks enterprise domain contracts: workflow trees, per-node ontology
 * bindings, governance policies, and per-run execution plans.
 */

/** Enterprise execution mode resolved from config. Default: "enforce". */
export type EnterpriseMode = "enforce" | "observe" | "off";

/** Stable dotted identifier used for trees, nodes, and ontology objects. */
export type EnterpriseId = string;

/** Ontology entity relevant to a workflow step. */
export type OntologyEntity = {
  id: EnterpriseId;
  description?: string;
};

/** Directed relationship between two ontology entities. */
export type OntologyRelationship = {
  id: EnterpriseId;
  from: EnterpriseId;
  to: EnterpriseId;
  description?: string;
};

/** Action a step may perform, optionally bound to concrete tool names. */
export type OntologyAction = {
  id: EnterpriseId;
  description?: string;
  /** Tool name globs this action is expected to use. */
  tools?: string[];
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

/** Selection hints matching inbound requests onto a tree. */
export type WorkflowTreeMatch = {
  /** Case-insensitive keywords scored against the request text. */
  keywords?: string[];
  /** Run triggers this tree applies to. Empty/omitted = user-triggered runs. */
  triggers?: WorkflowTreeTrigger[];
  /** Higher wins ties; equal priority ties break on tree id. */
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

/** Prepared execution plan for one enterprise-mode run. */
export type EnterpriseRunPlan = {
  runId: string;
  treeId: EnterpriseId;
  treeVersion: string;
  treeName: string;
  /** How the tree was chosen for this request. */
  matchedBy: "keywords" | "trigger" | "default";
  /** Truncated, secret-redacted request text for trace inspection. */
  requestSummary: string;
  /** Depth-first flattened subtree nodes. */
  nodes: EnterprisePlanNode[];
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
 * Adapter that retrieves from one knowledge foundation. Plugins (e.g. LightRAG)
 * register an adapter per foundation id; the built-in in-memory adapter serves
 * examples and tests.
 */
export type KnowledgeFoundationAdapter = {
  retrieve(params: {
    foundationId: EnterpriseId;
    query: string;
    limit: number;
    /** Aborts when the agent run is cancelled/timed out; remote adapters honor it. */
    signal?: AbortSignal;
  }): Promise<KnowledgeSnippet[]>;
};

/**
 * Trace event kinds appended to enterprise_run_events. `node.entered` /
 * `node.completed` bracket each workflow step as the run advances through the
 * plan; they are only emitted for governed trees (a node carries ontology
 * guidance), so guidance-free built-in runs stay write-quiet like slice 1.
 */
export type EnterpriseRunEventKind =
  | "run.started"
  | "run.ended"
  | "governance.decision"
  | "node.entered"
  | "node.completed";

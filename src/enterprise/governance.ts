/**
 * Governance policy resolution and evaluation for enterprise-mode runs.
 * Two layers per decision: the active node's ontology scope, then
 * config-declared policies. Matching policies compose order-independently
 * with precedence deny > require_approval > allow > audit (deny-wins matches
 * repo tool-policy semantics; audit records without changing the outcome).
 */
import { isToolAllowedByPolicyName } from "../agents/tool-policy-match.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  EnterprisePlanNode,
  EnterpriseRunPlan,
  GovernanceDecision,
  GovernancePolicy,
  OntologyAction,
} from "./types.js";

/** Governance policies declared in config, in declaration order. */
export function resolveGovernancePolicies(config?: OpenClawConfig): GovernancePolicy[] {
  return config?.enterprise?.governance?.policies ?? [];
}

function matchesSelector(value: string, globs: readonly string[] | undefined): boolean {
  if (!globs || globs.length === 0) {
    return true;
  }
  // Reuse the repo tool-policy matcher for glob semantics (allow-list only).
  return isToolAllowedByPolicyName(value, { allow: [...globs] });
}

function hasSubjectSelectors(policy: GovernancePolicy): boolean {
  return Boolean(policy.tools?.length || policy.actions?.length || policy.knowledge?.length);
}

/** Whether a policy's tree selector matches (or is unset for) the given tree. */
export function policyTargetsTree(policy: GovernancePolicy, treeId: string): boolean {
  return matchesSelector(treeId, policy.trees);
}

/**
 * Ontology actions across the active step's root→node path that cover the
 * called tool. An omitted `tools` list means the action covers every tool; an
 * empty list (which the schema rejects, but guard programmatic policies)
 * covers nothing rather than widening to match-all via the empty-globs matcher.
 */
function actionsCoveringTool(
  path: readonly EnterprisePlanNode[],
  toolName: string,
): OntologyAction[] {
  return path
    .flatMap((node) => node.ontology.actions ?? [])
    .filter((action) => {
      if (action.tools === undefined) {
        return true;
      }
      return action.tools.length > 0 && matchesSelector(toolName, action.tools);
    });
}

/**
 * Does an `actions`-scoped policy cover this call?
 *
 * When the call NAMES an action (invoke_action), that action is the subject and
 * nothing else is: matching the covering set instead would make a policy scoped
 * to "refund" fire for invoke_action("read-note") too, purely because some action
 * happens to list invoke_action among its tools. The gate finally sees which
 * action the model chose, so it uses it.
 *
 * For every other tool there is no named action, and the covering set (actions
 * whose `tools` globs reach this tool) remains the only signal available.
 */
function actionSelectorMatches(
  policy: GovernancePolicy,
  params: {
    coveringActions: readonly OntologyAction[];
    actionId?: string;
    carriesAction?: boolean;
    /** Action ids the active root→node path declares. */
    declaredActions: ReadonlySet<string>;
  },
): boolean {
  if (params.carriesAction) {
    // The action is NAMED in the call, never inferred from tool globs. Until it is
    // named it cannot be judged: falling back to the covering set here would let a
    // policy denying "refund" block an `invoke_action` whose action a hook has not
    // filled in yet — and which may turn out to be something else entirely. The
    // authoritative decision is taken on the final params.
    //
    // The name must also be one the active step actually DECLARES. A model can put
    // any string there, and the tool will reject an undeclared one anyway — but a
    // require_approval or audit policy would otherwise fire on it first, letting a
    // made-up action id prompt a human or write an audit entry.
    if (params.actionId === undefined || !params.declaredActions.has(params.actionId)) {
      return false;
    }
    return matchesSelector(params.actionId, policy.actions);
  }
  return params.coveringActions.some((action) => matchesSelector(action.id, policy.actions));
}

/**
 * First node on the root→active path whose ontology tool scope rejects the
 * call, or null when every level allows it. Each level is an independent gate:
 * a tool must satisfy the allow/deny lists of every ancestor, so a leaf cannot
 * widen past the scope its root declared. Levels without tool lists don't
 * constrain.
 */
function ontologyScopeViolation(
  path: readonly EnterprisePlanNode[],
  toolName: string,
): EnterprisePlanNode | null {
  for (const node of path) {
    const { ontology } = node;
    const scoped = Boolean(ontology.allowedTools?.length || ontology.deniedTools?.length);
    if (
      scoped &&
      !isToolAllowedByPolicyName(toolName, {
        ...(ontology.allowedTools ? { allow: [...ontology.allowedTools] } : {}),
        ...(ontology.deniedTools ? { deny: [...ontology.deniedTools] } : {}),
      })
    ) {
      return node;
    }
  }
  return null;
}

function policyAppliesToToolCall(
  policy: GovernancePolicy,
  params: {
    treeId: string;
    path: readonly EnterprisePlanNode[];
    toolName: string;
    coveringActions: readonly OntologyAction[];
    /** The ontology action the model actually invoked, when the call names one. */
    actionId?: string;
    /** This tool's subject is an action carried in its params (invoke_action). */
    carriesAction?: boolean;
    /** Action ids the active root→node path declares. */
    declaredActions: ReadonlySet<string>;
  },
): boolean {
  const toolScoped = Boolean(policy.tools?.length);
  const actionScoped = Boolean(policy.actions?.length);
  if (!toolScoped && !actionScoped) {
    // Selector-less policies target runs, not calls.
    return false;
  }
  if (policy.knowledge?.length) {
    // A knowledge selector cannot match a tool call, and "all present selectors
    // must match", so a knowledge-scoped policy never applies to tool calls.
    return false;
  }
  if (toolScoped && !matchesSelector(params.toolName, policy.tools)) {
    return false;
  }
  if (actionScoped && !actionSelectorMatches(policy, params)) {
    return false;
  }
  // Node-scoped policies match any node on the active step's root→active path,
  // so a policy pinned to the workflow root keeps applying after the run
  // advances into a leaf (it would otherwise silently stop covering deeper
  // steps).
  const nodeMatches = params.path.some((node) => matchesSelector(node.nodeId, policy.nodes));
  return matchesSelector(params.treeId, policy.trees) && nodeMatches;
}

function policyAppliesToRun(
  policy: GovernancePolicy,
  params: { treeId: string; rootNodeId: string },
): boolean {
  if (hasSubjectSelectors(policy)) {
    return false;
  }
  return (
    matchesSelector(params.treeId, policy.trees) && matchesSelector(params.rootNodeId, policy.nodes)
  );
}

/**
 * Evaluate governance for one tool call under the active plan node. `path` is
 * the root→active chain (defaults to the node alone) so ontology tool scope and
 * covering actions compose down the branch; policy tree/node selectors still
 * match the active node itself.
 */
export function evaluateToolCallGovernance(params: {
  plan: EnterpriseRunPlan;
  node: EnterprisePlanNode;
  toolName: string;
  policies: readonly GovernancePolicy[];
  path?: readonly EnterprisePlanNode[];
  /**
   * The ontology action the call names (invoke_action). Present only for calls
   * that carry one; every other tool leaves it undefined.
   */
  actionId?: string;
  /**
   * This tool takes its action from its PARAMS rather than its name. Such a call
   * cannot be judged by an action-scoped policy until the action is known.
   */
  carriesAction?: boolean;
}): GovernanceDecision {
  const path = params.path ?? [params.node];
  const violation = ontologyScopeViolation(path, params.toolName);
  if (violation) {
    return {
      effect: "deny",
      policyId: null,
      source: "ontology",
      reason: `tool "${params.toolName}" is outside the ontology tool scope of workflow step "${violation.nodeId}"`,
    };
  }

  const coveringActions = actionsCoveringTool(path, params.toolName);
  const declaredActions = new Set(
    path.flatMap((node) => (node.ontology.actions ?? []).map((action) => action.id)),
  );
  const matching = params.policies.filter((policy) =>
    policyAppliesToToolCall(policy, {
      treeId: params.plan.treeId,
      path,
      toolName: params.toolName,
      coveringActions,
      declaredActions,
      ...(params.actionId !== undefined ? { actionId: params.actionId } : {}),
      ...(params.carriesAction ? { carriesAction: true } : {}),
    }),
  );
  // Name the ACTION in the reason when the call carried one: an operator reading
  // "action \"refund\" is denied" can act on it; "tool invoke_action is denied"
  // tells them nothing about which of a node's actions tripped the policy.
  const subject =
    params.actionId !== undefined ? `action "${params.actionId}"` : `tool "${params.toolName}"`;
  const decision = resolvePolicyDecision(matching, () => subject);
  if (decision) {
    return decision;
  }
  return {
    effect: "allow",
    policyId: null,
    source: "default",
    reason: "no governance policy restricts this tool call",
  };
}

function policyAppliesToKnowledge(
  policy: GovernancePolicy,
  params: { treeId: string; path: readonly EnterprisePlanNode[]; foundationId: string },
): boolean {
  if (!policy.knowledge?.length || !matchesSelector(params.foundationId, policy.knowledge)) {
    return false;
  }
  if (policy.tools?.length || policy.actions?.length) {
    // A tool/action selector cannot match a knowledge retrieval, and "all
    // present selectors must match", so such a policy never gates retrieval.
    return false;
  }
  // Node selector matches any node on the active step's root→active path, so a
  // policy pinned to the workflow root keeps covering knowledge from leaves.
  const nodeMatches = params.path.some((node) => matchesSelector(node.nodeId, policy.nodes));
  return matchesSelector(params.treeId, policy.trees) && nodeMatches;
}

/**
 * Evaluate governance for retrieving from one knowledge foundation under the
 * active plan node. `path` is the root→active chain (defaults to the node
 * alone). Which foundations a step may query at all is an ontology allow-list
 * enforced before this call; here config policies gate the foundations in scope.
 */
export function evaluateKnowledgeRetrievalGovernance(params: {
  plan: EnterpriseRunPlan;
  node: EnterprisePlanNode;
  foundationId: string;
  policies: readonly GovernancePolicy[];
  path?: readonly EnterprisePlanNode[];
}): GovernanceDecision {
  const path = params.path ?? [params.node];
  const matching = params.policies.filter((policy) =>
    policyAppliesToKnowledge(policy, {
      treeId: params.plan.treeId,
      path,
      foundationId: params.foundationId,
    }),
  );
  const decision = resolvePolicyDecision(
    matching,
    () => `knowledge foundation "${params.foundationId}"`,
  );
  if (decision) {
    return decision;
  }
  return {
    effect: "allow",
    policyId: null,
    source: "default",
    reason: "no governance policy restricts this knowledge foundation",
  };
}

/**
 * Compose matching policies deny > require_approval > allow > audit,
 * order-independent.
 */
function resolvePolicyDecision(
  matching: readonly GovernancePolicy[],
  describeSubject: (policy: GovernancePolicy) => string,
): GovernanceDecision | null {
  const winner =
    matching.find((policy) => policy.effect === "deny") ??
    matching.find((policy) => policy.effect === "require_approval") ??
    matching.find((policy) => policy.effect === "allow") ??
    matching.find((policy) => policy.effect === "audit");
  if (!winner) {
    return null;
  }
  // Blank descriptions fall back to a generated reason so denial messages
  // and decision traces never surface empty text.
  const description = winner.description?.trim();
  const generated =
    winner.effect === "deny"
      ? `${describeSubject(winner)} is denied by governance policy "${winner.id}"`
      : winner.effect === "require_approval"
        ? `${describeSubject(winner)} requires approval by governance policy "${winner.id}"`
        : `${winner.effect === "allow" ? "allowed" : "audited"} by governance policy "${winner.id}"`;
  return {
    effect: winner.effect,
    policyId: winner.id,
    source: "policy",
    reason: description || generated,
    ...(winner.effect === "require_approval" && winner.approval
      ? { approval: winner.approval }
      : {}),
  };
}

/** Evaluate run-level governance for the selected tree before execution starts. */
export function evaluateRunStartGovernance(params: {
  plan: EnterpriseRunPlan;
  policies: readonly GovernancePolicy[];
}): GovernanceDecision {
  // Run-level policies target the tree as a whole, so match their node selector
  // against the workflow root (nodes[0]) — not the first leaf the run starts
  // execution on, which would drop root-scoped run-start policies.
  const rootNodeId = params.plan.nodes[0]?.nodeId ?? params.plan.activeNodeId;
  const runScope = { treeId: params.plan.treeId, rootNodeId };
  const matching = params.policies.filter((policy) => policyAppliesToRun(policy, runScope));
  const decision = resolvePolicyDecision(matching, () => `workflow tree "${params.plan.treeId}"`);
  if (decision) {
    return decision;
  }
  return {
    effect: "allow",
    policyId: null,
    source: "default",
    reason: "no governance policy restricts this workflow tree",
  };
}

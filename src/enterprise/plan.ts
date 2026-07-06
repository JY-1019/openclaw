/**
 * Workflow subtree selection and per-run plan construction. Selection is the
 * slice-1 request-decomposition placeholder: trees advertise keyword/trigger
 * match hints and the highest-scoring tree wins deterministically.
 */
import { redactSecrets } from "../logging/redact.js";
import { BUILTIN_ASSIST_TREE } from "./builtin-trees.js";
import type {
  EnterpriseMode,
  EnterprisePlanNode,
  EnterpriseRunPlan,
  OntologyBinding,
  WorkflowNodeDefinition,
  WorkflowTreeDefinition,
  WorkflowTreeTrigger,
} from "./types.js";

const REQUEST_SUMMARY_MAX_CHARS = 300;
const DIGEST_MAX_HINT_LINES = 8;

/** Map an embedded run trigger + spawn lineage onto tree trigger classes. */
export function classifyWorkflowTrigger(params: {
  trigger?: string;
  spawnedBy?: string | null;
}): WorkflowTreeTrigger {
  if (params.spawnedBy) {
    return "subagent";
  }
  switch (params.trigger) {
    case "cron":
    case "heartbeat":
    case "memory":
    case "overflow":
      return "system";
    default:
      return "user";
  }
}

function scoreKeywords(requestText: string, keywords: readonly string[] | undefined): number {
  if (!keywords || keywords.length === 0) {
    return 0;
  }
  const haystack = requestText.toLowerCase();
  let hits = 0;
  for (const keyword of keywords) {
    if (haystack.includes(keyword.toLowerCase())) {
      hits += 1;
    }
  }
  return hits;
}

export type WorkflowTreeSelection = {
  tree: WorkflowTreeDefinition;
  matchedBy: EnterpriseRunPlan["matchedBy"];
};

/**
 * Pick the tree for a request. Keyword hits beat trigger-only matches; ties
 * break on priority then tree id so selection stays deterministic.
 */
export function selectWorkflowTree(params: {
  requestText: string;
  trigger: WorkflowTreeTrigger;
  trees: readonly WorkflowTreeDefinition[];
}): WorkflowTreeSelection {
  let best: { tree: WorkflowTreeDefinition; keywordHits: number; priority: number } | null = null;
  for (const tree of params.trees) {
    // Omitted or empty trigger lists mean user-triggered (the schema rejects
    // empty arrays; this also covers programmatically-built trees).
    const triggers = tree.match?.triggers?.length ? tree.match.triggers : ["user"];
    if (!triggers.includes(params.trigger)) {
      continue;
    }
    const keywordHits = scoreKeywords(params.requestText, tree.match?.keywords);
    if (tree.match?.keywords?.length && keywordHits === 0) {
      // Keyword-scoped trees only apply when the request mentions them.
      continue;
    }
    const priority = tree.match?.priority ?? 0;
    if (
      !best ||
      keywordHits > best.keywordHits ||
      (keywordHits === best.keywordHits && priority > best.priority) ||
      (keywordHits === best.keywordHits && priority === best.priority && tree.id < best.tree.id)
    ) {
      best = { tree, keywordHits, priority };
    }
  }
  if (best) {
    return {
      tree: best.tree,
      matchedBy: best.keywordHits > 0 ? "keywords" : "trigger",
    };
  }
  // No tree matched the trigger class: fall back to the default tree so
  // enterprise mode never leaves a run without a bound tree. The fallback is
  // resolved from the provided list first so imported overrides of the
  // built-in default keep governing unmatched runs.
  const fallback =
    params.trees.find((tree) => tree.id === BUILTIN_ASSIST_TREE.id) ?? BUILTIN_ASSIST_TREE;
  return { tree: fallback, matchedBy: "default" };
}

function flattenPlanNodes(root: WorkflowNodeDefinition): EnterprisePlanNode[] {
  const nodes: EnterprisePlanNode[] = [];
  const visit = (node: WorkflowNodeDefinition, parentId: string | null) => {
    nodes.push({
      nodeId: node.id,
      parentId,
      seq: nodes.length,
      title: node.title,
      ...(node.description !== undefined ? { description: node.description } : {}),
      ontology: node.ontology ?? {},
    });
    for (const child of node.children ?? []) {
      visit(child, node.id);
    }
  };
  visit(root, null);
  return nodes;
}

function summarizeRequestText(requestText: string): string {
  const redacted = redactSecrets(requestText).replace(/\s+/g, " ").trim();
  if (redacted.length <= REQUEST_SUMMARY_MAX_CHARS) {
    return redacted;
  }
  return `${redacted.slice(0, REQUEST_SUMMARY_MAX_CHARS - 1)}…`;
}

/** Build the prepared execution plan for one enterprise-mode run. */
export function buildEnterpriseRunPlan(params: {
  runId: string;
  requestText: string;
  trigger: WorkflowTreeTrigger;
  mode: Exclude<EnterpriseMode, "off">;
  trees: readonly WorkflowTreeDefinition[];
  now?: number;
}): EnterpriseRunPlan {
  const selection = selectWorkflowTree({
    requestText: params.requestText,
    trigger: params.trigger,
    trees: params.trees,
  });
  const nodes = flattenPlanNodes(selection.tree.root);
  return {
    runId: params.runId,
    treeId: selection.tree.id,
    treeVersion: selection.tree.version,
    treeName: selection.tree.name,
    matchedBy: selection.matchedBy,
    requestSummary: summarizeRequestText(params.requestText),
    nodes,
    // Runs start at the subtree root, the general scope every mediated runtime
    // enforces. Only runtimes that install the step-loop hook (embedded) enter
    // the first leaf and advance through the leaf steps; CLI/ACP stay on the
    // root scope rather than freezing on an arbitrary leaf they can't advance.
    activeNodeId: nodes[0].nodeId,
    mode: params.mode,
    createdAt: params.now ?? Date.now(),
  };
}

export function findPlanNode(
  plan: EnterpriseRunPlan,
  nodeId: string,
): EnterprisePlanNode | undefined {
  return plan.nodes.find((node) => node.nodeId === nodeId);
}

/**
 * Ancestor chain from the subtree root down to `nodeId` (inclusive). Governance
 * evaluates the tool call against every node on this path so a deeper step
 * cannot escape the scope its ancestors declared. Returns [] when the node is
 * missing. The walk is bounded by the node count so a malformed parentId chain
 * can never spin.
 */
export function resolvePlanNodePath(plan: EnterpriseRunPlan, nodeId: string): EnterprisePlanNode[] {
  const byId = new Map(plan.nodes.map((node) => [node.nodeId, node]));
  const path: EnterprisePlanNode[] = [];
  let current = byId.get(nodeId);
  while (current && path.length <= plan.nodes.length) {
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.toReversed();
}

/**
 * Ordered node ids the run steps through: the depth-first leaf nodes. Interior
 * nodes only provide inherited scope, so the cursor visits leaves (concrete
 * work). A childless root is itself the single leaf/step.
 */
export function enterpriseStepSequence(plan: EnterpriseRunPlan): string[] {
  const parentIds = new Set(
    plan.nodes.map((node) => node.parentId).filter((id): id is string => id !== null),
  );
  return plan.nodes.filter((node) => !parentIds.has(node.nodeId)).map((node) => node.nodeId);
}

/** True when an ontology carries model-facing guidance (digest is non-empty). */
export function ontologyHasGuidance(ontology: OntologyBinding): boolean {
  return Boolean(
    ontology.constraints?.length ||
    ontology.contextHints?.length ||
    ontology.allowedTools?.length ||
    ontology.deniedTools?.length ||
    ontology.actions?.length ||
    ontology.knowledgeFoundations?.length ||
    ontology.expectedOutput,
  );
}

/**
 * Whether a run should advance and trace per-node steps. Only governed trees
 * qualify: the root must have sub-steps (a leaf distinct from the root that the
 * hook enters and enforces — true whenever the plan has more than the root
 * node) and some node must carry ontology guidance or opt into auditing.
 * Guidance-free built-in runs stay step-quiet so the stock path adds no per-run
 * trace writes (slice 1).
 */
export function planTracksSteps(plan: EnterpriseRunPlan): boolean {
  if (plan.nodes.length <= 1) {
    return false;
  }
  return plan.nodes.some(
    (node) => ontologyHasGuidance(node.ontology) || node.ontology.audit === true,
  );
}

/** Append one node's ontology guidance to the digest, indented under its step. */
function appendOntologyGuidance(lines: string[], ontology: OntologyBinding, indent: string): void {
  if (ontology.actions?.length) {
    lines.push(`${indent}Actions:`);
    for (const action of ontology.actions.slice(0, DIGEST_MAX_HINT_LINES)) {
      const detail = [
        action.description,
        action.tools?.length ? `tools: ${action.tools.toSorted().join(", ")}` : undefined,
      ]
        .filter(Boolean)
        .join(" — ");
      lines.push(`${indent}- ${action.id}${detail ? `: ${detail}` : ""}`);
    }
  }
  if (ontology.constraints?.length) {
    lines.push(`${indent}Constraints:`);
    for (const constraint of ontology.constraints.slice(0, DIGEST_MAX_HINT_LINES)) {
      lines.push(`${indent}- ${constraint.description}`);
    }
  }
  if (ontology.contextHints?.length) {
    lines.push(`${indent}Context:`);
    for (const hint of ontology.contextHints.slice(0, DIGEST_MAX_HINT_LINES)) {
      lines.push(`${indent}- ${hint}`);
    }
  }
  if (ontology.allowedTools?.length) {
    lines.push(`${indent}Allowed tools: ${ontology.allowedTools.toSorted().join(", ")}`);
  }
  if (ontology.deniedTools?.length) {
    lines.push(`${indent}Denied tools: ${ontology.deniedTools.toSorted().join(", ")}`);
  }
  if (ontology.knowledgeFoundations?.length) {
    lines.push(
      `${indent}Knowledge sources: ${ontology.knowledgeFoundations.toSorted().join(", ")}`,
    );
  }
  if (ontology.expectedOutput) {
    lines.push(`${indent}Expected output: ${ontology.expectedOutput}`);
  }
}

/**
 * Per-run system prompt section describing the whole bound workflow. The run
 * advances through steps at execution time and governance enforces each step's
 * ontology, so the model must see every step's guidance up front — otherwise a
 * later step's denial or approval fires for instructions it never received.
 * Returns an empty string when no node carries guidance so the built-in
 * permissive trees add zero prompt bytes (prompt-cache/back-compat).
 */
export function buildEnterprisePromptSection(plan: EnterpriseRunPlan): string {
  if (!plan.nodes.some((node) => ontologyHasGuidance(node.ontology))) {
    return "";
  }
  const lines: string[] = [
    "## Enterprise workflow",
    `This run is governed by workflow "${plan.treeName}" (${plan.treeId}@${plan.treeVersion}). Work the steps in order and respect each step's constraints and tool scope.`,
    "Steps:",
  ];
  // Render every step: governance advances into and enforces each one, so a
  // later step must not have its rules omitted (only per-category hint lists are
  // bounded). Trees are operator-authored, so total size stays reasonable.
  for (const node of plan.nodes) {
    lines.push(`${node.seq}. ${node.title}${node.description ? ` — ${node.description}` : ""}`);
    appendOntologyGuidance(lines, node.ontology, "   ");
  }
  return lines.join("\n");
}

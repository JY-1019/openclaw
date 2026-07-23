/**
 * Workflow candidate collection and per-run plan construction.
 *
 * Trees advertise the trigger classes they serve, which is filtered here and
 * stays deterministic. WHICH of the surviving trees governs a request is a
 * semantic judgement made by @openclaw/enterprise-planner, not a match hint:
 * keyword matching used to decide it and failed both ways — a request phrased
 * without a tree's keywords escaped its governance, and an unrelated request
 * that happened to contain one was locked into it.
 */
import { createHash } from "node:crypto";
import { countTreeNodes, type EnterpriseRouteSelection } from "@openclaw/enterprise-planner";
import { redactSecrets } from "../logging/redact.js";
import { BUILTIN_ASSIST_TREE, BUILTIN_SYSTEM_TREE } from "./builtin-trees.js";
import type {
  EnterpriseRoutePlan,
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

export type WorkflowTreeCandidates = {
  /**
   * Trees that could govern this trigger, ordered work-maps first (priority
   * desc, then id) with the catch-all default last. The order is the contract
   * the planner package fails closed on: it binds the FIRST candidate when the
   * model cannot be trusted to choose.
   */
  candidates: readonly WorkflowTreeDefinition[];
  /** The catch-all for this trigger; governs when no work-map applies. */
  defaultTree: WorkflowTreeDefinition;
};

/**
 * Collect the trees a request could bind to.
 *
 * Trigger classing stays DETERMINISTIC and is not the model's to decide: a cron
 * or heartbeat run must never bind a user-facing work-map, whatever its text
 * says. Within a trigger class the choice is semantic, so this returns every
 * candidate and lets the planner pick (see selectWorkflowPlan).
 *
 * The default is resolved from the provided list first, so an imported tree that
 * reuses the built-in id keeps governing runs no work-map claims — that is the
 * seam an operator uses to make unmatched runs non-permissive.
 */
export function collectWorkflowTreeCandidates(params: {
  trigger: WorkflowTreeTrigger;
  trees: readonly WorkflowTreeDefinition[];
}): WorkflowTreeCandidates {
  const builtinDefault = params.trigger === "system" ? BUILTIN_SYSTEM_TREE : BUILTIN_ASSIST_TREE;
  const defaultTree = params.trees.find((tree) => tree.id === builtinDefault.id) ?? builtinDefault;
  const matching = params.trees.filter((tree) => {
    // Omitted or empty trigger lists mean user-triggered (the schema rejects
    // empty arrays; this also covers programmatically-built trees).
    const triggers = tree.match?.triggers?.length ? tree.match.triggers : ["user"];
    return triggers.includes(params.trigger);
  });
  const candidates = matching.toSorted((left, right) => {
    const byPriority = (right.match?.priority ?? 0) - (left.match?.priority ?? 0);
    return byPriority !== 0 ? byPriority : left.id.localeCompare(right.id);
  });
  // The default must always be selectable, even when it declares no trigger that
  // matches (or was dropped from the registry): enterprise mode never leaves a
  // run without a bound tree.
  if (!candidates.some((tree) => tree.id === defaultTree.id)) {
    candidates.push(defaultTree);
  }
  return { candidates, defaultTree };
}

/**
 * Flatten the subtree depth-first. When `keep` is given, only those nodes are
 * planned — the route. `keep` always contains a selected node's ancestors, so a
 * skipped node can never have a kept descendant and pruning its branch is safe.
 */
function flattenPlanNodes(
  root: WorkflowNodeDefinition,
  keep?: ReadonlySet<string>,
): EnterprisePlanNode[] {
  const nodes: EnterprisePlanNode[] = [];
  const visit = (node: WorkflowNodeDefinition, parentId: string | null) => {
    if (keep && !keep.has(node.id)) {
      return;
    }
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

const MODEL_TEXT_MAX_CHARS = 300;

/**
 * Redact + bound text the MODEL produced about the request (route rationales,
 * hallucinated route strings). It is persisted to the trace and rendered in the
 * UI, so it gets the same redaction as the request summary — a rationale that
 * quotes the prompt back would otherwise smuggle a secret into the trace.
 */
function summarizeModelText(text: string): string {
  const redacted = redactSecrets(text).replace(/\s+/g, " ").trim();
  if (redacted.length <= MODEL_TEXT_MAX_CHARS) {
    return redacted;
  }
  return `${redacted.slice(0, MODEL_TEXT_MAX_CHARS - 1)}…`;
}

function summarizeRequestText(requestText: string): string {
  const redacted = redactSecrets(requestText).replace(/\s+/g, " ").trim();
  if (redacted.length <= REQUEST_SUMMARY_MAX_CHARS) {
    return redacted;
  }
  return `${redacted.slice(0, REQUEST_SUMMARY_MAX_CHARS - 1)}…`;
}

/**
 * Stable content hash of a tree definition. Keys are sorted so an equivalent
 * definition always hashes the same regardless of authoring order.
 */
export function hashWorkflowTree(tree: WorkflowTreeDefinition): string {
  const canonical = JSON.stringify(tree, (_key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .toSorted()
          .map((key) => [key, record[key]]),
      );
    }
    return value;
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Build the prepared execution plan for one enterprise-mode run.
 *
 * The governing tree is passed IN, never re-derived here: selection is a model
 * judgement now, so a second derivation could disagree with the one the run was
 * governed and prompted against.
 */
export function buildEnterpriseRunPlan(params: {
  runId: string;
  requestText: string;
  mode: Exclude<EnterpriseMode, "off">;
  /** The governing tree, already chosen. */
  tree: WorkflowTreeDefinition;
  /** How it was chosen; recorded on the plan for audit. */
  matchedBy: EnterpriseRunPlan["matchedBy"];
  /** Why it was chosen. Model text when the model chose, so it is redacted. */
  treeRationale?: string;
  /** Route through the chosen tree. Omit to plan the whole subtree. */
  route?: EnterpriseRouteSelection;
  now?: number;
}): EnterpriseRunPlan {
  const tree = params.tree;
  const totalNodes = countTreeNodes(tree);
  // A route resolved against a DIFFERENT tree cannot prune this one; ignoring it
  // is the safe read (plan everything) rather than planning an empty run.
  const routeNodeIds =
    params.route?.nodeIds && params.route.nodeIds.has(tree.root.id)
      ? params.route.nodeIds
      : undefined;
  const nodes = flattenPlanNodes(tree.root, routeNodeIds);
  const route: EnterpriseRoutePlan | undefined = params.route
    ? {
        // Route ids are safe: they were resolved against the tree, so they can
        // only be node ids the definition already contains.
        routes: routeNodeIds ? [...params.route.routes] : [],
        // The rationale and any hallucinated route strings are MODEL TEXT echoing
        // the request, so they get the same treatment as requestSummary. Without
        // this the trace, the plan row, and the chat card become a new sink for
        // whatever secret the user pasted into the prompt.
        rationale: summarizeModelText(params.route.rationale),
        source: routeNodeIds ? params.route.source : "whole-tree",
        selectedNodes: nodes.length,
        totalNodes,
        ...(params.route.invalidRoutes.length > 0
          ? { invalidRoutes: params.route.invalidRoutes.map(summarizeModelText) }
          : {}),
      }
    : undefined;
  return {
    runId: params.runId,
    treeId: tree.id,
    treeVersion: tree.version,
    treeName: tree.name,
    matchedBy: params.matchedBy,
    // Model text about the request, so it gets the same redaction as the route
    // rationale: it is persisted to the trace and rendered to operators.
    ...(params.treeRationale ? { treeRationale: summarizeModelText(params.treeRationale) } : {}),
    treeHash: hashWorkflowTree(tree),
    requestSummary: summarizeRequestText(params.requestText),
    nodes,
    ...(route ? { route } : {}),
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
    ontology.expectedOutput ||
    // The object graph is guidance too. Without these, a tree whose ONLY guidance
    // is its ontology reads as guidance-free: the step loop never advances past
    // the root, so every ontology tool call resolves the root scope and rejects
    // the leaf's own object types for the entire run.
    ontology.entities?.length ||
    ontology.relationships?.length ||
    ontology.functions?.length ||
    ontology.objects?.length ||
    ontology.links?.length,
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
  // The step's addressable ontology: the ids its tools take as arguments. Without
  // these the model has the tools but no vocabulary for them — it cannot know this
  // step addresses a "claim", that a claim links to a "policy", or that a
  // "claim-triage-band" exists to compute, so it would guess ids and read back
  // errors.
  //
  // Deliberately does NOT name the tools. Tool availability is a RUNTIME fact
  // (these are opt-in enterprise tools, and a CLI loopback path builds tools with
  // no runId at all), while this digest is built from the plan alone. Naming them
  // here would tell the model to call something the run may never have been given;
  // the tools introduce themselves through their own descriptions.
  //
  // Ids and shapes only. The VALUES live in the store and are fetched with a tool;
  // restating them here would be the prompt-stuffing this slice exists to replace.
  if (ontology.entities?.length) {
    lines.push(`${indent}Object types:`);
    for (const entity of ontology.entities.slice(0, DIGEST_MAX_HINT_LINES)) {
      const properties = (entity.properties ?? []).map(
        (property) => `${property.id}${property.primaryKey ? "*" : ""}`,
      );
      lines.push(
        `${indent}- ${entity.id}${properties.length ? ` (${properties.join(", ")})` : ""}`,
      );
    }
  }
  if (ontology.relationships?.length) {
    lines.push(`${indent}Link types:`);
    for (const relationship of ontology.relationships.slice(0, DIGEST_MAX_HINT_LINES)) {
      lines.push(
        `${indent}- ${relationship.id}: ${relationship.from} -> ${relationship.to}${
          relationship.cardinality ? ` (${relationship.cardinality})` : ""
        }`,
      );
    }
  }
  if (ontology.functions?.length) {
    lines.push(`${indent}Derived values:`);
    for (const fn of ontology.functions.slice(0, DIGEST_MAX_HINT_LINES)) {
      lines.push(
        `${indent}- ${fn.id}: over ${fn.entity}, returns ${fn.returns}${
          fn.description ? ` — ${fn.description}` : ""
        }`,
      );
    }
  }
  if (ontology.actions?.length) {
    lines.push(`${indent}Actions:`);
    for (const action of ontology.actions.slice(0, DIGEST_MAX_HINT_LINES)) {
      // Effects are the action's write scope. The model has to know it is about
      // to create/update an object type before it calls the tool, not after
      // governance blocks it. Reads are omitted: they carry no such warning.
      const writes = (action.effects ?? [])
        .filter((effect) => effect.kind !== "read")
        .map((effect) => `${effect.kind} ${effect.entity}`);
      // Parameters are what the model must actually gather before it can call
      // the action, so the declaration is only useful if it reaches the prompt.
      const parameters = (action.parameters ?? []).map(
        (parameter) =>
          `${parameter.id} (${parameter.type}${parameter.required ? ", required" : ""})`,
      );
      const detail = [
        action.description,
        action.tools?.length ? `tools: ${action.tools.toSorted().join(", ")}` : undefined,
        parameters.length ? `params: ${parameters.join(", ")}` : undefined,
        writes.length ? `writes: ${writes.join(", ")}` : undefined,
      ]
        .filter(Boolean)
        .join(" — ");
      lines.push(`${indent}- ${action.id}${detail ? `: ${detail}` : ""}`);
      // Preconditions gate the action, so they must reach the model before it
      // acts. Accepting the field without rendering it would make it decorative.
      for (const precondition of action.preconditions?.slice(0, DIGEST_MAX_HINT_LINES) ?? []) {
        lines.push(`${indent}  requires: ${precondition}`);
      }
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
    // Ids only: which foundation covers what is a RUNTIME fact (the descriptor
    // from the live registry), and this digest is built from the plan alone. The
    // human-readable routing labels live in the `knowledge_search` tool
    // description, which is assembled after runtime plugins register.
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

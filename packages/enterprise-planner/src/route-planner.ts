/**
 * Workflow planning: which tree governs a request, and which part of it runs.
 *
 * Both questions are one model call. Tree selection used to be a keyword
 * substring match in core, which failed in both directions: a request phrased
 * without the tree's keywords (or in another language) silently escaped the
 * work-map's tool scopes entirely, and an unrelated request that happened to
 * contain one ("refactor the payout settlement code") got locked into them.
 * Keyword matching is also the cheaper half of a decision the model is already
 * making, so folding it in costs no extra call — and keeps the planning prompt
 * a single stable prefix rather than one that changes with whichever tree
 * matched.
 *
 * Route selection then answers WHICH PART of the chosen tree runs. A 40-node
 * tree has one relevant branch for any given request, and planning the whole
 * thing means the run carries (and steps through) 35 nodes of guidance that do
 * not apply. The planner picks cut points — node ids — and the run plans exactly
 * their subtrees plus the ancestors needed to reach them. Ancestors matter:
 * governance merges every node's ontology down the root→active path, so dropping
 * an ancestor would drop the tool ceiling it declares.
 *
 * The model call is INJECTED. This module stays pure so the prompt inputs, the
 * parsing contract, and the route→node resolution are testable without a
 * provider, and so a run with no planner wired simply falls back to the default
 * tree planned whole (today's behavior) rather than failing.
 *
 * Candidate ORDER is the caller's: this package is structural and does not know
 * about triggers or priorities, so core hands it an already-filtered,
 * deterministically ordered list and the fail-closed pick below is "the first
 * non-default candidate".
 */
import { z } from "zod";
import type { PlannableNode, PlannableTree } from "./types.js";

/** Alias kept for readability inside this module. */
type EnterpriseId = string;
type WorkflowNodeDefinition = PlannableNode;
type WorkflowTreeDefinition = PlannableTree;

/** Trees this small are cheaper to run whole than to ask a model about. */
const MIN_NODES_TO_PLAN = 5;
/** Keep the candidate digest bounded: it is prompt-cache-sensitive prefix text. */
const SUMMARY_MAX_CHARS = 120;

/**
 * What the injected planner must return. Three outcomes, kept distinct because
 * selectWorkflowPlan treats each differently — collapsing any two of them either
 * drops requests out of governance or drags every request into a work-map:
 *
 * - `decided` — the model answered. `treeId: null` inside it is itself an answer
 *   ("no work-map applies") and is honored.
 * - `unavailable` — the planner could not be consulted AT ALL: no model is
 *   configured or authorized for it. That is a property of the install, not of
 *   the request, and no request can provoke it.
 * - `failed` — it WAS consulted and the transport or the answer was unusable.
 *   A crafted request can provoke this, so it must not read as an answer.
 */
export type WorkflowPlanDecision =
  | { kind: "decided"; treeId: string | null; routes: string[]; rationale?: string }
  | { kind: "unavailable" }
  | { kind: "failed" };

export type WorkflowPlanner = (params: {
  /** Candidate trees, in the caller's deterministic order. */
  trees: readonly WorkflowTreeDefinition[];
  requestText: string;
  /** The candidates, already rendered. Planners should not re-derive them. */
  candidates: string;
  signal?: AbortSignal;
}) => Promise<WorkflowPlanDecision>;

export type EnterpriseRouteSelection = {
  /** Cut points the planner chose (node ids), empty when the whole tree runs. */
  routes: EnterpriseId[];
  /** Node ids to plan, or null to plan the whole tree. */
  nodeIds: ReadonlySet<EnterpriseId> | null;
  rationale: string;
  source: "planner" | "whole-tree";
  /** Route strings the planner returned that do not exist in the tree. */
  invalidRoutes: string[];
};

/** How the governing tree was chosen, recorded on the plan for audit. */
export type WorkflowTreeSource =
  /** The model picked it from the candidates. */
  | "planner"
  /** Only one tree could apply, so no model call was made. */
  | "only-candidate"
  /** The model judged that no work-map applies; the default tree governs. */
  | "no-match"
  /**
   * No planner could be consulted for this run at all. The default tree governs:
   * an install that can never plan would otherwise put EVERY request, including
   * unrelated ones, under whichever work-map sorts first — see selectWorkflowPlan.
   */
  | "unavailable"
  /**
   * A planner WAS consulted and answered unusably. A domain tree governs rather
   * than the permissive default — see selectWorkflowPlan.
   */
  | "fallback";

export type EnterpriseWorkflowSelection<
  TTree extends WorkflowTreeDefinition = WorkflowTreeDefinition,
> = {
  tree: TTree;
  treeSource: WorkflowTreeSource;
  /** Model text when the model chose; a fixed explanation otherwise. */
  treeRationale: string;
  route: EnterpriseRouteSelection;
};

const planDecisionSchema = z.object({
  treeId: z.string().nullable(),
  routes: z.array(z.string()),
  rationale: z.string().optional(),
});

function shorten(text: string | undefined): string {
  if (!text) {
    return "";
  }
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SUMMARY_MAX_CHARS ? `${flat.slice(0, SUMMARY_MAX_CHARS - 1)}…` : flat;
}

function walk(
  node: WorkflowNodeDefinition,
  depth: number,
  visit: (node: WorkflowNodeDefinition, depth: number) => void,
): void {
  visit(node, depth);
  for (const child of node.children ?? []) {
    walk(child, depth + 1, visit);
  }
}

export function countTreeNodes(tree: WorkflowTreeDefinition): number {
  let count = 0;
  walk(tree.root, 0, () => {
    count += 1;
  });
  return count;
}

/**
 * Render one tree as an indented list of selectable routes. Only titles and a
 * short description go in: the ontology digest is what the RUN sees, and putting
 * it here would balloon the planning prompt for no selection signal.
 */
export function buildRouteCandidateDigest(tree: WorkflowTreeDefinition): string {
  const lines: string[] = [];
  walk(tree.root, 0, (node, depth) => {
    const summary = shorten(node.description);
    const indent = "  ".repeat(depth);
    lines.push(`${indent}${node.id} — ${node.title}${summary ? `: ${summary}` : ""}`);
  });
  return lines.join("\n");
}

/**
 * Render every candidate tree for one prompt. The model needs each tree's nodes
 * in the same call it picks the tree, because picking a tree without seeing what
 * is inside it is a name-matching exercise — the failure mode this replaces.
 *
 * The tree description carries the domain cue that keywords used to carry, so it
 * has to be here: two work-maps can have equally generic names ("Operations")
 * and be told apart only by what their descriptions claim.
 */
export function buildPlanCandidateDigest(trees: readonly WorkflowTreeDefinition[]): string {
  return trees
    .map((tree) => {
      const summary = shorten(tree.description);
      return [
        `# ${tree.id} — ${tree.name}${summary ? `: ${summary}` : ""}`,
        buildRouteCandidateDigest(tree),
      ].join("\n");
    })
    .join("\n\n");
}

/**
 * Expand chosen cut points into the set of nodes to plan: each route's whole
 * subtree, plus every ancestor above it (governance needs the full root→node
 * scope chain, and the plan's parent links must resolve).
 */
export function resolveRouteNodeIds(
  tree: WorkflowTreeDefinition,
  routes: readonly string[],
): { nodeIds: Set<EnterpriseId>; invalid: string[] } {
  const parentOf = new Map<string, string | null>();
  const byId = new Map<string, WorkflowNodeDefinition>();
  const collect = (node: WorkflowNodeDefinition, parentId: string | null) => {
    parentOf.set(node.id, parentId);
    byId.set(node.id, node);
    for (const child of node.children ?? []) {
      collect(child, node.id);
    }
  };
  collect(tree.root, null);

  const nodeIds = new Set<EnterpriseId>();
  const invalid: string[] = [];
  for (const raw of routes) {
    const route = raw.trim();
    const node = byId.get(route);
    if (!node) {
      invalid.push(raw);
      continue;
    }
    // Descendants: the whole subtree under the cut point runs.
    walk(node, 0, (descendant) => {
      nodeIds.add(descendant.id);
    });
    // Ancestors: needed for the scope chain and for parentId to resolve.
    let parent = parentOf.get(route) ?? null;
    while (parent) {
      nodeIds.add(parent);
      parent = parentOf.get(parent) ?? null;
    }
  }
  return { nodeIds, invalid };
}

/** Whole-tree selection: the pre-planner behavior, and every route fallback. */
function wholeTree(rationale: string, invalidRoutes: string[] = []): EnterpriseRouteSelection {
  return { routes: [], nodeIds: null, rationale, source: "whole-tree", invalidRoutes };
}

/**
 * Resolve the routes a decision named against the tree it named.
 *
 * Every failure resolves to the whole tree rather than to an empty plan: an
 * empty plan would be an unGOVERNED run (no node scopes at all), which is the
 * opposite of failing closed. Running the whole tree keeps every scope the tree
 * declares — it is only less precise, never less safe.
 */
function resolveRoute(
  tree: WorkflowTreeDefinition,
  routes: readonly string[],
  rationale: string | undefined,
): EnterpriseRouteSelection {
  const total = countTreeNodes(tree);
  const { nodeIds, invalid } = resolveRouteNodeIds(tree, routes);
  if (nodeIds.size === 0) {
    return wholeTree(
      invalid.length > 0
        ? `route planner returned only unknown routes (${invalid.join(", ")}); planning the whole tree`
        : "route planner selected no route; planning the whole tree",
      invalid,
    );
  }
  // A route set that covers the tree anyway is not a narrowing; report it as
  // whole-tree so the trace does not claim a selection that changed nothing.
  if (nodeIds.size === total) {
    return wholeTree(rationale?.trim() || "route planner selected the whole tree", invalid);
  }
  const valid = routes.filter((route) => !invalid.includes(route)).map((route) => route.trim());
  return {
    routes: valid,
    nodeIds,
    rationale: rationale?.trim() || `selected ${valid.join(", ")}`,
    source: "planner",
    invalidRoutes: invalid,
  };
}

function selectionWithoutModel<TTree extends WorkflowTreeDefinition>(
  tree: TTree,
  treeSource: WorkflowTreeSource,
  treeRationale: string,
  routeRationale: string,
): EnterpriseWorkflowSelection<TTree> {
  return { tree, treeSource, treeRationale, route: wholeTree(routeRationale) };
}

/**
 * The selection for a run nothing may judge, but governance must still see a
 * work-map for: the first domain candidate, planned whole.
 *
 * Exported because mediation withholds an otherwise-available planner when a
 * run-start policy already denies a candidate — the prompt must not reach a
 * provider for a run that is going to be blocked. That is NOT the same as having
 * no planner: binding the permissive default there would make the very policy
 * that withheld the planner miss its target, and the run would be allowed.
 */
export function failClosedWorkflowSelection<TTree extends WorkflowTreeDefinition>(params: {
  trees: readonly TTree[];
  defaultTree: TTree;
  reason: string;
}): EnterpriseWorkflowSelection<TTree> {
  // Candidate order is the caller's contract: the first domain tree is the one a
  // failure binds (see the module header).
  const firstDomainTree = params.trees.find((tree) => tree.id !== params.defaultTree.id);
  return selectionWithoutModel(
    firstDomainTree ?? params.defaultTree,
    "fallback",
    params.reason,
    "planning the whole tree",
  );
}

/**
 * Choose the governing tree and the route through it, for one request.
 *
 * FAILING CLOSED. Four outcomes are deliberately not the same thing:
 *
 * - The model answers `treeId: null` — "no work-map applies". That is a
 *   judgement, and it is honored: the default tree governs, which is how a
 *   coding question on a machine that also holds a finance work-map keeps
 *   working.
 * - The model answers unusably (prose, a tree id that does not exist), or the
 *   call itself blows up. That is NOT a judgement and must not read as one. A
 *   hostile request can provoke it — the strict parser rejects prose, so text
 *   crafted to make the planner ramble would otherwise be a reliable way to fall
 *   out of governance. So a failure binds the first domain candidate and plans it
 *   WHOLE: over-restrictive, never unGOVERNED.
 * - NO planner can be consulted for this run — none was wired, or none is
 *   configured/authorized. The default tree governs. This is deliberately NOT the
 *   failure case: a request cannot cause it, it is the same answer for every run
 *   on the box, and treating it as failure would put every unrelated request
 *   (a poem, a refactor) under whichever work-map happens to sort first, planned
 *   whole. The tradeoff is accepted and real: if planner auth breaks silently,
 *   work-maps stop governing until it is fixed. The runtime logs a warning when
 *   it cannot build a planner, and `matchedBy: "unavailable"` on the run records it.
 * - No domain candidate exists at all (the stock install). Then the default tree
 *   is the only answer, and no model call is made for it.
 */
export async function selectWorkflowPlan<TTree extends WorkflowTreeDefinition>(params: {
  /** Candidate trees for this trigger, in deterministic order. */
  trees: readonly TTree[];
  /** The catch-all tree for this trigger; governs when no work-map applies. */
  defaultTree: TTree;
  requestText: string;
  planner?: WorkflowPlanner;
  signal?: AbortSignal;
}): Promise<EnterpriseWorkflowSelection<TTree>> {
  const domainTrees = params.trees.filter((tree) => tree.id !== params.defaultTree.id);
  // Nothing to decide: the default tree is the only thing that could govern.
  // Stock installs land here on every run and pay no model call for it.
  if (domainTrees.length === 0) {
    const only = params.trees[0] ?? params.defaultTree;
    if (!params.planner || countTreeNodes(only) < MIN_NODES_TO_PLAN) {
      return selectionWithoutModel(
        only,
        "only-candidate",
        "no work-map is installed for this trigger",
        !params.planner
          ? "no route planner configured"
          : `tree has ${countTreeNodes(only)} nodes; planning it is not worth a model call`,
      );
    }
  }
  /** No planner at all for this run: the default governs. See the header. */
  const unplanned = (reason: string): EnterpriseWorkflowSelection<TTree> =>
    selectionWithoutModel(
      params.defaultTree,
      "unavailable",
      reason,
      "the default tree has no route to plan",
    );

  if (!params.planner) {
    return unplanned("no workflow planner is wired for this runtime");
  }

  const byId = new Map(params.trees.map((tree) => [tree.id, tree]));
  /** A consulted planner that answered unusably must still be governed. */
  const failClosed = (reason: string): EnterpriseWorkflowSelection<TTree> =>
    failClosedWorkflowSelection({ trees: params.trees, defaultTree: params.defaultTree, reason });

  let decision: WorkflowPlanDecision;
  try {
    decision = await params.planner({
      trees: params.trees,
      requestText: params.requestText,
      candidates: buildPlanCandidateDigest(params.trees),
      ...(params.signal ? { signal: params.signal } : {}),
    });
  } catch (err) {
    return failClosed(
      `workflow planner failed (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (decision.kind === "unavailable") {
    return unplanned("no workflow planner is configured for this run");
  }
  if (decision.kind === "failed") {
    return failClosed("workflow planner returned no decision");
  }

  const parsed = planDecisionSchema.safeParse(decision);
  if (!parsed.success) {
    return failClosed("workflow planner returned an unsupported shape");
  }

  // An explicit "none apply" is an ANSWER, not a failure: honor it.
  if (parsed.data.treeId === null) {
    return selectionWithoutModel(
      params.defaultTree,
      "no-match",
      parsed.data.rationale?.trim() || "no work-map applies to this request",
      "the default tree has no route to plan",
    );
  }

  const tree = byId.get(parsed.data.treeId.trim());
  if (!tree) {
    // A named tree that does not exist is the model answering unusably, which is
    // exactly the case a crafted request could provoke. Never read it as "none".
    return failClosed(`workflow planner named an unknown tree (${parsed.data.treeId})`);
  }

  const treeRationale = parsed.data.rationale?.trim() || `selected ${tree.id}`;
  if (countTreeNodes(tree) < MIN_NODES_TO_PLAN) {
    return selectionWithoutModel(
      tree,
      "planner",
      treeRationale,
      `tree has ${countTreeNodes(tree)} nodes; planning it is not worth a model call`,
    );
  }
  return {
    tree,
    treeSource: "planner",
    treeRationale,
    route: resolveRoute(tree, parsed.data.routes, parsed.data.rationale),
  };
}

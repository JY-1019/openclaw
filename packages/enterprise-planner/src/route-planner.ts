/**
 * Route selection inside a workflow tree.
 *
 * Tree selection answers "which tree governs this request". Route selection
 * answers the next question: WHICH PART of it actually runs. A 40-node tree has
 * one relevant branch for any given request, and planning the whole thing means
 * the run carries (and steps through) 35 nodes of guidance that do not apply.
 *
 * The planner picks cut points — node ids — and the run plans exactly their
 * subtrees plus the ancestors needed to reach them. Ancestors matter: governance
 * merges every node's ontology down the root→active path, so dropping an
 * ancestor would drop the tool ceiling it declares.
 *
 * The model call is INJECTED. This module stays pure so the prompt, the parsing,
 * and the route→node resolution are testable without a provider, and so a run
 * with no planner wired simply falls back to the whole subtree (today's
 * behavior) rather than failing.
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

/** What the injected planner must return. Null means "no opinion". */
export type RoutePlannerDecision = { routes: string[]; rationale?: string } | null;

export type RoutePlanner = (params: {
  tree: WorkflowTreeDefinition;
  requestText: string;
  /** The candidate routes, already rendered. Planners should not re-derive them. */
  candidates: string;
  signal?: AbortSignal;
}) => Promise<RoutePlannerDecision>;

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

const routeDecisionSchema = z.object({
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
 * Render the tree as an indented list of selectable routes. Only titles and a
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

/** Whole-tree selection: the pre-planner behavior, and every fallback. */
function wholeTree(rationale: string, invalidRoutes: string[] = []): EnterpriseRouteSelection {
  return { routes: [], nodeIds: null, rationale, source: "whole-tree", invalidRoutes };
}

/**
 * Choose the route(s) through one tree for one request.
 *
 * Every failure resolves to the whole tree rather than to an empty plan: an
 * empty plan would be an unGOVERNED run (no node scopes at all), which is the
 * opposite of failing closed. Running the whole tree keeps every scope the tree
 * declares — it is only less precise, never less safe.
 */
export async function selectWorkflowRoute(params: {
  tree: WorkflowTreeDefinition;
  requestText: string;
  planner?: RoutePlanner;
  signal?: AbortSignal;
}): Promise<EnterpriseRouteSelection> {
  if (!params.planner) {
    return wholeTree("no route planner configured");
  }
  const total = countTreeNodes(params.tree);
  if (total < MIN_NODES_TO_PLAN) {
    return wholeTree(`tree has ${total} nodes; planning it is not worth a model call`);
  }

  let decision: RoutePlannerDecision;
  try {
    decision = await params.planner({
      tree: params.tree,
      requestText: params.requestText,
      candidates: buildRouteCandidateDigest(params.tree),
      ...(params.signal ? { signal: params.signal } : {}),
    });
  } catch (err) {
    return wholeTree(
      `route planner failed (${err instanceof Error ? err.message : String(err)}); planning the whole tree`,
    );
  }
  if (!decision) {
    return wholeTree("route planner returned no decision; planning the whole tree");
  }

  const parsed = routeDecisionSchema.safeParse(decision);
  if (!parsed.success) {
    return wholeTree("route planner returned an unsupported shape; planning the whole tree");
  }

  const { nodeIds, invalid } = resolveRouteNodeIds(params.tree, parsed.data.routes);
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
    return wholeTree(
      parsed.data.rationale?.trim() || "route planner selected the whole tree",
      invalid,
    );
  }

  const valid = parsed.data.routes.filter((route) => !invalid.includes(route)).map((r) => r.trim());
  return {
    routes: valid,
    nodeIds,
    rationale: parsed.data.rationale?.trim() || `selected ${valid.join(", ")}`,
    source: "planner",
    invalidRoutes: invalid,
  };
}

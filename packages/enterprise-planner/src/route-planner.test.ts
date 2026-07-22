import { describe, expect, it, vi } from "vitest";
import {
  buildPlanCandidateDigest,
  buildRouteCandidateDigest,
  countTreeNodes,
  resolveRouteNodeIds,
  selectWorkflowPlan,
  type WorkflowPlanner,
} from "./route-planner.js";
import type { PlannableNode, PlannableTree } from "./types.js";

function node(id: string, title: string, children?: PlannableNode[]): PlannableNode {
  return { id, title, ...(children ? { children } : {}) };
}

/** Two domains, each with two leaves: enough to prune, small enough to read. */
const TREE: PlannableTree = {
  id: "acme.ops",
  name: "Ops",
  root: node("ops", "Operations", [
    node("ops.claims", "Claims", [
      node("ops.claims.intake", "Claim intake"),
      node("ops.claims.payout", "Claim payout"),
    ]),
    node("ops.risk", "Risk", [
      node("ops.risk.triage", "Alert triage"),
      node("ops.risk.filing", "SAR filing"),
    ]),
  ]),
};

/** The permissive catch-all every trigger falls back to. */
const DEFAULT_TREE: PlannableTree = {
  id: "clawworks.assist",
  name: "General assistance",
  root: node("assist", "Assist with the request", [node("assist.do", "Carry out the work")]),
};

const CANDIDATES = [TREE, DEFAULT_TREE];

const plannerReturning = (
  treeId: string | null,
  routes: string[],
  rationale = "because",
): WorkflowPlanner => vi.fn(async () => ({ kind: "decided" as const, treeId, routes, rationale }));

const planFor = (requestText: string, planner?: WorkflowPlanner) =>
  selectWorkflowPlan({
    trees: CANDIDATES,
    defaultTree: DEFAULT_TREE,
    requestText,
    ...(planner ? { planner } : {}),
  });

describe("resolveRouteNodeIds", () => {
  it("expands a cut point into its subtree plus every ancestor", () => {
    const { nodeIds, invalid } = resolveRouteNodeIds(TREE, ["ops.claims"]);
    expect(invalid).toEqual([]);
    // Ancestors (root) + the cut point + its whole subtree — and nothing from risk.
    expect([...nodeIds].toSorted()).toEqual([
      "ops",
      "ops.claims",
      "ops.claims.intake",
      "ops.claims.payout",
    ]);
  });

  it("reports unknown routes instead of silently dropping them", () => {
    const { nodeIds, invalid } = resolveRouteNodeIds(TREE, ["ops.claims", "ops.nope"]);
    expect(invalid).toEqual(["ops.nope"]);
    expect(nodeIds.has("ops.claims.intake")).toBe(true);
  });

  it("unions several routes", () => {
    const { nodeIds } = resolveRouteNodeIds(TREE, ["ops.claims.payout", "ops.risk.triage"]);
    expect([...nodeIds].toSorted()).toEqual([
      "ops",
      "ops.claims",
      "ops.claims.payout",
      "ops.risk",
      "ops.risk.triage",
    ]);
    // The unselected siblings are not planned.
    expect(nodeIds.has("ops.claims.intake")).toBe(false);
    expect(nodeIds.has("ops.risk.filing")).toBe(false);
  });
});

describe("buildRouteCandidateDigest", () => {
  it("renders every node as an indented, selectable id", () => {
    const digest = buildRouteCandidateDigest(TREE);
    expect(digest).toContain("ops — Operations");
    expect(digest).toContain("  ops.claims — Claims");
    expect(digest).toContain("    ops.claims.payout — Claim payout");
    expect(digest.split("\n")).toHaveLength(countTreeNodes(TREE));
  });
});

describe("buildPlanCandidateDigest", () => {
  it("renders every candidate tree with its nodes", () => {
    const digest = buildPlanCandidateDigest(CANDIDATES);
    // The model picks the tree and the branch from ONE prompt, so both trees and
    // both node lists have to be in it.
    expect(digest).toContain("# acme.ops — Ops");
    expect(digest).toContain("# clawworks.assist — General assistance");
    expect(digest).toContain("    ops.claims.payout — Claim payout");
    expect(digest).toContain("  assist.do — Carry out the work");
  });

  it("renders each tree's description, the domain cue selection depends on", () => {
    // Two work-maps can carry equally generic names and be told apart only by
    // what their descriptions claim. Nothing else carries that signal since
    // keyword matching was removed, so leaving it out silently degrades
    // selection to name matching.
    const digest = buildPlanCandidateDigest([
      { ...TREE, description: "Claims handling and financial-crime risk." },
      DEFAULT_TREE,
    ]);
    expect(digest).toContain("# acme.ops — Ops: Claims handling and financial-crime risk.");
    // A tree without one still renders cleanly (no dangling separator).
    expect(digest).toContain("# clawworks.assist — General assistance\n");
  });
});

describe("selectWorkflowPlan", () => {
  it("binds the work-map the model chose and plans only the chosen branch", async () => {
    const selection = await planFor(
      "pay out the claim",
      plannerReturning("acme.ops", ["ops.claims.payout"]),
    );
    expect(selection.tree.id).toBe("acme.ops");
    expect(selection.treeSource).toBe("planner");
    expect(selection.route.source).toBe("planner");
    expect(selection.route.nodeIds && [...selection.route.nodeIds].toSorted()).toEqual([
      "ops",
      "ops.claims",
      "ops.claims.payout",
    ]);
  });

  it("honors an explicit 'no work-map applies' by binding the default tree", async () => {
    const selection = await planFor("write me a python script", plannerReturning(null, []));
    // This is the judgement we ASKED for, so it is honored: a coding question on a
    // machine that also holds a finance work-map keeps working.
    expect(selection.tree.id).toBe(DEFAULT_TREE.id);
    expect(selection.treeSource).toBe("no-match");
  });

  it("fails closed to a work-map when the planner throws", async () => {
    const selection = await planFor(
      "x",
      vi.fn(async () => {
        throw new Error("provider down");
      }),
    );
    // NOT the permissive default: a failure is not a judgement that nothing
    // applies, and a hostile request can provoke one.
    expect(selection.tree.id).toBe("acme.ops");
    expect(selection.treeSource).toBe("fallback");
    expect(selection.treeRationale).toContain("provider down");
    // Failing closed also means planning the tree WHOLE, never an empty plan.
    expect(selection.route.nodeIds).toBeNull();
  });

  it("fails closed when the reply is unparseable prose", async () => {
    // The runtime parser reports prose as "failed"; that reaches here as a failure.
    const selection = await planFor(
      "x",
      vi.fn(async () => ({ kind: "failed" }) as const),
    );
    expect(selection.tree.id).toBe("acme.ops");
    expect(selection.treeSource).toBe("fallback");
  });

  it("fails closed when the planner names a tree that does not exist", async () => {
    const selection = await planFor("x", plannerReturning("acme.ghost", ["ops.claims"]));
    expect(selection.tree.id).toBe("acme.ops");
    expect(selection.treeSource).toBe("fallback");
    expect(selection.treeRationale).toContain("acme.ghost");
  });

  it("binds the default tree when no planner is wired", async () => {
    const selection = await planFor("anything");
    // No planner can be consulted, so nothing distinguishes this request from any
    // other on the box. Binding the work-map here would put every unrelated
    // request under it, planned whole — which is what it looked like in practice.
    expect(selection.tree.id).toBe("clawworks.assist");
    expect(selection.treeSource).toBe("unavailable");
    expect(selection.route.nodeIds).toBeNull();
  });

  it("separates a planner that cannot be consulted from one that answered badly", async () => {
    // Same null-ish outcome, opposite bindings: "unavailable" is a property of the
    // install (no request can cause it), while "failed" can be provoked by crafted
    // text, so only the latter fails closed onto a work-map.
    const unavailable = await planFor(
      "anything",
      vi.fn(async () => ({ kind: "unavailable" }) as const),
    );
    expect(unavailable.tree.id).toBe("clawworks.assist");
    expect(unavailable.treeSource).toBe("unavailable");

    const failed = await planFor(
      "anything",
      vi.fn(async () => ({ kind: "failed" }) as const),
    );
    expect(failed.tree.id).toBe("acme.ops");
    expect(failed.treeSource).toBe("fallback");
    expect(failed.route.nodeIds).toBeNull();
  });

  it("binds the default tree when no planner is wired and no work-map exists", async () => {
    const selection = await selectWorkflowPlan({
      trees: [DEFAULT_TREE],
      defaultTree: DEFAULT_TREE,
      requestText: "anything",
    });
    expect(selection.tree.id).toBe(DEFAULT_TREE.id);
    expect(selection.treeSource).toBe("only-candidate");
  });

  it("makes no model call when the default tree is the only candidate", async () => {
    const planner = plannerReturning("clawworks.assist", []);
    const selection = await selectWorkflowPlan({
      trees: [DEFAULT_TREE],
      defaultTree: DEFAULT_TREE,
      requestText: "hello",
      planner,
    });
    // The stock install lands here on every run and must pay nothing for it.
    expect(planner).not.toHaveBeenCalled();
    expect(selection.treeSource).toBe("only-candidate");
  });

  it("plans the chosen tree whole when every route is a hallucination", async () => {
    const selection = await planFor("x", plannerReturning("acme.ops", ["ops.nonexistent"]));
    expect(selection.tree.id).toBe("acme.ops");
    expect(selection.route.source).toBe("whole-tree");
    expect(selection.route.invalidRoutes).toEqual(["ops.nonexistent"]);
  });

  it("keeps valid routes and reports the hallucinated ones alongside", async () => {
    const selection = await planFor(
      "x",
      plannerReturning("acme.ops", ["ops.risk.filing", "ops.ghost"]),
    );
    expect(selection.route.source).toBe("planner");
    expect(selection.route.routes).toEqual(["ops.risk.filing"]);
    expect(selection.route.invalidRoutes).toEqual(["ops.ghost"]);
  });

  it("reports selecting the root as whole-tree, not as a narrowing", async () => {
    const selection = await planFor("x", plannerReturning("acme.ops", ["ops"]));
    expect(selection.route.source).toBe("whole-tree");
    expect(selection.route.nodeIds).toBeNull();
  });

  it("skips route planning for a chosen tree too small to be worth it", async () => {
    const tiny: PlannableTree = {
      id: "acme.tiny",
      name: "Tiny",
      root: node("tiny", "Tiny", [node("tiny.a", "A")]),
    };
    const selection = await selectWorkflowPlan({
      trees: [tiny, DEFAULT_TREE],
      defaultTree: DEFAULT_TREE,
      requestText: "x",
      planner: plannerReturning("acme.tiny", ["tiny.a"]),
    });
    expect(selection.tree.id).toBe("acme.tiny");
    expect(selection.treeSource).toBe("planner");
    expect(selection.route.source).toBe("whole-tree");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  buildRouteCandidateDigest,
  countTreeNodes,
  resolveRouteNodeIds,
  selectWorkflowRoute,
  type RoutePlanner,
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

const plannerReturning = (routes: string[], rationale = "because"): RoutePlanner =>
  vi.fn(async () => ({ routes, rationale }));

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

describe("selectWorkflowRoute", () => {
  it("plans only the chosen branch", async () => {
    const selection = await selectWorkflowRoute({
      tree: TREE,
      requestText: "pay out the claim",
      planner: plannerReturning(["ops.claims.payout"]),
    });
    expect(selection.source).toBe("planner");
    expect(selection.routes).toEqual(["ops.claims.payout"]);
    expect(selection.nodeIds && [...selection.nodeIds].toSorted()).toEqual([
      "ops",
      "ops.claims",
      "ops.claims.payout",
    ]);
  });

  it("falls back to the whole tree when no planner is wired", async () => {
    const selection = await selectWorkflowRoute({ tree: TREE, requestText: "anything" });
    expect(selection.source).toBe("whole-tree");
    expect(selection.nodeIds).toBeNull();
  });

  it("falls back to the whole tree when the planner throws", async () => {
    const selection = await selectWorkflowRoute({
      tree: TREE,
      requestText: "x",
      planner: vi.fn(async () => {
        throw new Error("provider down");
      }),
    });
    // A failed planner must never yield an EMPTY plan: that would be an
    // ungoverned run. The whole tree is less precise, never less governed.
    expect(selection.source).toBe("whole-tree");
    expect(selection.nodeIds).toBeNull();
    expect(selection.rationale).toContain("provider down");
  });

  it("falls back to the whole tree when every route is a hallucination", async () => {
    const selection = await selectWorkflowRoute({
      tree: TREE,
      requestText: "x",
      planner: plannerReturning(["ops.nonexistent"]),
    });
    expect(selection.source).toBe("whole-tree");
    expect(selection.nodeIds).toBeNull();
    expect(selection.invalidRoutes).toEqual(["ops.nonexistent"]);
  });

  it("keeps valid routes and reports the hallucinated ones alongside", async () => {
    const selection = await selectWorkflowRoute({
      tree: TREE,
      requestText: "x",
      planner: plannerReturning(["ops.risk.filing", "ops.ghost"]),
    });
    expect(selection.source).toBe("planner");
    expect(selection.routes).toEqual(["ops.risk.filing"]);
    expect(selection.invalidRoutes).toEqual(["ops.ghost"]);
  });

  it("reports selecting the root as whole-tree, not as a narrowing", async () => {
    const selection = await selectWorkflowRoute({
      tree: TREE,
      requestText: "x",
      planner: plannerReturning(["ops"]),
    });
    // Selecting the root covers every node; calling that a "route" would make the
    // trace claim a selection that pruned nothing.
    expect(selection.source).toBe("whole-tree");
    expect(selection.nodeIds).toBeNull();
  });

  it("does not call the planner for a tree too small to be worth planning", async () => {
    const planner = plannerReturning(["tiny.a"]);
    const tiny: PlannableTree = {
      ...TREE,
      id: "acme.tiny",
      root: node("tiny", "Tiny", [node("tiny.a", "A")]),
    };
    const selection = await selectWorkflowRoute({ tree: tiny, requestText: "x", planner });
    expect(planner).not.toHaveBeenCalled();
    expect(selection.source).toBe("whole-tree");
  });
});

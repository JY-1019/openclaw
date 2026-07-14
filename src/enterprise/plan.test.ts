import { describe, expect, it } from "vitest";
import { BUILTIN_ASSIST_TREE, BUILTIN_SYSTEM_TREE } from "./builtin-trees.js";
import {
  buildEnterprisePromptSection,
  buildEnterpriseRunPlan,
  classifyWorkflowTrigger,
  enterpriseStepSequence,
  ontologyHasGuidance,
  planTracksSteps,
  resolvePlanNodePath,
  selectWorkflowTree,
} from "./plan.js";
import type { WorkflowTreeDefinition } from "./types.js";

const REFUND_TREE: WorkflowTreeDefinition = {
  schema: "clawworks.workflow-tree",
  schemaVersion: 1,
  id: "acme.refunds",
  version: "1.0.0",
  name: "Refund handling",
  match: { keywords: ["refund", "chargeback"], triggers: ["user"] },
  root: {
    id: "refunds",
    title: "Handle a refund request",
    ontology: {
      allowedTools: ["memory_search", "message"],
      constraints: [{ id: "policy", description: "Only refund within 30 days." }],
      contextHints: ["Refund window: 30 days."],
      expectedOutput: "Refund decision with rationale.",
    },
    children: [
      { id: "refunds.verify", title: "Verify the purchase" },
      { id: "refunds.decide", title: "Decide the refund" },
    ],
  },
};

describe("classifyWorkflowTrigger", () => {
  it("maps triggers onto tree trigger classes", () => {
    expect(classifyWorkflowTrigger({ trigger: "user" })).toBe("user");
    expect(classifyWorkflowTrigger({ trigger: "manual" })).toBe("user");
    expect(classifyWorkflowTrigger({})).toBe("user");
    expect(classifyWorkflowTrigger({ trigger: "cron" })).toBe("system");
    expect(classifyWorkflowTrigger({ trigger: "heartbeat" })).toBe("system");
    expect(classifyWorkflowTrigger({ trigger: "user", spawnedBy: "agent:main:x" })).toBe(
      "subagent",
    );
  });
});

describe("selectWorkflowTree", () => {
  const trees = [BUILTIN_ASSIST_TREE, BUILTIN_SYSTEM_TREE, REFUND_TREE];

  it("prefers keyword matches over trigger-only trees", () => {
    const selection = selectWorkflowTree({
      requestText: "I want a refund for my order",
      trigger: "user",
      trees,
    });
    expect(selection.tree.id).toBe("acme.refunds");
    expect(selection.matchedBy).toBe("keywords");
  });

  it("skips keyword-scoped trees when nothing matches", () => {
    const selection = selectWorkflowTree({
      requestText: "what is the weather like",
      trigger: "user",
      trees,
    });
    expect(selection.tree.id).toBe("clawworks.assist");
    expect(selection.matchedBy).toBe("trigger");
  });

  it("routes system triggers to the system tree", () => {
    const selection = selectWorkflowTree({ requestText: "tick", trigger: "system", trees });
    expect(selection.tree.id).toBe("clawworks.system");
  });

  it("falls back to the built-in default when no tree matches the trigger", () => {
    const selection = selectWorkflowTree({
      requestText: "hello",
      trigger: "system",
      trees: [REFUND_TREE],
    });
    expect(selection.tree.id).toBe("clawworks.assist");
    expect(selection.matchedBy).toBe("default");
  });

  it("falls back to an imported override of the default tree, not the static built-in", () => {
    const assistOverride: WorkflowTreeDefinition = {
      ...BUILTIN_ASSIST_TREE,
      version: "9.9.9",
      match: { keywords: ["special"], triggers: ["user"] },
    };
    const selection = selectWorkflowTree({
      requestText: "hello",
      trigger: "user",
      trees: [assistOverride, BUILTIN_SYSTEM_TREE],
    });
    expect(selection.matchedBy).toBe("default");
    expect(selection.tree.version).toBe("9.9.9");
  });

  it("treats an empty trigger list like user-triggered (programmatic trees)", () => {
    const tree: WorkflowTreeDefinition = {
      ...REFUND_TREE,
      id: "acme.empty-triggers",
      match: { keywords: ["refund"], triggers: [] },
    };
    const selection = selectWorkflowTree({
      requestText: "refund please",
      trigger: "user",
      trees: [tree],
    });
    expect(selection.tree.id).toBe("acme.empty-triggers");
  });
});

describe("buildEnterpriseRunPlan", () => {
  it("flattens the subtree depth-first and starts on the root scope", () => {
    const plan = buildEnterpriseRunPlan({
      runId: "run-1",
      requestText: "please process my refund",
      trigger: "user",
      mode: "enforce",
      trees: [BUILTIN_ASSIST_TREE, REFUND_TREE],
      now: 1000,
    });
    expect(plan.treeId).toBe("acme.refunds");
    expect(plan.nodes.map((node) => node.nodeId)).toEqual([
      "refunds",
      "refunds.verify",
      "refunds.decide",
    ]);
    expect(plan.nodes.map((node) => node.seq)).toEqual([0, 1, 2]);
    expect(plan.nodes[1].parentId).toBe("refunds");
    // Runs start on the root; the embedded step hook enters the first leaf.
    expect(plan.activeNodeId).toBe("refunds");
    expect(plan.createdAt).toBe(1000);
  });

  it("truncates and collapses whitespace in the request summary", () => {
    const plan = buildEnterpriseRunPlan({
      runId: "run-2",
      requestText: `a  b\n\nc ${"x".repeat(600)}`,
      trigger: "user",
      mode: "enforce",
      trees: [BUILTIN_ASSIST_TREE],
    });
    expect(plan.requestSummary.startsWith("a b c ")).toBe(true);
    expect(plan.requestSummary.length).toBeLessThanOrEqual(300);
    expect(plan.requestSummary.endsWith("…")).toBe(true);
  });
});

describe("buildEnterpriseRunPlan route pruning", () => {
  it("plans only the selected route and keeps its ancestors (the governance scope chain)", () => {
    const tree: WorkflowTreeDefinition = {
      ...REFUND_TREE,
      root: {
        id: "refunds",
        title: "Refunds",
        ontology: { deniedTools: ["exec"] },
        children: [
          {
            id: "refunds.intake",
            title: "Intake",
            children: [{ id: "refunds.intake.triage", title: "Triage" }],
          },
          {
            id: "refunds.payout",
            title: "Payout",
            children: [{ id: "refunds.payout.issue", title: "Issue payment" }],
          },
        ],
      },
    };
    const plan = buildEnterpriseRunPlan({
      runId: "run-route",
      requestText: "refund",
      trigger: "user",
      mode: "enforce",
      trees: [tree],
      route: {
        routes: ["refunds.payout"],
        nodeIds: new Set(["refunds", "refunds.payout", "refunds.payout.issue"]),
        rationale: "the request is about paying out",
        source: "planner",
        invalidRoutes: [],
      },
    });
    expect(plan.nodes.map((node) => node.nodeId)).toEqual([
      "refunds",
      "refunds.payout",
      "refunds.payout.issue",
    ]);
    // The root is kept even though it was not the cut point: governance merges
    // every ancestor's ontology down the path, so dropping it would drop the
    // tool ceiling it declares.
    expect(plan.nodes[0].ontology.deniedTools).toEqual(["exec"]);
    expect(plan.activeNodeId).toBe("refunds");
    expect(plan.route).toMatchObject({
      routes: ["refunds.payout"],
      source: "planner",
      selectedNodes: 3,
      totalNodes: 5,
    });
  });

  it("redacts secrets out of the planner's rationale before it is persisted", () => {
    // The rationale is model text echoing the request. It lands in plan_json, the
    // route.selected trace event, and the chat card — so it must be redacted like
    // requestSummary, or the trace becomes a new secret sink.
    const plan = buildEnterpriseRunPlan({
      runId: "run-redact",
      requestText: "refund",
      trigger: "user",
      mode: "enforce",
      trees: [REFUND_TREE],
      route: {
        routes: [],
        nodeIds: null,
        rationale: "the user pasted sk-ant-api03-SUPERSECRETVALUE0000000000 into the prompt",
        source: "whole-tree",
        invalidRoutes: [],
      },
    });
    expect(plan.route?.rationale).not.toContain("SUPERSECRETVALUE");
  });

  it("plans the whole tree when the route selection is whole-tree", () => {
    const plan = buildEnterpriseRunPlan({
      runId: "run-whole",
      requestText: "refund",
      trigger: "user",
      mode: "enforce",
      trees: [REFUND_TREE],
      route: {
        routes: [],
        nodeIds: null,
        rationale: "planner unavailable",
        source: "whole-tree",
        invalidRoutes: [],
      },
    });
    expect(plan.route?.source).toBe("whole-tree");
    expect(plan.route?.selectedNodes).toBe(plan.route?.totalNodes);
  });

  it("ignores a route resolved against a different tree rather than planning nothing", () => {
    // Defensive: a stale/foreign node set must not produce an empty (ungoverned)
    // plan. Planning everything is the safe read.
    const plan = buildEnterpriseRunPlan({
      runId: "run-foreign",
      requestText: "refund",
      trigger: "user",
      mode: "enforce",
      trees: [REFUND_TREE],
      route: {
        routes: ["other.tree.node"],
        nodeIds: new Set(["other.tree.node"]),
        rationale: "stale",
        source: "planner",
        invalidRoutes: [],
      },
    });
    expect(plan.nodes.length).toBeGreaterThan(0);
    expect(plan.route?.source).toBe("whole-tree");
    expect(plan.route?.routes).toEqual([]);
  });
});

describe("buildEnterprisePromptSection", () => {
  it("returns an empty string for guidance-free built-in trees (prompt-neutral default)", () => {
    const plan = buildEnterpriseRunPlan({
      runId: "run-3",
      requestText: "hello",
      trigger: "user",
      mode: "enforce",
      trees: [BUILTIN_ASSIST_TREE],
    });
    expect(buildEnterprisePromptSection(plan)).toBe("");
  });

  it("renders the ids the ontology tools take as arguments", () => {
    // Without these the model has the tools but no vocabulary for them: it cannot
    // know this step addresses a "claim", that it links to a "policy", or that a
    // "band" exists to compute — so it would have to guess ids and read back
    // errors. Ids and shapes only; the VALUES are fetched with search_objects.
    const plan = buildEnterpriseRunPlan({
      runId: "run-onto",
      requestText: "triage",
      trigger: "user",
      mode: "enforce",
      trees: [
        {
          schema: "clawworks.workflow-tree",
          schemaVersion: 1,
          id: "acme.claims",
          version: "1.0.0",
          name: "Claims",
          match: { triggers: ["user"], priority: 50 },
          root: {
            id: "claims",
            title: "Handle a claim",
            ontology: {
              entities: [
                {
                  id: "claim",
                  properties: [
                    { id: "claim-id", type: "id", primaryKey: true },
                    { id: "fraud-score", type: "number" },
                  ],
                },
                { id: "policy", properties: [{ id: "policy-id", type: "id", primaryKey: true }] },
              ],
              relationships: [
                {
                  id: "claim-against-policy",
                  from: "claim",
                  to: "policy",
                  cardinality: "many-to-one",
                },
              ],
              functions: [
                {
                  id: "band",
                  entity: "claim",
                  expression: "$fraud-score >= 80 ? 'refer' : 'auto'",
                  returns: "string",
                },
              ],
            },
            children: [{ id: "claims.triage", title: "Triage" }],
          },
        },
      ],
    });
    const section = buildEnterprisePromptSection(plan);
    expect(section).toContain("Object types:");
    // The primaryKey is starred: it is the id every other tool takes.
    expect(section).toContain("- claim (claim-id*, fraud-score)");
    expect(section).toContain("Link types:");
    expect(section).toContain("- claim-against-policy: claim -> policy (many-to-one)");
    expect(section).toContain("Derived values:");
    expect(section).toContain("- band: over claim, returns string");
    // Ids and shapes, not values: the object graph lives in the store.
    expect(section).not.toContain("fraud-score >= 80");
    // Tool availability is a RUNTIME fact (opt-in tools; CLI loopback builds tools
    // with no runId at all), while this digest is built from the plan alone. Naming
    // the tools would tell the model to call something the run may never have got.
    expect(section).not.toContain("search_objects");
    expect(section).not.toContain("get_neighbors");
    expect(section).not.toContain("compute_function");
  });

  it("never names a tool in the digest, whatever the tree declares", () => {
    // Tool availability is decided by the RUNTIME, not the tree. A compat tree may
    // declare relationships without ever declaring their endpoint types under
    // `entities` (the schema allows it) and gets no ontology tools at all.
    const plan = buildEnterpriseRunPlan({
      runId: "run-compat",
      requestText: "x",
      trigger: "user",
      mode: "enforce",
      trees: [
        {
          schema: "clawworks.workflow-tree",
          schemaVersion: 1,
          id: "acme.compat",
          version: "1.0.0",
          name: "Compat",
          match: { triggers: ["user"], priority: 50 },
          root: {
            id: "compat",
            title: "Compat step",
            ontology: {
              relationships: [{ id: "a-b", from: "a", to: "b" }],
              expectedOutput: "Something.",
            },
            children: [{ id: "compat.leaf", title: "Leaf" }],
          },
        },
      ],
    });
    const section = buildEnterprisePromptSection(plan);
    expect(section).toContain("Expected output: Something.");
    // Describing the tree's link types is fine; NAMING a tool is not. This tree
    // gets no ontology tools at all, so an instruction to call one would be a lie.
    expect(section).toContain("Link types:");
    expect(section).not.toContain("get_neighbors");
    expect(section).not.toContain("search_objects");
    expect(section).not.toContain("compute_function");
  });

  it("renders a compact digest for guidance-bearing ontologies", () => {
    const plan = buildEnterpriseRunPlan({
      runId: "run-4",
      requestText: "refund please",
      trigger: "user",
      mode: "enforce",
      trees: [REFUND_TREE],
    });
    const section = buildEnterprisePromptSection(plan);
    expect(section).toContain("## Enterprise workflow");
    expect(section).toContain('workflow "Refund handling" (acme.refunds@1.0.0)');
    expect(section).toContain("0. Handle a refund request");
    expect(section).toContain("1. Verify the purchase");
    expect(section).toContain("- Only refund within 30 days.");
    expect(section).toContain("- Refund window: 30 days.");
    expect(section).toContain("Allowed tools: memory_search, message");
    expect(section).toContain("Expected output: Refund decision with rationale.");
  });

  it("renders guidance for every step even in large trees (no step-count cap)", () => {
    // 20 leaves; only the last carries scope. Governance still advances into
    // and enforces it, so its rule must appear in the digest.
    const children = Array.from({ length: 20 }, (_, index) => ({
      id: `big.step${index}`,
      title: `Step ${index}`,
      ...(index === 19 ? { ontology: { deniedTools: ["exec"] } } : {}),
    }));
    const tree: WorkflowTreeDefinition = {
      schema: "clawworks.workflow-tree",
      schemaVersion: 1,
      id: "acme.big",
      version: "1.0.0",
      name: "Big",
      match: { keywords: ["big"], triggers: ["user"] },
      root: { id: "big", title: "Big flow", children },
    };
    const section = buildEnterprisePromptSection(planFor(tree, "big"));
    // The 20th leaf (flattened seq 20) and its rule must both appear.
    expect(section).toContain("20. Step 19");
    expect(section).toContain("Denied tools: exec");
  });

  it("renders guidance for every step, including leaves the run advances into", () => {
    const tree: WorkflowTreeDefinition = {
      ...REFUND_TREE,
      root: {
        id: "refunds",
        title: "Handle a refund request",
        // Root carries no guidance; a leaf does. The digest must still render so
        // the model sees the leaf rule governance will enforce after advancing.
        children: [
          {
            id: "refunds.verify",
            title: "Verify the purchase",
            ontology: {
              allowedTools: ["memory_search"],
              constraints: [{ id: "receipt", description: "Require a receipt id." }],
            },
          },
          { id: "refunds.decide", title: "Decide the refund" },
        ],
      },
    };
    const plan = buildEnterpriseRunPlan({
      runId: "run-leaf",
      requestText: "refund please",
      trigger: "user",
      mode: "enforce",
      trees: [tree],
    });
    const section = buildEnterprisePromptSection(plan);
    expect(section).toContain("1. Verify the purchase");
    expect(section).toContain("- Require a receipt id.");
    expect(section).toContain("Allowed tools: memory_search");
  });

  it("renders knowledge sources when the ontology declares them", () => {
    const tree: WorkflowTreeDefinition = {
      ...REFUND_TREE,
      root: {
        id: "refunds",
        title: "Handle a refund request",
        ontology: { knowledgeFoundations: ["acme.support-kb", "acme.policy-kb"] },
      },
    };
    const plan = buildEnterpriseRunPlan({
      runId: "run-6",
      requestText: "refund",
      trigger: "user",
      mode: "enforce",
      trees: [tree],
    });
    expect(buildEnterprisePromptSection(plan)).toContain(
      "Knowledge sources: acme.policy-kb, acme.support-kb",
    );
  });

  it("renders action preconditions and write effects (the model must see them before it acts)", () => {
    const tree: WorkflowTreeDefinition = {
      ...REFUND_TREE,
      root: {
        id: "refunds",
        title: "Handle a refund request",
        ontology: {
          entities: [{ id: "payment" }, { id: "claim" }],
          actions: [
            {
              id: "issue-payment",
              description: "Settle an approved claim",
              tools: ["memory_search"],
              parameters: [
                { id: "claim-id", type: "id", required: true },
                { id: "amount", type: "number" },
              ],
              preconditions: ["The claim must already be approved."],
              effects: [
                { entity: "payment", kind: "create" },
                { entity: "claim", kind: "update" },
                { entity: "claim", kind: "read" },
              ],
            },
          ],
        },
      },
    };
    const plan = buildEnterpriseRunPlan({
      runId: "run-effects",
      requestText: "refund",
      trigger: "user",
      mode: "enforce",
      trees: [tree],
    });
    const section = buildEnterprisePromptSection(plan);
    expect(section).toContain("requires: The claim must already be approved.");
    // The model cannot call the action without knowing what it must gather.
    expect(section).toContain("params: claim-id (id, required), amount (number)");
    // Writes are called out; a read-only effect is not a warning and is omitted.
    expect(section).toContain("writes: create payment, update claim");
    expect(section).not.toContain("read claim");
  });

  it("renders action guidance when actions are the only ontology content", () => {
    const tree: WorkflowTreeDefinition = {
      ...REFUND_TREE,
      root: {
        id: "refunds",
        title: "Handle a refund request",
        ontology: {
          actions: [
            { id: "lookup-order", description: "Find the purchase", tools: ["memory_search"] },
            { id: "notify" },
          ],
        },
      },
    };
    const plan = buildEnterpriseRunPlan({
      runId: "run-5",
      requestText: "refund",
      trigger: "user",
      mode: "enforce",
      trees: [tree],
    });
    const section = buildEnterprisePromptSection(plan);
    expect(section).toContain("Actions:");
    expect(section).toContain("- lookup-order: Find the purchase — tools: memory_search");
    expect(section).toContain("- notify");
  });
});

const NESTED_TREE: WorkflowTreeDefinition = {
  schema: "clawworks.workflow-tree",
  schemaVersion: 1,
  id: "acme.ops",
  version: "1.0.0",
  name: "Operations",
  match: { keywords: ["deploy"], triggers: ["user"] },
  root: {
    id: "ops",
    title: "Run an operation",
    ontology: { allowedTools: ["memory_search", "message"] },
    children: [
      {
        id: "ops.phase",
        title: "Execution phase",
        ontology: { deniedTools: ["message"] },
        children: [
          { id: "ops.phase.a", title: "Step A" },
          { id: "ops.phase.b", title: "Step B" },
        ],
      },
      { id: "ops.wrap", title: "Wrap up" },
    ],
  },
};

function planFor(tree: WorkflowTreeDefinition, keywords = "deploy") {
  return buildEnterpriseRunPlan({
    runId: "run-path",
    requestText: keywords,
    trigger: "user",
    mode: "enforce",
    trees: [tree],
  });
}

describe("resolvePlanNodePath", () => {
  it("returns the root→node chain inclusive", () => {
    const plan = planFor(NESTED_TREE);
    expect(resolvePlanNodePath(plan, "ops.phase.b").map((node) => node.nodeId)).toEqual([
      "ops",
      "ops.phase",
      "ops.phase.b",
    ]);
  });

  it("returns just the root for the root node and [] for a missing node", () => {
    const plan = planFor(NESTED_TREE);
    expect(resolvePlanNodePath(plan, "ops").map((node) => node.nodeId)).toEqual(["ops"]);
    expect(resolvePlanNodePath(plan, "nope")).toEqual([]);
  });
});

describe("enterpriseStepSequence", () => {
  it("lists the depth-first leaves, skipping interior parents", () => {
    const plan = planFor(NESTED_TREE);
    expect(enterpriseStepSequence(plan)).toEqual(["ops.phase.a", "ops.phase.b", "ops.wrap"]);
  });

  it("yields a single-step sequence for a childless root", () => {
    const plan = buildEnterpriseRunPlan({
      runId: "run-single",
      requestText: "hello",
      trigger: "user",
      mode: "enforce",
      trees: [
        {
          schema: "clawworks.workflow-tree",
          schemaVersion: 1,
          id: "acme.single",
          version: "1.0.0",
          name: "Single",
          match: { keywords: ["hello"], triggers: ["user"] },
          root: { id: "solo", title: "Do it", ontology: { allowedTools: ["message"] } },
        },
      ],
    });
    expect(enterpriseStepSequence(plan)).toEqual(["solo"]);
  });
});

describe("ontologyHasGuidance / planTracksSteps", () => {
  it("flags ontologies that carry model-facing guidance", () => {
    expect(ontologyHasGuidance({})).toBe(false);
    expect(ontologyHasGuidance({ audit: true })).toBe(false);
    expect(ontologyHasGuidance({ allowedTools: ["message"] })).toBe(true);
    expect(ontologyHasGuidance({ expectedOutput: "a summary" })).toBe(true);
  });

  it("tracks steps only for governed trees with a leaf to advance into", () => {
    expect(planTracksSteps(planFor(NESTED_TREE))).toBe(true);
    expect(planTracksSteps(planFor(REFUND_TREE, "refund"))).toBe(true);
    // Guidance-free built-in trees stay step-quiet (stock path adds no writes).
    expect(planTracksSteps(planFor(BUILTIN_ASSIST_TREE, "hello"))).toBe(false);
  });

  it("tracks a root with a single guidance-bearing leaf step", () => {
    const tree: WorkflowTreeDefinition = {
      schema: "clawworks.workflow-tree",
      schemaVersion: 1,
      id: "acme.approval",
      version: "1.0.0",
      name: "Approval",
      match: { keywords: ["approve"], triggers: ["user"] },
      root: {
        id: "approval",
        title: "Approval flow",
        children: [
          {
            id: "approval.act",
            title: "Act",
            ontology: { deniedTools: ["exec"] },
          },
        ],
      },
    };
    // The lone leaf carries scope the hook must enter to enforce, so the run
    // must track even though there is nothing to advance between.
    expect(planTracksSteps(planFor(tree, "approve"))).toBe(true);
  });
});

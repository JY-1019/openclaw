import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  collectTreeRequiredProperties,
  resolveActiveOntologyScope,
  runDeclaresOntology,
} from "../../enterprise/ontology-runtime.js";
import {
  clearEnterpriseActiveRunsForTest,
  evaluateEnterpriseToolCall,
  registerEnterpriseActiveRun,
  runAllowsOntologyWrites,
  type EnterpriseActiveRun,
} from "../../enterprise/runtime.js";
import { importWorkflowTreeContent } from "../../enterprise/tree-io.js";
import { invalidateWorkflowTreeRegistry } from "../../enterprise/tree-registry.js";
import type { EnterprisePlanNode, EnterpriseRunPlan } from "../../enterprise/types.js";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import {
  createComputeFunctionTool,
  createGetNeighborsTool,
  createInvokeActionTool,
  createSearchObjectsTool,
} from "./ontology-tools.js";

const tempDir = mkdtempSync(path.join(tmpdir(), "clawworks-ontology-tools-"));
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
const TREE_ID = "test.scoped";
const RUN_ID = "run-ontology";

// The root owns `claim`. The SIBLING branch owns `payroll-record`. The whole
// point of a per-node ontology is that standing on the claims branch must not
// make the payroll branch addressable.
const TREE = JSON.stringify({
  schema: "clawworks.workflow-tree",
  schemaVersion: 1,
  id: TREE_ID,
  version: "1.0.0",
  name: "Scoped",
  root: {
    id: "root",
    title: "Root",
    ontology: {
      entities: [
        {
          id: "claim",
          properties: [
            { id: "claim-id", type: "id", primaryKey: true },
            { id: "amount", type: "number" },
            { id: "fraud-score", type: "number" },
          ],
        },
        { id: "policy", properties: [{ id: "policy-id", type: "id", primaryKey: true }] },
      ],
      relationships: [{ id: "claim-against-policy", from: "claim", to: "policy" }],
      functions: [
        {
          id: "band",
          entity: "claim",
          expression: "$fraud-score >= 80 ? 'refer' : 'auto'",
          returns: "string",
        },
      ],
      objects: [
        // salary-note is declared only on the PAYROLL branch, but an object type is
        // tree-scoped, so the stored row legitimately carries it. A run on the
        // claims branch must not be able to read it.
        {
          entity: "claim",
          properties: {
            "claim-id": "C-1",
            amount: 10,
            "fraud-score": 91,
            "salary-note": "confidential",
          },
        },
        { entity: "policy", properties: { "policy-id": "P-1" } },
        { entity: "payroll-record", properties: { "run-id": "PR-1" } },
      ],
      links: [
        { relationship: "claim-against-policy", from: "C-1", to: "P-1" },
        { relationship: "claim-touches-payroll", from: "C-1", to: "PR-1" },
      ],
    },
    children: [
      { id: "root.claims", title: "Claims" },
      {
        id: "root.payroll",
        title: "Payroll",
        ontology: {
          entities: [
            { id: "payroll-record", properties: [{ id: "run-id", type: "id", primaryKey: true }] },
            {
              id: "claim",
              properties: [{ id: "salary-note", type: "string", required: true }],
            },
          ],
          relationships: [{ id: "claim-touches-payroll", from: "claim", to: "payroll-record" }],
        },
      },
    ],
  },
});

/** A run standing on the claims branch. Payroll is a sibling, so it is not in scope. */
function activeRun(activeNodeId: string): EnterpriseActiveRun {
  const nodes: EnterprisePlanNode[] = [
    {
      nodeId: "root",
      parentId: null,
      seq: 0,
      title: "Root",
      ontology: JSON.parse(TREE).root.ontology,
    },
    { nodeId: "root.claims", parentId: "root", seq: 1, title: "Claims", ontology: {} },
    {
      nodeId: "root.payroll",
      parentId: "root",
      seq: 2,
      title: "Payroll",
      ontology: JSON.parse(TREE).root.children[1].ontology,
    },
  ];
  const plan: EnterpriseRunPlan = {
    runId: RUN_ID,
    treeId: TREE_ID,
    treeVersion: "1.0.0",
    treeName: "Scoped",
    matchedBy: "trigger",
    requestSummary: "triage",
    nodes,
    activeNodeId,
    mode: "enforce",
    createdAt: 0,
  };
  return { plan, policies: [] };
}

async function call(tool: ReturnType<typeof createSearchObjectsTool>, params: unknown) {
  const result = await tool.execute("call-1", params);
  return result.details as Record<string, unknown>;
}

beforeAll(() => {
  setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
  invalidateWorkflowTreeRegistry();
  expect(importWorkflowTreeContent({ content: TREE, format: "json" }).ok).toBe(true);
});

afterEach(() => {
  clearEnterpriseActiveRunsForTest();
});

afterAll(() => {
  closeOpenClawStateDatabase();
  invalidateWorkflowTreeRegistry();
  rmSync(tempDir, { recursive: true, force: true });
  envSnapshot.restore();
});

describe("search_objects", () => {
  it("returns typed objects for a type the active node declares", async () => {
    registerEnterpriseActiveRun(activeRun("root.claims"));
    const details = await call(createSearchObjectsTool({ runId: RUN_ID }), { entity: "claim" });
    expect(details.count).toBe(1);
    expect(details.objects).toEqual([
      { objectId: "C-1", properties: { "claim-id": "C-1", amount: 10, "fraud-score": 91 } },
    ]);
  });

  it("refuses a type the active node's path does not declare", async () => {
    // payroll-record exists in the TREE, but on a sibling branch. Standing on the
    // claims branch it is not part of this step's contract, so it is not
    // addressable — whatever the model may have inferred from the prompt.
    registerEnterpriseActiveRun(activeRun("root.claims"));
    const details = await call(createSearchObjectsTool({ runId: RUN_ID }), {
      entity: "payroll-record",
    });
    expect(details.error).toContain("not in the ontology of this workflow step");
    // The denial names what IS addressable, so the model redirects instead of
    // reading "not found" as "the data is missing" and hunting for another way in.
    expect(details.error).toContain("claim");
    expect(details.objects).toBeUndefined();
  });

  it("becomes addressable once the run stands on the node that declares it", async () => {
    registerEnterpriseActiveRun(activeRun("root.payroll"));
    const details = await call(createSearchObjectsTool({ runId: RUN_ID }), {
      entity: "payroll-record",
    });
    expect(details.error).toBeUndefined();
    expect(details.objects).toEqual([{ objectId: "PR-1", properties: { "run-id": "PR-1" } }]);
  });

  it("reports an unmediated run rather than throwing", async () => {
    const details = await call(createSearchObjectsTool({ runId: "no-such-run" }), {
      entity: "claim",
    });
    expect(details.error).toContain("not governed by a workflow tree");
  });
});

describe("addressability gate: a dropped primaryKey hides stale runtime rows", () => {
  // The stored C-1 row was seeded while `claim` had a primaryKey. A re-import that
  // drops the primaryKey keeps that runtime row (seeds are replaced, runtime rows
  // survive), but the type can no longer own addressable instances — so the reads
  // must refuse it, matching compute_function and the enterprise.objects.list
  // gateway path, instead of handing the model an orphaned row.
  function runWithDeAddressedClaim(): EnterpriseActiveRun {
    const run = activeRun("root.claims");
    const root = run.plan.nodes.find((node) => node.nodeId === "root");
    if (!root) {
      throw new Error("expected the root node");
    }
    root.ontology = {
      ...root.ontology,
      entities: (root.ontology.entities ?? []).map((entity) =>
        entity.id === "claim"
          ? { id: "claim", properties: [{ id: "amount", type: "number" }] }
          : entity,
      ),
    };
    return run;
  }

  it("search_objects refuses a de-addressed type and returns no rows", async () => {
    registerEnterpriseActiveRun(runWithDeAddressedClaim());
    const details = await call(createSearchObjectsTool({ runId: RUN_ID }), { entity: "claim" });
    expect(details.error).toContain("not addressable");
    expect(details.objects).toBeUndefined();
  });

  it("get_neighbors refuses to traverse from a de-addressed type", async () => {
    registerEnterpriseActiveRun(runWithDeAddressedClaim());
    const details = await call(createGetNeighborsTool({ runId: RUN_ID }), {
      entity: "claim",
      objectId: "C-1",
    });
    expect(details.error).toContain("not addressable");
    expect(details.neighbors).toBeUndefined();
  });

  it("get_neighbors drops a neighbor whose TARGET type was de-addressed", async () => {
    // claim stays addressable, but policy loses its primaryKey. The stored
    // claim-against-policy link + P-1 row survive the re-import, and the link type
    // is still in scope — but the de-addressed target must not surface.
    const run = activeRun("root.claims");
    const root = run.plan.nodes.find((node) => node.nodeId === "root");
    if (!root) {
      throw new Error("expected the root node");
    }
    root.ontology = {
      ...root.ontology,
      entities: (root.ontology.entities ?? []).map((entity) =>
        entity.id === "policy"
          ? { id: "policy", properties: [{ id: "note", type: "string" }] }
          : entity,
      ),
    };
    registerEnterpriseActiveRun(run);

    const details = await call(createGetNeighborsTool({ runId: RUN_ID }), {
      entity: "claim",
      objectId: "C-1",
    });
    // claim-against-policy is the only in-scope link and its target is now
    // de-addressed, so the traversal surfaces nothing.
    expect(details.count).toBe(0);
  });
});

describe("the node boundary holds against sibling-branch data", () => {
  /** The payroll branch extends `claim` with a field and links it to its own type. */
  function runWithSiblingExtensions(activeNodeId: string): EnterpriseActiveRun {
    const run = activeRun(activeNodeId);
    const payroll = run.plan.nodes.find((node) => node.nodeId === "root.payroll");
    if (!payroll) {
      throw new Error("expected the payroll node");
    }
    payroll.ontology = {
      entities: [
        { id: "payroll-record", properties: [{ id: "run-id", type: "id", primaryKey: true }] },
        // A SIBLING adds a field to the shared `claim` type.
        { id: "claim", properties: [{ id: "salary-note", type: "string" }] },
      ],
      relationships: [{ id: "claim-touches-payroll", from: "claim", to: "payroll-record" }],
    };
    return run;
  }

  it("does not return a property a sibling branch added to a shared object type", async () => {
    registerEnterpriseActiveRun(runWithSiblingExtensions("root.claims"));
    const details = await call(createSearchObjectsTool({ runId: RUN_ID }), { entity: "claim" });
    const [object] = details.objects as Array<{ properties: Record<string, unknown> }>;
    // `salary-note` is stored on the row, but the claims branch never declared it.
    expect(Object.keys(object.properties).toSorted()).toEqual([
      "amount",
      "claim-id",
      "fraud-score",
    ]);
    expect(object.properties["salary-note"]).toBeUndefined();
  });

  it("does not let match probe a property the step cannot read", async () => {
    registerEnterpriseActiveRun(runWithSiblingExtensions("root.claims"));
    // The stored row's salary-note is "confidential". Matching it from the claims
    // branch must find nothing, or the model could probe hidden values by watching
    // which objects come back.
    const details = await call(createSearchObjectsTool({ runId: RUN_ID }), {
      entity: "claim",
      match: "confidential",
    });
    expect(details.count).toBe(0);
  });

  it("does not let compute_function derive a value from a hidden property", async () => {
    // The scalar a function returns IS the hidden data. A function validated
    // against the merged tree-wide type may reference a sibling-only property, so
    // evaluating it here would leak sideways exactly what search_objects and
    // get_neighbors withhold.
    const run = runWithSiblingExtensions("root.claims");
    const root = run.plan.nodes.find((node) => node.nodeId === "root");
    if (!root) {
      throw new Error("expected the root node");
    }
    root.ontology = {
      ...root.ontology,
      functions: [
        ...(root.ontology.functions ?? []),
        {
          id: "peek",
          entity: "claim",
          expression: "length($salary-note)",
          returns: "number",
        },
      ],
    };
    registerEnterpriseActiveRun(run);

    const details = await call(createComputeFunctionTool({ runId: RUN_ID }), {
      function: "peek",
      objectId: "C-1",
    });
    expect(details.value).toBeUndefined();
    expect(details.error).toContain('"$salary-note"');
    expect(details.error).toContain("does not declare in this workflow step");
  });

  it("does not traverse a link type a sibling branch declared", async () => {
    registerEnterpriseActiveRun(runWithSiblingExtensions("root.claims"));
    const details = await call(createGetNeighborsTool({ runId: RUN_ID }), {
      entity: "claim",
      objectId: "C-1",
    });
    const neighbors = details.neighbors as Array<{ relationship: string }>;
    // Only the claims branch's own link. claim-touches-payroll belongs to the
    // sibling, so walking it would reach straight through the node boundary.
    expect(neighbors.map((neighbor) => neighbor.relationship)).toEqual(["claim-against-policy"]);
  });
});

describe("tree-wide shape survives routing", () => {
  it("sees a required property declared on a node the route pruned", async () => {
    // A routed run plans only its route, so plan.nodes cannot be the source of the
    // tree-wide required shape: a pruned sibling's `required` would be invisible,
    // and an object created here without it would violate its own type the moment
    // a future run on that sibling reads it. The registry has the FULL tree.
    const run = activeRun("root.claims");
    // Simulate a routed plan: the payroll branch is pruned out entirely.
    run.plan.nodes = run.plan.nodes.filter((node) => node.nodeId !== "root.payroll");
    // Mediation snapshots this from the FULL tree definition it planned against,
    // not from the routed plan and not by re-reading the registry per call.
    run.treeRequiredProperties = collectTreeRequiredProperties(
      JSON.parse(TREE) as Parameters<typeof collectTreeRequiredProperties>[0],
    );
    registerEnterpriseActiveRun(run);

    const scope = resolveActiveOntologyScope(RUN_ID);
    if (!scope) {
      throw new Error("expected a scope");
    }
    // salary-note is required on the PRUNED payroll branch (see TREE).
    expect(scope.treeRequiredProperties.get("claim")?.has("salary-note")).toBe(true);
  });
});

describe("entity merging along the path", () => {
  it("keeps an ancestor's primaryKey when a child extends the object type", async () => {
    // An object type is TREE-scoped: a child may add properties to one its
    // ancestor introduced, WITHOUT repeating the primary key. Last-wins replacing
    // the ancestor's record would drop that key and make the type unaddressable —
    // compute_function would report a type it can plainly see as "not addressable".
    const run = activeRun("root.claims");
    const claims = run.plan.nodes.find((node) => node.nodeId === "root.claims");
    if (!claims) {
      throw new Error("expected the claims node");
    }
    claims.ontology = {
      entities: [{ id: "claim", properties: [{ id: "note", type: "string" }] }],
    };
    registerEnterpriseActiveRun(run);

    const details = await call(createComputeFunctionTool({ runId: RUN_ID }), {
      function: "band",
      objectId: "C-1",
    });
    expect(details.error).toBeUndefined();
    expect(details.value).toBe("refer");
  });

  it("does not let an explicit primaryKey:false clear an inherited identity", async () => {
    // A redeclaration EXTENDS a type; it does not un-declare it. Letting false
    // clear the ancestor's identity would make the object type unaddressable.
    const run = activeRun("root.claims");
    const claims = run.plan.nodes.find((node) => node.nodeId === "root.claims");
    if (!claims) {
      throw new Error("expected the claims node");
    }
    claims.ontology = {
      entities: [{ id: "claim", properties: [{ id: "claim-id", type: "id", primaryKey: false }] }],
    };
    registerEnterpriseActiveRun(run);

    const details = await call(createComputeFunctionTool({ runId: RUN_ID }), {
      function: "band",
      objectId: "C-1",
    });
    expect(details.error).toBeUndefined();
    expect(details.value).toBe("refer");
  });

  it("keeps primaryKey when a child restates a property without repeating the flag", async () => {
    // Restating `claim-id` to add a description must not drop `primaryKey: true`,
    // or the object type reports itself unaddressable at that step.
    const run = activeRun("root.claims");
    const claims = run.plan.nodes.find((node) => node.nodeId === "root.claims");
    if (!claims) {
      throw new Error("expected the claims node");
    }
    claims.ontology = {
      entities: [
        {
          id: "claim",
          properties: [{ id: "claim-id", type: "id", description: "The claim reference." }],
        },
      ],
    };
    registerEnterpriseActiveRun(run);

    const details = await call(createComputeFunctionTool({ runId: RUN_ID }), {
      function: "band",
      objectId: "C-1",
    });
    expect(details.error).toBeUndefined();
    expect(details.value).toBe("refer");
  });
});

describe("invoke_action", () => {
  it("is DENIED BY GOVERNANCE when the active step did not opt into writes", () => {
    // Exposure is plan-level (the tool list must not change mid-run), but
    // PERMISSION is path-level — and it is GOVERNANCE, decided before any policy
    // or approval runs. Deciding it in the tool instead would let a non-opted step
    // prompt a human for approval and record it, only for the tool to refuse the
    // call anyway.
    const run = activeRun("root.claims");
    const payroll = run.plan.nodes.find((node) => node.nodeId === "root.payroll");
    if (!payroll) {
      throw new Error("expected the payroll node");
    }
    // The SIBLING opts in; the active claims branch does not.
    payroll.ontology = { allowedTools: ["invoke_action"] };
    registerEnterpriseActiveRun(run);
    expect(runAllowsOntologyWrites(RUN_ID)).toBe(true);

    const verdict = evaluateEnterpriseToolCall({
      runId: RUN_ID,
      toolName: "invoke_action",
      actionId: "anything",
    });
    expect(verdict?.blocked).toBe(true);
    expect(verdict?.decision.reason).toContain("does not allow ontology writes");
  });

  it("refuses an action the workflow step does not declare", async () => {
    // The step's declared actions ARE what it may do. An action it never declared
    // is not performable here, whatever the model inferred from the prompt.
    const run = activeRun("root.claims");
    const claims = run.plan.nodes.find((node) => node.nodeId === "root.claims");
    if (!claims) {
      throw new Error("expected the claims node");
    }
    claims.ontology = { allowedTools: ["invoke_action"] };
    registerEnterpriseActiveRun(run);
    const details = await call(createInvokeActionTool({ runId: RUN_ID }), {
      action: "wire-the-money",
      args: { "claim-id": "C-1" },
    });
    expect(details.error).toContain("not in the ontology of this workflow step");
    expect(details.writes).toBeUndefined();
  });

  it("reports an unmediated run rather than writing anything", async () => {
    const details = await call(createInvokeActionTool({ runId: "no-such-run" }), {
      action: "anything",
    });
    expect(details.error).toContain("not governed by a workflow tree");
  });
});

describe("tool exposure", () => {
  it("withholds the WRITE tool unless a node explicitly allows it", () => {
    // An omitted allowedTools means allow-all, so an existing tree that declares
    // actions but scopes no tools would silently gain object-store writes on
    // upgrade — from effects that until now were only validated and rendered.
    const run = activeRun("root.claims");
    registerEnterpriseActiveRun(run);
    expect(runDeclaresOntology(RUN_ID)).toBe(true);
    expect(runAllowsOntologyWrites(RUN_ID)).toBe(false);
    clearEnterpriseActiveRunsForTest();

    const optedIn = activeRun("root.claims");
    const claims = optedIn.plan.nodes.find((node) => node.nodeId === "root.claims");
    if (!claims) {
      throw new Error("expected the claims node");
    }
    claims.ontology = { allowedTools: ["search_objects", "invoke_action"] };
    registerEnterpriseActiveRun(optedIn);
    expect(runAllowsOntologyWrites(RUN_ID)).toBe(true);
  });

  it("accepts an opt-in whatever its casing", () => {
    // The ontology scope gate normalizes tool names, so an exact-string check here
    // would deny writes for a step that explicitly allowed the tool.
    const run = activeRun("root.claims");
    const claims = run.plan.nodes.find((node) => node.nodeId === "root.claims");
    if (!claims) {
      throw new Error("expected the claims node");
    }
    claims.ontology = { allowedTools: [" INVOKE_ACTION "] };
    registerEnterpriseActiveRun(run);
    expect(runAllowsOntologyWrites(RUN_ID)).toBe(true);
  });

  it("accepts the enterprise-write GROUP as an opt-in", () => {
    // group:enterprise-write exists solely to hold this tool, and it is the
    // documented way to allow it. A check that only knew the literal name would
    // make the advertised configuration silently not work.
    const run = activeRun("root.claims");
    const claims = run.plan.nodes.find((node) => node.nodeId === "root.claims");
    if (!claims) {
      throw new Error("expected the claims node");
    }
    claims.ontology = { allowedTools: ["group:enterprise-write"] };
    registerEnterpriseActiveRun(run);
    expect(runAllowsOntologyWrites(RUN_ID)).toBe(true);
  });

  it("does not treat the READ group as opting into writes", () => {
    const run = activeRun("root.claims");
    const claims = run.plan.nodes.find((node) => node.nodeId === "root.claims");
    if (!claims) {
      throw new Error("expected the claims node");
    }
    // group:enterprise has only ever meant read/inspect.
    claims.ontology = { allowedTools: ["group:enterprise"] };
    registerEnterpriseActiveRun(run);
    expect(runAllowsOntologyWrites(RUN_ID)).toBe(false);
  });

  it("does not treat a wildcard allowlist as opting into writes", () => {
    // A tree that says `["*"]` has not thought about ontology writes either.
    const run = activeRun("root.claims");
    const claims = run.plan.nodes.find((node) => node.nodeId === "root.claims");
    if (!claims) {
      throw new Error("expected the claims node");
    }
    claims.ontology = { allowedTools: ["*"] };
    registerEnterpriseActiveRun(run);
    expect(runAllowsOntologyWrites(RUN_ID)).toBe(false);
  });

  it("is not offered to a mediated run whose tree declares no ontology", () => {
    // Enterprise mode is ON by default and the stock built-in trees are
    // deliberately guidance-free. Gating on "a run is registered" would add three
    // useless tools to every stock run's model-visible tool list.
    registerEnterpriseActiveRun({
      plan: {
        runId: "bare-run",
        treeId: "clawworks.assist",
        treeVersion: "1.0.0",
        treeName: "Assist",
        matchedBy: "trigger",
        requestSummary: "hi",
        nodes: [{ nodeId: "assist", parentId: null, seq: 0, title: "Assist", ontology: {} }],
        activeNodeId: "assist",
        mode: "enforce",
        createdAt: 0,
      },
      policies: [],
    });
    expect(runDeclaresOntology("bare-run")).toBe(false);
    // ...but a tree that actually models a domain does get them.
    registerEnterpriseActiveRun(activeRun("root.claims"));
    expect(runDeclaresOntology(RUN_ID)).toBe(true);
  });
});

describe("get_neighbors", () => {
  it("walks a declared link", async () => {
    registerEnterpriseActiveRun(activeRun("root.claims"));
    const details = await call(createGetNeighborsTool({ runId: RUN_ID }), {
      entity: "claim",
      objectId: "C-1",
    });
    expect(details.count).toBe(1);
    expect(details.neighbors).toEqual([
      {
        relationship: "claim-against-policy",
        direction: "outbound",
        entity: "policy",
        objectId: "P-1",
        properties: { "policy-id": "P-1" },
      },
    ]);
  });

  it("refuses a link type outside the step's ontology", async () => {
    registerEnterpriseActiveRun(activeRun("root.claims"));
    const details = await call(createGetNeighborsTool({ runId: RUN_ID }), {
      entity: "claim",
      objectId: "C-1",
      relationship: "made-up-link",
    });
    expect(details.error).toContain("not in the ontology of this workflow step");
  });
});

describe("compute_function", () => {
  it("evaluates a declared function against a real object", async () => {
    registerEnterpriseActiveRun(activeRun("root.claims"));
    const details = await call(createComputeFunctionTool({ runId: RUN_ID }), {
      function: "band",
      objectId: "C-1",
    });
    // The value is COMPUTED from the stored object, not asserted by the model.
    expect(details).toMatchObject({
      function: "band",
      entity: "claim",
      objectId: "C-1",
      returns: "string",
      value: "refer",
    });
  });

  it("refuses a function the step does not declare", async () => {
    registerEnterpriseActiveRun(activeRun("root.claims"));
    const details = await call(createComputeFunctionTool({ runId: RUN_ID }), {
      function: "not-declared",
      objectId: "C-1",
    });
    expect(details.error).toContain("not in the ontology of this workflow step");
  });

  it("reports a missing object rather than inventing a value", async () => {
    registerEnterpriseActiveRun(activeRun("root.claims"));
    const details = await call(createComputeFunctionTool({ runId: RUN_ID }), {
      function: "band",
      objectId: "C-404",
    });
    expect(details.error).toContain('no "claim" object with id "C-404"');
  });
});

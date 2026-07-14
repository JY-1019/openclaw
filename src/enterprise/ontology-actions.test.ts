import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { evaluateToolCallGovernance } from "./governance.js";
import {
  getOntologyObject,
  runOntologyObjectWrite,
  searchOntologyObjects,
} from "./object-store.sqlite.js";
import { invokeOntologyAction } from "./ontology-actions.js";
import type { NodeOntologyScope } from "./ontology-runtime.js";
import {
  clearEnterpriseActiveRunsForTest,
  evaluateEnterpriseToolCall,
  registerEnterpriseActiveRun,
} from "./runtime.js";
import { importWorkflowTreeContent } from "./tree-io.js";
import { invalidateWorkflowTreeRegistry } from "./tree-registry.js";
import type {
  EnterprisePlanNode,
  EnterpriseRunPlan,
  GovernancePolicy,
  OntologyAction,
  OntologyEntity,
  OntologyValue,
} from "./types.js";

const tempDir = mkdtempSync(path.join(tmpdir(), "clawworks-actions-"));
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
const TREE_ID = "test.actions";

const CLAIM: OntologyEntity = {
  id: "claim",
  properties: [
    { id: "claim-id", type: "id", primaryKey: true, required: true },
    { id: "status", type: "string" },
    { id: "amount", type: "number", required: true },
  ],
};

const TREE = JSON.stringify({
  schema: "clawworks.workflow-tree",
  schemaVersion: 1,
  id: TREE_ID,
  version: "1.0.0",
  name: "Actions",
  root: {
    id: "root",
    title: "Root",
    ontology: {
      entities: [CLAIM],
      objects: [
        { entity: "claim", properties: { "claim-id": "C-1", status: "intake", amount: 10 } },
      ],
    },
    children: [{ id: "root.work", title: "Work" }],
  },
});

/** Actions are supplied per test; the object type stays fixed. */
function scopeWith(
  actions: OntologyAction[],
  treeRequired?: Map<string, Set<string>>,
): NodeOntologyScope {
  return {
    treeId: TREE_ID,
    nodeId: "root.work",
    enforce: true,
    entities: new Map([["claim", CLAIM]]),
    relationships: new Map(),
    actions: new Map(actions.map((action) => [action.id, action])),
    functions: new Map(),
    treeRequiredProperties: treeRequired ?? new Map([["claim", new Set(["claim-id", "amount"])]]),
  };
}

function invoke(action: OntologyAction, args: Record<string, OntologyValue>) {
  return runOntologyObjectWrite((database) =>
    invokeOntologyAction(database, { scope: scopeWith([action]), action, args }),
  );
}

const UPDATE_CLAIM: OntologyAction = {
  id: "triage-claim",
  parameters: [
    { id: "claim-id", type: "id", required: true },
    { id: "status", type: "string", required: true },
    { id: "rationale", type: "string" },
  ],
  effects: [{ entity: "claim", kind: "update" }],
};

beforeAll(() => {
  setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
  invalidateWorkflowTreeRegistry();
  expect(importWorkflowTreeContent({ content: TREE, format: "json" }).ok).toBe(true);
});

afterAll(() => {
  closeOpenClawStateDatabase();
  invalidateWorkflowTreeRegistry();
  rmSync(tempDir, { recursive: true, force: true });
  envSnapshot.restore();
});

describe("effects are the write authorization", () => {
  it("writes only the properties the parameters name, and only on the effect's object type", () => {
    const result = invoke(UPDATE_CLAIM, {
      "claim-id": "C-1",
      status: "adjudicating",
      rationale: "fraud score is high",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.writes).toEqual([{ entity: "claim", objectId: "C-1", kind: "update" }]);
    // A parameter that matches no property is the operator's evidence, not store
    // data: it lands in the audit trail instead of the object.
    expect(result.unmappedParameters).toEqual({ rationale: "fraud score is high" });

    const object = getOntologyObject({ treeId: TREE_ID, entity: "claim", objectId: "C-1" });
    expect(object?.properties).toEqual({
      "claim-id": "C-1",
      status: "adjudicating",
      amount: 10,
    });
  });

  it("refuses an action whose effects declare no write", () => {
    // The effects ARE the write scope. Before this, an action declaring only
    // `kind: read` was treated exactly like one declaring `kind: delete` — the
    // naming convention the types file claimed it wasn't.
    const readOnly: OntologyAction = {
      id: "look",
      parameters: [{ id: "claim-id", type: "id", required: true }],
      effects: [{ entity: "claim", kind: "read" }],
    };
    const result = invoke(readOnly, { "claim-id": "C-1" });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("declares no write effects");
  });

  it("refuses to write an object type outside the step's ontology", () => {
    const foreign: OntologyAction = {
      id: "touch-payroll",
      parameters: [{ id: "run-id", type: "id", required: true }],
      effects: [{ entity: "payroll-record", kind: "update" }],
    };
    const result = invoke(foreign, { "run-id": "PR-1" });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("this workflow step does not declare");
  });

  it("enforces the action's declared parameters", () => {
    const missing = invoke(UPDATE_CLAIM, { "claim-id": "C-1" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error).toContain('requires the parameter "status"');
    }

    const wrongType = invoke(UPDATE_CLAIM, { "claim-id": "C-1", status: 7 });
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) {
      expect(wrongType.error).toContain('is declared "string" but got number');
    }

    const undeclared = invoke(UPDATE_CLAIM, { "claim-id": "C-1", status: "x", bogus: 1 });
    expect(undeclared.ok).toBe(false);
    if (!undeclared.ok) {
      expect(undeclared.error).toContain('does not declare a parameter "bogus"');
    }
  });

  it("commits nothing when a LATER effect fails", () => {
    // A returned error does not roll the caller's transaction back, so an action
    // that wrote effect 1 and then failed on effect 2 would leave the graph in a
    // state no action authorized — and no audit event to explain it.
    const twoEffects: OntologyAction = {
      id: "half-write",
      parameters: [{ id: "claim-id", type: "id", required: true }],
      effects: [
        { entity: "claim", kind: "update" },
        // The SECOND effect is impossible: this step declares no such object type.
        { entity: "payroll-record", kind: "update" },
      ],
    };
    const before = getOntologyObject({ treeId: TREE_ID, entity: "claim", objectId: "C-1" });
    const result = invoke(twoEffects, { "claim-id": "C-1" });
    expect(result.ok).toBe(false);

    // The claim must be byte-identical: the first effect must never have run.
    const after = getOntologyObject({ treeId: TREE_ID, entity: "claim", objectId: "C-1" });
    expect(after?.properties).toEqual(before?.properties);
  });

  it("refuses to write a value the TARGET PROPERTY's type rejects", () => {
    // The action parameter and the object property are two different declarations
    // and a tree may disagree with itself. The store is the ontology's, so the
    // property wins: persisting the parameter's type would put an object in the
    // graph that every later read and function assumes is typed differently.
    const mistyped: OntologyAction = {
      id: "bad-amount",
      parameters: [
        { id: "claim-id", type: "id", required: true },
        // Declares amount a STRING, while claim.amount is a number.
        { id: "amount", type: "string", required: true },
      ],
      effects: [{ entity: "claim", kind: "update" }],
    };
    const result = invoke(mistyped, { "claim-id": "C-1", amount: "lots" });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain('is declared "number"');
  });

  it("will not let an optional parameter clear a required property", () => {
    const nuller: OntologyAction = {
      id: "clear-amount",
      parameters: [
        { id: "claim-id", type: "id", required: true },
        { id: "amount", type: "number" },
      ],
      effects: [{ entity: "claim", kind: "update" }],
    };
    const result = invoke(nuller, { "claim-id": "C-1", amount: null });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("is required, so action");
  });

  it("will not create an object with a blank or padded identity", () => {
    // Import already rejects these on seeded objects. An action must not be able
    // to create one through the other door: the tools read objectId through the
    // trimming param reader, so such a row can never be addressed again.
    const create: OntologyAction = {
      id: "open-claim-2",
      parameters: [
        { id: "claim-id", type: "id", required: true },
        { id: "amount", type: "number", required: true },
      ],
      effects: [{ entity: "claim", kind: "create" }],
    };
    const padded = invoke(create, { "claim-id": " C-3 ", amount: 1 });
    expect(padded.ok).toBe(false);
    if (!padded.ok) {
      expect(padded.error).toContain("leading or trailing whitespace");
    }
    const blank = invoke(create, { "claim-id": "", amount: 1 });
    expect(blank.ok).toBe(false);
    if (!blank.ok) {
      expect(blank.error).toContain("must not be blank");
    }
  });

  it("type-checks the primary key on a DELETE too", () => {
    // The delete branch used to return before property validation, so a
    // wrongly-typed key would be stringified and remove a row that update/create
    // would have refused to touch.
    const remove: OntologyAction = {
      id: "void-by-number",
      // claim-id is an `id` (a string), but this declares the key parameter numeric.
      parameters: [{ id: "claim-id", type: "number", required: true }],
      effects: [{ entity: "claim", kind: "delete" }],
    };
    const result = invoke(remove, { "claim-id": 1 });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain('is declared "id"');
  });

  it("will not update an object that does not exist", () => {
    const result = invoke(UPDATE_CLAIM, { "claim-id": "C-404", status: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('no "claim" object with id "C-404" to update');
    }
  });

  it("creates an object only when it satisfies its own type", () => {
    const create: OntologyAction = {
      id: "open-claim",
      parameters: [
        { id: "claim-id", type: "id", required: true },
        { id: "amount", type: "number" },
      ],
      effects: [{ entity: "claim", kind: "create" }],
    };
    // `amount` is a REQUIRED property of claim, so a create that omits it would
    // put an instance in the store that the ontology says cannot exist.
    const invalid = invoke(create, { "claim-id": "C-2" });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error).toContain("needs its required properties: amount");
    }

    const valid = invoke(create, { "claim-id": "C-2", amount: 500 });
    expect(valid.ok).toBe(true);
    expect(
      getOntologyObject({ treeId: TREE_ID, entity: "claim", objectId: "C-2" })?.properties,
    ).toEqual({ "claim-id": "C-2", amount: 500 });
  });

  it("holds a create to the TREE-WIDE required shape, not just this branch's", () => {
    // Objects are stored tree-wide. If a SIBLING marks a property required, an
    // object created here without it violates its own type the moment that sibling
    // reads it. `note` is not required on this path, but the tree says it is.
    const create: OntologyAction = {
      id: "open-claim-3",
      parameters: [
        { id: "claim-id", type: "id", required: true },
        { id: "amount", type: "number", required: true },
      ],
      effects: [{ entity: "claim", kind: "create" }],
    };
    const treeRequired = new Map([["claim", new Set(["claim-id", "amount", "note"])]]);
    const result = runOntologyObjectWrite((database) =>
      invokeOntologyAction(database, {
        scope: scopeWith([create], treeRequired),
        action: create,
        args: { "claim-id": "C-7", amount: 5 },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("note");
  });

  it("refuses an action that writes the same object twice", () => {
    // Every effect is planned against the ORIGINAL state, so `delete` then
    // `update` on one object would delete the row and then recreate it — the
    // delete becomes a no-op and the update becomes a create. Effects are not
    // ordered, so this is a definition bug, not a sequence.
    const conflicting: OntologyAction = {
      id: "delete-then-update",
      parameters: [{ id: "claim-id", type: "id", required: true }],
      effects: [
        { entity: "claim", kind: "delete" },
        { entity: "claim", kind: "update" },
      ],
    };
    const before = getOntologyObject({ treeId: TREE_ID, entity: "claim", objectId: "C-1" });
    const result = invoke(conflicting, { "claim-id": "C-1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("more than one effect");
    }
    // ...and nothing was written.
    expect(
      getOntologyObject({ treeId: TREE_ID, entity: "claim", objectId: "C-1" })?.properties,
    ).toEqual(before?.properties);
  });

  it("deletes through a delete effect, and takes the object with it", () => {
    // Seed the target in THIS test: relying on an earlier test's create would make
    // this pass or fail on run order rather than on delete behavior.
    const create: OntologyAction = {
      id: "open-claim-for-delete",
      parameters: [
        { id: "claim-id", type: "id", required: true },
        { id: "amount", type: "number", required: true },
      ],
      effects: [{ entity: "claim", kind: "create" }],
    };
    if (!getOntologyObject({ treeId: TREE_ID, entity: "claim", objectId: "C-2" })) {
      expect(invoke(create, { "claim-id": "C-2", amount: 500 }).ok).toBe(true);
    }

    const remove: OntologyAction = {
      id: "void-claim",
      parameters: [{ id: "claim-id", type: "id", required: true }],
      effects: [{ entity: "claim", kind: "delete" }],
    };
    expect(invoke(remove, { "claim-id": "C-2" }).ok).toBe(true);
    expect(getOntologyObject({ treeId: TREE_ID, entity: "claim", objectId: "C-2" })).toBeNull();
    expect(
      searchOntologyObjects({ treeId: TREE_ID, entity: "claim", limit: 10 }).map((c) => c.objectId),
    ).toEqual(["C-1"]);
  });
});

describe("a numeric primary key stays a number", () => {
  const TICKET: OntologyEntity = {
    id: "ticket",
    properties: [
      { id: "ticket-no", type: "number", primaryKey: true, required: true },
      { id: "note", type: "string" },
    ],
  };

  it("does not persist the stringified store key into a numeric id property", () => {
    // The store KEY is TEXT, but the primary-key PROPERTY keeps its declared type.
    // Writing the key back would persist 7 as "7", and every later read and
    // function would see an object violating the ontology it was validated against.
    const open: OntologyAction = {
      id: "open-ticket",
      parameters: [
        { id: "ticket-no", type: "number", required: true },
        { id: "note", type: "string" },
      ],
      effects: [{ entity: "ticket", kind: "create" }],
    };
    const scope: NodeOntologyScope = {
      treeId: TREE_ID,
      nodeId: "root.work",
      enforce: true,
      entities: new Map([["ticket", TICKET]]),
      relationships: new Map(),
      actions: new Map([[open.id, open]]),
      functions: new Map(),
      treeRequiredProperties: new Map([["ticket", new Set(["ticket-no"])]]),
    };
    const result = runOntologyObjectWrite((database) =>
      invokeOntologyAction(database, {
        scope,
        action: open,
        args: { "ticket-no": 7, note: "hi" },
      }),
    );
    expect(result.ok).toBe(true);

    const stored = getOntologyObject({ treeId: TREE_ID, entity: "ticket", objectId: "7" });
    expect(stored?.properties["ticket-no"]).toBe(7);
    expect(stored?.properties["ticket-no"]).not.toBe("7");
  });
});

describe("governance sees the action the model actually invoked", () => {
  const node: EnterprisePlanNode = {
    nodeId: "root.work",
    parentId: "root",
    seq: 1,
    title: "Work",
    ontology: {
      actions: [
        // Both actions declare invoke_action among their tools, so BOTH would be
        // "covering actions" for an invoke_action call. Only the invoked one may
        // decide the policy.
        { id: "refund", tools: ["invoke_action"], effects: [{ entity: "claim", kind: "update" }] },
        { id: "note", tools: ["invoke_action"], effects: [{ entity: "claim", kind: "update" }] },
      ],
    },
  };
  const plan = {
    runId: "r",
    treeId: TREE_ID,
    treeVersion: "1.0.0",
    treeName: "Actions",
    matchedBy: "trigger",
    requestSummary: "x",
    nodes: [node],
    activeNodeId: "root.work",
    mode: "enforce",
    createdAt: 0,
  } as EnterpriseRunPlan;

  const denyRefund: GovernancePolicy[] = [
    { id: "no-refunds", effect: "deny", actions: ["refund"] } as GovernancePolicy,
  ];

  // carriesAction mirrors what the runtime passes for invoke_action: its subject
  // is the action in its params, never inferred from tool globs.
  function decide(actionId?: string) {
    return evaluateToolCallGovernance({
      plan,
      node,
      toolName: "invoke_action",
      policies: denyRefund,
      path: [node],
      carriesAction: true,
      ...(actionId !== undefined ? { actionId } : {}),
    });
  }

  it("denies the action the policy names", () => {
    const decision = decide("refund");
    expect(decision.effect).toBe("deny");
    // The reason names the ACTION, not just the tool: "tool invoke_action is
    // denied" tells an operator nothing about which action tripped the policy.
    expect(decision.reason).toContain('action "refund"');
  });

  it("does not judge an action-scoped policy before the action is named", () => {
    // A hook may still fill the action in. Falling back to the covering set here
    // would let a policy denying "refund" block an invoke_action whose action is
    // not decided yet — and which may turn out to be something else entirely.
    expect(decide(undefined).effect).toBe("allow");
  });

  it("ignores an action name the step does not declare", () => {
    // A model can put ANY string there. The tool will reject an undeclared action
    // anyway, but a require_approval or audit policy would otherwise fire on it
    // first — letting a made-up id prompt a human or write an audit entry.
    const approveMadeUp: GovernancePolicy[] = [
      { id: "gate", effect: "require_approval", actions: ["made-up"] } as GovernancePolicy,
    ];
    const decision = evaluateToolCallGovernance({
      plan,
      node,
      toolName: "invoke_action",
      policies: approveMadeUp,
      path: [node],
      carriesAction: true,
      actionId: "made-up",
    });
    expect(decision.effect).toBe("allow");
  });

  it("records a denied action so a blocked write cannot vanish from the trace", () => {
    // The pre-hook evaluation is deliberately non-recording (a hook can still
    // rewrite the action), but a DENIAL returns immediately and can never be
    // rewritten — so it must always reach the trail. A blocked write attempt is
    // exactly the event an operator needs to see.
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    registerEnterpriseActiveRun({
      plan,
      policies: denyRefund,
      sink: (event) => events.push({ kind: event.kind, payload: event.payload }),
    });
    try {
      const verdict = evaluateEnterpriseToolCall({
        runId: plan.runId,
        toolName: "invoke_action",
        actionId: "refund",
        record: false,
      });
      expect(verdict?.blocked).toBe(true);
      const decisions = events.filter((event) => event.kind === "governance.decision");
      expect(decisions).toHaveLength(1);
      expect(decisions[0]?.payload.effect).toBe("deny");
      expect(decisions[0]?.payload.enforced).toBe(true);
      // The trail must name WHICH action was attempted. "invoke_action was denied"
      // tells an operator nothing; a policy may also set its own description, so
      // the reason string cannot be relied on to carry it.
      expect(decisions[0]?.payload.actionId).toBe("refund");
    } finally {
      clearEnterpriseActiveRunsForTest();
    }
  });

  it("does NOT deny a different action of the same tool", () => {
    // This is the whole absorption. The gate used to see only "invoke_action", so
    // a policy scoped to `refund` matched through the covering-action set and
    // would have denied `note` as well — every action or none.
    expect(decide("note").effect).toBe("allow");
  });
});

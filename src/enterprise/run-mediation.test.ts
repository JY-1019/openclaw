import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  beginEnterpriseRun,
  clearEnterpriseRunMediationForTest,
  endEnterpriseRun,
} from "./run-mediation.js";
import {
  evaluateEnterpriseToolCall,
  getEnterpriseActiveRun,
  recordEnterpriseTurnExecuted,
  setEnterpriseStepForTurn,
} from "./runtime.js";
import {
  getEnterpriseRunRecord,
  listEnterpriseRunEvents,
  listEnterpriseRunExecutions,
} from "./trace-store.sqlite.js";

afterEach(() => {
  clearEnterpriseRunMediationForTest();
});

afterAll(() => {
  closeOpenClawStateDatabase();
});

let runCounter = 0;
function nextRunId(): string {
  runCounter += 1;
  return `mediation-run-${runCounter}`;
}

function latestEventKinds(runId: string): string[] {
  const record = getEnterpriseRunRecord(runId);
  if (!record) {
    return [];
  }
  return listEnterpriseRunEvents(record.executionId).map((event) => event.kind);
}

describe("beginEnterpriseRun", () => {
  it("returns off and registers nothing when enterprise mode is off", async () => {
    const runId = nextRunId();
    const mediation = await beginEnterpriseRun({
      runId,
      prompt: "hello",
      config: { enterprise: { mode: "off" } },
    });
    expect(mediation.kind).toBe("off");
    expect(getEnterpriseActiveRun(runId)).toBeUndefined();
    expect(getEnterpriseRunRecord(runId)).toBeNull();
  });

  it("mediates by default (no enterprise config) with the built-in tree and persists the trace", async () => {
    const runId = nextRunId();
    const mediation = await beginEnterpriseRun({
      runId,
      prompt: "hello there",
      trigger: "user",
      sessionKey: "agent:main:test",
      agentId: "main",
    });
    expect(mediation.kind).toBe("mediated");
    if (mediation.kind !== "mediated") {
      return;
    }
    expect(mediation.plan.treeId).toBe("clawworks.assist");
    // Built-in trees are guidance-free: default runs add zero prompt bytes.
    expect(mediation.promptSection).toBe("");
    expect(getEnterpriseActiveRun(runId)).toBeDefined();

    const record = getEnterpriseRunRecord(runId);
    expect(record?.status).toBe("running");
    expect(record?.treeId).toBe("clawworks.assist");
    expect(record?.sessionKey).toBe("agent:main:test");
    expect(latestEventKinds(runId)).toEqual(["run.started"]);
  });

  it("reuses the active execution while it is still running (nested begins)", async () => {
    const runId = nextRunId();
    const first = await beginEnterpriseRun({ runId, prompt: "hello" });
    const second = await beginEnterpriseRun({ runId, prompt: "different text" });
    expect(first.kind).toBe("mediated");
    expect(second.kind).toBe("mediated");
    if (first.kind === "mediated" && second.kind === "mediated") {
      expect(second.plan).toBe(first.plan);
    }
    expect(listEnterpriseRunExecutions(runId)).toHaveLength(1);
    expect(latestEventKinds(runId)).toEqual(["run.started"]);
  });

  it("dedupes concurrent begins for one runId across the planner await", async () => {
    // The planner is awaited BEFORE the run is registered, so without a pending
    // guard two overlapping begins would both plan and both write an execution
    // row — and only the last would ever be finalized. Needs a tree big enough
    // that route planning actually runs (small trees skip the model call).
    const { importWorkflowTreeContent, removeImportedWorkflowTree } = await import("./tree-io.js");
    const { invalidateWorkflowTreeRegistry } = await import("./tree-registry.js");
    importWorkflowTreeContent({
      content: JSON.stringify({
        schema: "clawworks.workflow-tree",
        schemaVersion: 1,
        id: "acme.big",
        version: "1.0.0",
        name: "Big",
        match: { triggers: ["user"] },
        root: {
          id: "big",
          title: "Big",
          children: [
            { id: "big.a", title: "A", children: [{ id: "big.a.1", title: "A1" }] },
            { id: "big.b", title: "B", children: [{ id: "big.b.1", title: "B1" }] },
          ],
        },
      }),
      format: "json",
    });
    invalidateWorkflowTreeRegistry();
    try {
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const planner = vi.fn(async () => {
        await gate;
        return { kind: "decided" as const, treeId: "acme.big", routes: ["big.a"], rationale: "a" };
      });
      const runId = nextRunId();
      const first = beginEnterpriseRun({ runId, prompt: "bigtest please", routePlanner: planner });
      const second = beginEnterpriseRun({ runId, prompt: "bigtest please", routePlanner: planner });
      release?.();
      const [a, b] = await Promise.all([first, second]);

      expect(planner).toHaveBeenCalledTimes(1);
      expect(a).toBe(b);
      expect(listEnterpriseRunExecutions(runId)).toHaveLength(1);
      endEnterpriseRun({ runId, status: "completed" });
    } finally {
      removeImportedWorkflowTree("acme.big");
      invalidateWorkflowTreeRegistry();
    }
  });

  it("leaves no trace when the turn is cancelled during route planning", async () => {
    // The planner awaits a provider. A cancel that lands in that window must not
    // persist run.started/route.selected for a turn that never ran.
    const controller = new AbortController();
    const planner = vi.fn(async () => ({ kind: "failed" }) as const);
    const runId = nextRunId();
    // The turn is cancelled while mediation is starting (the planner awaits a
    // provider, so this is exactly the window that matters).
    controller.abort();
    const mediation = await beginEnterpriseRun({
      runId,
      prompt: "hello",
      routePlanner: planner,
      signal: controller.signal,
    });
    expect(mediation.kind).toBe("off");
    expect(listEnterpriseRunExecutions(runId)).toHaveLength(0);
    expect(getEnterpriseActiveRun(runId)).toBeUndefined();
  });

  it("creates a fresh execution per begin→end cycle (recurring runIds)", async () => {
    const runId = nextRunId();
    await beginEnterpriseRun({ runId, prompt: "first scheduled run" });
    endEnterpriseRun({ runId, status: "failed" });
    await beginEnterpriseRun({ runId, prompt: "second scheduled run" });
    endEnterpriseRun({ runId, status: "completed" });

    const executions = listEnterpriseRunExecutions(runId);
    expect(executions).toHaveLength(2);
    expect(executions.map((record) => record.status).toSorted()).toEqual(["completed", "failed"]);
    for (const execution of executions) {
      expect(listEnterpriseRunEvents(execution.executionId).map((event) => event.kind)).toEqual([
        "run.started",
        "run.ended",
      ]);
    }
  });

  it("blocks run start in enforce mode when a run-level policy denies the tree", async () => {
    const runId = nextRunId();
    const config: OpenClawConfig = {
      enterprise: {
        governance: {
          policies: [
            {
              id: "deny.default-tree",
              effect: "deny",
              trees: ["clawworks.*"],
              description: "Default trees are not approved for this org.",
            },
          ],
        },
      },
    };
    const mediation = await beginEnterpriseRun({ runId, prompt: "hello", config });
    expect(mediation.kind).toBe("blocked");
    if (mediation.kind === "blocked") {
      expect(mediation.reason).toBe("Default trees are not approved for this org.");
    }
    expect(getEnterpriseActiveRun(runId)).toBeUndefined();
    expect(getEnterpriseRunRecord(runId)?.status).toBe("blocked");
    expect(latestEventKinds(runId)).toEqual(["run.started", "governance.decision", "run.ended"]);

    // Same-runId retries re-evaluate deterministically into their own blocked
    // execution without corrupting the first trace.
    const retried = await beginEnterpriseRun({ runId, prompt: "hello", config });
    expect(retried.kind).toBe("blocked");
    const executions = listEnterpriseRunExecutions(runId);
    expect(executions).toHaveLength(2);
    for (const execution of executions) {
      expect(execution.status).toBe("blocked");
      expect(listEnterpriseRunEvents(execution.executionId)).toHaveLength(3);
    }
  });

  it("records run-level audit policies as trace evidence without blocking", async () => {
    const runId = nextRunId();
    const config: OpenClawConfig = {
      enterprise: {
        governance: {
          policies: [{ id: "audit.default-tree", effect: "audit", trees: ["clawworks.*"] }],
        },
      },
    };
    const mediation = await beginEnterpriseRun({ runId, prompt: "hello", config });
    expect(mediation.kind).toBe("mediated");
    const record = getEnterpriseRunRecord(runId);
    const decision = listEnterpriseRunEvents(record?.executionId ?? "").find(
      (event) => event.kind === "governance.decision",
    );
    expect(decision?.payload).toMatchObject({
      subject: "run",
      effect: "audit",
      enforced: false,
      policyId: "audit.default-tree",
    });
  });

  it("records but does not block run-level denials in observe mode", async () => {
    const runId = nextRunId();
    const config: OpenClawConfig = {
      enterprise: {
        mode: "observe",
        governance: {
          policies: [{ id: "deny.default-tree", effect: "deny", trees: ["clawworks.*"] }],
        },
      },
    };
    const mediation = await beginEnterpriseRun({ runId, prompt: "hello", config });
    expect(mediation.kind).toBe("mediated");
    expect(getEnterpriseActiveRun(runId)).toBeDefined();
    expect(latestEventKinds(runId)).toContain("governance.decision");
  });

  it("fails closed in enforce mode when imported trees cannot load", async () => {
    const { upsertEnterpriseWorkflowTree, deleteEnterpriseWorkflowTree } =
      await import("./tree-store.sqlite.js");
    const { invalidateWorkflowTreeRegistry } = await import("./tree-registry.js");
    const corrupt = {
      schema: "clawworks.workflow-tree",
      schemaVersion: 1,
      id: "acme.corrupt",
      version: "1.0.0",
      name: "Corrupt",
      root: {
        id: "root",
        title: "Root",
        children: [
          { id: "dup", title: "A" },
          { id: "dup", title: "B" },
        ],
      },
    } as never;
    upsertEnterpriseWorkflowTree({ tree: corrupt, sourceFormat: "yaml" });
    invalidateWorkflowTreeRegistry();
    try {
      const runId = nextRunId();
      const blocked = await beginEnterpriseRun({ runId, prompt: "hello" });
      expect(blocked.kind).toBe("blocked");
      if (blocked.kind === "blocked") {
        expect(blocked.reason).toContain('"acme.corrupt"');
      }
      expect(getEnterpriseActiveRun(runId)).toBeUndefined();

      // Observe mode records the degradation but keeps running on built-ins.
      const observeRunId = nextRunId();
      const observed = await beginEnterpriseRun({
        runId: observeRunId,
        prompt: "hello",
        config: { enterprise: { mode: "observe" } },
      });
      expect(observed.kind).toBe("mediated");
      if (observed.kind === "mediated") {
        expect(observed.plan.treeId).toBe("clawworks.assist");
      }
      endEnterpriseRun({ runId: observeRunId, status: "completed" });
    } finally {
      deleteEnterpriseWorkflowTree("acme.corrupt");
      invalidateWorkflowTreeRegistry();
    }
  });

  it("never sends a denied run to the route planner (no model contact before the block)", async () => {
    const denyPolicies = {
      governance: {
        policies: [
          {
            id: "deny.default-tree",
            effect: "deny" as const,
            trees: ["clawworks.*"],
          },
        ],
      },
    };
    const planner = vi.fn(async () => ({
      kind: "decided" as const,
      treeId: null,
      routes: [],
      rationale: "should not run",
    }));
    const runId = nextRunId();
    const mediation = await beginEnterpriseRun({
      runId,
      prompt: "hello",
      config: { enterprise: denyPolicies } as OpenClawConfig,
      routePlanner: planner,
    });
    // The policy denies the run, so the request text must never reach a provider
    // and the block must not wait behind a model round-trip.
    expect(mediation.kind).toBe("blocked");
    expect(planner).not.toHaveBeenCalled();
  });

  it("still plans a route in observe mode when a policy would deny (nothing is blocked)", async () => {
    const planner = vi.fn(async () => ({
      kind: "decided" as const,
      treeId: null,
      routes: [],
      rationale: "no narrowing",
    }));
    const runId = nextRunId();
    const mediation = await beginEnterpriseRun({
      runId,
      prompt: "hello",
      config: {
        enterprise: {
          mode: "observe",
          governance: {
            policies: [
              { id: "deny.default-tree", effect: "deny" as const, trees: ["clawworks.*"] },
            ],
          },
        },
      } as OpenClawConfig,
      routePlanner: planner,
    });
    expect(mediation.kind).toBe("mediated");
    // Observe never blocks, so route selection RAN (the plan carries a route
    // decision). The default tree is too small to be worth a model call, so the
    // planner itself is short-circuited — that is the size rule, not the deny.
    expect(mediation.kind === "mediated" && mediation.plan.route).toBeDefined();
    expect(mediation.kind === "mediated" && mediation.plan.route?.source).toBe("whole-tree");
    endEnterpriseRun({ runId, status: "completed" });
  });

  it("never offers a shipped built-in example as a candidate", async () => {
    // The support example ships REGISTERED so the Control UI has a rich tree to
    // inspect, and its leaves restrict tools. Only the imported-only rule keeps
    // it off stock traffic now that no phrase gates it. If it were a candidate,
    // the planner would be consulted (it is big enough to plan) and the blind
    // fallback would bind it — so asserting no model call also asserts that
    // stock installs stay free of per-request planning cost.
    const planner = vi.fn(async () => ({
      kind: "decided" as const,
      treeId: "clawworks.support",
      routes: [],
      rationale: "support",
    }));
    const runId = nextRunId();
    const mediation = await beginEnterpriseRun({
      runId,
      prompt: "resolve ticket #12, already triaged, issue a $30 refund",
      routePlanner: planner,
    });
    expect(planner).not.toHaveBeenCalled();
    expect(mediation.kind === "mediated" && mediation.plan.treeId).toBe("clawworks.assist");
    endEnterpriseRun({ runId, status: "completed" });
  });

  it("still blocks when a policy denies the work-map and no planner runs", async () => {
    // The precheck withholds the planner so a denied prompt never reaches a
    // provider. Selection must stay on the tree the policy TARGETS: treating the
    // withheld planner as "unavailable" would bind the permissive default, the
    // acme.* deny would miss it, and the run this policy exists to stop would run.
    const { importWorkflowTreeContent, removeImportedWorkflowTree } = await import("./tree-io.js");
    const { invalidateWorkflowTreeRegistry } = await import("./tree-registry.js");
    const imported = importWorkflowTreeContent({
      content: JSON.stringify({
        schema: "clawworks.workflow-tree",
        schemaVersion: 1,
        id: "acme.denied",
        version: "1.0.0",
        name: "Denied",
        match: { triggers: ["user"] },
        root: { id: "denied", title: "Denied work" },
      }),
      format: "json",
    });
    expect(imported.ok).toBe(true);
    try {
      const config: OpenClawConfig = {
        enterprise: {
          governance: { policies: [{ id: "deny.acme", effect: "deny", trees: ["acme.*"] }] },
        },
      };
      const runId = nextRunId();
      const mediation = await beginEnterpriseRun({ runId, prompt: "do the acme work", config });
      expect(mediation.kind).toBe("blocked");
    } finally {
      removeImportedWorkflowTree("acme.denied");
      invalidateWorkflowTreeRegistry();
    }
  });

  it("leaves an imported work-map unbound when no planner can be consulted", async () => {
    const { importWorkflowTreeContent, removeImportedWorkflowTree } = await import("./tree-io.js");
    const { invalidateWorkflowTreeRegistry } = await import("./tree-registry.js");
    const imported = importWorkflowTreeContent({
      content: JSON.stringify({
        schema: "clawworks.workflow-tree",
        schemaVersion: 1,
        id: "acme.billing",
        version: "1.0.0",
        name: "Billing",
        match: { triggers: ["user"] },
        root: { id: "billing", title: "Handle billing", ontology: { allowedTools: ["message"] } },
      }),
      format: "json",
    });
    expect(imported.ok).toBe(true);
    try {
      const runId = nextRunId();
      // No planner wired: nothing can judge whether this request belongs to the
      // work-map, and no request can influence that. Binding it anyway would put
      // EVERY request on this install under its tool scope, planned whole.
      const mediation = await beginEnterpriseRun({ runId, prompt: "please fix my invoice" });
      expect(mediation.kind).toBe("mediated");
      if (mediation.kind === "mediated") {
        expect(mediation.plan.treeId).toBe("clawworks.assist");
        expect(mediation.plan.matchedBy).toBe("unavailable");
      }
      // The default tree is guidance-free, so the work-map's tool scope is not
      // applied to a request nobody judged to belong to it.
      const verdict = evaluateEnterpriseToolCall({ runId, toolName: "exec" });
      expect(verdict?.blocked).toBeFalsy();
      endEnterpriseRun({ runId, status: "completed" });
    } finally {
      removeImportedWorkflowTree("acme.billing");
      invalidateWorkflowTreeRegistry();
    }
  });

  it("wires the gate sink so tool decisions land in the event log", async () => {
    const runId = nextRunId();
    const config: OpenClawConfig = {
      enterprise: {
        governance: {
          policies: [{ id: "deny.exec", effect: "deny", tools: ["exec"] }],
        },
      },
    };
    await beginEnterpriseRun({ runId, prompt: "hello", config });
    const verdict = evaluateEnterpriseToolCall({ runId, toolName: "exec", toolCallId: "c1" });
    expect(verdict?.blocked).toBe(true);
    const record = getEnterpriseRunRecord(runId);
    const decision = listEnterpriseRunEvents(record?.executionId ?? "").find(
      (event) => event.kind === "governance.decision",
    );
    expect(decision?.payload).toMatchObject({
      toolName: "exec",
      effect: "deny",
      enforced: true,
      policyId: "deny.exec",
    });
    // Non-embedded runs stay on the root scope (no step-loop hook advances).
    expect(decision?.nodeId).toBe("assist");
  });
});

describe("endEnterpriseRun", () => {
  it("finalizes the trace, stops gating, and ignores duplicate ends", async () => {
    const runId = nextRunId();
    await beginEnterpriseRun({ runId, prompt: "hello" });
    endEnterpriseRun({ runId, status: "completed" });
    endEnterpriseRun({ runId, status: "failed" });

    expect(getEnterpriseActiveRun(runId)).toBeUndefined();
    expect(evaluateEnterpriseToolCall({ runId, toolName: "exec" })).toBeUndefined();
    expect(listEnterpriseRunExecutions(runId)).toHaveLength(1);
    expect(getEnterpriseRunRecord(runId)?.status).toBe("completed");
    expect(latestEventKinds(runId)).toEqual(["run.started", "run.ended"]);
  });
});

describe("enterprise step tracing", () => {
  const flowPlanner = () =>
    vi.fn(async () => ({
      kind: "decided" as const,
      treeId: "acme.flow",
      routes: [],
      rationale: "flow",
    }));

  async function withFlowTree<T>(run: () => T | Promise<T>): Promise<T> {
    const { importWorkflowTreeContent, removeImportedWorkflowTree } = await import("./tree-io.js");
    const { invalidateWorkflowTreeRegistry } = await import("./tree-registry.js");
    const imported = importWorkflowTreeContent({
      content: JSON.stringify({
        schema: "clawworks.workflow-tree",
        schemaVersion: 1,
        id: "acme.flow",
        version: "1.0.0",
        name: "Flow",
        match: { triggers: ["user"] },
        root: {
          id: "flow",
          title: "Run the flow",
          ontology: { allowedTools: ["message"] },
          children: [
            { id: "flow.a", title: "Step A" },
            { id: "flow.b", title: "Step B" },
          ],
        },
      }),
      format: "json",
    });
    expect(imported.ok).toBe(true);
    try {
      return await run();
    } finally {
      removeImportedWorkflowTree("acme.flow");
      invalidateWorkflowTreeRegistry();
    }
  }

  it("records the hook-driven step timeline (open + advance) in trace order", async () => {
    await withFlowTree(async () => {
      const runId = nextRunId();
      const mediation = await beginEnterpriseRun({
        runId,
        prompt: "run the flowtest now",
        routePlanner: flowPlanner(),
      });
      expect(mediation.kind).toBe("mediated");
      // Simulate the embedded step-loop hook across two turns: enter the first
      // leaf, record the turn, then advance to the next leaf.
      setEnterpriseStepForTurn(runId);
      recordEnterpriseTurnExecuted(runId);
      setEnterpriseStepForTurn(runId);
      endEnterpriseRun({ runId, status: "completed" });

      const record = getEnterpriseRunRecord(runId);
      const events = listEnterpriseRunEvents(record?.executionId ?? "");
      expect(events.map((event) => `${event.kind}:${event.nodeId ?? "-"}`)).toEqual([
        "run.started:-",
        // Binding this work-map takes a planner, and consulting one is itself traced.
        "route.selected:-",
        "node.entered:flow.a",
        "node.completed:flow.a",
        "node.entered:flow.b",
        "run.ended:-",
      ]);
    });
  });

  it("re-persists the plan so the trace reports the advanced active node", async () => {
    await withFlowTree(async () => {
      const runId = nextRunId();
      await beginEnterpriseRun({
        runId,
        prompt: "run the flowtest now",
        routePlanner: flowPlanner(),
      });
      // Run-start snapshot points at the root scope.
      expect(getEnterpriseRunRecord(runId)?.plan.activeNodeId).toBe("flow");
      setEnterpriseStepForTurn(runId);
      expect(getEnterpriseRunRecord(runId)?.plan.activeNodeId).toBe("flow.a");
      recordEnterpriseTurnExecuted(runId);
      setEnterpriseStepForTurn(runId);
      // After advancement the persisted plan tracks the current leaf.
      expect(getEnterpriseRunRecord(runId)?.plan.activeNodeId).toBe("flow.b");
      endEnterpriseRun({ runId, status: "completed" });
      expect(getEnterpriseRunRecord(runId)?.plan.activeNodeId).toBe("flow.b");
    });
  });

  it("keeps mediation timeline-free for runtimes that never advance (CLI/ACP)", async () => {
    await withFlowTree(async () => {
      const runId = nextRunId();
      // No step-loop hook runs, so no node events should be emitted and the run
      // stays on the root scope rather than claiming a leaf it never reached.
      await beginEnterpriseRun({
        runId,
        prompt: "run the flowtest now",
        routePlanner: flowPlanner(),
      });
      endEnterpriseRun({ runId, status: "completed" });

      const record = getEnterpriseRunRecord(runId);
      const kinds = listEnterpriseRunEvents(record?.executionId ?? "").map((event) => event.kind);
      // route.selected comes from mediation; the absence of node.* is the point.
      expect(kinds).toEqual(["run.started", "route.selected", "run.ended"]);
      expect(record?.plan.activeNodeId).toBe("flow");
    });
  });
});

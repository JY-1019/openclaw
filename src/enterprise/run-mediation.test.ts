import { afterAll, afterEach, describe, expect, it } from "vitest";
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
  it("returns off and registers nothing when enterprise mode is off", () => {
    const runId = nextRunId();
    const mediation = beginEnterpriseRun({
      runId,
      prompt: "hello",
      config: { enterprise: { mode: "off" } },
    });
    expect(mediation.kind).toBe("off");
    expect(getEnterpriseActiveRun(runId)).toBeUndefined();
    expect(getEnterpriseRunRecord(runId)).toBeNull();
  });

  it("mediates by default (no enterprise config) with the built-in tree and persists the trace", () => {
    const runId = nextRunId();
    const mediation = beginEnterpriseRun({
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

  it("reuses the active execution while it is still running (nested begins)", () => {
    const runId = nextRunId();
    const first = beginEnterpriseRun({ runId, prompt: "hello" });
    const second = beginEnterpriseRun({ runId, prompt: "different text" });
    expect(first.kind).toBe("mediated");
    expect(second.kind).toBe("mediated");
    if (first.kind === "mediated" && second.kind === "mediated") {
      expect(second.plan).toBe(first.plan);
    }
    expect(listEnterpriseRunExecutions(runId)).toHaveLength(1);
    expect(latestEventKinds(runId)).toEqual(["run.started"]);
  });

  it("creates a fresh execution per begin→end cycle (recurring runIds)", () => {
    const runId = nextRunId();
    beginEnterpriseRun({ runId, prompt: "first scheduled run" });
    endEnterpriseRun({ runId, status: "failed" });
    beginEnterpriseRun({ runId, prompt: "second scheduled run" });
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

  it("blocks run start in enforce mode when a run-level policy denies the tree", () => {
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
    const mediation = beginEnterpriseRun({ runId, prompt: "hello", config });
    expect(mediation.kind).toBe("blocked");
    if (mediation.kind === "blocked") {
      expect(mediation.reason).toBe("Default trees are not approved for this org.");
    }
    expect(getEnterpriseActiveRun(runId)).toBeUndefined();
    expect(getEnterpriseRunRecord(runId)?.status).toBe("blocked");
    expect(latestEventKinds(runId)).toEqual(["run.started", "governance.decision", "run.ended"]);

    // Same-runId retries re-evaluate deterministically into their own blocked
    // execution without corrupting the first trace.
    const retried = beginEnterpriseRun({ runId, prompt: "hello", config });
    expect(retried.kind).toBe("blocked");
    const executions = listEnterpriseRunExecutions(runId);
    expect(executions).toHaveLength(2);
    for (const execution of executions) {
      expect(execution.status).toBe("blocked");
      expect(listEnterpriseRunEvents(execution.executionId)).toHaveLength(3);
    }
  });

  it("records run-level audit policies as trace evidence without blocking", () => {
    const runId = nextRunId();
    const config: OpenClawConfig = {
      enterprise: {
        governance: {
          policies: [{ id: "audit.default-tree", effect: "audit", trees: ["clawworks.*"] }],
        },
      },
    };
    const mediation = beginEnterpriseRun({ runId, prompt: "hello", config });
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

  it("records but does not block run-level denials in observe mode", () => {
    const runId = nextRunId();
    const config: OpenClawConfig = {
      enterprise: {
        mode: "observe",
        governance: {
          policies: [{ id: "deny.default-tree", effect: "deny", trees: ["clawworks.*"] }],
        },
      },
    };
    const mediation = beginEnterpriseRun({ runId, prompt: "hello", config });
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
      const blocked = beginEnterpriseRun({ runId, prompt: "hello" });
      expect(blocked.kind).toBe("blocked");
      if (blocked.kind === "blocked") {
        expect(blocked.reason).toContain('"acme.corrupt"');
      }
      expect(getEnterpriseActiveRun(runId)).toBeUndefined();

      // Observe mode records the degradation but keeps running on built-ins.
      const observeRunId = nextRunId();
      const observed = beginEnterpriseRun({
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

  it("selects imported trees over built-ins when their keywords match", async () => {
    const { importWorkflowTreeContent, removeImportedWorkflowTree } = await import("./tree-io.js");
    const { invalidateWorkflowTreeRegistry } = await import("./tree-registry.js");
    const imported = importWorkflowTreeContent({
      content: JSON.stringify({
        schema: "clawworks.workflow-tree",
        schemaVersion: 1,
        id: "acme.billing",
        version: "1.0.0",
        name: "Billing",
        match: { keywords: ["invoice"], triggers: ["user"] },
        root: { id: "billing", title: "Handle billing", ontology: { allowedTools: ["message"] } },
      }),
      format: "json",
    });
    expect(imported.ok).toBe(true);
    try {
      const runId = nextRunId();
      const mediation = beginEnterpriseRun({ runId, prompt: "please fix my invoice" });
      expect(mediation.kind).toBe("mediated");
      if (mediation.kind === "mediated") {
        expect(mediation.plan.treeId).toBe("acme.billing");
        expect(mediation.plan.matchedBy).toBe("keywords");
      }
      const verdict = evaluateEnterpriseToolCall({ runId, toolName: "exec" });
      expect(verdict?.blocked).toBe(true);
      endEnterpriseRun({ runId, status: "completed" });
    } finally {
      removeImportedWorkflowTree("acme.billing");
      invalidateWorkflowTreeRegistry();
    }
  });

  it("wires the gate sink so tool decisions land in the event log", () => {
    const runId = nextRunId();
    const config: OpenClawConfig = {
      enterprise: {
        governance: {
          policies: [{ id: "deny.exec", effect: "deny", tools: ["exec"] }],
        },
      },
    };
    beginEnterpriseRun({ runId, prompt: "hello", config });
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
  it("finalizes the trace, stops gating, and ignores duplicate ends", () => {
    const runId = nextRunId();
    beginEnterpriseRun({ runId, prompt: "hello" });
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
        match: { keywords: ["flowtest"], triggers: ["user"] },
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
    await withFlowTree(() => {
      const runId = nextRunId();
      const mediation = beginEnterpriseRun({ runId, prompt: "run the flowtest now" });
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
        "node.entered:flow.a",
        "node.completed:flow.a",
        "node.entered:flow.b",
        "run.ended:-",
      ]);
    });
  });

  it("re-persists the plan so the trace reports the advanced active node", async () => {
    await withFlowTree(() => {
      const runId = nextRunId();
      beginEnterpriseRun({ runId, prompt: "run the flowtest now" });
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
    await withFlowTree(() => {
      const runId = nextRunId();
      // No step-loop hook runs, so no node events should be emitted and the run
      // stays on the root scope rather than claiming a leaf it never reached.
      beginEnterpriseRun({ runId, prompt: "run the flowtest now" });
      endEnterpriseRun({ runId, status: "completed" });

      const record = getEnterpriseRunRecord(runId);
      const kinds = listEnterpriseRunEvents(record?.executionId ?? "").map((event) => event.kind);
      expect(kinds).toEqual(["run.started", "run.ended"]);
      expect(record?.plan.activeNodeId).toBe("flow");
    });
  });
});

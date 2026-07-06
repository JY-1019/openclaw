import { afterEach, describe, expect, it } from "vitest";
import {
  clearEnterpriseActiveRunsForTest,
  enterpriseRunTracksSteps,
  evaluateEnterpriseToolCall,
  getEnterpriseActiveRun,
  recordEnterpriseApprovalResolution,
  recordEnterpriseTurnExecuted,
  registerEnterpriseActiveRun,
  resolveEnterpriseMode,
  setEnterpriseStepForTurn,
  unregisterEnterpriseActiveRun,
  type EnterpriseActiveRun,
} from "./runtime.js";
import type { EnterprisePlanNode, EnterpriseRunPlan, GovernancePolicy } from "./types.js";

function makeRun(overrides: {
  runId?: string;
  mode?: "enforce" | "observe";
  allowedTools?: string[];
  audit?: boolean;
  policies?: GovernancePolicy[];
  sink?: EnterpriseActiveRun["sink"];
}): EnterpriseActiveRun {
  const plan: EnterpriseRunPlan = {
    runId: overrides.runId ?? "run-1",
    treeId: "acme.support",
    treeVersion: "1.0.0",
    treeName: "Support",
    matchedBy: "trigger",
    requestSummary: "help",
    nodes: [
      {
        nodeId: "support",
        parentId: null,
        seq: 0,
        title: "Support",
        ontology: {
          ...(overrides.allowedTools ? { allowedTools: overrides.allowedTools } : {}),
          ...(overrides.audit !== undefined ? { audit: overrides.audit } : {}),
        },
      },
    ],
    activeNodeId: "support",
    mode: overrides.mode ?? "enforce",
    createdAt: 0,
  };
  return {
    plan,
    policies: overrides.policies ?? [],
    ...(overrides.sink ? { sink: overrides.sink } : {}),
  };
}

afterEach(() => {
  clearEnterpriseActiveRunsForTest();
});

describe("resolveEnterpriseMode", () => {
  it("defaults to enforce, including with no config at all", () => {
    expect(resolveEnterpriseMode(undefined)).toBe("enforce");
    expect(resolveEnterpriseMode({})).toBe("enforce");
  });

  it("honors explicit config modes", () => {
    expect(resolveEnterpriseMode({ enterprise: { mode: "observe" } })).toBe("observe");
    expect(resolveEnterpriseMode({ enterprise: { mode: "off" } })).toBe("off");
  });
});

describe("evaluateEnterpriseToolCall", () => {
  it("returns undefined for unmediated runs", () => {
    expect(evaluateEnterpriseToolCall({ runId: "unknown", toolName: "exec" })).toBeUndefined();
    expect(evaluateEnterpriseToolCall({ toolName: "exec" })).toBeUndefined();
  });

  it("blocks denied tools in enforce mode and records the decision", () => {
    const events: Array<Record<string, unknown>> = [];
    registerEnterpriseActiveRun(
      makeRun({
        allowedTools: ["memory_search"],
        sink: (event) => {
          events.push(event.payload);
        },
      }),
    );
    const verdict = evaluateEnterpriseToolCall({
      runId: "run-1",
      toolName: "exec",
      toolCallId: "call-1",
    });
    expect(verdict?.blocked).toBe(true);
    expect(verdict?.decision.effect).toBe("deny");
    expect(verdict?.nodeId).toBe("support");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      subject: "tool_call",
      toolName: "exec",
      toolCallId: "call-1",
      effect: "deny",
      enforced: true,
    });
  });

  it("records but does not block denials in observe mode", () => {
    const events: Array<Record<string, unknown>> = [];
    registerEnterpriseActiveRun(
      makeRun({
        mode: "observe",
        allowedTools: ["memory_search"],
        sink: (event) => {
          events.push(event.payload);
        },
      }),
    );
    const verdict = evaluateEnterpriseToolCall({ runId: "run-1", toolName: "exec" });
    expect(verdict?.blocked).toBe(false);
    expect(verdict?.decision.effect).toBe("deny");
    expect(events[0]).toMatchObject({ effect: "deny", enforced: false });
  });

  it("allows in-scope tools without tracing default allows", () => {
    const events: Array<Record<string, unknown>> = [];
    registerEnterpriseActiveRun(
      makeRun({
        allowedTools: ["exec", "memory_search"],
        sink: (event) => {
          events.push(event.payload);
        },
      }),
    );
    const verdict = evaluateEnterpriseToolCall({ runId: "run-1", toolName: "exec" });
    expect(verdict?.blocked).toBe(false);
    expect(verdict?.decision.effect).toBe("allow");
    // Stock path: no per-tool-call trace writes for default allows.
    expect(events).toHaveLength(0);
  });

  it("traces default allows when the node opts into ontology.audit", () => {
    const events: Array<Record<string, unknown>> = [];
    registerEnterpriseActiveRun(
      makeRun({
        audit: true,
        sink: (event) => {
          events.push(event.payload);
        },
      }),
    );
    const verdict = evaluateEnterpriseToolCall({ runId: "run-1", toolName: "exec" });
    expect(verdict?.decision.effect).toBe("allow");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ effect: "allow", enforced: false });
  });

  it("fails closed in enforce mode when the plan is corrupt", () => {
    const run = makeRun({});
    run.plan.activeNodeId = "missing.node";
    registerEnterpriseActiveRun(run);
    const verdict = evaluateEnterpriseToolCall({ runId: "run-1", toolName: "exec" });
    expect(verdict?.blocked).toBe(true);
    expect(verdict?.decision.reason).toContain("enterprise governance evaluation failed");
  });

  it("fails open in observe mode when the plan is corrupt", () => {
    const run = makeRun({ mode: "observe" });
    run.plan.activeNodeId = "missing.node";
    registerEnterpriseActiveRun(run);
    const verdict = evaluateEnterpriseToolCall({ runId: "run-1", toolName: "exec" });
    expect(verdict?.blocked).toBe(false);
  });

  it("never throws when the sink throws", () => {
    registerEnterpriseActiveRun(
      makeRun({
        allowedTools: ["memory_search"],
        sink: () => {
          throw new Error("sink boom");
        },
      }),
    );
    expect(() => evaluateEnterpriseToolCall({ runId: "run-1", toolName: "exec" })).not.toThrow();
  });

  it("marks require_approval verdicts for enforce mode without pre-recording", () => {
    const events: Array<Record<string, unknown>> = [];
    const approvalPolicies: GovernancePolicy[] = [
      {
        id: "approve.exec",
        effect: "require_approval",
        tools: ["exec"],
        approval: { severity: "critical" },
      },
    ];
    registerEnterpriseActiveRun(
      makeRun({
        policies: approvalPolicies,
        sink: (event) => {
          events.push(event.payload);
        },
      }),
    );
    const verdict = evaluateEnterpriseToolCall({ runId: "run-1", toolName: "exec" });
    expect(verdict?.requiresApproval).toBe(true);
    expect(verdict?.blocked).toBe(false);
    expect(verdict?.decision.approval).toEqual({ severity: "critical" });
    // The gate records the decision once the human resolution settles.
    expect(events).toHaveLength(0);

    recordEnterpriseApprovalResolution({
      runId: "run-1",
      verdict: verdict!,
      toolName: "exec",
      toolCallId: "call-9",
      outcome: "approved",
      resolution: "allow-once",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      effect: "require_approval",
      approved: true,
      enforced: false,
      resolution: "allow-once",
      toolCallId: "call-9",
      policyId: "approve.exec",
    });

    recordEnterpriseApprovalResolution({
      runId: "run-1",
      verdict: verdict!,
      toolName: "exec",
      outcome: "denied",
      resolution: "deny",
    });
    expect(events[1]).toMatchObject({
      effect: "require_approval",
      approved: false,
      enforced: true,
      resolution: "deny",
    });
  });

  it("records require_approval decisions immediately in observe mode", () => {
    const events: Array<Record<string, unknown>> = [];
    registerEnterpriseActiveRun(
      makeRun({
        mode: "observe",
        policies: [{ id: "approve.exec", effect: "require_approval", tools: ["exec"] }],
        sink: (event) => {
          events.push(event.payload);
        },
      }),
    );
    const verdict = evaluateEnterpriseToolCall({ runId: "run-1", toolName: "exec" });
    expect(verdict?.requiresApproval).toBe(false);
    expect(verdict?.blocked).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ effect: "require_approval", enforced: false });
  });

  it("stops gating after unregistering", () => {
    registerEnterpriseActiveRun(makeRun({ allowedTools: ["memory_search"] }));
    expect(getEnterpriseActiveRun("run-1")).toBeDefined();
    unregisterEnterpriseActiveRun("run-1");
    expect(evaluateEnterpriseToolCall({ runId: "run-1", toolName: "exec" })).toBeUndefined();
  });
});

type SinkEvent = { kind: string; nodeId: string; payload: Record<string, unknown> };

function leaf(nodeId: string, seq: number, title: string): EnterprisePlanNode {
  return { nodeId, parentId: "support", seq, title, ontology: {} };
}

function makeGovernedRun(
  sink?: (event: SinkEvent) => void,
  opts: { rootAudit?: boolean; activeNodeId?: string } = {},
): EnterpriseActiveRun {
  const plan: EnterpriseRunPlan = {
    runId: "run-steps",
    treeId: "acme.support",
    treeVersion: "1.0.0",
    treeName: "Support",
    matchedBy: "trigger",
    requestSummary: "help",
    nodes: [
      {
        nodeId: "support",
        parentId: null,
        seq: 0,
        title: "Support",
        ontology: {
          allowedTools: ["memory_search", "message"],
          ...(opts.rootAudit ? { audit: true } : {}),
        },
      },
      leaf("support.triage", 1, "Triage"),
      leaf("support.resolve", 2, "Resolve"),
    ],
    // Runs start on the root; the step hook enters the first leaf on turn one.
    activeNodeId: opts.activeNodeId ?? "support",
    mode: "enforce",
    createdAt: 0,
  };
  return { plan, policies: [], ...(sink ? { sink } : {}) };
}

describe("enterpriseRunTracksSteps", () => {
  it("is true for governed multi-step runs and false for unknown runs", () => {
    registerEnterpriseActiveRun(makeGovernedRun());
    expect(enterpriseRunTracksSteps("run-steps")).toBe(true);
    expect(enterpriseRunTracksSteps("nope")).toBe(false);
  });

  it("is false for a guidance-free single-node run", () => {
    registerEnterpriseActiveRun(makeRun({ runId: "run-1" }));
    expect(enterpriseRunTracksSteps("run-1")).toBe(false);
  });

  it("is true for a guidance-free multi-leaf run when a policy targets a node", () => {
    const run = makeGovernedRun();
    // Strip ontology guidance so only the node-scoped policy justifies tracking.
    run.plan.nodes[0].ontology = {};
    run.policies = [
      { id: "deny.leaf.exec", effect: "deny", tools: ["exec"], nodes: ["support.resolve"] },
    ];
    registerEnterpriseActiveRun(run);
    expect(enterpriseRunTracksSteps("run-steps")).toBe(true);
  });

  it("ignores node-scoped policies whose tree selector cannot match this run", () => {
    const run = makeGovernedRun();
    run.plan.nodes[0].ontology = {};
    // Policy is pinned to a different tree, so it can never apply here; the run
    // must stay write-quiet rather than install the hook for nothing.
    run.policies = [
      {
        id: "deny.other.tree",
        effect: "deny",
        tools: ["exec"],
        nodes: ["support.resolve"],
        trees: ["finance.*"],
      },
    ];
    registerEnterpriseActiveRun(run);
    expect(enterpriseRunTracksSteps("run-steps")).toBe(false);
  });
});

describe("enterprise step cursor", () => {
  it("tracks executed turns: enter the first leaf, then advance as turns complete", () => {
    const events: SinkEvent[] = [];
    registerEnterpriseActiveRun(makeGovernedRun((event) => events.push(event)));

    setEnterpriseStepForTurn("run-steps");
    expect(getEnterpriseActiveRun("run-steps")?.plan.activeNodeId).toBe("support.triage");
    recordEnterpriseTurnExecuted("run-steps");
    setEnterpriseStepForTurn("run-steps");
    expect(getEnterpriseActiveRun("run-steps")?.plan.activeNodeId).toBe("support.resolve");

    expect(events.map((event) => `${event.kind}:${event.nodeId}`)).toEqual([
      "node.entered:support.triage",
      "node.completed:support.triage",
      "node.entered:support.resolve",
    ]);
    expect(events[0].payload).toMatchObject({ seq: 1, title: "Triage" });
  });

  it("redoes the same step on a preflight-failed turn's retry (never skips)", () => {
    const events: SinkEvent[] = [];
    registerEnterpriseActiveRun(makeGovernedRun((event) => events.push(event)));
    // Turn one enters the first leaf, then fails before a response — no executed
    // turn is recorded.
    setEnterpriseStepForTurn("run-steps");
    events.length = 0;
    // The retry's first turn must land on the same leaf, not skip to the next.
    setEnterpriseStepForTurn("run-steps");
    expect(getEnterpriseActiveRun("run-steps")?.plan.activeNodeId).toBe("support.triage");
    expect(events).toHaveLength(0);
  });

  it("advances a run resumed after real progress (executed turn recorded)", () => {
    registerEnterpriseActiveRun(makeGovernedRun());
    setEnterpriseStepForTurn("run-steps"); // turn one → first leaf
    recordEnterpriseTurnExecuted("run-steps"); // turn one executed
    // A fresh attempt resumes; its first turn advances to the next step.
    setEnterpriseStepForTurn("run-steps");
    expect(getEnterpriseActiveRun("run-steps")?.plan.activeNodeId).toBe("support.resolve");
  });

  it("saturates at the final step instead of running off the end", () => {
    const events: SinkEvent[] = [];
    registerEnterpriseActiveRun(makeGovernedRun((event) => events.push(event)));
    for (let turn = 0; turn < 5; turn += 1) {
      setEnterpriseStepForTurn("run-steps");
      recordEnterpriseTurnExecuted("run-steps");
    }
    expect(getEnterpriseActiveRun("run-steps")?.plan.activeNodeId).toBe("support.resolve");
    // Only two real transitions happen (triage, resolve); the rest clamp.
    expect(events.filter((event) => event.kind === "node.entered")).toHaveLength(2);
  });

  it("is a no-op for unknown runs", () => {
    expect(() => setEnterpriseStepForTurn("nope")).not.toThrow();
    expect(() => recordEnterpriseTurnExecuted("nope")).not.toThrow();
  });

  it("scopes the gate to the active leaf's ancestor path", () => {
    registerEnterpriseActiveRun(makeGovernedRun(undefined, { activeNodeId: "support.triage" }));
    // On the first leaf: the root allows only memory_search/message, so an
    // out-of-scope tool is denied under the leaf's inherited path.
    const verdict = evaluateEnterpriseToolCall({ runId: "run-steps", toolName: "exec" });
    expect(verdict?.nodeId).toBe("support.triage");
    expect(verdict?.blocked).toBe(true);
    expect(verdict?.decision.reason).toContain('workflow step "support"');
  });

  it("keeps recording default allows under a leaf when the root opts into audit", () => {
    const events: SinkEvent[] = [];
    registerEnterpriseActiveRun(
      makeGovernedRun((event) => events.push(event), {
        rootAudit: true,
        activeNodeId: "support.triage",
      }),
    );
    // The active leaf is audit-free, but the root audit setting is inherited
    // down the path, so default allows are still traced.
    const verdict = evaluateEnterpriseToolCall({ runId: "run-steps", toolName: "message" });
    expect(verdict?.decision.effect).toBe("allow");
    expect(verdict?.decision.source).toBe("default");
    const decisions = events.filter((event) => event.kind === "governance.decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0].nodeId).toBe("support.triage");
  });
});

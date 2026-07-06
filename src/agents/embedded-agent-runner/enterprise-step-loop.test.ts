import { afterEach, describe, expect, it } from "vitest";
import {
  clearEnterpriseActiveRunsForTest,
  getEnterpriseActiveRun,
  registerEnterpriseActiveRun,
  type EnterpriseActiveRun,
} from "../../enterprise/runtime.js";
import type { EnterpriseRunPlan } from "../../enterprise/types.js";
import { installEnterpriseStepLoopHook } from "./enterprise-step-loop.js";

type TransformContext = (
  messages: unknown[],
  signal: AbortSignal,
) => unknown[] | Promise<unknown[]>;

type PrepareNextTurn = (signal?: AbortSignal) => unknown;

type StepAgent = { transformContext?: TransformContext; prepareNextTurn?: PrepareNextTurn };

type SinkEvent = { kind: string; nodeId: string };

const SIGNAL = new AbortController().signal;

function governedRun(runId: string, sink?: (event: SinkEvent) => void): EnterpriseActiveRun {
  const plan: EnterpriseRunPlan = {
    runId,
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
        ontology: { allowedTools: ["message"] },
      },
      { nodeId: "support.triage", parentId: "support", seq: 1, title: "Triage", ontology: {} },
      { nodeId: "support.resolve", parentId: "support", seq: 2, title: "Resolve", ontology: {} },
    ],
    // Runs start on the root; the hook enters the first leaf on the first turn.
    activeNodeId: "support",
    mode: "enforce",
    createdAt: 0,
  };
  return { plan, policies: [], ...(sink ? { sink } : {}) };
}

function guidanceFreeRun(runId: string): EnterpriseActiveRun {
  const plan: EnterpriseRunPlan = {
    runId,
    treeId: "clawworks.assist",
    treeVersion: "1.0.0",
    treeName: "Assist",
    matchedBy: "default",
    requestSummary: "hi",
    nodes: [
      { nodeId: "assist", parentId: null, seq: 0, title: "Assist", ontology: {} },
      { nodeId: "assist.do", parentId: "assist", seq: 1, title: "Do", ontology: {} },
    ],
    activeNodeId: "assist",
    mode: "enforce",
    createdAt: 0,
  };
  return { plan, policies: [] };
}

afterEach(() => {
  clearEnterpriseActiveRunsForTest();
});

async function runTurn(agent: StepAgent, message: unknown): Promise<unknown> {
  // Model one provider turn: transform at the start, then mark it executed (as
  // the loop's prepareNextTurn would after a real turn_end).
  const result = await agent.transformContext?.([message], SIGNAL);
  await agent.prepareNextTurn?.(SIGNAL);
  return result;
}

describe("installEnterpriseStepLoopHook", () => {
  it("enters the first leaf, then advances one step per executed turn", async () => {
    const events: SinkEvent[] = [];
    registerEnterpriseActiveRun(governedRun("run-hook", (event) => events.push(event)));
    const calls: unknown[][] = [];
    const original: TransformContext = (messages) => {
      calls.push(messages);
      return [...messages, "transformed"];
    };
    const agent: StepAgent = { transformContext: original };
    const dispose = installEnterpriseStepLoopHook({ agent, runId: "run-hook" });

    // First turn enters the first leaf; the prior transform still runs verbatim.
    const first = await runTurn(agent, "m0");
    expect(getEnterpriseActiveRun("run-hook")?.plan.activeNodeId).toBe("support.triage");
    expect(first).toEqual(["m0", "transformed"]);

    await runTurn(agent, "m1");
    expect(getEnterpriseActiveRun("run-hook")?.plan.activeNodeId).toBe("support.resolve");
    // Final step reached: further turns saturate without stepping off the end.
    await runTurn(agent, "m2");
    expect(getEnterpriseActiveRun("run-hook")?.plan.activeNodeId).toBe("support.resolve");
    expect(calls).toHaveLength(3);
    expect(events.map((event) => `${event.kind}:${event.nodeId}`)).toEqual([
      "node.entered:support.triage",
      "node.completed:support.triage",
      "node.entered:support.resolve",
    ]);

    dispose();
    expect(agent.transformContext).toBe(original);
  });

  it("advances on the first turn of a resumed attempt (executed turn recorded)", async () => {
    // A fallback/compaction retry re-installs the hook after real progress; its
    // first turn must advance to the next step, not stall on the current one.
    const run = governedRun("run-resume");
    run.stepTurnsExecuted = 1;
    run.plan.activeNodeId = "support.triage";
    registerEnterpriseActiveRun(run);
    const agent: StepAgent = {};
    const dispose = installEnterpriseStepLoopHook({ agent, runId: "run-resume" });

    await agent.transformContext?.(["m0"], SIGNAL);
    expect(getEnterpriseActiveRun("run-resume")?.plan.activeNodeId).toBe("support.resolve");
    dispose();
  });

  it("attaches even without prior hooks and passes messages through", async () => {
    registerEnterpriseActiveRun(governedRun("run-solo"));
    const agent: StepAgent = {};
    const dispose = installEnterpriseStepLoopHook({ agent, runId: "run-solo" });
    expect(typeof agent.transformContext).toBe("function");
    expect(typeof agent.prepareNextTurn).toBe("function");

    const first = await runTurn(agent, "m0");
    expect(first).toEqual(["m0"]);
    expect(getEnterpriseActiveRun("run-solo")?.plan.activeNodeId).toBe("support.triage");
    await runTurn(agent, "m1");
    expect(getEnterpriseActiveRun("run-solo")?.plan.activeNodeId).toBe("support.resolve");

    dispose();
    expect(agent.transformContext).toBeUndefined();
    expect(agent.prepareNextTurn).toBeUndefined();
  });

  it("is a no-op for guidance-free runs (agent left untouched)", () => {
    registerEnterpriseActiveRun(guidanceFreeRun("run-plain"));
    const original: TransformContext = (messages) => messages;
    const agent: StepAgent = { transformContext: original };
    const dispose = installEnterpriseStepLoopHook({ agent, runId: "run-plain" });
    expect(agent.transformContext).toBe(original);
    expect(agent.prepareNextTurn).toBeUndefined();
    dispose();
    expect(agent.transformContext).toBe(original);
  });

  it("is a no-op for unmediated runs", () => {
    const agent: StepAgent = {};
    const dispose = installEnterpriseStepLoopHook({ agent, runId: "unknown" });
    expect(agent.transformContext).toBeUndefined();
    dispose();
  });
});

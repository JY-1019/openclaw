/**
 * Process-local enterprise run state and the per-tool-call governance gate.
 * The registry carries prepared facts (plan, policies, trace sink) keyed by
 * runId so hot-path gate lookups never re-resolve config or definitions.
 * Trace persistence stays behind the sink installed by run mediation, keeping
 * this module import-light for agent hot paths.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { evaluateToolCallGovernance, policyTargetsTree } from "./governance.js";
import {
  enterpriseStepSequence,
  findPlanNode,
  planTracksSteps,
  resolvePlanNodePath,
} from "./plan.js";
import type {
  EnterpriseMode,
  EnterpriseRunPlan,
  GovernanceDecision,
  GovernancePolicy,
} from "./types.js";

/** Trace sink installed by run mediation; must never throw. */
export type EnterpriseRunTraceSink = (event: {
  kind: "governance.decision" | "node.entered" | "node.completed";
  nodeId: string;
  payload: Record<string, unknown>;
}) => void;

export type EnterpriseActiveRun = {
  plan: EnterpriseRunPlan;
  policies: readonly GovernancePolicy[];
  sink?: EnterpriseRunTraceSink;
  /**
   * Provider turns that have actually executed for this execution. The active
   * leaf is `leaves[min(stepTurnsExecuted, last)]`, so it only advances once a
   * turn really runs — a preflight-failed turn is never counted and the retry
   * redoes that step. Absent means zero (fixtures/first turn).
   */
  stepTurnsExecuted?: number;
};

/** Effective enterprise mode. Enterprise is on ("enforce") unless config opts out. */
export function resolveEnterpriseMode(config?: OpenClawConfig): EnterpriseMode {
  return config?.enterprise?.mode ?? "enforce";
}

// Symbol-keyed global so duplicated dist chunks share one registry
// (same pattern as the memory embedding provider registry).
const ACTIVE_RUNS_KEY = Symbol.for("openclaw.enterpriseActiveRuns");

function activeRuns(): Map<string, EnterpriseActiveRun> {
  const holder = globalThis as { [ACTIVE_RUNS_KEY]?: Map<string, EnterpriseActiveRun> };
  holder[ACTIVE_RUNS_KEY] ??= new Map();
  return holder[ACTIVE_RUNS_KEY];
}

export function registerEnterpriseActiveRun(run: EnterpriseActiveRun): void {
  activeRuns().set(run.plan.runId, run);
}

export function getEnterpriseActiveRun(runId: string): EnterpriseActiveRun | undefined {
  return activeRuns().get(runId);
}

export function unregisterEnterpriseActiveRun(runId: string): void {
  activeRuns().delete(runId);
}

/** Test-only: clear registry state between cases (isolate:false lanes). */
export function clearEnterpriseActiveRunsForTest(): void {
  activeRuns().clear();
}

/** Whether a mediated run advances/traces per-node steps (governed trees only). */
export function enterpriseRunTracksSteps(runId: string): boolean {
  const run = activeRuns().get(runId);
  if (!run) {
    return false;
  }
  if (planTracksSteps(run.plan)) {
    return true;
  }
  // Node-scoped governance policies also require advancement so the active node
  // can reach the leaves they target. Only policies that can match this tree
  // count, or an unrelated tree's policy would break the write-quiet no-op path.
  return (
    run.plan.nodes.length > 1 &&
    run.policies.some(
      (policy) => (policy.nodes?.length ?? 0) > 0 && policyTargetsTree(policy, run.plan.treeId),
    )
  );
}

/**
 * Point the active node at the step for the current turn, called by the step
 * hook at the start of every provider turn (the `transformContext` seam). The
 * step is `leaves[min(stepTurnsExecuted, last)]`, so it tracks turns that have
 * actually executed (see recordEnterpriseTurnExecuted): a fresh turn projects
 * the executed count onto the active leaf, emitting node transitions. Because
 * the counter only moves after a turn completes, a preflight-failed turn's
 * retry redoes the same step (never skips), while a run resumed after real
 * progress lands on the next step. The cursor is clamped at the final leaf and
 * the root is a scope container, so leaving it opens the timeline (entered) with
 * no `completed`.
 */
export function setEnterpriseStepForTurn(runId: string): void {
  const run = activeRuns().get(runId);
  if (!run) {
    return;
  }
  const leaves = enterpriseStepSequence(run.plan);
  const targetId = leaves[Math.min(run.stepTurnsExecuted ?? 0, leaves.length - 1)];
  if (!targetId || run.plan.activeNodeId === targetId) {
    return;
  }
  const from = findPlanNode(run.plan, run.plan.activeNodeId);
  const to = findPlanNode(run.plan, targetId);
  if (!to) {
    return;
  }
  run.plan.activeNodeId = to.nodeId;
  if (from && leaves.includes(from.nodeId)) {
    run.sink?.({
      kind: "node.completed",
      nodeId: from.nodeId,
      payload: { seq: from.seq, title: from.title },
    });
  }
  run.sink?.({
    kind: "node.entered",
    nodeId: to.nodeId,
    payload: { seq: to.seq, title: to.title },
  });
}

/**
 * Count one executed provider turn, called by the step hook from the loop's
 * `prepareNextTurn` seam. That fires only after a turn's `turn_end` — i.e. after
 * the model actually responded — so a preflight failure (which ends the attempt
 * before its response) never counts, and the next attempt's first turn re-runs
 * the same step instead of skipping it. Firing once after the final turn is
 * harmless: no later `setEnterpriseStepForTurn` projects the bumped count.
 */
export function recordEnterpriseTurnExecuted(runId: string): void {
  const run = activeRuns().get(runId);
  if (run) {
    run.stepTurnsExecuted = (run.stepTurnsExecuted ?? 0) + 1;
  }
}

export type EnterpriseToolCallVerdict = {
  decision: GovernanceDecision;
  nodeId: string;
  treeId: string;
  mode: Exclude<EnterpriseMode, "off">;
  /** True when the decision must block execution (enforce mode denials). */
  blocked: boolean;
  /** True when enforce mode must gate this call behind a human approval. */
  requiresApproval: boolean;
};

/**
 * Governance gate for one tool call. Returns undefined when the run is not
 * enterprise-mediated (mode off, unmediated caller, or unknown runId).
 * Never throws: internal evaluation failures fail closed in enforce mode and
 * open in observe mode, mirroring the enterprise/observe contract.
 */
export function evaluateEnterpriseToolCall(params: {
  runId?: string;
  toolName: string;
  toolCallId?: string;
}): EnterpriseToolCallVerdict | undefined {
  if (!params.runId) {
    return undefined;
  }
  const run = getEnterpriseActiveRun(params.runId);
  if (!run) {
    return undefined;
  }
  const { plan } = run;
  try {
    const node = findPlanNode(plan, plan.activeNodeId);
    if (!node) {
      throw new Error(`active workflow node "${plan.activeNodeId}" missing from plan`);
    }
    // Scope the call with the active node's ontology plus its ancestors so a
    // deeper step cannot escape the tool scope its root declared.
    const path = resolvePlanNodePath(plan, node.nodeId);
    const decision = evaluateToolCallGovernance({
      plan,
      node,
      toolName: params.toolName,
      policies: run.policies,
      path,
    });
    const verdict: EnterpriseToolCallVerdict = {
      decision,
      nodeId: node.nodeId,
      treeId: plan.treeId,
      mode: plan.mode,
      blocked: decision.effect === "deny" && plan.mode === "enforce",
      requiresApproval: decision.effect === "require_approval" && plan.mode === "enforce",
    };
    // Default allows stay silent (matching run-start mediation) so the stock
    // enterprise path adds no per-tool-call SQLite writes; a node opts into full
    // decision auditing with ontology.audit. Audit is inherited down the path so
    // a root audit setting keeps covering leaves after the run advances.
    // Approval-gated calls are recorded once the human decision resolves.
    const auditEnabled = path.some((step) => step.ontology.audit === true);
    const silentDefaultAllow =
      decision.effect === "allow" && decision.source === "default" && !auditEnabled;
    if (!silentDefaultAllow && !verdict.requiresApproval) {
      recordDecision(run, verdict, params);
    }
    return verdict;
  } catch (err) {
    const reason = `enterprise governance evaluation failed: ${err instanceof Error ? err.message : String(err)}`;
    const decision: GovernanceDecision = {
      effect: plan.mode === "enforce" ? "deny" : "allow",
      policyId: null,
      source: "default",
      reason,
    };
    const verdict: EnterpriseToolCallVerdict = {
      decision,
      nodeId: plan.activeNodeId,
      treeId: plan.treeId,
      mode: plan.mode,
      blocked: plan.mode === "enforce",
      requiresApproval: false,
    };
    recordDecision(run, verdict, params);
    return verdict;
  }
}

export type EnterpriseApprovalOutcome = "approved" | "denied";

/**
 * Record the resolution of an approval-gated tool call. Called from the
 * approval onResolution callback so the trace reflects the real outcome
 * across inline, deferred, and cancelled resolutions.
 */
export function recordEnterpriseApprovalResolution(params: {
  runId: string;
  verdict: EnterpriseToolCallVerdict;
  toolName: string;
  toolCallId?: string;
  outcome: EnterpriseApprovalOutcome;
  resolution: string;
}): void {
  const run = getEnterpriseActiveRun(params.runId);
  if (!run) {
    return;
  }
  try {
    run.sink?.({
      kind: "governance.decision",
      nodeId: params.verdict.nodeId,
      payload: {
        subject: "tool_call",
        toolName: params.toolName,
        ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
        effect: "require_approval",
        enforced: params.outcome === "denied",
        approved: params.outcome === "approved",
        resolution: params.resolution,
        policyId: params.verdict.decision.policyId,
        source: params.verdict.decision.source,
        reason: params.verdict.decision.reason,
      },
    });
  } catch {
    // Trace sinks fail open: a persistence fault must never affect the
    // approval outcome already resolved for this call.
  }
}

function recordDecision(
  run: EnterpriseActiveRun,
  verdict: EnterpriseToolCallVerdict,
  params: { toolName: string; toolCallId?: string },
): void {
  try {
    run.sink?.({
      kind: "governance.decision",
      nodeId: verdict.nodeId,
      payload: {
        subject: "tool_call",
        toolName: params.toolName,
        ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
        effect: verdict.decision.effect,
        enforced: verdict.blocked,
        policyId: verdict.decision.policyId,
        source: verdict.decision.source,
        reason: verdict.decision.reason,
      },
    });
  } catch {
    // Trace sinks fail open: a persistence fault must never affect the
    // governance verdict already computed for this call.
  }
}

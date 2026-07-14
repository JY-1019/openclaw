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
  EnterprisePlanNode,
} from "./types.js";

/** Trace sink installed by run mediation; must never throw. */
export type EnterpriseRunTraceSink = (event: {
  kind: "governance.decision" | "node.entered" | "node.completed" | "action.invoked";
  nodeId: string;
  payload: Record<string, unknown>;
}) => void;

export type EnterpriseActiveRun = {
  plan: EnterpriseRunPlan;
  policies: readonly GovernancePolicy[];
  sink?: EnterpriseRunTraceSink;
  /**
   * Required property ids per object type, from the tree this run PLANNED
   * against. Snapshotted at mediation so a mid-run re-import cannot change the
   * shape an in-flight write is judged by.
   */
  treeRequiredProperties?: Map<string, Set<string>>;
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
/**
 * The ontology action a tool call names, if any.
 *
 * invoke_action is the only tool whose SUBJECT is an ontology action rather than
 * the tool itself, and governance has to know which action was chosen before it
 * can decide. The tool-name literal lives here, in the enterprise domain that
 * owns the tool, rather than in the generic before-tool-call gate.
 */
/**
 * Record what an ontology action actually DID. The governance decision that
 * permitted the call is a separate event and says nothing about the write, so
 * without this the audit trail can show that a write was allowed but not that it
 * happened, nor to which object.
 */
export function recordEnterpriseActionInvoked(
  runId: string,
  event: { actionId: string; writes: readonly unknown[]; context: Record<string, unknown> },
): void {
  const run = getEnterpriseActiveRun(runId);
  if (!run?.sink) {
    return;
  }
  try {
    run.sink({
      kind: "action.invoked",
      nodeId: run.plan.activeNodeId,
      payload: { actionId: event.actionId, writes: event.writes, context: event.context },
    });
  } catch {
    // Fail OPEN. The write is already committed and durable, so letting a trace
    // fault propagate would report a successful mutation as a FAILED tool call —
    // and the model would sensibly retry it, writing twice. The sink logs its own
    // persistence failures (persistTrace), and this module stays import-light for
    // the agent hot path, so there is nothing to add here but the guarantee.
  }
}

/**
 * Does this tool's SUBJECT come from its params rather than its name?
 *
 * invoke_action's action id decides which governance policy applies, and a hook
 * can add or change it after the first gate — including filling in one that was
 * absent. So the final decision for this tool must always be taken on the final
 * params, whether or not the call arrived with an action.
 */
export function toolCarriesOntologyAction(toolName: string): boolean {
  return toolName === "invoke_action";
}

/**
 * The two ways a node can consent to ontology writes: naming the tool, or naming
 * the group that exists solely to hold it. `*` and `group:enterprise` (the READ
 * group) are not consent — a wildcard has not thought about writes, and the read
 * group has only ever meant read.
 *
 * Normalized like the tool-policy matcher normalizes a name (trim + lowercase),
 * because the ontology scope gate accepts `INVOKE_ACTION` and a step that
 * explicitly allowed the tool must not have its writes denied on casing.
 */
const ONTOLOGY_WRITE_OPT_INS = new Set(["invoke_action", "group:enterprise-write"]);
function explicitlyAllowsOntologyWrites(node: EnterprisePlanNode): boolean {
  return (node.ontology.allowedTools ?? []).some((tool) =>
    ONTOLOGY_WRITE_OPT_INS.has(tool.trim().toLowerCase()),
  );
}

/**
 * Does ANY planned node opt into ontology writes? Plan-level, so the tool list
 * stays fixed for the run (prompt cache). Exposure only — see the path check.
 */
export function runAllowsOntologyWrites(runId: string): boolean {
  const run = getEnterpriseActiveRun(runId);
  return run ? run.plan.nodes.some(explicitlyAllowsOntologyWrites) : false;
}

/**
 * May the run write from where it currently STANDS?
 *
 * Exposure is plan-level and must be (the model-visible tool list cannot change
 * mid-run), but exposure is not permission: one sibling opting into writes would
 * otherwise hand the tool to every other step, including one that declares actions
 * and omits `allowedTools` — which the per-call scope gate reads as allow-all.
 *
 * This is GOVERNANCE, not a tool-level afterthought: deciding it here means a
 * non-opted step is denied and recorded before any approval is prompted, rather
 * than prompting a human and then having the tool refuse the call anyway.
 */
function activePathAllowsWrites(plan: EnterpriseRunPlan): boolean {
  const node = findPlanNode(plan, plan.activeNodeId);
  if (!node) {
    return false;
  }
  return resolvePlanNodePath(plan, node.nodeId).some(explicitlyAllowsOntologyWrites);
}

export function readInvokedActionId(toolName: string, params: unknown): string | undefined {
  if (!toolCarriesOntologyAction(toolName) || !params || typeof params !== "object") {
    return undefined;
  }
  const action = (params as Record<string, unknown>).action;
  return typeof action === "string" && action.trim().length > 0 ? action.trim() : undefined;
}

export function evaluateEnterpriseToolCall(params: {
  runId?: string;
  toolName: string;
  toolCallId?: string;
  /** The ontology action the call names (invoke_action). See readInvokedActionId. */
  actionId?: string;
  /**
   * Write the decision to the audit trail. The pre-hook check for a call whose
   * params a hook may still rewrite passes false: recording there would leave the
   * trail claiming action A was allowed when action B actually ran, and nothing
   * can retract an appended event.
   */
  record?: boolean;
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
    // An ontology WRITE needs an explicit opt-in on the active path, decided
    // before any policy or approval runs.
    if (toolCarriesOntologyAction(params.toolName) && !activePathAllowsWrites(plan)) {
      const verdict: EnterpriseToolCallVerdict = {
        decision: {
          effect: "deny",
          policyId: null,
          source: "ontology",
          reason: `workflow step "${node.nodeId}" does not allow ontology writes; a step must name invoke_action in its allowedTools`,
        },
        nodeId: node.nodeId,
        treeId: plan.treeId,
        mode: plan.mode,
        blocked: plan.mode === "enforce",
        requiresApproval: false,
      };
      // Same rule as every other decision: a BLOCKED call is always recorded (it
      // returns immediately, so nothing can rewrite it), but an observed one that
      // a later pass will re-judge must not be written twice.
      if (verdict.blocked || params.record !== false) {
        recordDecision(run, verdict, params);
      }
      return verdict;
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
      ...(params.actionId !== undefined ? { actionId: params.actionId } : {}),
      ...(toolCarriesOntologyAction(params.toolName) ? { carriesAction: true } : {}),
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
    // A BLOCKED call is always recorded, whatever `record` says: it returns
    // immediately, so no hook can still rewrite it, and a denied write attempt is
    // exactly the event an operator needs in the trace. `record: false` exists to
    // suppress a decision that a later hook could invalidate — never a denial.
    const shouldRecord = verdict.blocked || params.record !== false;
    if (shouldRecord && !silentDefaultAllow && !verdict.requiresApproval) {
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
  /** The ontology action the approval was about (invoke_action). */
  actionId?: string;
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
        // Which declared action the approval was about; see recordDecision.
        ...(params.actionId !== undefined ? { actionId: params.actionId } : {}),
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
  params: { toolName: string; toolCallId?: string; actionId?: string },
): void {
  try {
    run.sink?.({
      kind: "governance.decision",
      nodeId: verdict.nodeId,
      payload: {
        subject: "tool_call",
        toolName: params.toolName,
        // The ACTION is the subject of an invoke_action decision, and the reason
        // string is not always going to carry it (a policy may set its own
        // description). Without it, a denied or approved write in the trail cannot
        // say WHICH declared action was attempted.
        ...(params.actionId !== undefined ? { actionId: params.actionId } : {}),
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

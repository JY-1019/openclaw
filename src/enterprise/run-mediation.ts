/**
 * Enterprise run mediation: binds one agent execution to a workflow subtree,
 * evaluates run-start governance, registers the active run for the
 * per-tool-call gate, and persists the run trace. Trace persistence fails
 * open (logged) — only governance enforcement fails closed.
 *
 * runIds recur (fallback retries reuse them; recurring cron sessions reuse
 * their sessionId), so every begin→end cycle gets its own execution_id trace
 * row and the in-memory registry only holds currently-active executions.
 */
import { randomUUID } from "node:crypto";
import {
  failClosedWorkflowSelection,
  selectWorkflowPlan,
  type EnterpriseRouteSelection,
  type WorkflowPlanner,
} from "@openclaw/enterprise-planner";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { evaluateRunStartGovernance, resolveGovernancePolicies } from "./governance.js";
import { collectTreeRequiredProperties } from "./ontology-runtime.js";
import {
  buildEnterprisePromptSection,
  buildEnterpriseRunPlan,
  classifyWorkflowTrigger,
  collectWorkflowTreeCandidates,
} from "./plan.js";
import {
  registerEnterpriseActiveRun,
  resolveEnterpriseMode,
  unregisterEnterpriseActiveRun,
  type EnterpriseActiveRun,
} from "./runtime.js";
import {
  appendEnterpriseRunEvent,
  finalizeEnterpriseRun,
  persistEnterpriseRunStart,
  updateEnterpriseRunPlan,
} from "./trace-store.sqlite.js";
import { getWorkflowTreeRegistrySnapshot } from "./tree-registry.js";
import type {
  EnterpriseRunEventKind,
  EnterpriseRunPlan,
  EnterpriseRunStatus,
  WorkflowTreeDefinition,
} from "./types.js";

const log = createSubsystemLogger("enterprise");

type MediatedRunState = EnterpriseActiveRun & {
  executionId: string;
  allocateSeq: () => number;
};

// Active executions only, keyed by runId (the gate looks runs up by the
// HookContext runId). Entries are removed when the execution ends.
const mediatedRuns = new Map<string, MediatedRunState>();

// Begins that are still awaiting route planning. mediatedRuns is only populated
// AFTER the planner resolves, so without this a second begin for the same runId
// (a nested begin from one runner invocation) would sail past the existing-run
// guard, plan a second time, and create a duplicate execution row that nothing
// ever finalizes.
const pendingBegins = new Map<string, Promise<EnterpriseRunMediation>>();

export type EnterpriseRunMediation =
  | { kind: "off" }
  | { kind: "blocked"; reason: string }
  | { kind: "mediated"; plan: EnterpriseRunPlan; promptSection: string };

export type BeginEnterpriseRunParams = {
  runId: string;
  prompt: string;
  trigger?: string;
  spawnedBy?: string | null;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
  /**
   * Picks the governing tree and the route through it. Omit to bind the trigger's
   * default tree and plan it whole.
   */
  routePlanner?: WorkflowPlanner;
  /** Cancels the planning call when the agent run is aborted. */
  signal?: AbortSignal;
};

/** Begin enterprise mediation for one agent execution. */
export async function beginEnterpriseRun(
  params: BeginEnterpriseRunParams,
): Promise<EnterpriseRunMediation> {
  const inFlight = pendingBegins.get(params.runId);
  if (inFlight) {
    return await inFlight;
  }
  const begin = beginEnterpriseRunInternal(params);
  pendingBegins.set(params.runId, begin);
  try {
    return await begin;
  } finally {
    pendingBegins.delete(params.runId);
  }
}

async function beginEnterpriseRunInternal(
  params: BeginEnterpriseRunParams,
): Promise<EnterpriseRunMediation> {
  const mode = resolveEnterpriseMode(params.config);
  if (mode === "off") {
    return { kind: "off" };
  }

  const existing = mediatedRuns.get(params.runId);
  if (existing) {
    // The same execution is still active (nested begin from one runner
    // invocation); reuse it rather than double-tracing.
    return {
      kind: "mediated",
      plan: existing.plan,
      promptSection: buildEnterprisePromptSection(existing.plan),
    };
  }

  // Enforce mode fails closed whenever imported tree definitions may exist
  // but cannot be loaded: running on permissive built-ins would silently
  // drop the org's restrictions. Both failure classes carry an actionable
  // repair path so state-DB repair debt surfaces loudly instead of blocking
  // opaquely; observe/off remain the availability escape hatches.
  const registry = getWorkflowTreeRegistrySnapshot();
  const treeLoadFailure =
    registry.importErrors.length > 0
      ? `imported enterprise workflow trees failed to load: ${registry.importErrors
          .map((entry) => `"${entry.treeId}" (${entry.message})`)
          .join(", ")}; re-import or remove them`
      : registry.storeError
        ? `the enterprise workflow tree store could not be read (${registry.storeError}); repair the state database (openclaw doctor --fix) or relax enterprise.mode to "observe"/"off"`
        : undefined;
  if (treeLoadFailure) {
    if (mode === "enforce") {
      return { kind: "blocked", reason: treeLoadFailure };
    }
    log.warn(`enterprise observe mode continuing on built-in trees: ${treeLoadFailure}`);
  }

  // Only trees an operator IMPORTED can govern a run. Built-ins other than the
  // trigger default ship as EXAMPLES — registered so the Enterprise UI can show
  // a rich work-map without an import step, not so they bind real traffic. They
  // restrict tools per node, and picking a tree is a model judgement now, so
  // nothing else keeps a shipped example off unrelated requests: without this
  // filter the customer-support example governs every stock run, and it also
  // outranks the operator's own work-maps in the fail-closed fallback.
  // Adopting an example means importing it (imports override built-ins by id).
  const trees = registry.entries
    .filter((entry) => entry.source === "imported")
    .map((entry) => entry.tree);
  const trigger = classifyWorkflowTrigger({
    ...(params.trigger !== undefined ? { trigger: params.trigger } : {}),
    ...(params.spawnedBy !== undefined ? { spawnedBy: params.spawnedBy } : {}),
  });
  const { candidates, defaultTree } = collectWorkflowTreeCandidates({ trigger, trees });
  const policies = resolveGovernancePolicies(params.config);

  const buildPlanFor = (chosen: {
    tree: WorkflowTreeDefinition;
    matchedBy: EnterpriseRunPlan["matchedBy"];
    treeRationale?: string;
    route?: EnterpriseRouteSelection;
  }) =>
    buildEnterpriseRunPlan({
      runId: params.runId,
      requestText: params.prompt,
      mode,
      ...chosen,
    });

  // Evaluate run-start governance BEFORE any model contact. Planning sends the
  // request text to a provider, so a run a policy denies must be blocked first —
  // otherwise a denied prompt still leaves the machine, and the block is delayed
  // behind a model round-trip.
  //
  // Choosing the tree is ITSELF a model call now, so this check can no longer be
  // scoped to "the" tree — it has to cover every tree the request could bind to.
  // If any candidate denies the run at start, nothing is sent and selection stays
  // deterministic. The decision that actually blocks and gets traced is still the
  // one for the tree finally bound, evaluated below on the real plan.
  const anyCandidateDenied = candidates.some((tree) => {
    const decision = evaluateRunStartGovernance({
      plan: buildPlanFor({ tree, matchedBy: "fallback" }),
      policies,
    });
    return decision.effect === "deny" || decision.effect === "require_approval";
  });
  // The precheck above found a deny/approval, so no planner may run for this
  // turn. Selection must then stay on the tree that policy TARGETS: the deny is
  // re-evaluated below against the bound plan, and binding the permissive default
  // here would make the very policy that withheld the planner miss and let the
  // run through. This is deliberately not treated as planner unavailability.
  const plannerWithheldByGovernance = anyCandidateDenied && mode === "enforce";
  // Only consult (and trace) the planner when one is actually wired. With no
  // planner there is no decision to record, and emitting a route event would make
  // every stock run write trace rows it never wrote before.
  const plannerConsulted = Boolean(params.routePlanner) && !plannerWithheldByGovernance;
  const selection = plannerWithheldByGovernance
    ? failClosedWorkflowSelection({
        trees: candidates,
        defaultTree,
        reason: "run-start governance denied a candidate before planning",
      })
    : await selectWorkflowPlan({
        trees: candidates,
        defaultTree,
        requestText: params.prompt,
        ...(params.routePlanner ? { planner: params.routePlanner } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      });
  const plan = buildPlanFor({
    tree: selection.tree,
    matchedBy: selection.treeSource,
    treeRationale: selection.treeRationale,
    ...(plannerConsulted ? { route: selection.route } : {}),
  });
  const startDecision = evaluateRunStartGovernance({ plan, policies });
  const runStartDenied =
    startDecision.effect === "deny" || startDecision.effect === "require_approval";
  const skipPlanning = runStartDenied && mode === "enforce";

  // Route planning can await a provider. If the turn was cancelled while it was
  // in flight, the runner is already tearing the run down — persisting
  // run.started/route.selected now would leave a trace claiming a route for a
  // turn that never ran. Nothing is registered, so nothing needs finalizing.
  if (params.signal?.aborted) {
    return { kind: "off" };
  }

  let seq = 0;
  const run: MediatedRunState = {
    plan,
    policies,
    // Snapshot the tree's required-property shape from the definition this run
    // PLANNED against. Looking it up per tool call would drift: a re-import
    // mid-run invalidates the registry, and an in-flight write would start being
    // judged against a tree the run never planned or prompted against.
    treeRequiredProperties: collectTreeRequiredProperties(selection.tree),
    executionId: randomUUID(),
    allocateSeq: () => seq++,
    sink: (event) => {
      persistTrace(() => {
        appendEvent(run, event.kind, event.nodeId, event.payload);
      });
      // Advancement mutated run.plan.activeNodeId in place; re-persist the plan
      // so trace reads reflect the current step, not the run-start root.
      if (event.kind === "node.entered") {
        persistTrace(() => {
          updateEnterpriseRunPlan({ executionId: run.executionId, plan: run.plan });
        });
      }
    },
  };

  persistTrace(() => {
    persistEnterpriseRunStart({
      executionId: run.executionId,
      plan,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
    });
  });
  persistTrace(() => {
    appendEvent(run, "run.started", null, {
      treeId: plan.treeId,
      treeVersion: plan.treeVersion,
      matchedBy: plan.matchedBy,
      mode: plan.mode,
    });
  });
  // The route decision is the run's headline: which branch of the tree it took,
  // why, and how much of the tree that covers. Coverage is what makes a wrong
  // route visible (a correct route is a small fraction; a confused one is most
  // of the tree), so it belongs in the trace even when nothing was pruned.
  const routePlan = plan.route;
  if (routePlan) {
    persistTrace(() => {
      appendEvent(run, "route.selected", null, {
        source: routePlan.source,
        routes: routePlan.routes.join(", "),
        rationale: routePlan.rationale,
        selectedNodes: routePlan.selectedNodes,
        totalNodes: routePlan.totalNodes,
        ...(routePlan.invalidRoutes?.length
          ? { invalidRoutes: routePlan.invalidRoutes.join(", ") }
          : {}),
      });
    });
  }

  // Run-level approvals have no interactive channel at run start (the config
  // schema rejects them; this guards programmatic policies), so they compose
  // as deny-equivalent in enforce mode rather than silently passing.
  const runStartBlocked = skipPlanning;
  if (startDecision.source !== "default") {
    // Policy-sourced run decisions (deny, audit, explicit allow) are trace
    // evidence operators configured; only default allows stay silent.
    persistTrace(() => {
      appendEvent(run, "governance.decision", null, {
        subject: "run",
        effect: startDecision.effect,
        enforced: runStartBlocked,
        policyId: startDecision.policyId,
        source: startDecision.source,
        reason: startDecision.reason,
      });
    });
  }
  if (runStartBlocked) {
    persistTrace(() => {
      appendEvent(run, "run.ended", null, { status: "blocked", reason: startDecision.reason });
    });
    persistTrace(() => {
      finalizeEnterpriseRun({ executionId: run.executionId, status: "blocked" });
    });
    return { kind: "blocked", reason: startDecision.reason };
  }

  mediatedRuns.set(params.runId, run);
  registerEnterpriseActiveRun(run);
  // The node.entered/completed step timeline is owned by the embedded step-loop
  // hook (the only runtime that advances), so mediation stays timeline-free.
  // CLI/ACP runs never advance and therefore never claim leaf steps they
  // skipped; the sink still re-persists the plan whenever a step is entered.
  return { kind: "mediated", plan, promptSection: buildEnterprisePromptSection(plan) };
}

/** Finish the active execution for a runId with its terminal outcome. */
export function endEnterpriseRun(params: {
  runId: string;
  status: Exclude<EnterpriseRunStatus, "running">;
  reason?: string;
}): void {
  const run = mediatedRuns.get(params.runId);
  if (!run) {
    return;
  }
  mediatedRuns.delete(params.runId);
  unregisterEnterpriseActiveRun(params.runId);
  // The final step stays "entered" without an explicit node.completed; run.ended
  // carries the terminal status that closes the run (the step-loop hook owns the
  // per-step completed transitions it can actually observe).
  persistTrace(() => {
    appendEvent(run, "run.ended", null, {
      status: params.status,
      ...(params.reason ? { reason: params.reason } : {}),
    });
  });
  persistTrace(() => {
    finalizeEnterpriseRun({ executionId: run.executionId, status: params.status });
  });
}

/** Test-only: reset mediation state between cases (isolate:false lanes). */
export function clearEnterpriseRunMediationForTest(): void {
  for (const runId of mediatedRuns.keys()) {
    unregisterEnterpriseActiveRun(runId);
  }
  mediatedRuns.clear();
  pendingBegins.clear();
}

function appendEvent(
  run: MediatedRunState,
  kind: EnterpriseRunEventKind,
  nodeId: string | null,
  payload: Record<string, unknown>,
): void {
  appendEnterpriseRunEvent({
    executionId: run.executionId,
    seq: run.allocateSeq(),
    nodeId,
    kind,
    payload,
    createdAt: Date.now(),
  });
}

function persistTrace(write: () => void): void {
  try {
    write();
  } catch (err) {
    log.warn(
      `enterprise trace persistence failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

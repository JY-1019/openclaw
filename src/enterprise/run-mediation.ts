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
  selectWorkflowRoute,
  type EnterpriseRouteSelection,
  type RoutePlanner,
} from "@openclaw/enterprise-planner";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { evaluateRunStartGovernance, resolveGovernancePolicies } from "./governance.js";
import { collectTreeRequiredProperties } from "./ontology-runtime.js";
import {
  buildEnterprisePromptSection,
  buildEnterpriseRunPlan,
  classifyWorkflowTrigger,
  selectWorkflowTree,
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
import type { EnterpriseRunEventKind, EnterpriseRunPlan, EnterpriseRunStatus } from "./types.js";

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
  /** Picks the route through the selected tree. Omit to plan the whole subtree. */
  routePlanner?: RoutePlanner;
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

  const trees = registry.entries.map((entry) => entry.tree);
  const trigger = classifyWorkflowTrigger({
    ...(params.trigger !== undefined ? { trigger: params.trigger } : {}),
    ...(params.spawnedBy !== undefined ? { spawnedBy: params.spawnedBy } : {}),
  });
  // Route selection needs the tree first, so resolve it here and hand the same
  // selection to the plan builder (which re-derives it deterministically).
  const selection = selectWorkflowTree({ requestText: params.prompt, trigger, trees });
  const policies = resolveGovernancePolicies(params.config);

  const buildPlan = (route?: EnterpriseRouteSelection) =>
    buildEnterpriseRunPlan({
      runId: params.runId,
      requestText: params.prompt,
      trigger,
      mode,
      trees,
      ...(route ? { route } : {}),
    });

  // Evaluate run-start governance BEFORE any model contact. Route planning sends
  // the request text to a provider, so a run a policy denies must be blocked
  // first — otherwise a denied prompt still leaves the machine, and the block is
  // delayed behind a model round-trip. Governance is evaluated on the unrouted
  // plan; run-level policies select on tree/node, which pruning cannot add to.
  const unroutedPlan = buildPlan();
  const startDecision = evaluateRunStartGovernance({ plan: unroutedPlan, policies });
  const runStartDenied =
    startDecision.effect === "deny" || startDecision.effect === "require_approval";
  const skipPlanning = runStartDenied && mode === "enforce";

  // Only run (and trace) route selection when a planner is actually wired. With
  // no planner there is no decision to record, and emitting a route event would
  // make every stock run write trace rows it never wrote before.
  const route =
    params.routePlanner && !skipPlanning
      ? await selectWorkflowRoute({
          tree: selection.tree,
          requestText: params.prompt,
          planner: params.routePlanner,
          ...(params.signal ? { signal: params.signal } : {}),
        })
      : undefined;
  const plan = route ? buildPlan(route) : unroutedPlan;

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

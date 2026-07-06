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
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { evaluateRunStartGovernance, resolveGovernancePolicies } from "./governance.js";
import {
  buildEnterprisePromptSection,
  buildEnterpriseRunPlan,
  classifyWorkflowTrigger,
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
};

/** Begin enterprise mediation for one agent execution. */
export function beginEnterpriseRun(params: BeginEnterpriseRunParams): EnterpriseRunMediation {
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

  const plan = buildEnterpriseRunPlan({
    runId: params.runId,
    requestText: params.prompt,
    trigger: classifyWorkflowTrigger({
      ...(params.trigger !== undefined ? { trigger: params.trigger } : {}),
      ...(params.spawnedBy !== undefined ? { spawnedBy: params.spawnedBy } : {}),
    }),
    mode,
    trees: registry.entries.map((entry) => entry.tree),
  });
  const policies = resolveGovernancePolicies(params.config);
  const startDecision = evaluateRunStartGovernance({ plan, policies });

  let seq = 0;
  const run: MediatedRunState = {
    plan,
    policies,
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

  // Run-level approvals have no interactive channel at run start (the config
  // schema rejects them; this guards programmatic policies), so they compose
  // as deny-equivalent in enforce mode rather than silently passing.
  const runStartDenied =
    startDecision.effect === "deny" || startDecision.effect === "require_approval";
  const runStartBlocked = runStartDenied && mode === "enforce";
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

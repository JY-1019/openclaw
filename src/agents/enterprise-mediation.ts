import type { RoutePlanner } from "@openclaw/enterprise-planner";
/**
 * Runner glue for ClawWorks enterprise mediation, shared by every agent
 * runtime (embedded, CLI-backed, ACP): binds the run to a workflow subtree,
 * injects the per-run step digest into system-prompt params where the runtime
 * supports it, and maps run outcomes onto the enterprise trace.
 */
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { beginEnterpriseRun, endEnterpriseRun } from "../enterprise/run-mediation.js";
import { resolveEnterpriseMode } from "../enterprise/runtime.js";
import type { EnterpriseRunStatus } from "../enterprise/types.js";
import { hasGlobalHooks } from "../plugins/hook-runner-global.js";
import { buildAgentRunTerminalOutcome } from "./agent-run-terminal-outcome.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";

/** Structural param surface shared by the mediated runner entrypoints. */
export type EnterpriseMediatedRunParams = {
  runId: string;
  prompt: string;
  trigger?: string;
  spawnedBy?: string | null;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
  extraSystemPrompt?: string;
  /** Internal one-shot model probe (raw model run). */
  modelRun?: boolean;
  /** "none" marks raw model runs that bypass agent mediation. */
  promptMode?: string;
  /** Cancels the turn; route planning must observe it, not outlive it. */
  abortSignal?: AbortSignal;
  /**
   * The model the RUN selected. Route planning must use it, not the agent
   * default: a user who picked a local/private model must not have the request
   * shipped to a cloud default provider just to pick a route.
   */
  model?: string;
  /**
   * The provider the RUN selected. Runners pass provider and model separately,
   * and a bare model id would be resolved against the DEFAULT provider — which
   * is exactly the leak this is here to prevent.
   */
  provider?: string;
  /**
   * The turn is dispatched to a backend OpenClaw does not pick the model for
   * (ACP). Route planning must not run: it would send the prompt to OpenClaw's
   * default completion model while the turn itself goes somewhere else entirely.
   */
  externalDispatch?: boolean;
  /** The auth profile the run dispatches with (account/tenant boundary). */
  authProfileId?: string;
};

/**
 * How route planning should pick its model, from the run's own dispatch choice.
 *
 * A closed result, not a nullable string: "no ref" is ambiguous between "use the
 * agent default (which IS this run's choice)" and "this run pinned a provider we
 * cannot express as a ref" — and those must behave differently. Guessing the
 * former for the latter is exactly the leak this exists to prevent.
 */
function defaultHasHook(hook: "before_model_resolve" | "before_agent_reply"): boolean {
  try {
    return hasGlobalHooks(hook);
  } catch {
    // No hook runtime registered (tests, early startup): nothing can rewrite the
    // model or claim the turn, so planning on the run's own choice stays correct.
    return false;
  }
}

export type RouteModelChoice =
  | { kind: "ref"; ref: string }
  /** The run pinned no provider/model: the agent default IS its dispatch choice. */
  | { kind: "agent-default" }
  /** The run pinned a provider we cannot turn into a ref: do not plan at all. */
  | { kind: "skip" };

export function resolveRouteModelRef(
  params: EnterpriseMediatedRunParams,
  deps: { hasHook?: (hook: "before_model_resolve" | "before_agent_reply") => boolean } = {},
): RouteModelChoice {
  // The turn goes to a backend we do not choose the model for, so there is no
  // model choice to route with. Planning would ship the prompt to OpenClaw's
  // default provider — an unrelated cloud model for a possibly-local ACP run.
  if (params.externalDispatch) {
    return { kind: "skip" };
  }
  const hasHook = deps.hasHook ?? defaultHasHook;
  // A before_model_resolve hook can swap the run onto a different (often local
  // or private) provider AFTER mediation runs. We would be routing on the
  // pre-hook model, i.e. possibly the very cloud default the hook exists to
  // avoid. We cannot know the post-hook choice here, so we do not plan.
  if (hasHook("before_model_resolve")) {
    return { kind: "skip" };
  }
  // On a CRON run a before_agent_reply hook can claim the turn and answer it
  // without ever reaching a backend (see the same gate in cli-runner). Planning
  // first would make a model call for a turn that was never going to make one.
  //
  // Scoped to cron ON PURPOSE: a bundled plugin (memory-core) registers this hook
  // in every install, so skipping on its mere presence would disable route
  // planning for everyone.
  if (params.trigger === "cron" && hasHook("before_agent_reply")) {
    return { kind: "skip" };
  }
  const model = params.model?.trim();
  const provider = params.provider?.trim();
  if (model) {
    if (!provider) {
      return { kind: "ref", ref: model };
    }
    // Qualify with the PINNED provider unless the model already carries it.
    // A bare "contains a slash" test would be wrong: gateway providers route
    // slash-bearing model ids (openrouter + "anthropic/claude-sonnet-4-6"), and
    // treating that as already-qualified would drop `openrouter` and send the
    // prompt to anthropic — the exact leak this function exists to prevent.
    if (model === provider || model.startsWith(`${provider}/`)) {
      return { kind: "ref", ref: model };
    }
    return { kind: "ref", ref: `${provider}/${model}` };
  }
  if (provider) {
    // A provider with no model (a CLI run on that provider's default). We cannot
    // build a ref that pins the provider, and resolving a bare default would fall
    // back to the AGENT default — possibly a cloud provider this run deliberately
    // avoided. Skip planning; the whole tree is planned instead, which is less
    // precise but never routes the prompt somewhere the run did not choose.
    return { kind: "skip" };
  }
  return { kind: "agent-default" };
}

export type EnterpriseMediationOutcome<T extends EnterpriseMediatedRunParams> = {
  params: T;
  /** Set when run-start governance denied the run in enforce mode. */
  blockedResult?: EmbeddedAgentRunResult;
  /** True when this run is enterprise-mediated and must be finished. */
  mediated: boolean;
};

/**
 * Bind an agent run to enterprise mediation. Call AFTER session identity is
 * resolved (sessionKey backfill, session-target agentId) so the persisted
 * trace attributes the run correctly.
 */
export async function applyEnterpriseMediation<T extends EnterpriseMediatedRunParams>(
  params: T,
): Promise<EnterpriseMediationOutcome<T>> {
  // Raw model runs (one-shot probes, promptMode "none") are runtime
  // machinery outside agent mediation, matching isRawModelRun semantics.
  if (params.modelRun || params.promptMode === "none") {
    return { params, mediated: false };
  }
  // Explicit-model callers may omit params.config (the runner only snapshots
  // config for default model resolution). Governance must still see the
  // configured enterprise mode/policies, so fall back to the pinned snapshot.
  const config = params.config ?? getRuntimeConfigSnapshot() ?? undefined;
  // The planner is only built when a config exists AND enterprise mediation is
  // actually on: without one there is no model to ask, and mediation plans the
  // whole subtree (its prior behavior).
  //
  // It is loaded LAZILY. The planner module pulls in the provider/completion
  // runtime, and a static import would put that cost on every embedded/CLI/ACP
  // run — including the ones with enterprise mode off, which never plan.
  const modelChoice = resolveRouteModelRef(params);
  const planningPossible =
    Boolean(config) && resolveEnterpriseMode(config) !== "off" && modelChoice.kind !== "skip";
  // The planner module pulls in the provider/completion runtime. Import it inside
  // the CALLBACK, not here: selectWorkflowRoute skips small trees entirely (the
  // built-in default is 4 nodes), so a stock run would otherwise pay that startup
  // cost on the hot path for a planner it never calls.
  const routePlanner: RoutePlanner | undefined =
    planningPossible && config
      ? async (plannerParams) => {
          const { createModelRoutePlanner } = await import("./enterprise-route-planner.runtime.js");
          const planner = createModelRoutePlanner({
            cfg: config,
            ...(params.agentId ? { agentId: params.agentId } : {}),
            // Route with the exact provider/model/profile the run dispatches to.
            ...(modelChoice.kind === "ref" ? { modelRef: modelChoice.ref } : {}),
            ...(params.authProfileId ? { authProfileId: params.authProfileId } : {}),
          });
          return planner ? await planner(plannerParams) : null;
        }
      : undefined;
  const mediation = await beginEnterpriseRun({
    runId: params.runId,
    prompt: params.prompt,
    ...(params.trigger !== undefined ? { trigger: params.trigger } : {}),
    ...(params.spawnedBy !== undefined ? { spawnedBy: params.spawnedBy } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(config ? { config } : {}),
    ...(routePlanner ? { routePlanner } : {}),
    // Cancelling the turn must cancel route planning with it; otherwise the
    // planner runs to its timeout and traces a route for an aborted run.
    ...(params.abortSignal ? { signal: params.abortSignal } : {}),
  });
  if (mediation.kind === "off") {
    return { params, mediated: false };
  }
  if (mediation.kind === "blocked") {
    return {
      params,
      mediated: false,
      blockedResult: {
        payloads: [{ text: mediation.reason, isError: true }],
        meta: {
          durationMs: 0,
          error: { kind: "hook_block", message: mediation.reason },
        },
      },
    };
  }
  if (!mediation.promptSection) {
    return { params, mediated: true };
  }
  return {
    mediated: true,
    params: {
      ...params,
      extraSystemPrompt: [params.extraSystemPrompt, mediation.promptSection]
        .filter(Boolean)
        .join("\n\n"),
    },
  };
}

/**
 * Map one agent-run outcome onto the enterprise run trace.
 * No-op for unmediated runs (mode off, probes, unknown runId).
 */
export function finishEnterpriseMediation(
  runId: string,
  outcome: { result?: EmbeddedAgentRunResult; error?: unknown },
): void {
  endEnterpriseRun({ runId, status: resolveEnterpriseRunStatus(outcome) });
}

function resolveEnterpriseRunStatus(outcome: {
  result?: EmbeddedAgentRunResult;
  error?: unknown;
}): Exclude<EnterpriseRunStatus, "running"> {
  if (outcome.error !== undefined) {
    return isAbortError(outcome.error) ? "aborted" : "failed";
  }
  const meta = outcome.result?.meta;
  if (!meta) {
    return "completed";
  }
  if (meta.error?.kind === "hook_block") {
    return "blocked";
  }
  // Canonical terminal normalization owns timeout/liveness/stop-reason
  // precedence (repo rule: never rederive it in projections). meta.aborted
  // only classifies runs the normalizer would otherwise call completed, so
  // aborted timeouts keep their timeout attribution.
  const terminal = buildAgentRunTerminalOutcome({
    status: meta.error ? "error" : meta.timeoutPhase ? "timeout" : "ok",
    error: meta.error?.message,
    stopReason: meta.stopReason,
    livenessState: meta.livenessState,
    timeoutPhase: meta.timeoutPhase,
    providerStarted: meta.providerStarted,
  });
  switch (terminal.reason) {
    case "completed":
      return meta.aborted ? "aborted" : "completed";
    case "hard_timeout":
    case "timed_out":
      return "timed_out";
    case "cancelled":
    case "aborted":
      return "aborted";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    default:
      return terminal.reason satisfies never;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Test-only alias: the ref contract is what keeps a private run off a cloud default. */
export { resolveRouteModelRef as resolveRouteModelRefForTest };

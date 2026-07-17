/**
 * Tests the shared runner enterprise mediation glue: param injection,
 * run-start blocking, raw-run skips, and outcome→trace status mapping.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearEnterpriseRunMediationForTest } from "../enterprise/run-mediation.js";
import { getEnterpriseActiveRun } from "../enterprise/runtime.js";
import { getEnterpriseRunRecord } from "../enterprise/trace-store.sqlite.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type { RunEmbeddedAgentParams } from "./embedded-agent-runner/run/params.js";
import {
  applyEnterpriseMediation,
  finishEnterpriseMediation,
  resolveRouteModelRefForTest,
  type EnterpriseMediatedRunParams,
} from "./enterprise-mediation.js";

// The helper feeds BOTH entrypoints, and they take different param surfaces:
// applyEnterpriseMediation takes the runner's params, resolveRouteModelRef takes
// the mediation surface (which is where externalDispatch/authProfileId live).
// Typing it as only the former silently dropped the dispatch fields the
// model-leak guard is built on.
type MediationTestParams = RunEmbeddedAgentParams & EnterpriseMediatedRunParams;

let runCounter = 0;
function makeParams(overrides: Partial<MediationTestParams> = {}): MediationTestParams {
  runCounter += 1;
  return {
    sessionId: `session-${runCounter}`,
    workspaceDir: "/tmp/clawworks-test",
    prompt: "hello",
    timeoutMs: 1000,
    runId: `mediation-glue-${runCounter}`,
    ...overrides,
  };
}

afterEach(() => {
  clearEnterpriseRunMediationForTest();
  clearRuntimeConfigSnapshot();
});

afterAll(() => {
  closeOpenClawStateDatabase();
});

describe("applyEnterpriseMediation", () => {
  it("mediates default runs without touching the system prompt (guidance-free tree)", async () => {
    const params = makeParams({ extraSystemPrompt: "existing" });
    const outcome = await applyEnterpriseMediation(params);
    expect(outcome.mediated).toBe(true);
    expect(outcome.blockedResult).toBeUndefined();
    expect(outcome.params.extraSystemPrompt).toBe("existing");
    expect(getEnterpriseActiveRun(params.runId)).toBeDefined();
  });

  it("skips internal model probes and promptMode none raw runs", async () => {
    const probe = makeParams({ modelRun: true });
    expect((await applyEnterpriseMediation(probe)).mediated).toBe(false);
    expect(getEnterpriseActiveRun(probe.runId)).toBeUndefined();

    const rawRun = makeParams({ promptMode: "none" });
    expect((await applyEnterpriseMediation(rawRun)).mediated).toBe(false);
    expect(getEnterpriseActiveRun(rawRun.runId)).toBeUndefined();
  });

  it("skips mediation when enterprise mode is off", async () => {
    const params = makeParams({ config: { enterprise: { mode: "off" } } });
    const outcome = await applyEnterpriseMediation(params);
    expect(outcome.mediated).toBe(false);
    expect(outcome.params).toBe(params);
  });

  it("falls back to the runtime config snapshot when params omit config", async () => {
    // Explicit-model callers omit params.config; configured governance
    // (here an opt-out) must still apply via the pinned snapshot.
    setRuntimeConfigSnapshot({ enterprise: { mode: "off" } });
    const offOutcome = await applyEnterpriseMediation(makeParams());
    expect(offOutcome.mediated).toBe(false);

    setRuntimeConfigSnapshot({
      enterprise: {
        governance: {
          policies: [{ id: "deny.everything", effect: "deny" }],
        },
      },
    });
    const deniedOutcome = await applyEnterpriseMediation(makeParams());
    expect(deniedOutcome.blockedResult?.meta.error?.kind).toBe("hook_block");
  });

  it("returns a blocked hook_block result when run-start governance denies", async () => {
    const config: OpenClawConfig = {
      enterprise: {
        governance: {
          policies: [
            {
              id: "deny.everything",
              effect: "deny",
              description: "This workspace is locked down.",
            },
          ],
        },
      },
    };
    const params = makeParams({ config });
    const outcome = await applyEnterpriseMediation(params);
    expect(outcome.mediated).toBe(false);
    expect(outcome.blockedResult?.meta.error?.kind).toBe("hook_block");
    expect(outcome.blockedResult?.payloads?.[0]).toMatchObject({
      text: "This workspace is locked down.",
      isError: true,
    });
    expect(getEnterpriseRunRecord(params.runId)?.status).toBe("blocked");
  });
});

describe("route planning model selection", () => {
  it("routes with the run's own provider/model, never the agent default", async () => {
    // A user on a local/private model must not have the request shipped to a
    // cloud default provider just to pick a route.
    const params = makeParams({ provider: "ollama", model: "llama3" });
    const outcome = await applyEnterpriseMediation(params);
    expect(outcome.mediated).toBe(true);
    // The ref handed to the planner is the run's dispatch choice, qualified.
    expect(resolveRouteModelRefForTest(params)).toEqual({ kind: "ref", ref: "ollama/llama3" });
  });

  it("passes an already-qualified model ref through unchanged", () => {
    expect(
      resolveRouteModelRefForTest(makeParams({ provider: "anthropic", model: "anthropic/opus" })),
    ).toEqual({ kind: "ref", ref: "anthropic/opus" });
  });

  it("keeps a gateway provider that routes slash-bearing model ids", () => {
    // openrouter serves "anthropic/claude-sonnet-4-6". Treating the slash as
    // "already qualified" would drop openrouter and send the prompt to anthropic.
    expect(
      resolveRouteModelRefForTest(
        makeParams({ provider: "openrouter", model: "anthropic/claude-sonnet-4-6" }),
      ),
    ).toEqual({ kind: "ref", ref: "openrouter/anthropic/claude-sonnet-4-6" });
  });

  it("uses the bare model when the run pinned no provider", () => {
    expect(resolveRouteModelRefForTest(makeParams({ model: "llama3" }))).toEqual({
      kind: "ref",
      ref: "llama3",
    });
  });

  it("SKIPS planning for a provider-only run (its default model has no ref)", () => {
    // A CLI run pinned to a local provider with that provider's default model:
    // a bare default would resolve against the AGENT default, possibly a cloud
    // provider this run deliberately avoided. Planning is skipped instead.
    expect(resolveRouteModelRefForTest(makeParams({ provider: "ollama" }))).toEqual({
      kind: "skip",
    });
  });

  it("SKIPS planning for an ACP run (its prompt goes to a backend we do not pick)", () => {
    // ACP dispatches to its own backend. Routing would ship the prompt to
    // OpenClaw's default completion model — an unrelated cloud model for a
    // possibly-local ACP session.
    expect(resolveRouteModelRefForTest(makeParams({ externalDispatch: true }))).toEqual({
      kind: "skip",
    });
  });

  it("SKIPS planning when a before_model_resolve hook can still swap the provider", () => {
    // The hook runs AFTER mediation, so planning here would use the pre-hook
    // model — possibly the very cloud default the hook exists to avoid.
    expect(
      resolveRouteModelRefForTest(makeParams({ provider: "anthropic", model: "opus" }), {
        hasHook: (hook) => hook === "before_model_resolve",
      }),
    ).toEqual({ kind: "skip" });
  });

  it("SKIPS planning for a CRON run when a before_agent_reply hook may claim it", () => {
    expect(
      resolveRouteModelRefForTest(
        makeParams({ provider: "anthropic", model: "opus", trigger: "cron" }),
        { hasHook: (hook) => hook === "before_agent_reply" },
      ),
    ).toEqual({ kind: "skip" });
  });

  it("still plans a normal turn when only before_agent_reply exists", () => {
    // A bundled plugin (memory-core) registers this hook in EVERY install, so
    // skipping on its presence alone would disable route planning for everyone.
    expect(
      resolveRouteModelRefForTest(makeParams({ provider: "anthropic", model: "opus" }), {
        hasHook: (hook) => hook === "before_agent_reply",
      }),
    ).toEqual({ kind: "ref", ref: "anthropic/opus" });
  });

  it("uses the agent default when the run pinned nothing (that IS its choice)", () => {
    expect(resolveRouteModelRefForTest(makeParams({}))).toEqual({ kind: "agent-default" });
  });
});

describe("finishEnterpriseMediation", () => {
  it("maps clean results to completed", async () => {
    const params = makeParams();
    await applyEnterpriseMediation(params);
    finishEnterpriseMediation(params.runId, { result: { meta: { durationMs: 5 } } });
    expect(getEnterpriseRunRecord(params.runId)?.status).toBe("completed");
  });

  it("maps aborted results and abort errors to aborted", async () => {
    const first = makeParams();
    await applyEnterpriseMediation(first);
    finishEnterpriseMediation(first.runId, { result: { meta: { durationMs: 5, aborted: true } } });
    expect(getEnterpriseRunRecord(first.runId)?.status).toBe("aborted");

    const second = makeParams();
    await applyEnterpriseMediation(second);
    const abortError = new Error("stop");
    abortError.name = "AbortError";
    finishEnterpriseMediation(second.runId, { error: abortError });
    expect(getEnterpriseRunRecord(second.runId)?.status).toBe("aborted");
  });

  it("maps timeout metadata to timed_out via the canonical terminal outcome", async () => {
    const hardTimeout = makeParams();
    await applyEnterpriseMediation(hardTimeout);
    finishEnterpriseMediation(hardTimeout.runId, {
      result: { meta: { durationMs: 5, timeoutPhase: "provider" } },
    });
    expect(getEnterpriseRunRecord(hardTimeout.runId)?.status).toBe("timed_out");

    const softTimeout = makeParams();
    await applyEnterpriseMediation(softTimeout);
    finishEnterpriseMediation(softTimeout.runId, {
      result: { meta: { durationMs: 5, timeoutPhase: "queue" } },
    });
    expect(getEnterpriseRunRecord(softTimeout.runId)?.status).toBe("timed_out");

    // Timeout attribution beats the aborted flag (canonical precedence).
    const abortedTimeout = makeParams();
    await applyEnterpriseMediation(abortedTimeout);
    finishEnterpriseMediation(abortedTimeout.runId, {
      result: { meta: { durationMs: 5, aborted: true, timeoutPhase: "provider" } },
    });
    expect(getEnterpriseRunRecord(abortedTimeout.runId)?.status).toBe("timed_out");
  });

  it("maps run errors to failed and hook blocks to blocked", async () => {
    const first = makeParams();
    await applyEnterpriseMediation(first);
    finishEnterpriseMediation(first.runId, {
      result: { meta: { durationMs: 5, error: { kind: "retry_limit", message: "boom" } } },
    });
    expect(getEnterpriseRunRecord(first.runId)?.status).toBe("failed");

    const second = makeParams();
    await applyEnterpriseMediation(second);
    finishEnterpriseMediation(second.runId, {
      result: { meta: { durationMs: 5, error: { kind: "hook_block", message: "denied" } } },
    });
    expect(getEnterpriseRunRecord(second.runId)?.status).toBe("blocked");
  });
});

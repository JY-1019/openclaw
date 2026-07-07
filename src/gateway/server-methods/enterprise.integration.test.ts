// Cross-slice integration: a trace produced by real enterprise mediation
// (beginEnterpriseRun + governance + endEnterpriseRun) must round-trip out
// through the gateway read handlers. Existing enterprise.test.ts seeds the
// trace store directly; this proves the producer/consumer contract end to end.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  beginEnterpriseRun,
  clearEnterpriseRunMediationForTest,
  endEnterpriseRun,
} from "../../enterprise/run-mediation.js";
import { clearEnterpriseActiveRunsForTest } from "../../enterprise/runtime.js";
import { invalidateWorkflowTreeRegistry } from "../../enterprise/tree-registry.js";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { enterpriseHandlers } from "./enterprise.js";

const tempDir = mkdtempSync(path.join(tmpdir(), "clawworks-int-"));
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

type EnterpriseMethod = "enterprise.runs.list" | "enterprise.runs.get";

function invoke(method: EnterpriseMethod, params: Record<string, unknown>) {
  const calls: Array<{ ok: boolean; payload?: unknown }> = [];
  void enterpriseHandlers[method]?.({
    req: { type: "req", id: method, method, params: {} },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: (ok: boolean, payload?: unknown) => {
      calls.push({ ok, payload });
    },
    context: {} as never,
  });
  expect(calls).toHaveLength(1);
  return calls[0];
}

beforeAll(() => {
  // beginEnterpriseRun and the gateway handlers both read the default state DB;
  // point it at an isolated temp store so the round-trip is deterministic.
  setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
  invalidateWorkflowTreeRegistry();
});

afterAll(() => {
  clearEnterpriseRunMediationForTest();
  clearEnterpriseActiveRunsForTest();
  closeOpenClawStateDatabase();
  invalidateWorkflowTreeRegistry();
  rmSync(tempDir, { recursive: true, force: true });
  envSnapshot.restore();
});

describe("enterprise mediation to gateway round-trip", () => {
  it("surfaces a mediation-produced governed trace through the gateway read methods", () => {
    // A run-level audit policy records a governance decision without blocking.
    const config: OpenClawConfig = {
      enterprise: {
        governance: {
          policies: [{ id: "audit.trees", effect: "audit", trees: ["clawworks.*"] }],
        },
      },
    };

    const mediation = beginEnterpriseRun({
      runId: "int-run-1",
      prompt: "please help me finish a task",
      trigger: "user",
      config,
    });
    expect(mediation.kind).toBe("mediated");

    endEnterpriseRun({ runId: "int-run-1", status: "completed" });

    // The gateway list surfaces the finished run.
    const list = invoke("enterprise.runs.list", {});
    const runs = (list.payload as { runs: Array<Record<string, unknown>> }).runs;
    const summary = runs.find((run) => run.runId === "int-run-1");
    expect(summary).toBeDefined();
    expect(summary?.status).toBe("completed");
    expect(String(summary?.treeId)).toMatch(/^clawworks\./);

    // The gateway detail (keyed by the listed execution id) carries the plan and
    // the governance trace the mediation produced.
    const detail = invoke("enterprise.runs.get", {
      executionId: summary?.executionId as string,
    });
    const run = (detail.payload as { run: Record<string, unknown> | null }).run;
    if (!run) {
      throw new Error("expected gateway to return the mediated run detail");
    }
    expect((run.nodes as unknown[]).length).toBeGreaterThan(0);
    const kinds = (run.events as Array<{ kind: string }>).map((event) => event.kind);
    expect(kinds).toContain("run.started");
    expect(kinds).toContain("governance.decision");
    expect(kinds).toContain("run.ended");
  });
});

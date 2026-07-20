import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  clearEnterpriseKnowledgeFoundations,
  registerEnterpriseKnowledgeFoundation,
} from "../../enterprise/knowledge.js";
import { importWorkflowTreeContent } from "../../enterprise/tree-io.js";
import { invalidateWorkflowTreeRegistry } from "../../enterprise/tree-registry.js";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { enterpriseHandlers } from "./enterprise.js";

const tempDir = mkdtempSync(path.join(tmpdir(), "clawworks-gw-knowledge-"));
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

async function invoke(method: string, params: Record<string, unknown>) {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  await enterpriseHandlers[method]?.({
    req: { type: "req", id: method, method, params: {} },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      calls.push({ ok, payload, error });
    },
    context: {} as never,
  });
  expect(calls).toHaveLength(1);
  return calls[0];
}

// Two nodes on one tree name the same foundation, and a second tree names a
// different one, so referencedBy has to group by foundation rather than by tree.
const REFERENCING_TREE = JSON.stringify({
  schema: "clawworks.workflow-tree",
  schemaVersion: 1,
  id: "test.knowledge",
  version: "1.0.0",
  name: "Knowledge test",
  root: {
    id: "root",
    title: "Root",
    ontology: { knowledgeFoundations: ["acme.kb"] },
    children: [
      {
        id: "root.leaf",
        title: "Leaf",
        // "acme.kb" repeated: the schema permits it and retrieval ignores it,
        // so referencedBy must not list this node twice.
        ontology: { knowledgeFoundations: ["acme.kb", "acme.archive", "acme.kb"] },
      },
      { id: "root.unscoped", title: "Unscoped" },
    ],
  },
});

beforeAll(() => {
  setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
  invalidateWorkflowTreeRegistry();
  expect(importWorkflowTreeContent({ content: REFERENCING_TREE, format: "json" }).ok).toBe(true);
  invalidateWorkflowTreeRegistry();
});

afterEach(() => {
  clearEnterpriseKnowledgeFoundations();
});

afterAll(() => {
  closeOpenClawStateDatabase();
  invalidateWorkflowTreeRegistry();
  rmSync(tempDir, { recursive: true, force: true });
  envSnapshot.restore();
});

describe("enterprise.knowledge.foundations.list", () => {
  it("returns an empty list when no adapter plugin has registered", async () => {
    const { ok, payload } = await invoke("enterprise.knowledge.foundations.list", {});
    expect(ok).toBe(true);
    expect(payload).toEqual({ foundations: [] });
  });

  it("projects each registered foundation's descriptor", async () => {
    registerEnterpriseKnowledgeFoundation("acme.kb", {
      retrieve: async () => [],
      describe: () => ({ kind: "local", displayName: "Acme KB", detail: "http://kb:9621" }),
    });

    const { payload } = await invoke("enterprise.knowledge.foundations.list", {});
    const { foundations } = payload as { foundations: Array<Record<string, unknown>> };
    expect(foundations).toHaveLength(1);
    expect(foundations[0]).toMatchObject({
      id: "acme.kb",
      kind: "local",
      displayName: "Acme KB",
      detail: "http://kb:9621",
    });
  });

  it("omits detail entirely for an adapter that reports none", async () => {
    registerEnterpriseKnowledgeFoundation("acme.kb", { retrieve: async () => [] });

    const { payload } = await invoke("enterprise.knowledge.foundations.list", {});
    const { foundations } = payload as { foundations: Array<Record<string, unknown>> };
    // Absent, not null/"": the schema declares detail optional.
    expect(foundations[0]).not.toHaveProperty("detail");
    expect(foundations[0]).toMatchObject({ kind: "remote", displayName: "acme.kb" });
  });

  it("reports every node whose ontology allow-list names the foundation", async () => {
    registerEnterpriseKnowledgeFoundation("acme.kb", { retrieve: async () => [] });

    const { payload } = await invoke("enterprise.knowledge.foundations.list", {});
    const { foundations } = payload as {
      foundations: Array<{ id: string; referencedBy: Array<Record<string, unknown>> }>;
    };
    expect(foundations[0].referencedBy).toEqual([
      { treeId: "test.knowledge", treeName: "Knowledge test", nodeId: "root", nodeTitle: "Root" },
      {
        treeId: "test.knowledge",
        treeName: "Knowledge test",
        nodeId: "root.leaf",
        nodeTitle: "Leaf",
      },
    ]);
  });

  it("reports an unreferenced foundation with an empty referencedBy", async () => {
    registerEnterpriseKnowledgeFoundation("orphan.kb", { retrieve: async () => [] });

    const { payload } = await invoke("enterprise.knowledge.foundations.list", {});
    const { foundations } = payload as {
      foundations: Array<{ id: string; referencedBy: unknown[] }>;
    };
    expect(foundations[0]).toMatchObject({ id: "orphan.kb", referencedBy: [] });
  });

  it("lists foundations in sorted id order for a stable inspector view", async () => {
    registerEnterpriseKnowledgeFoundation("zeta.kb", { retrieve: async () => [] });
    registerEnterpriseKnowledgeFoundation("acme.kb", { retrieve: async () => [] });

    const { payload } = await invoke("enterprise.knowledge.foundations.list", {});
    const { foundations } = payload as { foundations: Array<{ id: string }> };
    expect(foundations.map((entry) => entry.id)).toEqual(["acme.kb", "zeta.kb"]);
  });

  it("rejects unknown params", async () => {
    const { ok, error } = await invoke("enterprise.knowledge.foundations.list", { nope: 1 });
    expect(ok).toBe(false);
    expect(String((error as { message?: string }).message)).toMatch(
      /invalid enterprise\.knowledge\.foundations\.list params/,
    );
  });
});

describe("enterprise.knowledge.foundations.testConnection", () => {
  it("reports a reachable foundation as ok", async () => {
    registerEnterpriseKnowledgeFoundation("acme.kb", {
      retrieve: async () => [],
      testConnection: async () => ({ ok: true }),
    });

    const { ok, payload } = await invoke("enterprise.knowledge.foundations.testConnection", {
      foundationId: "acme.kb",
    });
    expect(ok).toBe(true);
    expect(payload).toEqual({ status: "ok" });
  });

  it("reports an unreachable foundation as failed with the adapter's detail", async () => {
    registerEnterpriseKnowledgeFoundation("acme.kb", {
      retrieve: async () => [],
      testConnection: async () => ({ ok: false, detail: "ECONNREFUSED" }),
    });

    const { payload } = await invoke("enterprise.knowledge.foundations.testConnection", {
      foundationId: "acme.kb",
    });
    expect(payload).toEqual({ status: "failed", detail: "ECONNREFUSED" });
  });

  it("reports unsupported for an adapter that cannot probe", async () => {
    registerEnterpriseKnowledgeFoundation("legacy.kb", { retrieve: async () => [] });

    const { payload } = await invoke("enterprise.knowledge.foundations.testConnection", {
      foundationId: "legacy.kb",
    });
    expect(payload).toEqual({ status: "unsupported" });
  });

  it("answers a stale foundation id with a status, not a request error", async () => {
    // The operator's list can go stale when a plugin deactivates; that is not a
    // malformed request, and the inspector renders it as its own chip.
    const { ok, payload } = await invoke("enterprise.knowledge.foundations.testConnection", {
      foundationId: "ghost.kb",
    });
    expect(ok).toBe(true);
    expect(payload).toEqual({ status: "not-registered" });
  });

  it("rejects a missing foundationId", async () => {
    const { ok, error } = await invoke("enterprise.knowledge.foundations.testConnection", {});
    expect(ok).toBe(false);
    expect(String((error as { message?: string }).message)).toMatch(
      /invalid enterprise\.knowledge\.foundations\.testConnection params/,
    );
  });
});

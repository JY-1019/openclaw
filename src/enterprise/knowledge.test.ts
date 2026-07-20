import { afterEach, describe, expect, it } from "vitest";
import {
  clearEnterpriseKnowledgeFoundations,
  InMemoryKnowledgeFoundation,
  listEnterpriseKnowledgeFoundationDescriptors,
  listEnterpriseKnowledgeFoundationIds,
  listEnterpriseKnowledgeFoundations,
  registerEnterpriseKnowledgeFoundation,
  resolveEnterpriseKnowledge,
  restoreEnterpriseKnowledgeFoundations,
  testEnterpriseKnowledgeFoundationConnection,
} from "./knowledge.js";
import {
  clearEnterpriseActiveRunsForTest,
  registerEnterpriseActiveRun,
  type EnterpriseActiveRun,
} from "./runtime.js";
import type { EnterpriseRunPlan, GovernancePolicy, KnowledgeSnippet } from "./types.js";

type SinkEvent = { kind: string; nodeId: string; payload: Record<string, unknown> };

function run(opts: {
  mode?: "enforce" | "observe";
  knowledgeFoundations?: string[];
  policies?: GovernancePolicy[];
  sink?: (event: SinkEvent) => void;
}): EnterpriseActiveRun {
  const plan: EnterpriseRunPlan = {
    runId: "run-k",
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
        ontology: opts.knowledgeFoundations
          ? { knowledgeFoundations: opts.knowledgeFoundations }
          : {},
      },
    ],
    activeNodeId: "support",
    mode: opts.mode ?? "enforce",
    createdAt: 0,
  };
  return { plan, policies: opts.policies ?? [], ...(opts.sink ? { sink: opts.sink } : {}) };
}

function foundation(...texts: string[]): InMemoryKnowledgeFoundation {
  const docs: KnowledgeSnippet[] = texts.map((text, index) => ({
    foundationId: "pending",
    text,
    title: `doc-${index}`,
  }));
  return new InMemoryKnowledgeFoundation(docs);
}

afterEach(() => {
  clearEnterpriseActiveRunsForTest();
  clearEnterpriseKnowledgeFoundations();
});

describe("knowledge foundation registry", () => {
  it("registers, lists (sorted), and replaces adapters", () => {
    registerEnterpriseKnowledgeFoundation("acme.z", foundation("z"));
    registerEnterpriseKnowledgeFoundation("acme.a", foundation("a"));
    expect(listEnterpriseKnowledgeFoundationIds()).toEqual(["acme.a", "acme.z"]);
  });

  it("snapshots, clears, and restores for plugin (de)activation lifecycle", () => {
    registerEnterpriseKnowledgeFoundation("acme.a", foundation("a"));
    registerEnterpriseKnowledgeFoundation("acme.b", foundation("b"));
    const snapshot = listEnterpriseKnowledgeFoundations();
    expect(snapshot.map((entry) => entry.foundationId).toSorted()).toEqual(["acme.a", "acme.b"]);

    clearEnterpriseKnowledgeFoundations();
    expect(listEnterpriseKnowledgeFoundationIds()).toEqual([]);

    restoreEnterpriseKnowledgeFoundations(snapshot);
    expect(listEnterpriseKnowledgeFoundationIds()).toEqual(["acme.a", "acme.b"]);
  });
});

describe("InMemoryKnowledgeFoundation", () => {
  it("ranks by case-insensitive term overlap and honors the limit", async () => {
    const adapter = foundation(
      "Refund window is 30 days",
      "Shipping is free",
      "Refund needs a receipt",
    );
    const results = await adapter.retrieve({
      foundationId: "kb",
      query: "refund receipt",
      limit: 5,
    });
    expect(results[0].text).toBe("Refund needs a receipt"); // matches both terms
    expect(results.map((snippet) => snippet.foundationId)).toEqual(["kb", "kb"]);
    expect(results).toHaveLength(2); // "Shipping is free" matches neither term
  });
});

describe("resolveEnterpriseKnowledge", () => {
  it("returns an unmediated result for unknown runs", async () => {
    const result = await resolveEnterpriseKnowledge({ runId: "nope", query: "refund" });
    expect(result).toEqual({ snippets: [], skipped: [], mediated: false });
  });

  it("queries only ontology-allowed registered foundations", async () => {
    registerEnterpriseActiveRun(run({ knowledgeFoundations: ["acme.support"] }));
    registerEnterpriseKnowledgeFoundation("acme.support", foundation("Refund window is 30 days"));
    registerEnterpriseKnowledgeFoundation("acme.secret", foundation("Refund secrets"));

    const result = await resolveEnterpriseKnowledge({ runId: "run-k", query: "refund" });
    expect(result.mediated).toBe(true);
    expect(result.snippets.map((snippet) => snippet.foundationId)).toEqual(["acme.support"]);
  });

  it("queries all registered foundations when the step declares none", async () => {
    registerEnterpriseActiveRun(run({}));
    registerEnterpriseKnowledgeFoundation("acme.a", foundation("refund a"));
    registerEnterpriseKnowledgeFoundation("acme.b", foundation("refund b"));

    const result = await resolveEnterpriseKnowledge({ runId: "run-k", query: "refund" });
    expect(result.snippets.map((snippet) => snippet.foundationId).toSorted()).toEqual([
      "acme.a",
      "acme.b",
    ]);
  });

  it("skips and traces a foundation denied by a knowledge policy in enforce mode", async () => {
    const events: SinkEvent[] = [];
    registerEnterpriseActiveRun(
      run({
        policies: [{ id: "deny.secret", effect: "deny", knowledge: ["acme.secret"] }],
        sink: (event) => events.push(event),
      }),
    );
    registerEnterpriseKnowledgeFoundation("acme.support", foundation("refund window"));
    registerEnterpriseKnowledgeFoundation("acme.secret", foundation("refund secrets"));

    const result = await resolveEnterpriseKnowledge({ runId: "run-k", query: "refund" });
    expect(result.snippets.map((snippet) => snippet.foundationId)).toEqual(["acme.support"]);
    expect(result.skipped).toEqual([
      { foundationId: "acme.secret", reason: expect.stringContaining("acme.secret") },
    ]);
    const decision = events.find((event) => event.payload.subject === "knowledge");
    expect(decision?.payload).toMatchObject({
      subject: "knowledge",
      foundationId: "acme.secret",
      effect: "deny",
      enforced: true,
    });
  });

  it("traces default-allowed retrievals when an ancestor step opts into audit", async () => {
    const events: SinkEvent[] = [];
    const plan: EnterpriseRunPlan = {
      runId: "run-k",
      treeId: "acme.support",
      treeVersion: "1.0.0",
      treeName: "Support",
      matchedBy: "trigger",
      requestSummary: "help",
      nodes: [
        { nodeId: "support", parentId: null, seq: 0, title: "Support", ontology: { audit: true } },
        { nodeId: "support.triage", parentId: "support", seq: 1, title: "Triage", ontology: {} },
      ],
      activeNodeId: "support.triage",
      mode: "enforce",
      createdAt: 0,
    };
    registerEnterpriseActiveRun({ plan, policies: [], sink: (event) => events.push(event) });
    registerEnterpriseKnowledgeFoundation("acme.kb", foundation("refund window is 30 days"));

    const result = await resolveEnterpriseKnowledge({ runId: "run-k", query: "refund" });
    expect(result.snippets).toHaveLength(1); // default-allow still retrieves
    const decision = events.find((event) => event.payload.subject === "knowledge");
    expect(decision?.payload).toMatchObject({
      foundationId: "acme.kb",
      effect: "allow",
      enforced: false,
    });
  });

  it("caps results at the limit even when an adapter ignores it", async () => {
    registerEnterpriseActiveRun(run({}));
    // Adapter returns everything regardless of the requested limit.
    registerEnterpriseKnowledgeFoundation("acme.kb", {
      retrieve: async ({ foundationId }) => [
        { foundationId, text: "one" },
        { foundationId, text: "two" },
        { foundationId, text: "three" },
      ],
    });
    const result = await resolveEnterpriseKnowledge({ runId: "run-k", query: "x", limit: 1 });
    expect(result.snippets).toHaveLength(1);
  });

  it("skips a foundation whose adapter throws, without failing the whole retrieval", async () => {
    registerEnterpriseActiveRun(run({}));
    registerEnterpriseKnowledgeFoundation("acme.down", {
      retrieve: async () => {
        throw new Error("server unreachable");
      },
    });
    registerEnterpriseKnowledgeFoundation("acme.up", foundation("refund window"));

    const result = await resolveEnterpriseKnowledge({ runId: "run-k", query: "refund" });
    expect(result.snippets.map((snippet) => snippet.foundationId)).toEqual(["acme.up"]);
    // The model-facing reason is sanitized (raw error detail is logged out-of-band).
    expect(result.skipped).toEqual([{ foundationId: "acme.down", reason: "retrieval failed" }]);
  });

  it("propagates the error when the run is aborted mid-retrieval", async () => {
    registerEnterpriseActiveRun(run({}));
    const controller = new AbortController();
    registerEnterpriseKnowledgeFoundation("acme.kb", {
      retrieve: async () => {
        controller.abort();
        throw new Error("aborted");
      },
    });
    await expect(
      resolveEnterpriseKnowledge({ runId: "run-k", query: "refund", signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
  });

  it("records but does not skip denials in observe mode", async () => {
    const events: SinkEvent[] = [];
    registerEnterpriseActiveRun(
      run({
        mode: "observe",
        policies: [{ id: "deny.secret", effect: "deny", knowledge: ["acme.secret"] }],
        sink: (event) => events.push(event),
      }),
    );
    registerEnterpriseKnowledgeFoundation("acme.secret", foundation("refund secrets"));

    const result = await resolveEnterpriseKnowledge({ runId: "run-k", query: "refund" });
    expect(result.snippets.map((snippet) => snippet.foundationId)).toEqual(["acme.secret"]);
    expect(result.skipped).toHaveLength(0);
    expect(events.some((event) => event.payload.enforced === false)).toBe(true);
  });
});

describe("foundation descriptors", () => {
  it("uses the adapter's describe() when it implements one", () => {
    registerEnterpriseKnowledgeFoundation("acme.kb", {
      retrieve: async () => [],
      describe: () => ({ kind: "local", displayName: "Acme KB", detail: "http://kb:9621" }),
    });

    expect(listEnterpriseKnowledgeFoundationDescriptors()).toEqual([
      {
        foundationId: "acme.kb",
        descriptor: { kind: "local", displayName: "Acme KB", detail: "http://kb:9621" },
      },
    ]);
  });

  it("falls back for a retrieval-only adapter written before describe() existed", () => {
    registerEnterpriseKnowledgeFoundation("legacy.kb", foundation("anything"));

    expect(listEnterpriseKnowledgeFoundationDescriptors()).toEqual([
      { foundationId: "legacy.kb", descriptor: { kind: "remote", displayName: "legacy.kb" } },
    ]);
  });

  it("degrades one row instead of blanking the list when describe() throws", () => {
    registerEnterpriseKnowledgeFoundation("broken.kb", {
      retrieve: async () => [],
      describe: () => {
        throw new Error("plugin bug");
      },
    });
    registerEnterpriseKnowledgeFoundation("healthy.kb", {
      retrieve: async () => [],
      describe: () => ({ kind: "remote", displayName: "Healthy" }),
    });

    expect(listEnterpriseKnowledgeFoundationDescriptors()).toEqual([
      { foundationId: "broken.kb", descriptor: { kind: "remote", displayName: "broken.kb" } },
      { foundationId: "healthy.kb", descriptor: { kind: "remote", displayName: "Healthy" } },
    ]);
  });
});

describe("testEnterpriseKnowledgeFoundationConnection", () => {
  it("maps a reachable adapter to ok and carries its detail", async () => {
    registerEnterpriseKnowledgeFoundation("acme.kb", {
      retrieve: async () => [],
      testConnection: async () => ({ ok: true, detail: "healthy" }),
    });

    expect(await testEnterpriseKnowledgeFoundationConnection("acme.kb")).toEqual({
      status: "ok",
      detail: "healthy",
    });
  });

  it("maps an unreachable adapter to failed", async () => {
    registerEnterpriseKnowledgeFoundation("acme.kb", {
      retrieve: async () => [],
      testConnection: async () => ({ ok: false, detail: "ECONNREFUSED" }),
    });

    expect(await testEnterpriseKnowledgeFoundationConnection("acme.kb")).toEqual({
      status: "failed",
      detail: "ECONNREFUSED",
    });
  });

  it("reports unsupported separately from unreachable for a probe-less adapter", async () => {
    registerEnterpriseKnowledgeFoundation("legacy.kb", foundation("anything"));

    expect(await testEnterpriseKnowledgeFoundationConnection("legacy.kb")).toEqual({
      status: "unsupported",
    });
  });

  it("reports an unregistered id rather than claiming the server is down", async () => {
    expect(await testEnterpriseKnowledgeFoundationConnection("ghost.kb")).toEqual({
      status: "not-registered",
    });
  });

  it("keeps a thrown adapter error's detail out of the operator-facing result", async () => {
    registerEnterpriseKnowledgeFoundation("acme.kb", {
      retrieve: async () => [],
      testConnection: async () => {
        throw new Error("connect http://admin:hunter2@kb:9621 refused");
      },
    });

    // The raw message can carry urls/credentials; it belongs in the log only.
    expect(await testEnterpriseKnowledgeFoundationConnection("acme.kb")).toEqual({
      status: "failed",
      detail: "connection test failed",
    });
  });
});

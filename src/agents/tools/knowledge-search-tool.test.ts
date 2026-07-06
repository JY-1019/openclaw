import { afterEach, describe, expect, it } from "vitest";
import {
  clearEnterpriseKnowledgeFoundations,
  InMemoryKnowledgeFoundation,
  registerEnterpriseKnowledgeFoundation,
} from "../../enterprise/knowledge.js";
import {
  clearEnterpriseActiveRunsForTest,
  registerEnterpriseActiveRun,
  type EnterpriseActiveRun,
} from "../../enterprise/runtime.js";
import type { EnterpriseRunPlan } from "../../enterprise/types.js";
import { createKnowledgeSearchTool } from "./knowledge-search-tool.js";

function activeRun(): EnterpriseActiveRun {
  const plan: EnterpriseRunPlan = {
    runId: "run-tool",
    treeId: "acme.support",
    treeVersion: "1.0.0",
    treeName: "Support",
    matchedBy: "trigger",
    requestSummary: "help",
    nodes: [{ nodeId: "support", parentId: null, seq: 0, title: "Support", ontology: {} }],
    activeNodeId: "support",
    mode: "enforce",
    createdAt: 0,
  };
  return { plan, policies: [] };
}

afterEach(() => {
  clearEnterpriseActiveRunsForTest();
  clearEnterpriseKnowledgeFoundations();
});

describe("createKnowledgeSearchTool", () => {
  it("retrieves scoped, governed snippets for the run and honors the limit", async () => {
    registerEnterpriseActiveRun(activeRun());
    registerEnterpriseKnowledgeFoundation(
      "acme.kb",
      new InMemoryKnowledgeFoundation([
        { foundationId: "seed", text: "Refund window is 30 days" },
        { foundationId: "seed", text: "Refund needs a receipt" },
        { foundationId: "seed", text: "Shipping is free" },
      ]),
    );
    const tool = createKnowledgeSearchTool({ runId: "run-tool" });
    expect(tool.name).toBe("knowledge_search");

    const result = await tool.execute("call-1", { query: "refund", limit: 1 });
    const details = result.details as { snippets: Array<{ foundationId: string; text: string }> };
    expect(details.snippets).toHaveLength(1);
    expect(details.snippets[0].foundationId).toBe("acme.kb");
    expect(details.snippets[0].text).toContain("Refund");
  });

  it("rejects a missing query", async () => {
    registerEnterpriseActiveRun(activeRun());
    const tool = createKnowledgeSearchTool({ runId: "run-tool" });
    await expect(tool.execute("call-2", {})).rejects.toThrow(/query/i);
  });

  it("forwards the execute abort signal to the foundation adapter", async () => {
    registerEnterpriseActiveRun(activeRun());
    let seenSignal: AbortSignal | undefined;
    registerEnterpriseKnowledgeFoundation("acme.kb", {
      retrieve: async ({ foundationId, signal }) => {
        seenSignal = signal;
        return [{ foundationId, text: "hit" }];
      },
    });
    const controller = new AbortController();
    const tool = createKnowledgeSearchTool({ runId: "run-tool" });
    await tool.execute("call-3", { query: "x" }, controller.signal);
    expect(seenSignal).toBe(controller.signal);
  });
});

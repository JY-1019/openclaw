import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importWorkflowTreeContent } from "../../enterprise/tree-io.js";
import { invalidateWorkflowTreeRegistry } from "../../enterprise/tree-registry.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { enterpriseHandlers } from "./enterprise.js";

const tempDir = mkdtempSync(path.join(tmpdir(), "clawworks-trees-get-"));
const stateDatabasePath = path.join(tempDir, "state", "openclaw.sqlite");
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

// Write a row whose definition_json fails workflow-tree validation, so it
// surfaces as an import load failure (rowError) rather than a usable tree.
function insertCorruptTreeRow(treeId: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(stateDatabasePath);
  try {
    db.prepare(
      `INSERT OR REPLACE INTO enterprise_workflow_trees
         (tree_id, version, name, definition_json, source_format, imported_at, updated_at)
       VALUES (?, '1.0.0', 'Corrupt', '{"not":"a valid tree"}', 'json', 1, 1)`,
    ).run(treeId);
  } finally {
    db.close();
  }
}

function invoke(params: Record<string, unknown>) {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  void enterpriseHandlers["enterprise.trees.get"]?.({
    req: { type: "req", id: "enterprise.trees.get", method: "enterprise.trees.get", params: {} },
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

const RICH_TREE = JSON.stringify({
  schema: "clawworks.workflow-tree",
  schemaVersion: 1,
  id: "test.ontology",
  version: "2.0.0",
  name: "Ontology test",
  match: { keywords: ["onto"], triggers: ["user"], priority: 5 },
  root: {
    id: "root",
    title: "Root",
    ontology: {
      entities: [
        { id: "a", description: "Entity A", properties: [{ id: "score", type: "number" }] },
        { id: "b" },
      ],
      relationships: [{ id: "a-b", from: "a", to: "b", description: "A relates to B" }],
      allowedTools: ["memory_search"],
    },
    children: [
      {
        id: "root.child",
        title: "Child",
        description: "A leaf step",
        ontology: {
          actions: [{ id: "act", description: "Do a thing", tools: ["exec"] }],
          functions: [{ id: "hot", entity: "a", expression: "$score >= 75", returns: "boolean" }],
          constraints: [{ id: "c1", description: "Be careful" }],
          deniedTools: ["process"],
          audit: true,
        },
      },
    ],
  },
});

beforeAll(() => {
  setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
  invalidateWorkflowTreeRegistry();
  const result = importWorkflowTreeContent({ content: RICH_TREE, format: "json" });
  expect(result.ok).toBe(true);
  // A failed imported-only tree and a failed imported override of a built-in.
  insertCorruptTreeRow("corrupt.imported");
  insertCorruptTreeRow("clawworks.system");
  invalidateWorkflowTreeRegistry();
});

afterAll(() => {
  closeOpenClawStateDatabase();
  invalidateWorkflowTreeRegistry();
  rmSync(tempDir, { recursive: true, force: true });
  envSnapshot.restore();
});

describe("enterprise.trees.get", () => {
  it("flattens a built-in tree with parent ids and depth", () => {
    const { ok, payload } = invoke({ treeId: "clawworks.assist" });
    expect(ok).toBe(true);
    const { tree } = payload as { tree: Record<string, unknown> | null };
    expect(tree).not.toBeNull();
    expect(tree?.source).toBe("builtin");
    const nodes = tree?.nodes as Array<{ id: string; parentId: string | null; depth: number }>;
    expect(nodes[0]).toMatchObject({ id: "assist", parentId: null, depth: 0 });
    // Children flatten depth-first under their parent.
    expect(nodes.filter((node) => node.parentId === "assist").map((node) => node.id)).toEqual([
      "assist.understand",
      "assist.execute",
      "assist.respond",
    ]);
    expect(nodes.every((node) => node.depth === (node.parentId === null ? 0 : 1))).toBe(true);
  });

  it("projects the full ontology (entities, relationships, actions, functions, constraints, scopes)", () => {
    const { payload } = invoke({ treeId: "test.ontology" });
    const { tree } = payload as { tree: Record<string, unknown> };
    expect(tree).toMatchObject({ source: "imported", version: "2.0.0" });
    expect(tree.match).toEqual({ keywords: ["onto"], triggers: ["user"], priority: 5 });
    const nodes = tree.nodes as Array<Record<string, unknown>>;
    const root = nodes.find((node) => node.id === "root");
    expect(root?.ontology).toEqual({
      entities: [
        {
          id: "a",
          description: "Entity A",
          properties: [{ id: "score", type: "number" }],
        },
        { id: "b", description: undefined },
      ],
      relationships: [{ id: "a-b", from: "a", to: "b", description: "A relates to B" }],
      allowedTools: ["memory_search"],
    });
    const child = nodes.find((node) => node.id === "root.child");
    expect(child).toMatchObject({ parentId: "root", depth: 1, description: "A leaf step" });
    // Functions must survive the projection: a node's ontology that validates on
    // import but arrives at the API missing a field makes an imported tree look
    // like it silently lost half of what the operator authored.
    expect(child?.ontology).toEqual({
      actions: [{ id: "act", description: "Do a thing", tools: ["exec"] }],
      functions: [
        {
          id: "hot",
          title: undefined,
          description: undefined,
          entity: "a",
          expression: "$score >= 75",
          returns: "boolean",
        },
      ],
      constraints: [{ id: "c1", description: "Be careful" }],
      deniedTools: ["process"],
      audit: true,
    });
  });

  it("returns cloned arrays so payload mutation cannot corrupt the registry", () => {
    type FetchedTree = { match: { keywords: string[] }; nodes: Array<Record<string, unknown>> };
    const fetchTree = (): FetchedTree =>
      (invoke({ treeId: "test.ontology" }).payload as { tree: FetchedTree }).tree;
    const rootAllowedTools = (tree: FetchedTree): string[] => {
      const root = tree.nodes.find((node) => node.id === "root");
      if (!root) {
        throw new Error("expected a root node");
      }
      return (root.ontology as { allowedTools: string[] }).allowedTools;
    };

    const first = fetchTree();
    // Mutate the returned payload as a hostile in-process caller might.
    rootAllowedTools(first).push("hijacked");
    first.match.keywords.push("hijacked");

    // A fresh fetch reflects the registry, unaffected by the mutation above.
    const second = fetchTree();
    expect(rootAllowedTools(second)).toEqual(["memory_search"]);
    expect(second.match.keywords).toEqual(["onto"]);
  });

  it("returns null for an unknown tree id", () => {
    const { ok, payload } = invoke({ treeId: "does.not.exist" });
    expect(ok).toBe(true);
    expect(payload).toEqual({ tree: null });
  });

  it("surfaces an import load failure for a failed imported-only tree", () => {
    const { ok, payload } = invoke({ treeId: "corrupt.imported" });
    expect(ok).toBe(true);
    const result = payload as { tree: unknown; importError?: string };
    expect(result.tree).toBeNull();
    expect(result.importError).toBeTruthy();
  });

  it("surfaces the import failure of a corrupt override even though a built-in is returned", () => {
    const { ok, payload } = invoke({ treeId: "clawworks.system" });
    expect(ok).toBe(true);
    const result = payload as { tree: { source: string } | null; importError?: string };
    // The stale built-in is returned, but the failed override must not be hidden.
    expect(result.tree?.source).toBe("builtin");
    expect(result.importError).toBeTruthy();
  });

  it("rejects invalid params", () => {
    const { ok, error } = invoke({});
    expect(ok).toBe(false);
    expect(error).toBeDefined();
  });
});

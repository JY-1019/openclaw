import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  runOntologyObjectWrite,
  searchOntologyObjects,
  upsertOntologyObject,
} from "../../enterprise/object-store.sqlite.js";
import { importWorkflowTreeContent } from "../../enterprise/tree-io.js";
import * as treeRegistry from "../../enterprise/tree-registry.js";
import { invalidateWorkflowTreeRegistry } from "../../enterprise/tree-registry.js";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { enterpriseHandlers } from "./enterprise.js";

const tempDir = mkdtempSync(path.join(tmpdir(), "clawworks-objects-gw-"));
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

const TREE = JSON.stringify({
  schema: "clawworks.workflow-tree",
  schemaVersion: 1,
  id: "acme.objects",
  version: "1.0.0",
  name: "Objects",
  root: {
    id: "root",
    title: "Root",
    ontology: {
      entities: [
        {
          id: "claim",
          properties: [
            { id: "claim-id", type: "id", primaryKey: true },
            { id: "amount", type: "number" },
            { id: "status", type: "string" },
          ],
        },
      ],
      objects: [
        { entity: "claim", properties: { "claim-id": "C-1", amount: 100, status: "intake" } },
        { entity: "claim", properties: { "claim-id": "C-2", amount: 900, status: "closed" } },
      ],
    },
    children: [{ id: "root.work", title: "Work" }],
  },
});

function invoke(params: Record<string, unknown>) {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  void enterpriseHandlers["enterprise.objects.list"]?.({
    req: {
      type: "req",
      id: "enterprise.objects.list",
      method: "enterprise.objects.list",
      params: {},
    },
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

type ObjectRow = { objectId: string; properties: Record<string, unknown>; provenance: string };

beforeAll(() => {
  setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
  invalidateWorkflowTreeRegistry();
  expect(importWorkflowTreeContent({ content: TREE, format: "json" }).ok).toBe(true);
});

afterAll(() => {
  closeOpenClawStateDatabase();
  invalidateWorkflowTreeRegistry();
  rmSync(tempDir, { recursive: true, force: true });
  envSnapshot.restore();
});

describe("enterprise.objects.list", () => {
  it("serves the seeded instances of an object type, full properties", () => {
    const { ok, payload } = invoke({ treeId: "acme.objects", entity: "claim" });
    expect(ok).toBe(true);
    const objects = (payload as { objects: ObjectRow[] }).objects;
    expect(objects.map((object) => object.objectId).toSorted()).toEqual(["C-1", "C-2"]);
    // Operator inspection sees every property (unlike the model tools, which scope).
    const first = objects.find((object) => object.objectId === "C-1");
    expect(first?.properties).toEqual({ "claim-id": "C-1", amount: 100, status: "intake" });
    expect(first?.provenance).toBe("seed");
  });

  it("filters by property value in SQL", () => {
    const { payload } = invoke({ treeId: "acme.objects", entity: "claim", match: "closed" });
    const objects = (payload as { objects: ObjectRow[] }).objects;
    expect(objects.map((object) => object.objectId)).toEqual(["C-2"]);
  });

  it("returns an empty list for an object type with no instances", () => {
    const { ok, payload } = invoke({ treeId: "acme.objects", entity: "policy" });
    expect(ok).toBe(true);
    expect((payload as { objects: ObjectRow[] }).objects).toEqual([]);
  });

  it("rejects malformed params", () => {
    const { ok, error } = invoke({ treeId: "acme.objects" });
    expect(ok).toBe(false);
    expect(error).toBeDefined();
  });

  it("returns no rows for an unknown tree id", () => {
    const { ok, payload } = invoke({ treeId: "nope.unknown", entity: "claim" });
    expect(ok).toBe(true);
    expect((payload as { objects: ObjectRow[] }).objects).toEqual([]);
  });

  it("fails closed: serves no rows when the tree's definition is non-authoritative", () => {
    // Object rows persist in SQLite across imports; if the current definition
    // failed to load (importError), the still-present rows must not be served.
    const real = treeRegistry.getWorkflowTreeRegistrySnapshot();
    const spy = vi.spyOn(treeRegistry, "getWorkflowTreeRegistrySnapshot").mockReturnValue({
      ...real,
      importErrors: [{ treeId: "acme.objects", message: "definition_json invalid" }],
    });
    try {
      const { ok, payload } = invoke({ treeId: "acme.objects", entity: "claim" });
      expect(ok).toBe(true);
      // Sanity: without the gate these two seeded rows would come back.
      expect((payload as { objects: ObjectRow[] }).objects).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("fails closed: does not serve a runtime entity the current tree no longer declares", () => {
    // A run wrote an object for an entity id the authoritative tree does not
    // declare (e.g. one dropped in a re-import); the row persists as runtime.
    runOntologyObjectWrite((db) =>
      upsertOntologyObject(db, {
        treeId: "acme.objects",
        entity: "ghost",
        objectId: "G-1",
        properties: { "ghost-id": "G-1" },
      }),
    );
    // The row really is in the store...
    expect(
      searchOntologyObjects({ treeId: "acme.objects", entity: "ghost", limit: 10 }),
    ).toHaveLength(1);
    // ...but the gateway must not expose it: "ghost" is not an addressable type.
    const { ok, payload } = invoke({ treeId: "acme.objects", entity: "ghost" });
    expect(ok).toBe(true);
    expect((payload as { objects: ObjectRow[] }).objects).toEqual([]);
  });
});

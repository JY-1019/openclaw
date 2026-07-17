import { describe, expect, it } from "vitest";
import {
  collectDefinitionNodeIds,
  type EditableTreeDefinition,
  insertChildNode,
  newNodeIdIssue,
} from "./enterprise-tree-edit.ts";

function definition(): EditableTreeDefinition {
  return {
    schema: "clawworks.workflow-tree",
    schemaVersion: 1,
    id: "acme.support",
    version: "1.0.0",
    name: "Support",
    root: {
      id: "support",
      title: "Support",
      ontology: { entities: [{ id: "claim" }] },
      children: [{ id: "support.triage", title: "Triage" }],
    },
  };
}

describe("collectDefinitionNodeIds", () => {
  it("collects every node id in the tree", () => {
    expect([...collectDefinitionNodeIds(definition())].toSorted()).toEqual([
      "support",
      "support.triage",
    ]);
  });
});

describe("newNodeIdIssue", () => {
  const ids = new Set(["support", "support.triage"]);

  it("accepts a fresh dotted-lowercase id", () => {
    expect(newNodeIdIssue("support.resolve", ids)).toBeNull();
    expect(newNodeIdIssue("standalone", ids)).toBeNull();
  });

  it("rejects an empty id", () => {
    expect(newNodeIdIssue("   ", ids)).toBe("empty");
  });

  it("rejects a malformed id (uppercase, spaces, bad separators)", () => {
    expect(newNodeIdIssue("Support.Resolve", ids)).toBe("pattern");
    expect(newNodeIdIssue("support resolve", ids)).toBe("pattern");
    expect(newNodeIdIssue("support..resolve", ids)).toBe("pattern");
    expect(newNodeIdIssue(".support", ids)).toBe("pattern");
  });

  it("rejects an id already present in the tree", () => {
    expect(newNodeIdIssue("support.triage", ids)).toBe("duplicate");
  });
});

describe("insertChildNode", () => {
  it("appends a bare child under an existing node and preserves other fields", () => {
    const original = definition();
    const result = insertChildNode(original, "support", {
      id: "support.resolve",
      title: "Resolve",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const root = result.definition.root;
    expect(root.children?.map((child) => child.id)).toEqual(["support.triage", "support.resolve"]);
    // The added node is bare id + title; nothing else is invented.
    expect(root.children?.at(-1)).toEqual({ id: "support.resolve", title: "Resolve" });
    // Untouched fields survive verbatim.
    expect(root.ontology).toEqual({ entities: [{ id: "claim" }] });
    expect(result.definition.id).toBe("acme.support");
    expect(result.definition.schema).toBe("clawworks.workflow-tree");
  });

  it("creates the children array when the parent had none", () => {
    const original = definition();
    const result = insertChildNode(original, "support.triage", {
      id: "support.triage.review",
      title: "Review",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const triage = result.definition.root.children?.find((child) => child.id === "support.triage");
    expect(triage?.children).toEqual([{ id: "support.triage.review", title: "Review" }]);
  });

  it("does not mutate the input definition", () => {
    const original = definition();
    insertChildNode(original, "support", { id: "support.resolve", title: "Resolve" });
    expect(original.root.children?.map((child) => child.id)).toEqual(["support.triage"]);
  });

  it("fails when the parent id is not in the tree", () => {
    const result = insertChildNode(definition(), "support.ghost", { id: "support.x", title: "X" });
    expect(result).toEqual({ ok: false, reason: "parent-not-found" });
  });

  it("fails when the new id already exists anywhere in the tree", () => {
    const result = insertChildNode(definition(), "support", {
      id: "support.triage",
      title: "Dup",
    });
    expect(result).toEqual({ ok: false, reason: "duplicate-id" });
  });
});
